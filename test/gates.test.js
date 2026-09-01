#!/usr/bin/env node
'use strict';
// Gate tests against the GOLDEN FIXTURE -- the complete gate-passing edition
// supplied with open-wire-spec.md v1.0, captured from a live run on
// 2026-08-30 with every URL resolving at capture time.
//
// This is the closest thing to running the pipeline that exists without an
// API key: the gates are exercised against real data whose expected verdicts
// the handoff states independently (EXAMPLE-CALL.md, "use it as the input to
// your gate tests"). Each gate is also driven to FAIL on a mutated copy,
// because a gate that has only ever passed has not been tested.
//
//   node test/gates.test.js              gates, offline
//   node test/gates.test.js --network    also run REQ-GATE-2 for real

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { load } = require('../lib/config');
const { canonicalUrl, itemId } = require('../lib/canonical');
const G = require('../lib/gates');

const NETWORK = process.argv.includes('--network');
const cfg = load();
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'golden-current.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(golden));
const now = new Date(golden.generatedAt);

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok    ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n          ' + e.message); failed++; }
}

console.log('Golden fixture: ' + golden.editionId + ', ' + golden.itemCount + ' items\n');

// --- the canonicalizer, pinned to the fixture's own ids ---------------------
check('every item id reproduces from its url (85/85)', () => {
  const items = G.allItems(golden);
  const hits = items.filter((it) => itemId(it.url) === it.id).length;
  assert.strictEqual(hits, items.length, hits + '/' + items.length + ' ids reproduce');
});

check('canonicalUrl strips tracking, www and trailing slash', () => {
  assert.strictEqual(canonicalUrl('http://www.reuters.com/world/x/?utm_source=a&id=7'), 'https://reuters.com/world/x/?id=7');
  assert.strictEqual(canonicalUrl('https://apnews.com/article/y/'), 'https://apnews.com/article/y');
  assert.strictEqual(canonicalUrl('https://npr.org/a?fbclid=z'), 'https://npr.org/a');
});

// --- the golden edition against every offline gate --------------------------
//
// THE HANDOFF CALLS THIS FIXTURE "a complete, gate-passing edition" AND ITS
// OWN runReport RECORDS TEN PASSES. Five of the seven offline gates agree.
// TWO DO NOT, and the tests below assert the MEASURED result rather than the
// claimed one. Both discrepancies are in the supplied handoff, not in this
// implementation, and neither gate was loosened to make them go away.
check('gates 1,3,4,5,9 pass the golden edition', () => {
  const got = {
    'REQ-GATE-1': G.gate1(golden, cfg).status,
    'REQ-GATE-3': G.gate3(golden, cfg).status,
    'REQ-GATE-4': G.gate4(golden, cfg).status,
    'REQ-GATE-5': G.gate5(golden).status,
    'REQ-GATE-9': G.gate9(3.42, cfg).status,
  };
  assert.deepStrictEqual(got, {
    'REQ-GATE-1': 'pass', 'REQ-GATE-3': 'pass', 'REQ-GATE-4': 'pass',
    'REQ-GATE-5': 'pass', 'REQ-GATE-9': 'pass',
  }, JSON.stringify(got));
});

// DISCREPANCY 1 -- REQ-GATE-6. The fixture's runReport claims 0.91 inside the
// window. Its 45 non-Utah items are dated 08-29 (15), 08-28 (22), 08-27 (7),
// 08-24 (1) against a generatedAt of 2026-08-30T22:12Z and a 24h window.
// Nothing reproduces 0.91: a 24h window yields 0.33, 72h yields 0.98, 3d
// yields 0.82. THE CLAIMED FIGURE IS NOT DERIVABLE FROM THE FIXTURE'S OWN
// ITEMS under any reading of the configured window.
check('DISCREPANCY: golden edition FAILS REQ-GATE-6 at 0.33, not the 0.91 its report claims', () => {
  const r = G.gate6(golden, cfg, now);
  assert.strictEqual(r.status, 'fail', 'expected the documented failure; got ' + r.status);
  assert.ok(/^0\.33 /.test(r.detail), r.detail);
  assert.strictEqual(golden.runReport.checks.find((c) => c.id === 'REQ-GATE-6').status, 'pass',
    'the fixture no longer claims a pass -- re-check this test');
});

// DISCREPANCY 2 -- REQ-GATE-8. wire.config.yaml sets whyMaxChars: 500 and four
// fixture items carry why lines of 501, 504, 524 and 528 characters. The
// config is the source of truth under REQ-CFG-1, so the gate fails and the
// bound is NOT raised to accommodate the fixture.
check('DISCREPANCY: golden edition FAILS REQ-GATE-8 -- 4 why lines exceed whyMaxChars 500', () => {
  const r = G.gate8(golden, cfg);
  assert.strictEqual(r.status, 'fail', 'expected the documented failure; got ' + r.status);
  assert.ok(/^4 field error/.test(r.detail), r.detail);
  const over = G.allItems(golden).filter((i) => i.why.length > cfg.gates.whyMaxChars).map((i) => i.why.length);
  assert.deepStrictEqual(over.sort((a, b) => a - b), [501, 504, 524, 528]);
});

