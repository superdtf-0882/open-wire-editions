#!/usr/bin/env node
'use strict';
// REQ-OPS-1 window tests.
//
// The case that motivates all of this is `the 16:00 firing never happened`
// below: measured on this repository 2026-09-01/02, GitHub fired four times in
// nine hours and nothing at all in the 22:00Z hour. Under the old exact-hour
// check that edition was silently lost. It is the first test here.

const assert = require('assert');
const S = require('../tools/slot-check');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok    ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n          ' + e.message); failed++; }
}

// decide() reads the real editions/current.json, so these tests drive the
// pieces it composes rather than stubbing the filesystem: mostRecentSlot and
// utcForLocalHour carry the logic that was wrong.
const at = (iso) => new Date(iso);

// America/Denver is UTC-6 in September (MDT).
check('06:00 Denver resolves to 12:00Z in September', () => {
  const ref = S.localParts(at('2026-09-02T18:00:00Z'));
  assert.strictEqual(S.utcForLocalHour(ref, 6).toISOString(), '2026-09-02T12:00:00.000Z');
});
check('16:00 Denver resolves to 22:00Z in September', () => {
  const ref = S.localParts(at('2026-09-01T23:00:00Z'));
  assert.strictEqual(S.utcForLocalHour(ref, 16).toISOString(), '2026-09-01T22:00:00.000Z');
});

// DST: Denver is UTC-7 (MST) in January. If this resolved by fixed offset it
// would be an hour out for half the year.
check('06:00 Denver resolves to 13:00Z in January -- DST handled by the tz database', () => {
  const ref = S.localParts(at('2027-01-15T18:00:00Z'));
  assert.strictEqual(S.utcForLocalHour(ref, 6).toISOString(), '2027-01-15T13:00:00.000Z');
});

check('the most recent slot at 17:03 Denver is 16:00 the same day', () => {
  const s = S.mostRecentSlot(at('2026-09-01T23:03:00Z'));   // 17:03 MDT
  assert.strictEqual(s.hour, 16);
  assert.strictEqual(s.at.toISOString(), '2026-09-01T22:00:00.000Z');
});

check('the most recent slot at 02:00 Denver is 16:00 the PREVIOUS day', () => {
  const s = S.mostRecentSlot(at('2026-09-02T08:00:00Z'));   // 02:00 MDT
  assert.strictEqual(s.hour, 16);
  assert.strictEqual(s.at.toISOString(), '2026-09-01T22:00:00.000Z');
});

// --- THE REGRESSION THIS FIX EXISTS FOR -------------------------------------
// 2026-09-01: firings at 20:38Z (14:38 MDT) and 23:03Z (17:03 MDT), nothing in
// between. The 16:00 slot boundary is 22:00Z. Under an exact-hour match the
// 23:03Z firing saw hour 17, no-op'd, and the edition was lost.
check('THE MISSED SLOT: a 17:03 firing still covers the 16:00 slot', () => {
  const now = at('2026-09-01T23:03:00Z');
  const s = S.mostRecentSlot(now);
  const ageH = (now - s.at) / 3600e3;
  assert.strictEqual(s.hour, 16, 'wrong slot');
  assert.ok(ageH > 1 && ageH <= 3, 'age ' + ageH.toFixed(2) + 'h should be inside a 3h window but outside hour 16');
});

check('a firing 4h after the slot is OUTSIDE the 3h window', () => {
  const now = at('2026-09-02T02:00:00Z');   // 20:00 MDT, 4h after the 16:00 slot
  const s = S.mostRecentSlot(now);
  assert.strictEqual(s.hour, 16);
  assert.ok((now - s.at) / 3600e3 > 3);
});

// --- idempotence: the half that stops a window publishing N times -----------
check('an edition generated AFTER the slot boundary covers it', () => {
  const slotAt = at('2026-09-01T22:00:00.000Z');
  const gen = at('2026-09-01T22:04:11.000Z');
  assert.ok(gen >= slotAt, 'a post-slot edition must count as covering the slot');
});
check('an edition generated BEFORE the slot boundary does not cover it', () => {
  const slotAt = at('2026-09-01T22:00:00.000Z');
  const gen = at('2026-09-01T12:03:00.000Z');   // that morning's edition
  assert.ok(!(gen >= slotAt), 'the morning edition must not suppress the afternoon slot');
});

// --- the live decision, whatever today happens to be ------------------------
check('decide() returns a boolean and a reason, and does not throw', () => {
  const d = S.decide(new Date());
  assert.strictEqual(typeof d.run, 'boolean');
  assert.ok(d.why && d.why.length > 10, 'a decision must explain itself');
  console.log('          (live: ' + (d.run ? 'RUN' : 'no-op') + ' -- ' + d.why + ')');
});

check('the cost ceiling is stated where the window is set', () => {
  const cfg = require('../lib/config').load();
  assert.strictEqual(cfg.schedule.windowHours, 3);
  const worst = cfg.schedule.windowHours * cfg.budget.maxCostUsdPerRun;
  assert.strictEqual(worst, 18, 'worst case per slot changed: $' + worst);
  console.log('          (worst case per slot: ' + cfg.schedule.windowHours + ' attempts x $' +
    cfg.budget.maxCostUsdPerRun.toFixed(2) + ' = $' + worst.toFixed(2) + ')');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
