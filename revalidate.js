'use strict';
// On-demand revalidation. David 2026-09-01, on activity 1's measurement.
//
// WHY THIS EXISTS. Activity 1 measured that revalidation is REQUEST-DRIVEN:
// the first request after an edition lands is served the PREVIOUS render, and
// that request is what triggers regeneration. So without this call the first
// reader of every edition receives edition N-1 BY CONSTRUCTION -- ADR-009 R3
// as amended to v3 on 2026-09-01. A shorter revalidate interval does not help;
// the property is a position in the request queue, not a duration.
//
// SHAPE A STILL HOLDS. This is a CALL to a route the site owns, not a write to
// the site's repository. The machine never commits to
// superdtf-0882.github.io.
//
// FAIL-SOFT BY CONTRACT. This function never throws for a failed call. A
// commit that lands with a failed revalidation leaves the site STALE rather
// than WRONG, which is the same posture AC-011 requires of the fetch itself.
// Its result is reported, and the edition stands either way.

const DEFAULT_ENDPOINT = 'https://davidfacer.com/api/revalidate-wire';
const TIMEOUT_MS = 10000;

async function revalidate(editionId, { fetchImpl = globalThis.fetch, endpoint, secret } = {}) {
  const url = endpoint || process.env.OPEN_WIRE_REVALIDATE_URL || DEFAULT_ENDPOINT;
  const token = secret || process.env.OPEN_WIRE_REVALIDATE_SECRET;

  // Not configured is a REPORTED state, not a failure: the second credential
  // is David's to place, and until it exists the pipeline should still publish.
  if (!token) return { ok: false, detail: 'OPEN_WIRE_REVALIDATE_SECRET not set -- call skipped, edition published' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-open-wire-secret': token },
      body: JSON.stringify({ editionId }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, detail: 'HTTP ' + res.status };
    return { ok: true, detail: 'HTTP ' + res.status };
  } catch (e) {
    return { ok: false, detail: e.name === 'AbortError' ? 'timeout after ' + TIMEOUT_MS + 'ms' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { revalidate, DEFAULT_ENDPOINT };
