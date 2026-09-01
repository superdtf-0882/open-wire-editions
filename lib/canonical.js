'use strict';
// URL canonicalization and stable item ids.
//
// The rules are the spec's (EXAMPLE-CALL.md step 1, spec §4.2) and were
// CONFIRMED AGAINST THE GOLDEN FIXTURE rather than taken from the prose:
// all 85 items in fixtures/current.json reproduce their own `id` under the
// implementation below, and 11/85 under no canonicalization at all. Any
// change here must keep test/gates.test.js's id check at 85/85.

const crypto = require('crypto');

const TRACKING_EXACT = new Set(['fbclid', 'gclid', 'ref', 'igshid', 'mc_cid', 'mc_eid']);
const TRACKING_PREFIX = [/^utm_/, /^_hs/];

function canonicalUrl(raw) {
  const u = new URL(raw);
  u.protocol = 'https:';
  u.hostname = u.hostname.replace(/^www\./, '').toLowerCase();
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_EXACT.has(k) || TRACKING_PREFIX.some((r) => r.test(k))) u.searchParams.delete(k);
  }
  return u.toString().replace(/\/$/, '');
}

// First 16 hex chars of the SHA-256 of the canonical url. Stable across
// editions, which is what makes REQ-GATE-7's carry-over check possible.
function itemId(rawUrl) {
  return crypto.createHash('sha256').update(canonicalUrl(rawUrl)).digest('hex').slice(0, 16);
}

function hostOf(rawUrl) {
  return new URL(canonicalUrl(rawUrl)).hostname;
}

// A deny-list entry matches the host itself or any subdomain of it, so
// "nytimes.com" catches "cooking.nytimes.com". REQ-GATE-3's "host, or parent
// domain".
function hostMatches(host, denyEntry) {
  const d = denyEntry.replace(/^www\./, '').toLowerCase();
  return host === d || host.endsWith('.' + d);
}

module.exports = { canonicalUrl, itemId, hostOf, hostMatches };
