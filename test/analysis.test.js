#!/usr/bin/env node
'use strict';
// WIRE-SPEC-A1 tests: the prompt artifacts (A1-014..A1-017), the S4 response
// contract (A1-003/A1-004), and the deterministic S5 gates (G-A1.1..G-A1.3).
//
// The golden set is 85 REAL ACCEPTED LINES from a live run, so "do the gates
// reject lines a human accepted" is answered against real data rather than
// against invented examples. That is the eval A1-018 runs in CI.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const P = require('../lib/prompts');
const A = require('../lib/analysis-gates');

const golden = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'wire', 'evals', 'golden', 'edition-2026-08-30.json'), 'utf8'));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok    ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n          ' + e.message); failed++; }
}

// --- A1-014: no prompt text in application source ---------------------------
check('A1-014: no prompt string literal survives in lib/', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'lib'))) {
    // Comments are stripped FIRST. Prose comments in this codebase quote field
    // names in backticks, and a naive scan pairs those across hundreds of
    // characters -- which is how this test first failed, on itself.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/`([^`]{400,})`/g)) {
      assert.fail(f + ' carries a ' + m[1].length + '-char template literal -- prompt text belongs in prompts/wire/');
    }
  }
});

check('A1-014: every manifest stage points at a file that exists', () => {
  const m = P.manifest();
  for (const [name, s] of Object.entries(m.stages)) {
    const st = P.loadStage(name);
    assert.ok(st.task.length > 200, name + ' task prompt is suspiciously short');
    if (s.profile) assert.ok(st.profile.length > 200, name + ' profile did not load');
  }
});

// --- A1-015: the manifest is the single point of model selection ------------
check('A1-015: every stage binds a file, a model and a semantic version', () => {
  const m = P.manifest();
  for (const [name, s] of Object.entries(m.stages)) {
    assert.ok(s.prompt, name + ' has no prompt file');
    assert.ok(s.model, name + ' has no model');
    assert.ok(/^\d+\.\d+\.\d+$/.test(s.version), name + ' version "' + s.version + '" is not semver');
  }
});

check('A1-015: the live stage model agrees with wire.config.yaml', () => {
  const cfg = require('../lib/config').load();
  const live = P.loadStage('combined');
  assert.strictEqual(cfg.model.id, live.model,
    'wire.config.yaml pins ' + cfg.model.id + ' but the manifest says ' + live.model +
    ' -- two sources of truth for model selection');
});

check('AD A1.6: extraction and judge use a small model, analysis a frontier model', () => {
  const m = P.manifest();
  assert.notStrictEqual(m.stages.analyse.model, m.stages.extract.model);
  assert.strictEqual(m.stages.extract.model, m.stages.judge.model);
});

// --- A1-017 / section 7: the cache prefix and the word cap ------------------
check('A1-017: the cache prefix is profile-then-task and its key is a content hash', () => {
  const s = P.loadStage('analyse');
  assert.ok(s.prefix.indexOf(s.profile) < s.prefix.indexOf(s.task), 'profile must precede task');
  assert.ok(/^[0-9a-f]{16}$/.test(s.cacheKey), s.cacheKey);
  const again = P.loadStage('analyse');
  assert.strictEqual(s.cacheKey, again.cacheKey, 'cache key is not stable across loads');
});

check('section 7: the analyst profile is inside its 1,200-word cap', () => {
  const n = P.wordCount(P.loadStage('analyse').profile);
  assert.ok(n <= P.PROFILE_WORD_CAP, n + ' words, over the cap');
  console.log('          (profile is ' + n + ' words of ' + P.PROFILE_WORD_CAP + ')');
});

check('section 7: an over-long profile REFUSES rather than warning', () => {
  const p = path.join(P.DIR, 'analyst-profile.md');
  const original = fs.readFileSync(p, 'utf8');
  try {
    fs.writeFileSync(p, original + '\n\n' + 'padding '.repeat(1300));
    assert.throws(() => P.loadStage('analyse'), /over the 1200-word cap/);
  } finally { fs.writeFileSync(p, original); }
});

// --- A1-003 / A1-004: the S4 response contract, AD A1.3's control -----------
const ids = golden.items.slice(0, 3).map((i) => i.id);
const good = ids.map((id) => ({ id, w: 'x' }));

