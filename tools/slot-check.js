#!/usr/bin/env node
'use strict';
// REQ-OPS-1's other half: decide whether this hourly firing should generate.
//
// WHY THIS IS A WINDOW AND NOT AN HOUR MATCH. The first version asked "is the
// local hour exactly 06 or 16?" and no-op'd otherwise. That converts a DELAY
// INTO A SKIP: open-wire-spec.md section 3.2 warns that GitHub `schedule`
// triggers are "best-effort and frequently delayed, occasionally by 15+
// minutes and occasionally skipped entirely under platform load", and MEASURED
// 2026-09-01/02 this repository saw FOUR firings in nine hours -- nothing at
// all in the 22:00Z hour, which is the 16:00 America/Denver slot. That edition
// was not late; it never happened. With a twice-daily cron a delayed run still
// runs; with an exact-hour match a delayed run no-ops and the edition is lost.
//
// SO: run if we are INSIDE THE WINDOW after a slot AND that slot has not
// already produced an edition. The second half is what stops a window from
// publishing the same slot repeatedly -- a window without idempotence is N
// editions and N times the API spend, which is worse than the bug it fixes.
//
// COST BOUND, STATED BECAUSE IT IS REAL. The cron is hourly, so the window
// length IS the maximum number of attempts for one slot. A run that fails its
// gates commits nothing, so the next hour inside the window retries it -- good
// for a transient failure, expensive for a persistent one. WORST CASE PER SLOT
// IS windowHours x budget.maxCostUsdPerRun. At the shipped 3 and $6.00 that is
// $18. Widening the window widens that ceiling; the config says so.
//
// Writes a GITHUB_OUTPUT line and prints its reasoning to stderr, so the
// decision is legible in the run log even when the answer is no-op.

const fs = require('fs');
const path = require('path');
const { load } = require('../lib/config');

const cfg = load();
const TZ = cfg.schedule.timezone;
const slots = cfg.schedule.slots.map((s) => Number(String(s).split(':')[0])).sort((a, b) => a - b);
const windowHours = (cfg.schedule.windowHours === undefined) ? 3 : Number(cfg.schedule.windowHours);

// Local wall-clock parts for an instant, via the timezone database -- so DST
// is handled by the platform rather than by arithmetic anyone has to maintain.
function localParts(d) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: +p.year, m: +p.month, d: +p.day, h: +(p.hour === '24' ? '0' : p.hour), min: +p.minute };
}

// The UTC instant of a given local wall-clock hour on a given local date.
// Found by search rather than by offset arithmetic: try each candidate hour
// and keep the one whose local rendering matches. Correct across DST, where a
// local hour can be absent or repeated.
function utcForLocalHour(refDate, hour) {
  const { y, m, d } = refDate;
  for (let guess = 0; guess < 48; guess++) {
    const t = new Date(Date.UTC(y, m - 1, d, guess, 0, 0));
    const lp = localParts(t);
    if (lp.y === y && lp.m === m && lp.d === d && lp.h === hour) return t;
  }
  return null;
}

// The most recent slot boundary at or before `now`, walking back through today
// then yesterday.
function mostRecentSlot(now) {
  const here = localParts(now);
  for (let dayBack = 0; dayBack <= 1; dayBack++) {
    const ref = localParts(new Date(now.getTime() - dayBack * 86400e3));
    for (const h of [...slots].reverse()) {
      const t = utcForLocalHour(ref, h);
      if (t && t <= now) return { at: t, hour: h, local: ref };
    }
  }
  return null;
}

function currentEditionGeneratedAt() {
  try {
    const p = path.join(__dirname, '..', 'editions', 'current.json');
    const ed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = new Date(ed.generatedAt);
    return Number.isNaN(t.getTime()) ? null : t;
  } catch (e) {
    return null;   // no edition yet, or unreadable -- either way, nothing covers the slot
  }
}

function decide(now) {
  const slot = mostRecentSlot(now);
  if (!slot) return { run: false, why: 'no slot boundary found' };

  const ageMs = now - slot.at;
  if (ageMs > windowHours * 3600e3) {
    return { run: false, why: 'outside the window -- last slot ' + slot.hour + ':00 was ' +
      (ageMs / 3600e3).toFixed(1) + 'h ago, window is ' + windowHours + 'h' };
  }

  const gen = currentEditionGeneratedAt();
  if (gen && gen >= slot.at) {
    return { run: false, why: 'slot ' + slot.hour + ':00 already covered -- current edition generated ' +
      gen.toISOString() + ', slot boundary ' + slot.at.toISOString() };
  }

  return { run: true, why: 'inside the ' + windowHours + 'h window after the ' + slot.hour + ':00 ' + TZ +
    ' slot (' + (ageMs / 3600e3).toFixed(1) + 'h in), and ' +
    (gen ? 'the current edition predates it (' + gen.toISOString() + ')' : 'no edition exists yet') };
}

module.exports = { decide, mostRecentSlot, localParts, utcForLocalHour };

if (require.main === module) {
  const now = new Date();
  const d = decide(now);
  process.stderr.write('slot-check: ' + now.toISOString() + ' -> ' + (d.run ? 'RUN' : 'no-op') + '\n');
  process.stderr.write('  ' + d.why + '\n');
  process.stdout.write('run=' + d.run + '\n');
}
