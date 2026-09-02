#!/usr/bin/env node
'use strict';
// REQ-OPS-3 liveness tests.
//
// The first test is the hole this fix exists for. The previous heartbeat lived
// inline in the workflow and answered "no edition file? warning, exit 0" --
// which meant a pipeline that had never published looked healthy forever, and
// that was the live state on 2026-09-01/02. It was untestable where it lived;
// being able to write this assertion is the fix, and the changed verdict
// follows from it.

const assert = require('assert');
const { decide } = require('../tools/heartbeat-check');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok    ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n          ' + e.message); failed++; }
}

const at = (iso) => new Date(iso);
const cfg = (over = {}) => ({
  schedule: {
    slots: ['06:00', '16:00'],
    armedFrom: '2026-09-01T00:00:00Z',
    armedGraceHours: 24,
    missedSlotsBeforeError: 4,
    ...over,
  },
});
const ed = (iso) => ({ generatedAt: iso });

// --- THE HOLE -----------------------------------------------------------
check('THE HOLE: armed, no edition, past grace -> ERROR (was: warning, exit 0)', () => {
  const r = decide(cfg(), at('2026-09-02T06:00:00Z'), null);
  assert.strictEqual(r.status, 'error', r.detail);
  assert.ok(/NO EDITION HAS EVER BEEN PUBLISHED/.test(r.detail), r.detail);
});

check('armed, no edition, INSIDE grace -> warn, not error', () => {
  const r = decide(cfg(), at('2026-09-01T10:00:00Z'), null);
  assert.strictEqual(r.status, 'warn', r.detail);
});

check('grace covers the worst first-slot wait: armed 06:05, next slot 16:00, +3h window', () => {
  // Armed just after a morning slot; the earliest possible first edition is
  // the 16:00 slot, and the window allows until 19:00 -- about 13h.
  const c = cfg({ armedFrom: '2026-09-01T12:05:00Z' });
  const r = decide(c, at('2026-09-02T01:05:00Z'), null);   // 13h later
  assert.strictEqual(r.status, 'warn', 'a 13h-old arming must still be inside grace: ' + r.detail);
});

// --- not armed ----------------------------------------------------------
check('not armed yet -> ok, no edition expected', () => {
  const r = decide(cfg({ armedFrom: '2027-01-01T00:00:00Z' }), at('2026-09-02T06:00:00Z'), null);
  assert.strictEqual(r.status, 'ok');
});

check('armedFrom unset -> ok, AND the detail says the field must be set', () => {
  const r = decide(cfg({ armedFrom: undefined }), at('2026-09-02T06:00:00Z'), null);
  assert.strictEqual(r.status, 'ok');
  assert.ok(/set it when the pipeline goes live/.test(r.detail),
    'an unset field is the old hole in a new place and must say so: ' + r.detail);
});

// --- staleness ----------------------------------------------------------
check('a fresh edition -> ok', () => {
  const r = decide(cfg(), at('2026-09-02T06:00:00Z'), ed('2026-09-02T00:00:00Z'));
  assert.strictEqual(r.status, 'ok', r.detail);
});

check('an edition 49h old -> ERROR at the 48h threshold', () => {
  const r = decide(cfg(), at('2026-09-03T06:00:00Z'), ed('2026-09-01T05:00:00Z'));
  assert.strictEqual(r.status, 'error', r.detail);
  assert.ok(/49\.0h old/.test(r.detail), r.detail);
});

check('an edition 47h old -> still ok, so the boundary is not off by one', () => {
  const r = decide(cfg(), at('2026-09-03T06:00:00Z'), ed('2026-09-01T07:00:00Z'));
  assert.strictEqual(r.status, 'ok', r.detail);
});

check('the threshold follows the SLOT COUNT, not a hardcoded 48', () => {
  // Four slots a day -> 4 missed slots is 24h, not 48h.
  const c = cfg({ slots: ['06:00', '11:00', '16:00', '21:00'] });
  const r = decide(c, at('2026-09-03T06:00:00Z'), ed('2026-09-02T04:00:00Z'));   // 26h
  assert.strictEqual(r.status, 'error', 'at 4 slots/day, 26h is past a 24h threshold: ' + r.detail);
  assert.ok(/threshold 24h/.test(r.detail), r.detail);
});

check('an unreadable generatedAt is an ERROR, not a silent pass', () => {
  const r = decide(cfg(), at('2026-09-02T06:00:00Z'), ed('not a date'));
  assert.strictEqual(r.status, 'error', r.detail);
});

// --- the live config ----------------------------------------------------
check('the shipped config arms the pipeline and would flag today', () => {
  const live = require('../lib/config').load();
  assert.ok(live.schedule.armedFrom, 'armedFrom must be set now that the pipeline is live');
  const r = decide(live, new Date(), null);
  console.log('          (with no edition, live config says: ' + r.status.toUpperCase() + ')');
  assert.notStrictEqual(r.status, 'ok', 'an armed pipeline with no edition must not read as ok');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