check('A1-003: a well-formed response is accepted', () => {
  assert.strictEqual(A.validateResponse(good, ids).ok, true);
});
check('A1-003: an unknown id fails the stage', () => {
  assert.strictEqual(A.validateResponse([...good, { id: 'deadbeef', w: 'x' }], ids).ok, false);
});
check('A1-003: an omitted id fails the stage', () => {
  assert.strictEqual(A.validateResponse(good.slice(0, 2), ids).ok, false);
});
check('A1-004: a response carrying any item field is REFUSED -- the load-bearing control', () => {
  const r = A.validateResponse(ids.map((id) => ({ id, w: 'x', headline: 'rewritten' })), ids);
  assert.strictEqual(r.ok, false);
  assert.ok(/fields other than id and w/.test(r.detail), r.detail);
});

// --- G-A1.1 / G-A1.2 / G-A1.3 ----------------------------------------------
const lexicon = P.fillerLexicon();
check('G-A1.1 catches every phrase in the lexicon', () => {
  for (const phrase of lexicon) {
    const r = A.gA1_1('Some text that ' + phrase + ' and continues.', lexicon);
    assert.strictEqual(r.status, 'fail', 'missed: ' + phrase);
  }
});
check('G-A1.1 is case-insensitive', () => {
  assert.strictEqual(A.gA1_1('It REMAINS TO BE SEEN whether.', lexicon).status, 'fail');
});
check('A1-005 bounds come from config, not from a code literal -- REQ-CFG-1', () => {
  const cfg = require('../lib/config').load();
  assert.ok(cfg.gates.whyWords, 'wire.config.yaml carries no gates.whyWords');
  assert.strictEqual(cfg.gates.whyWords.min, 24, 'floor is not the ruled 24');
  const b = { minWords: cfg.gates.whyWords.min, maxWords: cfg.gates.whyWords.max, maxSentences: cfg.gates.whyWords.maxSentences };
  assert.strictEqual(A.gA1_2(Array(24).fill('word').join(' '), b).status, 'pass', '24 words must pass the ruled floor');
  assert.strictEqual(A.gA1_2(Array(23).fill('word').join(' '), b).status, 'fail', '23 must still fail');
});
check('G-A1.2 bounds words and sentences', () => {
  assert.strictEqual(A.gA1_2('Too short.').status, 'fail');
  assert.strictEqual(A.gA1_2(Array(90).fill('word').join(' ')).status, 'fail');
  assert.strictEqual(A.gA1_2(Array(40).fill('word').join(' ') + '. One. Two. Three.').status, 'fail');
});
check('G-A1.2 does not split sentences on abbreviations or decimals', () => {
  assert.strictEqual(A.sentenceCount('The U.S. rate hit 3.7% in Q2 and held there.'), 1);
});
check('G-A1.3 flags a numeral absent from the brief', () => {
  const item = { headline: 'Rates held', brief: 'The rate is 3.7%.', source: 'Reuters' };
  assert.strictEqual(A.gA1_3('The 9.9% figure changes the picture entirely here.', item).status, 'fail');
});
// NARROWED TO NUMERALS, David 2026-09-01. A proper noun absent from the
// verified text is REPORTED and does NOT fail the gate. The accepted cost is
// that a fabricated NAME passes; the observation is kept so run reports
// accumulate evidence on whether that risk materialises.
check('G-A1.3 does NOT fail on a proper noun -- it records an observation', () => {
  const item = { headline: 'Rates held', brief: 'The rate is 3.7%.', source: 'Reuters' };
  const r = A.gA1_3('This mirrors what Bundesbank did previously in similar conditions.', item);
  assert.strictEqual(r.status, 'pass', 'proper nouns must not gate after the narrowing');
  assert.deepStrictEqual(r.nounObservation, ['Bundesbank']);
});
check('G-A1.3 still HARD-fails on an unverified figure', () => {
  const item = { headline: 'Rates held', brief: 'The rate is 3.7%.', source: 'Reuters' };
  const r = A.gA1_3('The 9.9% revision is the number that changes the picture here.', item);
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.hard, true);
});
// Option B end to end: a figure the BRIEF omitted but the ARTICLE carries.
check('source text verifies a figure the brief omitted', () => {
  const item = { headline: 'Rates held', brief: 'The rate held.', source: 'Reuters' };
  const line = 'The 3.7% print is the binding number here today.';
  assert.strictEqual(A.gA1_3(line, item).status, 'fail', 'brief alone should not verify it');
  assert.strictEqual(A.gA1_3(line, item, 'The report showed inflation at 3.7% for the month.').status, 'pass',
    'source text should verify it');
});
check('G-A1.3 accepts a possessive form of a verified noun', () => {
  const item = { headline: 'Beijing holds data', brief: 'Beijing has not shared hydrological data.', source: 'AP' };
  // MID-SENTENCE deliberately: a sentence-initial possessive is skipped by the
  // sentence-start rule and would pass without exercising this path at all.
  assert.strictEqual(A.gA1_3("The live test is Beijing's handling of the data across that border.", item).status, 'pass');
});


