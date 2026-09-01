#!/usr/bin/env node
'use strict';
// The Open Wire generate job. WP-WIRE-01 activity 4, TC-38.
//
// Contract: AC-011 (Issued 2026-08-31). Decision: ADR-009 (Approved, v3).
// Requirements: open-wire-spec.md v1.0.
//
// SHAPE A IS STRUCTURAL HERE, not a convention: this process writes ONLY to
// this repository. It never touches superdtf-0882.github.io. AC-011's first
// ac_prohibited clause makes a pipeline commit to the site repository out of
// scope for the contract, not merely discouraged.
//
// FAIL-CLOSED: a failed gate writes a run report, exits non-zero, and commits
// NOTHING. The previously published edition stays live and untouched, with no
// rollback step, because a run that does not commit changes nothing.
//
//   --dry-run          do everything except write editions/ and revalidate
//   --skip-network     skip REQ-GATE-2's link checks (offline only)
//   --fixture <path>   feed cluster results from an existing edition instead of
//                      calling the API. This exercises THE REAL assembly path --
//                      normalize, id, merge in config order, gate, report -- with
//                      no key and no spend. It is how the pipeline was verified
//                      before an approved prompt existed. Implies --dry-run
//                      unless --write is also given.
//   --write            with --fixture, actually write editions/

const fs = require('fs');
const path = require('path');
const { load } = require('./lib/config');
const { runCluster, estimateCost } = require('./lib/anthropic');
const { build } = require('./lib/edition');
const { runGates } = require('./lib/gates');
const prompt = require('./lib/prompt');   // prompt.PROMPT_VERSION resolves from manifest.yaml (A1-015)
const { revalidate } = require('./revalidate');

const ROOT = __dirname;
const EDITIONS = path.join(ROOT, 'editions');
const REPORTS = path.join(ROOT, 'run-reports');
const RUN_BUDGET_MS = 20 * 60 * 1000;

const args = process.argv.slice(2);
const argv = new Set(args);
const FIXTURE = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
const DRY = argv.has('--dry-run') || (FIXTURE && !argv.has('--write'));
const SKIP_NET = argv.has('--skip-network');

// Rebuild cluster-shaped results from an existing edition, so the assembly
// path downstream of the API is driven by real data. The items are handed back
// in their RAW shape -- canonicalization and id assignment are lib/edition.js's
// job and must be exercised, not bypassed.
function clustersFromFixture(file, cfg) {
  const ed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byTopic = new Map();
  for (const g of ed.groups) for (const s of g.sections) byTopic.set(s.id, s.items);
  return cfg.clusters.map((c) => {
    const items = c.topics.flatMap((t) => (byTopic.get(t) || []).map((i) => ({ ...i })));
    return {
      id: c.id, status: 'ok', items, paywalled: [], searches: 0, attempts: 1,
      tokens: { input: 0, output: 0 }, note: 'from fixture ' + path.basename(file),
    };
  });
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// REQ-OPS-7: retain run reports for at least the last 30 runs.
function writeReport(report) {
  fs.mkdirSync(REPORTS, { recursive: true });
  const name = report.startedAt.replace(/[:.]/g, '-') + (report.gatesPassed ? '-pass' : '-FAIL') + '.json';
  fs.writeFileSync(path.join(REPORTS, name), JSON.stringify(report, null, 2) + '\n');
  const kept = fs.readdirSync(REPORTS).filter((f) => f.endsWith('.json')).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - 30))) fs.unlinkSync(path.join(REPORTS, old));
}

