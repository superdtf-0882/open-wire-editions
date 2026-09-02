#!/usr/bin/env node
'use strict';
// Pre-flight cost tests. REQ-GATE-9 measures what a run COST; this asks the
// same question before the money moves. It exists because pinning Opus 5
// against a $6.00 ceiling would have spent ~$7.56 per run and published
// nothing, up to three times per slot inside the window.

const assert = require('assert');
const { preflightCost, estimateCost, REFERENCE_RUN } = require('../lib/anthropic');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok    ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n          ' + e.message); failed++; }
}
const cfg = (model, ceiling) => ({ model: { id: model }, budget: { maxCostUsdPerRun: ceiling } });

check('REFUSES a model that cannot fit the ceiling', () => {
  const r = preflightCost(cfg('claude-opus-5', 6));
  assert.strictEqual(r.ok, false);
  assert.ok(/EVERY RUN WOULD SPEND AND THEN BE REJECTED/.test(r.detail), r.detail);
});

check('and names both remedies, since both are owner decisions', () => {
  const r = preflightCost(cfg('claude-opus-5', 6));
  assert.ok(/Raise budget.maxCostUsdPerRun or pin a cheaper model/.test(r.detail), r.detail);
});

check('passes a model that fits', () => {
  assert.strictEqual(preflightCost(cfg('claude-sonnet-5', 6)).ok, true);
});

check('WARNS inside 20% of the ceiling -- one measurement is not a distribution', () => {
  const cost = estimateCost('claude-opus-5', REFERENCE_RUN.tokens, REFERENCE_RUN.searches);
  const r = preflightCost(cfg('claude-opus-5', cost * 1.1));   // 10% headroom
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warn, true, 'a 10% margin must warn: ' + r.detail);
});

check('does not warn with comfortable headroom', () => {
  const cost = estimateCost('claude-opus-5', REFERENCE_RUN.tokens, REFERENCE_RUN.searches);
  const r = preflightCost(cfg('claude-opus-5', cost * 2));
  assert.ok(!r.warn, r.detail);
});

check('an unpriced model does not block -- it defers to REQ-GATE-9 and says so', () => {
  const r = preflightCost(cfg('some-future-model', 6));
  assert.strictEqual(r.ok, true);
  assert.ok(/cannot pre-flight/.test(r.detail), r.detail);
});

check('the shipped config is the case this check exists for', () => {
  const live = require('../lib/config').load();
  const r = preflightCost(live);
  console.log('          (live: ' + live.model.id + ' -> ' + (r.ok ? 'ok' : 'REFUSE') + ')');
  assert.strictEqual(live.model.id, 'claude-opus-5', 'model should be pinned to Opus 5');
  assert.strictEqual(r.ok, false, 'with the ceiling unchanged this must refuse rather than spend');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