// --- and each gate can be driven to fail ------------------------------------
check('REQ-GATE-1 fails on a bad kind', () => {
  const e = clone(); e.groups[0].sections[0].items[0].kind = 'opinion';
  assert.strictEqual(G.gate1(e, cfg).status, 'fail');
});
check('REQ-GATE-1 fails when itemCount disagrees with the tree', () => {
  const e = clone(); e.itemCount = 99;
  assert.strictEqual(G.gate1(e, cfg).status, 'fail');
});
check('REQ-GATE-3 fails on a deny-listed host', () => {
  const e = clone(); e.groups[0].sections[0].items[0].url = 'https://www.nytimes.com/2026/08/30/x.html';
  assert.strictEqual(G.gate3(e, cfg).status, 'fail');
});
check('REQ-GATE-3 catches a SUBDOMAIN of a denied host', () => {
  const e = clone(); e.groups[0].sections[0].items[0].url = 'https://cooking.nytimes.com/x';
  assert.strictEqual(G.gate3(e, cfg).status, 'fail');
});
check('REQ-GATE-4 fails when a topic is under its floor', () => {
  const e = clone(); e.groups[0].sections[0].items = e.groups[0].sections[0].items.slice(0, 1);
  assert.strictEqual(G.gate4(e, cfg).status, 'fail');
});
check('REQ-GATE-5 fails on a duplicate url across sections', () => {
  const e = clone();
  const dup = JSON.parse(JSON.stringify(e.groups[0].sections[0].items[0]));
  e.groups[0].sections[1].items.push(dup);
  assert.strictEqual(G.gate5(e).status, 'fail');
});
check('REQ-GATE-6 fails when items fall outside the window', () => {
  const e = clone();
  for (const g of e.groups) for (const s of g.sections) for (const it of s.items) it.publishedDate = '2020-01-01';
  assert.strictEqual(G.gate6(e, cfg, now).status, 'fail');
});
check('REQ-GATE-8 fails on an empty why', () => {
  const e = clone(); e.groups[0].sections[0].items[0].why = '   ';
  assert.strictEqual(G.gate8(e, cfg).status, 'fail');
});
check('REQ-GATE-8 fails on model preamble in a brief', () => {
  const e = clone(); e.groups[0].sections[0].items[0].brief = "Here's a summary of the article you asked about.";
  assert.strictEqual(G.gate8(e, cfg).status, 'fail');
});
check('REQ-GATE-8 fails on a refusal in a why line', () => {
  const e = clone(); e.groups[0].sections[0].items[0].why = 'I cannot provide analysis on this topic.';
  assert.strictEqual(G.gate8(e, cfg).status, 'fail');
});
check('REQ-GATE-9 fails above the run ceiling', () => {
  assert.strictEqual(G.gate9(6.01, cfg).status, 'fail');
  assert.strictEqual(G.gate9(6.00, cfg).status, 'pass');
});

// --- REQ-GATE-7 is warn-only and must never block ---------------------------
check('REQ-GATE-7 warns rather than fails when the ceiling is exceeded', () => {
  const r = G.gate7(golden, cfg, golden); // 100% carry-over against itself
  assert.strictEqual(r.status, 'warn', 'got ' + r.status);
});

// --- the orchestration: fail-closed, warn-open ------------------------------
//
// A REPAIRED copy of the golden edition is used for the end-to-end run: the
// two discrepancies above are corrected IN THE FIXTURE COPY, not in the gates,
// so the orchestration is exercised against data that genuinely passes.
function repaired() {
  const e = clone();
  for (const g of e.groups) for (const s of g.sections) for (const it of s.items) {
    if (it.why.length > cfg.gates.whyMaxChars) it.why = it.why.slice(0, cfg.gates.whyMaxChars - 1).trim();
    it.publishedDate = '2026-08-30';   // inside a 24h window from generatedAt
  }
  return e;
}

(async () => {
  const fixed = repaired();
  const r1 = await G.runGates(fixed, cfg, { previous: fixed, costUsd: 3.42, now, skipNetwork: !NETWORK });
  check('a repaired golden edition passes the full run, REQ-GATE-7 warning included', () => {
    assert.strictEqual(r1.checks.find((c) => c.id === 'REQ-GATE-7').status, 'warn');
    assert.strictEqual(r1.gatesPassed, true, JSON.stringify(r1.checks.filter((c) => c.status === 'fail')));
  });
  check('REQ-GATE-10 is reported as deferred, not silently omitted', () => {
    assert.strictEqual(r1.checks.find((c) => c.id === 'REQ-GATE-10').status, 'deferred');
  });
  check('a warn-level gate does not block publication', () => {
    assert.ok(r1.checks.some((c) => c.status === 'warn'));
    assert.strictEqual(r1.gatesPassed, true);
  });

  // The UNREPAIRED golden edition must fail the run -- fail-closed, on real data.
  const r0 = await G.runGates(golden, cfg, { previous: null, costUsd: 3.42, now, skipNetwork: true });
  check('the AS-SUPPLIED golden edition fails the run at REQ-GATE-6', () => {
    assert.strictEqual(r0.gatesPassed, false);
    assert.strictEqual(r0.checks[r0.checks.length - 1].id, 'REQ-GATE-6');
  });

  const bad = repaired(); bad.groups[0].sections[0].items[0].url = 'https://wsj.com/x';
  const r2 = await G.runGates(bad, cfg, { costUsd: 0, now, skipNetwork: true });
  check('a deny-list hit fails the run and stops before later gates', () => {
    assert.strictEqual(r2.gatesPassed, false);
    assert.ok(!r2.checks.some((c) => c.id === 'REQ-GATE-8'), 'cheapest-first ordering not honoured');
  });

  const costly = repaired();
  const r4 = await G.runGates(costly, cfg, { costUsd: 99, now, skipNetwork: true });
  check('REQ-GATE-9 blocks a run over the cost ceiling', () => {
    assert.strictEqual(r4.gatesPassed, false);
    assert.strictEqual(r4.checks.find((c) => c.id === 'REQ-GATE-9').status, 'fail');
  });

  if (NETWORK) {
    const r3 = await G.gate2(golden, cfg, globalThis.fetch);
    console.log('\n  REQ-GATE-2 (live): ' + r3.status + ' -- ' + r3.detail);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
