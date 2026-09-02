#!/usr/bin/env node
'use strict';
// REQ-OPS-3's liveness check, as a testable function.
//
// WHY THIS IS A SCRIPT AND NOT FOUR LINES OF SHELL. The previous version lived
// inline in heartbeat.yml and read:
//
//     if [ ! -f editions/current.json ]; then
//       echo "::warning::no edition has been published yet"; exit 0
//     fi
//
// A pipeline that had NEVER produced a first edition warned and passed,
// indefinitely -- and that was the state actually in force: armed 2026-09-01,
// zero editions, and the control built to notice could not. The hole was in a
// branch nothing could test, so moving the logic here IS the fix; the changed
// verdict is a consequence of being able to test it.
//
// THE DISTINCTION THAT MATTERS. This control was never CROSSED. It was
// configured to look where the failure was not. RULE-10 asks how a control can
// be crossed and does not reach that, so what this file owes instead is an
// honest statement of WHAT IT STILL CANNOT SEE -- see the bottom of this file.

const fs = require('fs');
const path = require('path');
const { load } = require('../lib/config');

// A pipeline is only delinquent for producing nothing if it was expected to
// produce. `armedFrom` is that expectation, declared rather than inferred:
// there is no reliable signal inside a workflow for "when did this become
// live", and guessing one would be another control looking in the wrong place.
function decide(cfg, now, edition) {
  const slots = (cfg.schedule.slots || []).length || 2;
  const missed = cfg.schedule.missedSlotsBeforeError === undefined ? 4 : Number(cfg.schedule.missedSlotsBeforeError);
  const staleHours = missed * (24 / slots);
  const graceHours = cfg.schedule.armedGraceHours === undefined ? 24 : Number(cfg.schedule.armedGraceHours);

  const armedFrom = cfg.schedule.armedFrom ? new Date(cfg.schedule.armedFrom) : null;
  const armed = armedFrom && !Number.isNaN(armedFrom.getTime()) && armedFrom <= now;

  if (!armed) {
    return {
      status: 'ok',
      detail: armedFrom
        ? 'not armed until ' + cfg.schedule.armedFrom + ' -- no edition expected yet'
        : 'schedule.armedFrom is not set, so no edition is expected; set it when the pipeline goes live',
    };
  }

  const armedHours = (now - armedFrom) / 3600e3;

  if (!edition) {
    // THE HOLE THIS FIX EXISTS FOR. Armed and producing nothing is a failure,
    // not a note -- after a grace period long enough to cover the wait for a
    // first slot plus its window.
    if (armedHours <= graceHours) {
      return { status: 'warn', detail: 'armed ' + armedHours.toFixed(1) + 'h ago and no edition yet; ' +
        'inside the ' + graceHours + 'h grace for a first slot' };
    }
    return { status: 'error', detail: 'ARMED ' + armedHours.toFixed(1) + 'h AGO AND NO EDITION HAS EVER BEEN ' +
      'PUBLISHED -- past the ' + graceHours + 'h grace. The pipeline is live and producing nothing.' };
  }

  const gen = new Date(edition.generatedAt);
  if (Number.isNaN(gen.getTime())) {
    return { status: 'error', detail: 'current.json has an unreadable generatedAt: ' + edition.generatedAt };
  }
  const ageHours = (now - gen) / 3600e3;
  if (ageHours > staleHours) {
    return { status: 'error', detail: 'latest edition is ' + ageHours.toFixed(1) + 'h old; ' + missed +
      ' or more scheduled slots have produced nothing (threshold ' + staleHours + 'h)' };
  }
  return { status: 'ok', detail: 'latest edition ' + ageHours.toFixed(1) + 'h old, inside the ' + staleHours + 'h threshold' };
}

function readEdition() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'editions', 'current.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

module.exports = { decide };

if (require.main === module) {
  const cfg = load();
  const r = decide(cfg, new Date(), readEdition());
  const line = 'heartbeat: ' + r.status.toUpperCase() + ' -- ' + r.detail;
  if (r.status === 'error') { console.log('::error::' + r.detail); console.error(line); process.exit(1); }
  if (r.status === 'warn') { console.log('::warning::' + r.detail); }
  console.error(line);
}

// WHAT THIS CONTROL STILL CANNOT SEE, stated because the last version's defect
// was exactly an unstated blind spot:
//
//   - It cannot see an edition that published but is WRONG. It checks
//     existence and age, never content. The closing gates do that, per run.
//   - It cannot see a slot missed WITHIN the threshold: at 4 missed slots,
//     up to two days of silence read as healthy.
//   - It cannot detect its OWN failure to run. A disabled or broken heartbeat
//     is silent in exactly the way it exists to prevent, and nothing here
//     closes that -- it needs a watcher outside this repository.
//   - `armedFrom` is DECLARED, not observed. If the pipeline is disarmed and
//     the field is not updated, this reports a failure that is a policy
//     change; if it is armed and the field is not set, this reports OK
//     forever, which is the old hole in a new place.
