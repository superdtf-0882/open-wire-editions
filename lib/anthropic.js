'use strict';
// The Anthropic call for one topic cluster.
//
// REQ-SEC-1: the key is read from the process environment ONLY. It is never
// written to a file, never placed in the edition, never logged, and never
// echoed in an error. redactKey() below is the one place that guarantees the
// last of those -- an SDK error message can otherwise carry a request dump.
//
// EXAMPLE-CALL.md: "The web_search tool type string and the structured-output
// mechanism are versioned and will drift. Verify both against current API
// docs." Both are therefore config/constant rather than scattered literals.

const { systemPrompt, userMessage, RECORD_DIGEST_TOOL } = require('./prompt');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';

// Pricing is recorded here so REQ-GATE-9 can be evaluated from real usage
// rather than guessed (spec §10). USD per million tokens; searches billed
// separately per 1k. Verify against current pricing when the model is repinned.
const PRICING = {
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-5': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
};
const SEARCH_USD_PER_1K = 10;

function redactKey(s, key) {
  if (!key) return String(s);
  return String(s).split(key).join('[REDACTED ANTHROPIC KEY]');
}

function estimateCost(modelId, tokens, searches) {
  const p = PRICING[modelId];
  if (!p) return null; // unknown model -- reported as null, never as zero
  return (
    (tokens.input / 1e6) * p.inputPerMTok +
    (tokens.output / 1e6) * p.outputPerMTok +
    (searches / 1000) * SEARCH_USD_PER_1K
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// REQ-OPS-4: transient failures retry with exponential backoff, bounded.
// 429 and 5xx are transient; 4xx other than 429 is not and fails immediately
// rather than burning the run's time budget on a request that cannot succeed.
async function callWithRetry(body, { apiKey, maxAttempts = 4, baseDelayMs = 2000, fetchImpl = globalThis.fetch, deadline = Infinity }) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() > deadline) throw new Error('run time budget exhausted before attempt ' + attempt);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json();
      const text = await res.text().catch(() => '');
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error('HTTP ' + res.status + ': ' + redactKey(text, apiKey).slice(0, 300));
      } else {
        throw new Error('HTTP ' + res.status + ' (not retryable): ' + redactKey(text, apiKey).slice(0, 300));
      }
    } catch (e) {
      if (/not retryable/.test(e.message)) throw new Error(redactKey(e.message, apiKey));
      lastErr = e;
    }
    if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  throw new Error(redactKey('all ' + maxAttempts + ' attempts failed: ' + (lastErr && lastErr.message), apiKey));
}

function extractDigest(response) {
  const block = (response.content || []).find((c) => c.type === 'tool_use' && c.name === 'record_digest');
  if (!block) throw new Error('model did not call record_digest');
  return block.input;
}

function countSearches(response) {
  return (response.content || []).filter((c) => c.type === 'server_tool_use' || c.type === 'web_search_tool_result').length;
}

// One cluster. Returns { id, status, items, paywalled, searches, attempts,
// tokens, note }. Per REQ-OPS-5 a cluster that fails after retries does NOT
// fail the run -- it returns status 'failed' and the caller carries on, with
// the affected topics judged against REQ-GATE-4 on their own.
async function runCluster(cluster, cfg, { apiKey, now = new Date(), fetchImpl = globalThis.fetch, deadline = Infinity }) {
  const topics = cluster.topics.map((id) => {
    const t = cfg.topic(id);
    if (!t) throw new Error('cluster ' + cluster.id + ' names unknown topic ' + id);
    return { ...t, resolvedWindow: cfg.windows[t.window] || cfg.windows.default };
  });
  const minSearches = topics.reduce((n, t) => n + Math.max(3, t.targetItems || 5), 0);

  const body = {
    model: cfg.model.id,
    max_tokens: cfg.model.maxTokensPerCluster,
    temperature: cfg.model.temperature,
    system: systemPrompt(),
    tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: minSearches * 2 }, RECORD_DIGEST_TOOL],
    messages: [{ role: 'user', content: userMessage({ topics, sources: cfg.sources, now, minSearches }) }],
  };

  const tokens = { input: 0, output: 0 };
  let searches = 0;
  let note;

  // §9.3: "Reject and retry once on schema-invalid output before treating the
  // cluster as failed." The sample run report's cluster C shows attempts: 2
  // for exactly this.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await callWithRetry(body, { apiKey, fetchImpl, deadline });
      tokens.input += (res.usage && res.usage.input_tokens) || 0;
      tokens.output += (res.usage && res.usage.output_tokens) || 0;
      searches += countSearches(res);
      const digest = extractDigest(res);
      const items = (digest.items || []).filter((it) => cluster.topics.includes(it.topicId));
      if (!items.length) throw new Error('no items for this cluster\'s topics');
      return {
        id: cluster.id, status: 'ok', items, paywalled: digest.paywalled || [],
        searches, attempts: attempt, tokens, note,
      };
    } catch (e) {
      note = redactKey(e.message, apiKey).slice(0, 200);
      if (attempt === 1) note = 'first attempt failed; retried once -- ' + note;
    }
  }
  return { id: cluster.id, status: 'failed', items: [], paywalled: [], searches, attempts: 2, tokens, note };
}

module.exports = { runCluster, estimateCost, redactKey, PRICING, WEB_SEARCH_TOOL_TYPE, API_VERSION };