async function main() {
  const startedAt = new Date();
  const cfg = load();

  // REQ-SEC-1. The key is read here and passed down; it is never written
  // anywhere, and lib/anthropic.js redacts it out of every error it raises.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !DRY && !FIXTURE) {
    console.error('ANTHROPIC_API_KEY is not set. It is a repository secret on this repo; see KILL-SWITCH.md.');
    process.exit(2);
  }

  // P-07 / WP-WIRE-01 activity 5: the prompt is not approved for Production
  // until David has approved it. This refuses rather than warns, which is what
  // makes it a control under RULE-10 rather than a note.
  if (!DRY && !FIXTURE && process.env.OPEN_WIRE_PROMPT_APPROVED !== 'true') {
    console.error(
      'REFUSED: the synthesis prompt (lib/prompt.js v' + prompt.PROMPT_VERSION + ') is not approved for Production.\n' +
      'P-07 requires David\'s approval before a production run; WP-WIRE-01 activity 5 is the act that gives it.\n' +
      'Declared crossing: set OPEN_WIRE_PROMPT_APPROVED=true once approval is on the record. See KILL-SWITCH.md.');
    process.exit(3);
  }

  const deadline = startedAt.getTime() + RUN_BUDGET_MS;
  console.log('Open Wire generate -- ' + startedAt.toISOString() + (DRY ? ' [DRY RUN]' : ''));
  console.log('  model ' + cfg.model.id + ', prompt v' + prompt.PROMPT_VERSION + ', ' + cfg.clusters.length + ' clusters');

  // Five clusters, concurrently -- they are independent (EXAMPLE-CALL.md).
  const results = FIXTURE
    ? clustersFromFixture(FIXTURE, cfg)
    : DRY
      ? []
      : await Promise.all(cfg.clusters.map((c) => runCluster(c, cfg, { apiKey, now: startedAt, deadline })));
  if (FIXTURE) console.log('  FIXTURE MODE -- no API call, no spend; assembly and gates exercised for real');

  // REQ-OPS-5: partial success is acceptable. A failed cluster does not fail
  // the run; its topics face REQ-GATE-4's floor on their own.
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) console.log('  ' + failed.length + ' cluster(s) failed after retries: ' + failed.map((f) => f.id).join(', '));
  if (failed.length === results.length && results.length) {
    console.error('  every cluster failed -- nothing to validate, publishing nothing');
    writeReport({ startedAt: startedAt.toISOString(), gatesPassed: false, checks: [], clusters: results });
    process.exit(1);
  }

  const tokens = results.reduce((a, r) => ({ input: a.input + r.tokens.input, output: a.output + r.tokens.output }), { input: 0, output: 0 });
  const searches = results.reduce((n, r) => n + r.searches, 0);
  const costUsd = estimateCost(cfg.model.id, tokens, searches);

  const previous = readJson(path.join(EDITIONS, 'current.json'));
  const edition = build(results, cfg, startedAt);

  const { gatesPassed, checks } = await runGates(edition, cfg, {
    previous, costUsd: costUsd == null ? 0 : costUsd, now: startedAt, skipNetwork: SKIP_NET,
  });

  const runReport = {
    startedAt: startedAt.toISOString(),
    gatesPassed,
    promptVersion: prompt.PROMPT_VERSION,
    model: cfg.model.id,
    durationMs: Date.now() - startedAt.getTime(),
    costUsd: costUsd == null ? null : Number(costUsd.toFixed(2)),
    tokens,
    searches,
    clusters: results.map(({ id, status, searches, attempts, note }) => ({ id, status, items: 0, searches, attempts, ...(note ? { note } : {}) })),
    checks,
  };
  results.forEach((r, i) => { runReport.clusters[i].items = r.items.length; });
  edition.runReport = runReport;

  for (const c of checks) console.log('  ' + c.id.padEnd(12) + c.status.padEnd(9) + c.detail);
  writeReport(runReport);

  if (!gatesPassed) {
    console.error('GATES FAILED -- publishing nothing. The previous edition stays live.');
    process.exit(1);
  }
  if (DRY) { console.log('DRY RUN -- nothing written.'); return; }

  // Rotate, then write. Order matters: a crash between the two leaves the
  // previous edition readable rather than leaving nothing.
  fs.mkdirSync(EDITIONS, { recursive: true });
  if (previous) fs.writeFileSync(path.join(EDITIONS, 'previous.json'), JSON.stringify(previous, null, 2) + '\n');
  fs.writeFileSync(path.join(EDITIONS, 'current.json'), JSON.stringify(edition, null, 2) + '\n');
  console.log('Wrote edition ' + edition.editionId + ' -- ' + edition.itemCount + ' items.');

  // The revalidation call MUST NOT be able to fail the edition. AC-011's
  // fail-soft posture: a commit that lands with a failed revalidation leaves
  // the site STALE rather than WRONG. Recorded, never thrown.
  const rev = await revalidate(edition.editionId).catch((e) => ({ ok: false, detail: e.message }));
  console.log('  revalidation: ' + (rev.ok ? 'ok' : 'FAILED (edition still published) -- ' + rev.detail));
}

main().catch((e) => { console.error('generate failed: ' + e.message); process.exit(1); });
