'use strict';
// REQ-GATE-1..9, in the spec's cheapest-first order (§6).
//
// REQ-GATE-10 (the site builds with the new edition) is NOT here: it is a
// property of superdtf-0882.github.io, not of this repository, and under
// ADR-009 Shape A this job never builds the site. It is recorded as
// "deferred" in the run report so the report's gate list stays complete
// rather than silently short.
//
// Every gate returns { id, status, detail } -- a human-readable detail, not
// just a boolean, because when a run fails at 06:00 the useful fact is WHICH
// link 404'd (EXAMPLE-CALL.md, "Reading the run report").

const { canonicalUrl, itemId, hostOf, hostMatches } = require('./canonical');

const PREAMBLE = [
  /^(here('s| is)|sure[,!]|certainly|i'?ll |i can |as an ai|i'?m sorry|unfortunately, i)/i,
  /\b(i cannot|i can't|i am unable to) (provide|help|assist|comply)/i,
  /^(based on (my|the) search|according to my search)/i,
];

const pass = (id, detail) => ({ id, status: 'pass', detail });
const warn = (id, detail) => ({ id, status: 'warn', detail });
const fail = (id, detail) => ({ id, status: 'fail', detail });

function allItems(edition) {
  const out = [];
  for (const g of edition.groups || []) for (const s of g.sections || []) out.push(...(s.items || []));
  return out;
}

// --- REQ-GATE-1: schema -----------------------------------------------------
const ITEM_FIELDS = ['id', 'headline', 'source', 'url', 'publishedDate', 'kind', 'brief', 'why', 'topicId'];
const KINDS = new Set(['news', 'analysis', 'primary']);

function gate1(edition, cfg) {
  const errs = [];
  if (edition.schemaVersion !== cfg.schemaVersion) errs.push('schemaVersion ' + edition.schemaVersion);
  for (const f of ['editionId', 'generatedAt', 'slot', 'itemCount', 'groups']) {
    if (edition[f] === undefined) errs.push('missing ' + f);
  }
  const items = allItems(edition);
  if (edition.itemCount !== items.length) {
    errs.push('itemCount ' + edition.itemCount + ' != ' + items.length + ' actual');
  }
  items.forEach((it, i) => {
    for (const f of ITEM_FIELDS) if (!it[f]) errs.push('item ' + i + ' missing ' + f);
    if (it.kind && !KINDS.has(it.kind)) errs.push('item ' + i + ' kind=' + it.kind);
    if (it.publishedDate && !/^\d{4}-\d{2}-\d{2}$/.test(it.publishedDate)) {
      errs.push('item ' + i + ' publishedDate=' + it.publishedDate);
    }
    if (it.url && !/^https:/.test(it.url)) errs.push('item ' + i + ' url not https');
  });
  return errs.length
    ? fail('REQ-GATE-1', errs.length + ' schema error(s): ' + errs.slice(0, 5).join('; '))
    : pass('REQ-GATE-1', 'edition valid against schemaVersion ' + edition.schemaVersion);
}

// --- REQ-GATE-3: deny list --------------------------------------------------
function gate3(edition, cfg) {
  const items = allItems(edition);
  const deny = cfg.sources.deny || [];
  const hits = [];
  const hosts = new Set();
  for (const it of items) {
    const h = hostOf(it.url);
    hosts.add(h);
    const d = deny.find((e) => hostMatches(h, e));
    if (d) hits.push(h + ' (' + d + ')');
  }
  return hits.length
    ? fail('REQ-GATE-3', hits.length + ' url(s) on deny list: ' + [...new Set(hits)].join(', '))
    : pass('REQ-GATE-3', '0 of ' + items.length + ' urls on deny list; ' + hosts.size + ' distinct hosts checked');
}

// --- REQ-GATE-4: item floors ------------------------------------------------
function gate4(edition, cfg) {
  const counts = new Map();
  for (const it of allItems(edition)) counts.set(it.topicId, (counts.get(it.topicId) || 0) + 1);
  const topics = cfg.allTopics();
  const short = topics.filter((t) => (counts.get(t.id) || 0) < t.minItems);
  return short.length
    ? fail('REQ-GATE-4', short.map((t) => t.id + ' ' + (counts.get(t.id) || 0) + '/' + t.minItems).join(', '))
    : pass('REQ-GATE-4', topics.length + '/' + topics.length + ' topics at or above minItems');
}

// --- REQ-GATE-5: uniqueness -------------------------------------------------
function gate5(edition) {
  const items = allItems(edition);
  const urls = new Map();
  const ids = new Map();
  for (const it of items) {
    const c = canonicalUrl(it.url);
    urls.set(c, (urls.get(c) || 0) + 1);
    ids.set(it.id, (ids.get(it.id) || 0) + 1);
  }
  const dupUrl = [...urls].filter(([, n]) => n > 1);
  const dupId = [...ids].filter(([, n]) => n > 1);
  if (dupUrl.length || dupId.length) {
    return fail('REQ-GATE-5',
      dupUrl.length + ' duplicate url(s), ' + dupId.length + ' duplicate id(s): ' +
      [...dupUrl.map((d) => d[0]), ...dupId.map((d) => d[0])].slice(0, 3).join(', '));
  }
  return pass('REQ-GATE-5', urls.size + ' unique canonical urls, ' + ids.size + ' unique ids');
}

// --- REQ-GATE-6: recency ----------------------------------------------------
// Utah sections carry a longer window, so they are excluded from the rate the
// spec sets the floor on ("non-Utah sections").
//
// PRECISION NOTE, and it is load-bearing. `publishedDate` is a DATE, not a
// timestamp (spec §4.2: "ISO YYYY-MM-DD"). A 24h window therefore cannot be
// evaluated to the hour: an article published at 09:00 on day N and one
// published at 23:59 the same day carry identical stamps. This gate resolves
// the window to WHOLE DAYS, generously -- a "24h" window admits any item whose
// publishedDate is the run date or the day before. That is the finest
// distinction the data supports, and rounding the other way would reject items
// that are genuinely inside the window.
//
// The golden fixture FAILS this gate at 0.33, against the 0.91 its own
// runReport claims. See test/gates.test.js and the activity-4 brief -- the
// discrepancy is reported rather than tuned away, because a gate loosened
// until a fixture passes is not a gate.
function gate6(edition, cfg, now) {
  const utah = new Set(cfg.utahTopicIds());
  const items = allItems(edition).filter((it) => !utah.has(it.topicId));
  if (!items.length) return pass('REQ-GATE-6', 'no non-Utah items to evaluate');
  const days = Math.ceil(cfg.windowMs(cfg.windows.default) / 86400e3);
  const cutoff = new Date(now.getTime() - days * 86400e3).toISOString().slice(0, 10);
  const inside = items.filter((it) => it.publishedDate >= cutoff).length;
  const rate = inside / items.length;
  const floor = cfg.gates.recencyMinRate;
  const d = rate.toFixed(2) + ' of non-Utah items inside window (floor ' + floor.toFixed(2) +
    ', window ' + cfg.windows.default + ' resolved to ' + days + 'd, cutoff ' + cutoff + ')';
  return rate >= floor ? pass('REQ-GATE-6', d) : fail('REQ-GATE-6', d);
}

// --- REQ-GATE-7: novelty -- WARN ONLY, never blocks -------------------------
function gate7(edition, cfg, previous) {
  const items = allItems(edition);
  if (!previous) return pass('REQ-GATE-7', 'no previous edition; carry-over not applicable');
  const prev = new Set(allItems(previous).map((i) => i.id));
  const carried = items.filter((i) => prev.has(i.id)).length;
  const rate = items.length ? carried / items.length : 0;
  const ceil = cfg.gates.carryoverMaxRate;
  const d = rate.toFixed(2) + ' carried over from edition N-1 (ceiling ' + ceil.toFixed(2) + ')';
  // Warn-level by REQ-GATE-7's own "Warn, publish". Exceeding the ceiling is
  // still only a warning -- that is the crossing declared in KILL-SWITCH.md.
  return rate > ceil
    ? warn('REQ-GATE-7', d + ' - EXCEEDED, warn-only by REQ-GATE-7, publishing')
    : pass('REQ-GATE-7', d + ' - within tolerance');
}

// --- REQ-GATE-8: field sanity ----------------------------------------------
function gate8(edition, cfg) {
  const errs = [];
  for (const it of allItems(edition)) {
    if (!it.brief || !it.brief.trim()) errs.push(it.id + ' empty brief');
    if (!it.why || !it.why.trim()) errs.push(it.id + ' empty why');
    if (it.headline && it.headline.length > cfg.gates.headlineMaxChars) errs.push(it.id + ' headline ' + it.headline.length);
    if (it.brief && it.brief.length > cfg.gates.briefMaxChars) errs.push(it.id + ' brief ' + it.brief.length);
    if (it.why && it.why.length > cfg.gates.whyMaxChars) errs.push(it.id + ' why ' + it.why.length);
    for (const f of ['brief', 'why']) {
      if (it[f] && PREAMBLE.some((r) => r.test(it[f].trim()))) errs.push(it.id + ' ' + f + ' preamble/refusal');
    }
  }
  return errs.length
    ? fail('REQ-GATE-8', errs.length + ' field error(s): ' + errs.slice(0, 5).join('; '))
    : pass('REQ-GATE-8', 'no empty fields, no preamble or refusal text detected');
}

// --- REQ-GATE-9: cost -------------------------------------------------------
function gate9(costUsd, cfg) {
  const ceil = cfg.budget.maxCostUsdPerRun;
  const d = '$' + costUsd.toFixed(2) + ' of $' + ceil.toFixed(2) + ' ceiling';
  return costUsd <= ceil ? pass('REQ-GATE-9', d) : fail('REQ-GATE-9', d + ' - EXCEEDED');
}

// --- REQ-GATE-2: link resolution -- the only gate that makes network calls --
async function gate2(edition, cfg, fetchImpl) {
  const items = allItems(edition);
  const g = cfg.gates.linkResolution;
  const hardFail = new Set(g.hardFailStatuses);
  const warnOnly = new Set(g.warnOnlyStatuses);
  let ok = 0, warned = 0;
  const failures = [];

  await mapLimit(items, 8, async (it) => {
    let status = 0;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), g.timeoutMs);
      try {
        let r = await fetchImpl(it.url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
        // Some hosts reject HEAD but serve GET. Retry once before judging.
        if (r.status === 405 || r.status === 501) {
          r = await fetchImpl(it.url, { method: 'GET', redirect: 'follow', signal: ctl.signal });
        }
        status = r.status;
      } finally { clearTimeout(t); }
    } catch (e) {
      status = 0; // timeout or network error -- counts as a resolution failure
    }
    if (status >= 200 && status < 300) ok++;
    else if (warnOnly.has(status)) warned++;              // 403 from a datacenter IP is not a paywall
    else if (hardFail.has(status) || status === 0) failures.push(it.url + ' -> ' + (status || 'timeout'));
    else ok++;                                            // 3xx already followed; anything else is not a listed failure
  });

  const denom = items.length;
  const rate = denom ? (ok + warned) / denom : 1;
  const d = ok + '/' + denom + ' resolved 2xx' + (warned ? '; ' + warned + ' warn (403 from datacenter IP, not counted as failure)' : '');
  // "zero may 404" -- any hard failure aborts regardless of the rate.
  if (failures.length) return fail('REQ-GATE-2', failures.length + ' hard failure(s): ' + failures.slice(0, 5).join(', '));
  if (rate < g.minPassRate) return fail('REQ-GATE-2', d + '; rate ' + rate.toFixed(2) + ' below ' + g.minPassRate);
  return pass('REQ-GATE-2', d);
}

async function mapLimit(list, limit, fn) {
  const q = [...list.entries()];
  const workers = Array.from({ length: Math.min(limit, q.length) }, async () => {
    for (;;) {
      const next = q.shift();
      if (!next) return;
      await fn(next[1], next[0]);
    }
  });
  await Promise.all(workers);
}

// Runs every gate cheapest-first and stops at the first ABORT-level failure,
// so a broken edition costs no network calls. Warn-level results never stop
// the run -- REQ-GATE-7 is the only warn-level gate and its "Warn, publish"
// is the reason this function distinguishes the two at all.
async function runGates(edition, cfg, opts = {}) {
  const { previous = null, costUsd = 0, fetchImpl = globalThis.fetch, now = new Date(), skipNetwork = false } = opts;
  const checks = [];
  const push = (c) => { checks.push(c); return c.status !== 'fail'; };

  if (!push(gate1(edition, cfg))) return finish(checks);
  if (!push(gate3(edition, cfg))) return finish(checks);
  if (!push(gate4(edition, cfg))) return finish(checks);
  if (!push(gate5(edition))) return finish(checks);
  if (!push(gate6(edition, cfg, now))) return finish(checks);
  push(gate7(edition, cfg, previous));                       // warn-only, never gates
  if (!push(gate8(edition, cfg))) return finish(checks);
  if (!push(gate9(costUsd, cfg))) return finish(checks);
  if (skipNetwork) checks.push({ id: 'REQ-GATE-2', status: 'skipped', detail: 'network checks disabled for this run' });
  else if (!push(await gate2(edition, cfg, fetchImpl))) return finish(checks);
  checks.push({ id: 'REQ-GATE-10', status: 'deferred', detail: 'site build is not this repository under ADR-009 Shape A' });
  return finish(checks);
}

// A run passes when no gate FAILED. 'warn', 'skipped' and 'deferred' do not
// block -- and each is a distinct word so a reader of the report can tell a
// gate that passed from one that never ran.
function finish(checks) {
  return { gatesPassed: !checks.some((c) => c.status === 'fail'), checks };
}

module.exports = { runGates, allItems, gate1, gate2, gate3, gate4, gate5, gate6, gate7, gate8, gate9 };
