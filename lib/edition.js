'use strict';
// Merge cluster responses into an edition.
//
// EXAMPLE-CALL.md step 3: merge "into the group/section tree defined by config
// order -- NOT by the order the clusters returned." That ordering is what
// makes two editions diffable against each other.

const { canonicalUrl, itemId } = require('./canonical');

// REQ-LEG-2 and REQ-LEG-3 travel IN THE PAYLOAD, not only on the page.
// ADR-009's restated D7 and AC-011's ac_prohibited: the content repository is
// PUBLIC, so raw.githubusercontent.com serves this JSON directly and a
// consumer may never see the rendered page. A notice that lives only in the
// renderer does not reach them.
function noticeBlock(cfg) {
  return {
    automatedGeneration: (cfg.site && cfg.site.automatedGenerationNotice
      ? String(cfg.site.automatedGenerationNotice).trim()
      : 'Every brief and analysis line on this page is written by an AI model from ' +
        'retrieved sources. It is not the site owner\'s reporting, analysis or endorsement.'),
    attribution: 'Every item names its outlet and links the original. Briefs are original ' +
      'summaries, not reproductions of source text.',
    requirements: ['REQ-LEG-1', 'REQ-LEG-2', 'REQ-LEG-3', 'REQ-LEG-4', 'REQ-LEG-5', 'REQ-LEG-6'],
  };
}

// Timestamped by ACTUAL RUN TIME, never by intended slot: spec §3.2 records
// that GitHub `schedule` triggers are best-effort and "occasionally delayed by
// 15+ minutes and occasionally skipped entirely".
function slotFor(now, cfg) {
  const local = new Date(now.toLocaleString('en-US', { timeZone: cfg.schedule.timezone }));
  const h = local.getHours();
  const slots = cfg.schedule.slots.map((s) => Number(s.split(':')[0]));
  let best = slots[0];
  for (const s of slots) if (Math.abs(h - s) < Math.abs(h - best)) best = s;
  return best < 12 ? 'am' : 'pm';
}

function build(clusterResults, cfg, now) {
  // Normalize and assign ids, then dedupe by canonical url across ALL
  // clusters -- two clusters can independently surface the same story.
  const seen = new Set();
  const byTopic = new Map();
  for (const r of clusterResults) {
    for (const raw of r.items) {
      let canon;
      try { canon = canonicalUrl(raw.url); } catch (e) { continue; } // unparseable url is dropped, not fatal
      if (seen.has(canon)) continue;
      seen.add(canon);
      const item = {
        id: itemId(raw.url),
        headline: String(raw.headline || '').trim(),
        source: String(raw.source || '').trim(),
        url: canon,
        publishedDate: raw.publishedDate,
        kind: raw.kind,
        brief: String(raw.brief || '').trim(),
        why: String(raw.why || '').trim(),
        topicId: raw.topicId,
      };
      if (!byTopic.has(item.topicId)) byTopic.set(item.topicId, []);
      byTopic.get(item.topicId).push(item);
    }
  }

  // Config order, not response order.
  const groups = cfg.groups.map((g) => ({
    id: g.id,
    label: g.label,
    sections: g.topics.map((t) => ({
      id: t.id,
      label: t.label,
      items: (byTopic.get(t.id) || []).slice(0, t.targetItems || undefined),
    })),
  }));

  const itemCount = groups.reduce((n, g) => n + g.sections.reduce((m, s) => m + s.items.length, 0), 0);
  const paywalled = [];
  const seenPaywalled = new Set();
  for (const r of clusterResults) {
    for (const p of r.paywalled || []) {
      const k = (p.outlet || '') + '|' + (p.headline || '');
      if (seenPaywalled.has(k)) continue;
      seenPaywalled.add(k);
      paywalled.push({ area: p.area || '', headline: p.headline, outlet: p.outlet });
    }
  }

  return {
    schemaVersion: cfg.schemaVersion,
    editionId: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    slot: slotFor(now, cfg),
    windowNote: 'Trailing ' + cfg.windows.default + '; Utah and local sections up to ' + cfg.windows.utahSections,
    itemCount,
    notice: noticeBlock(cfg),
    groups,
    paywalled,
    runReport: null, // filled by generate.js once the gates have run
  };
}

module.exports = { build, noticeBlock, slotFor };
