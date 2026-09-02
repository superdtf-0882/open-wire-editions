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
// produce. That expectation is ANCHORED ON THE P-07 APPROVAL rather than on a
// field kept for this control's benefit.
//
// WHY DERIVED AND NOT DECLARED. The first version read schedule.armedFrom and
// returned `ok` when it was unset -- which DTOG measured as FAILING OPEN: the
// hole it replaced returned `warn` and passed, and this returned `ok` and
// passed, ONE NOTCH QUIETER THAN WHAT IT REPLACED. Deriving from
// manifest.yaml's `approval.approvedOn` fixes that in three ways DTOG named:
//
//   1. The anchor is maintained by an obligation with an INDEPENDENT reason to
//      be right. A field existing only to feed one control decays the moment
//      that control is boring; approvedOn is P-07 evidence with a corpus
//      record behind it.
//   2. It converts fail-open to FAIL-CLOSED. No approval means not approved
//      means generate.js exits 3 -- the pipeline CANNOT be armed. "No anchor"
//      and "not armed" stop being two states this control conflates.
//   3. It errs in the safe direction. Approval is the EARLIEST possible
//      arming, so the anchor can only be too early and the control can only
//      fire sooner, never later. For a control whose subject is silence, early
//      is the correct direction to be wrong in.
//
// BEHAVIOUR CHANGE, landed knowingly rather than discovered on a Monday:
// APPROVAL DOES NOT IMPLY ARMED. If the prompt is approved and the secret is
// not wired for a week, this raises. DTOG's read, adopted: that is the control
// WORKING -- an approved pipeline producing nothing is exactly what REQ-OPS-3
// exists to surface, and whether the gap is a secret or a schedule is the
// operator's to discover.
//
// schedule.armedFrom is still honoured as an OVERRIDE when set, for a pipeline
// armed later than its approval; it can only move the anchor forward.
function armedAnchor(cfg, manifest) {
  const approved = manifest && manifest.approval && manifest.approval.approvedOn;
  const declared = cfg.schedule.armedFrom;
  const dates = [approved, declared]
    .map((d) => (d ? new Date(d) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()));
  if (!dates.length) return { at: null, source: 'none' };
  // The LATER of the two: a declared override can delay arming past approval,
  // never precede it.
  const at = dates.reduce((a, b) => (a > b ? a : b));
  return {
    at,
    source: dates.length === 2 ? 'approval+override' : (approved ? 'P-07 approval' : 'declared override'),
  };
}

function decide(cfg, now, edition, manifest) {
  const slots = (cfg.schedule.slots || []).length || 2;
  const missed = cfg.schedule.missedSlotsBeforeError === undefined ? 4 : Number(cfg.schedule.missedSlotsBeforeError);
  const staleHours = missed * (24 / slots);
  const graceHours = cfg.schedule.armedGraceHours === undefined ? 24 : Number(cfg.schedule.armedGraceHours);

  const anchor = armedAnchor(cfg, manifest);
  const armedFrom = anchor.at;

  // NO ANCHOR IS NOT "HEALTHY". Without a P-07 approval the pipeline cannot
  // run at all -- generate.js exits 3 -- so this state means the control has
  // nothing to measure against, which is a fact about the CONTROL and is
  // reported as such rather than as a clean bill. The old version returned
  // `ok` here and that was the fail-open DTOG found.
  if (!armedFrom) {
    return { status: 'warn', detail: 'NO ARMING ANCHOR: manifest.yaml carries no approval.approvedOn ' +
      'and schedule.armedFrom is unset. Publication cannot be assessed, and generate.js would refuse ' +
      'anyway for want of the same approval.' };
  }
  if (armedFrom > now) {
    return { status: 'ok', detail: 'not armed until ' + armedFrom.toISOString() +
      ' (' + anchor.source + ') -- no edition expected yet' };
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
    // DT2 49- section 4: a KNOWN red owes the date it stops being known.
    // Alarm fatigue is defeated by giving the alarm a terminal condition, not
    // by trusting a practice to keep looking. Past knownRedSlots the message
    // changes from 'waiting for the first run' to 'the pipeline does not
    // produce', which is a defect investigation rather than a status.
    const knownRedSlots = cfg.schedule.knownRedSlots === undefined ? 2 : Number(cfg.schedule.knownRedSlots);
    const slotsElapsed = Math.floor(armedHours / (24 / slots));
    if (slotsElapsed > knownRedSlots + (graceHours / (24 / slots))) {
      return { status: 'error', expired: true, detail: 'ARMED ' + armedHours.toFixed(1) + 'h AGO, ' +
        slotsElapsed + ' SCHEDULED SLOTS ELAPSED, AND NO EDITION HAS EVER BEEN PUBLISHED. This is past ' +
        'the known-red window of ' + knownRedSlots + ' slots beyond grace: it is NO LONGER "waiting for ' +
        'the first run" and IS "the pipeline does not produce". Treat as a defect investigation.' };
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

function readManifest() {
  try { return require('../lib/prompts').manifest(); } catch (e) { return null; }
}

module.exports = { decide, armedAnchor, readManifest };

if (require.main === module) {
  const cfg = load();
  const r = decide(cfg, new Date(), readEdition(), readManifest());
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
//   - The anchor is the P-07 APPROVAL, so APPROVAL DOES NOT IMPLY ARMED: an
//     approved pipeline whose secret is not wired raises here, which is the
//     control working rather than a false positive, but it does mean this
//     cannot distinguish 'not wired' from 'wired and broken'.
//   - schedule.armedFrom can still DELAY the anchor. A stale override reports
//     healthy for as long as it points at the future -- a smaller hole than
//     the unset-field one it replaced, but the same shape, and the only
//     remaining place a maintained value can lie to this control.
