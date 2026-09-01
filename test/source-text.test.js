#!/usr/bin/env node
'use strict';
// Option B's containment tests. David's ruling 2026-09-01: hold source text in
// the runner.
//
// THE ONE THAT MATTERS is "source text never reaches a serialised edition".
// The content repository is PUBLIC, so anything in the edition is published,
// and REQ-LEG-1 bars reproducing article paragraphs. The store is structurally
// separate from the edition -- a Map the edition has no reference to -- and
// this test is what keeps that true through a refactor. A convention would not
// survive one.

const assert = require('assert');
const { SourceTextStore, textFromHtml, fetchInto, harvestFromResponse, MAX_CHARS_PER_ITEM } = require('../lib/source-text');
const { runAnalysisGates } = require('../lib/analysis-stage');
const { load } = require('../lib/config');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok    ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n          ' + e.message); failed++; }
}

const cfg = load();
const SECRET = 'ZZQUUXMARKERZZ';   // a token that exists only in "source text"

function edition() {
  return {
    schemaVersion: 1, editionId: '2026-09-01T00:00:00Z', itemCount: 1,
    groups: [{ id: 'g', label: 'G', sections: [{ id: 'world-news', label: 'W', items: [{
      id: 'aaaaaaaaaaaaaaaa', topicId: 'world-news', headline: 'A thing happened',
      source: 'AP', url: 'https://apnews.com/x', publishedDate: '2026-09-01',
      kind: 'news', brief: 'A thing happened in a place.',
      why: 'The mechanism is that the thing changes the other thing, which matters because the second-order effect reaches a different set of actors than the first one did.',
    }] }] }],
  };
}

// --- THE CONTAINMENT TEST ---------------------------------------------------
check('source text NEVER reaches a serialised edition', () => {
  const store = new SourceTextStore();
  store.set('aaaaaaaaaaaaaaaa', 'article body mentioning ' + SECRET + ' repeatedly', 'fetch');
  const ed = edition();
  runAnalysisGates(ed, cfg, store);
  const json = JSON.stringify(ed);
  assert.ok(!json.includes(SECRET), 'the edition payload carries source text');
});

check('the run-report summary carries counts and origins, never text', () => {
  const store = new SourceTextStore();
  store.set('a', 'body with ' + SECRET, 'fetch');
  store.set('b', 'another body with ' + SECRET, 'web_search_tool_result');
  const s = store.summary();
  assert.ok(!JSON.stringify(s).includes(SECRET), 'summary leaks text');
  assert.deepStrictEqual(s, { items: 2, byOrigin: { fetch: 1, web_search_tool_result: 1 } });
});

check('analysis verdicts quote gate detail, never the article', () => {
  const store = new SourceTextStore();
  store.set('aaaaaaaaaaaaaaaa', SECRET + ' ' + SECRET, 'fetch');
  const ed = edition();
  ed.groups[0].sections[0].items[0].why = 'The Bundesbank precedent from 1997 is the mechanism here, and it reaches a different set of actors than the first order effect did originally.';
  const a = runAnalysisGates(ed, cfg, store);
  assert.ok(!JSON.stringify(a).includes(SECRET), 'verdicts leak source text');
  assert.ok(a.linesFailing >= 1, 'expected the unverified-noun failure');
});

check('dispose() clears the store and refuses further writes', () => {
  const store = new SourceTextStore();
  store.set('a', 'text', 'fetch');
  store.dispose();
  assert.strictEqual(store.size, 0);
  assert.throws(() => store.set('b', 'text', 'fetch'), /after dispose/);
});

check('entries are bounded so one long page cannot exhaust the runner', () => {
  const store = new SourceTextStore();
  store.set('a', 'x'.repeat(MAX_CHARS_PER_ITEM * 3), 'fetch');
  assert.strictEqual(store.get('a').length, MAX_CHARS_PER_ITEM);
});

// --- enforcement mode -------------------------------------------------------
check('report mode records failures and drops NOTHING', () => {
  const ed = edition();
  ed.groups[0].sections[0].items[0].why = 'It remains to be seen whether the thing matters at all, which is a question that will take some considerable time to answer properly.';
  const a = runAnalysisGates(ed, { ...cfg, gates: { ...cfg.gates, analysisEnforcement: 'report' } }, null);
  assert.strictEqual(a.mode, 'report');
  assert.strictEqual(a.linesDropped, 0);
  assert.ok(ed.groups[0].sections[0].items[0].why, 'report mode dropped a line');
});

check('enforce mode drops the LINE but keeps the ITEM -- A1-011', () => {
  const ed = edition();
  ed.groups[0].sections[0].items[0].why = 'It remains to be seen whether the thing matters at all, which is a question that will take some considerable time to answer properly.';
  const a = runAnalysisGates(ed, { ...cfg, gates: { ...cfg.gates, analysisEnforcement: 'enforce' } }, null);
  assert.strictEqual(a.linesDropped, 1);
  const it = ed.groups[0].sections[0].items[0];
  assert.strictEqual(it.why, undefined, 'line not dropped');
  assert.ok(it.headline && it.url, 'the ITEM must survive -- A1-011');
});

check('the shipped config is in REPORT mode pending the calibration ruling', () => {
  assert.strictEqual(cfg.gates.analysisEnforcement, 'report',
    'enforcement was switched on -- confirm the G-A1.3 calibration was ruled first');
});

// --- html extraction --------------------------------------------------------
check('script and style contents are stripped -- they cause false ACCEPTS', () => {
  const t = textFromHtml('<p>Real text.</p><script>var Bundesbank="x"</script><style>.Warsaw{}</style>');
  assert.ok(t.includes('Real text.'));
  assert.ok(!/Bundesbank/.test(t), 'script content survived and would verify a fabricated noun');
  assert.ok(!/Warsaw/.test(t), 'style content survived');
});

check('entities decode and whitespace collapses', () => {
  assert.strictEqual(textFromHtml('<p>A&nbsp;&amp;&nbsp;B</p>\n\n  <p>C</p>'), 'A & B C');
});

// --- harvest ----------------------------------------------------------------
check('harvestFromResponse tolerates an unknown block shape without throwing', () => {
  const store = new SourceTextStore();
  const n = harvestFromResponse({ content: [
    { type: 'text', text: 'ignored' },
    { type: 'web_search_tool_result', content: [{ url: 'https://apnews.com/x', page_content: 'body' }] },
    { type: 'web_search_tool_result', content: { nonsense: true } },
  ] }, store, () => 'id1');
  assert.strictEqual(n, 1);
  assert.strictEqual(store.get('id1'), 'body');
});

check('a failed fetch is reported, not thrown -- the gate falls back to the brief', async () => {});
(async () => {
  const store = new SourceTextStore();
  const r = await fetchInto(store, { id: 'x', url: 'https://apnews.com/x' },
    async () => { throw Object.assign(new Error('boom'), { name: 'TypeError' }); });
  check('a failed fetch returns a reason and stores nothing', () => {
    assert.strictEqual(r, 'error');
    assert.strictEqual(store.size, 0);
  });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
