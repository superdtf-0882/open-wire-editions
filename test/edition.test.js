#!/usr/bin/env node
'use strict';
// Assembly tests for lib/edition.js -- the path between the API response and
// the gates. Driven by the golden fixture's own items, so "does the merge
// reproduce a known-good edition" is answered against real data.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { load } = require('../lib/config');
const { build, slotFor, noticeBlock } = require('../lib/edition');
const { allItems } = require('../lib/gates');

const cfg = load();
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'golden-current.json'), 'utf8'));

// Rebuild cluster-shaped inputs from the fixture, exactly as generate.js
// --fixture does.
function clusters() {
  const byTopic = new Map();
  for (const g of golden.groups) for (const s of g.sections) byTopic.set(s.id, s.items);
  return cfg.clusters.map((c) => ({
    id: c.id, status: 'ok', paywalled: [], searches: 0, attempts: 1, tokens: { input: 0, output: 0 },
    items: c.topics.flatMap((t) => (byTopic.get(t) || []).map((i) => ({ ...i }))),
  }));
}

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok    ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n          ' + e.message); failed++; }
}

const now = new Date(golden.editionId);
const built = build(clusters(), cfg, now);

check('rebuilds every item -- 85 in, 85 out', () => {
  assert.strictEqual(built.itemCount, golden.itemCount);
  assert.strictEqual(allItems(built).length, allItems(golden).length);
});

check('assigns the same ids the fixture carries', () => {
  const a = allItems(built).map((i) => i.id).sort();
  const b = allItems(golden).map((i) => i.id).sort();
  assert.deepStrictEqual(a, b);
});

check('merges in CONFIG order, not response order', () => {
  assert.deepStrictEqual(built.groups.map((g) => g.id), cfg.groups.map((g) => g.id));
  for (let i = 0; i < built.groups.length; i++) {
    assert.deepStrictEqual(built.groups[i].sections.map((s) => s.id), cfg.groups[i].topics.map((t) => t.id));
  }
});

check('cross-cluster duplicate urls are dropped once, not twice', () => {
  const cs = clusters();
  const dup = JSON.parse(JSON.stringify(cs[0].items[0]));
  cs[1].items.push(dup);                       // same story surfaced by two clusters
  const e = build(cs, cfg, now);
  assert.strictEqual(e.itemCount, golden.itemCount, 'duplicate was not collapsed');
});

check('an unparseable url is dropped, not fatal', () => {
  const cs = clusters();
  cs[0].items.push({ ...cs[0].items[0], url: 'not a url' });
  const e = build(cs, cfg, now);
  assert.strictEqual(e.itemCount, golden.itemCount);
});

check('urls come out canonical -- no www, no tracking, no trailing slash', () => {
  for (const it of allItems(built)) {
    assert.ok(!/\/\/www\./.test(it.url), it.url);
    assert.ok(!/[?&](utm_|fbclid|gclid)/.test(it.url), it.url);
    assert.ok(!/\/$/.test(it.url), it.url);
    assert.ok(it.url.startsWith('https://'), it.url);
  }
});

// REQ-LEG-2 / REQ-LEG-3 travel IN THE PAYLOAD, because the content repository
// is public and raw.githubusercontent.com serves this JSON directly. ADR-009's
// restated D7; AC-011's ac_prohibited.
check('the edition payload carries the automated-generation notice', () => {
  assert.ok(built.notice, 'no notice block');
  assert.ok(built.notice.automatedGeneration.length > 40);
  assert.ok(/REQ-LEG-3/.test(built.notice.requirements.join(',')));
});

check('the notice comes from config, not a hardcoded string, when config sets one', () => {
  const withNotice = { ...cfg, site: { automatedGenerationNotice: 'CONFIGURED NOTICE TEXT' } };
  assert.strictEqual(noticeBlock(withNotice).automatedGeneration, 'CONFIGURED NOTICE TEXT');
});

check('slot is derived from the local hour, both ways', () => {
  assert.strictEqual(slotFor(new Date('2026-08-30T12:05:00Z'), cfg), 'am');  // 06:05 Denver
  assert.strictEqual(slotFor(new Date('2026-08-30T22:05:00Z'), cfg), 'pm');  // 16:05 Denver
});

check('editionId and generatedAt are both stamped and ISO', () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(built.editionId), built.editionId);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(built.generatedAt), built.generatedAt);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