// --- the regression cases in prompts/wire/evals/cases/ ----------------------
// A gate change that flips any of these verdicts fails CI. The cases exist so
// evals/cases/ is a real directory rather than a promised one.
(function regressionCases() {
  const spec = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'prompts', 'wire', 'evals', 'cases', 'gate-cases.json'), 'utf8'));
  const fn = { 'G-A1.1': (c) => A.gA1_1(c.w, lexicon), 'G-A1.2': (c) => A.gA1_2(c.w), 'G-A1.3': (c) => A.gA1_3(c.w, c.item) };
  for (const c of spec.cases) {
    check('case [' + c.gate + '] ' + c.why, () => {
      const r = fn[c.gate](c);
      assert.strictEqual(r.status, c.expect, 'got ' + r.status + ': ' + r.detail);
    });
  }
})();

// --- THE EVAL: the gates against 85 real accepted lines ---------------------
(function evalGolden() {
  const results = { total: 0, g1: 0, g2: 0, g3: 0, clean: 0 };
  const failures = { 'G-A1.1': [], 'G-A1.2': [], 'G-A1.3': [] };
  for (const it of golden.items) {
    if (!it.w) continue;
    results.total++;
    const r = A.runDeterministic(it.w, it, { lexicon });
    for (const c of r.checks) if (c.status === 'fail') failures[c.id].push({ id: it.id, detail: c.detail });
    results.g1 += r.checks[0].status === 'pass' ? 1 : 0;
    results.g2 += r.checks[1].status === 'pass' ? 1 : 0;
    results.g3 += r.checks[2].status === 'pass' ? 1 : 0;
    if (r.ok) results.clean++;
  }
  // The decision-relevant split: a fabricated FIGURE is the risk G-A1.3
  // exists for. An unverified proper noun is usually a demonym or an
  // adjectival form ("Chinese", "Himalayan") that no reasonable line avoids.
  // Measured separately so the calibration question has numbers behind it.
  let numOnly = 0;
  for (const it of golden.items) {
    if (!it.w) continue;
    const verified = [it.brief, it.headline, it.source].join(' ');
    const v = A.numerals(verified);
    const flat = verified.toLowerCase();
    if (![...A.numerals(it.w)].some((n) => !v.has(n) && !flat.includes(n))) numOnly++;
  }
  results.g3NumeralsOnly = numOnly;

  console.log('\n  GOLDEN-SET EVAL -- deterministic gates against ' + results.total + ' accepted lines');
  console.log('    G-A1.1 no filler        : ' + results.g1 + '/' + results.total);
  console.log('    G-A1.2 shape            : ' + results.g2 + '/' + results.total);
  console.log('    G-A1.3 no new facts     : ' + results.g3 + '/' + results.total + '   <-- see the brief');
  console.log('    G-A1.3 NUMERALS ONLY    : ' + numOnly + '/' + results.total + '   <-- the same gate, proper nouns dropped');
  console.log('    all three               : ' + results.clean + '/' + results.total);
  for (const [gate, list] of Object.entries(failures)) {
    if (!list.length) continue;
    console.log('    ' + gate + ' rejected ' + list.length + ':');
    for (const f of list.slice(0, 4)) console.log('      ' + f.id + '  ' + f.detail.slice(0, 100));
  }
  fs.writeFileSync(path.join(__dirname, '..', 'prompts', 'wire', 'evals', 'last-score.json'),
    JSON.stringify({ ...results, failures }, null, 2) + '\n');
  console.log('');
})();

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
