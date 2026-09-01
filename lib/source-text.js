'use strict';
// Ephemeral source-text store. David's ruling 2026-09-01: "Take option B --
// hold source text in the runner."
//
// WHY THIS EXISTS. G-A1.3 is specified against "b plus the fetched source
// text". The pipeline retained no source text, so the gate ran against the
// 2-3 sentence brief alone and rejected 78 of 85 human-accepted lines. The
// measured cause was not ungroundedness but the BRIEF'S COMPRESSION: `w` is
// written against the article, `b` summarises it, and the gap between them was
// being reported as a fabrication risk.
//
// THE CONSTRAINT THAT SHAPES EVERY LINE BELOW. The content repository is
// PUBLIC. Text retained IN the repository is PUBLISHED, and REQ-LEG-1 bars
// reproducing article paragraphs. DTOG's 38- section 2 resolved this by asking
// WHERE rather than WHETHER: the text lives in the runner's own memory for the
// duration of the run and is discarded. REQ-LEG-4 permits it (the text came
// from the search tool); REQ-LEG-1 is never engaged (nothing is reproduced,
// nothing is committed).
//
// SO THIS STORE IS STRUCTURALLY SEPARATE FROM THE EDITION. It is not a field
// on an item and not a field on the edition. It is a Map the edition object
// has no reference to, held beside the pipeline rather than inside it, and
// test/source-text.test.js asserts that no serialised edition ever contains
// text that passed through here. A convention would not survive a refactor;
// a separate object with no path into the payload might.
//
// IT NEVER TOUCHES DISK. Not a temp file, not a cache directory. Process exit
// is the discard, and dispose() makes it explicit for a long-lived process.

const MAX_CHARS_PER_ITEM = 40000;   // enough for a long article; bounds memory
const FETCH_TIMEOUT_MS = 8000;

class SourceTextStore {
  constructor() {
    this._byId = new Map();
    this._origin = new Map();   // where each entry came from, for the run report
    this.disposed = false;
  }

  set(id, text, origin) {
    if (this.disposed) throw new Error('SourceTextStore used after dispose()');
    if (!text) return;
    this._byId.set(id, String(text).slice(0, MAX_CHARS_PER_ITEM));
    this._origin.set(id, origin);
  }

  get(id) {
    return this._byId.get(id) || '';
  }

  has(id) { return this._byId.has(id); }
  get size() { return this._byId.size; }

  // What the run report records. COUNTS AND ORIGINS ONLY -- never the text.
  summary() {
    const byOrigin = {};
    for (const o of this._origin.values()) byOrigin[o] = (byOrigin[o] || 0) + 1;
    return { items: this._byId.size, byOrigin };
  }

  // Explicit discard. Also called on process exit by install() below, so a
  // crash between the gates and the commit does not leave the text reachable
  // from a heap dump for longer than the process lives.
  dispose() {
    this._byId.clear();
    this._origin.clear();
    this.disposed = true;
  }
}

// Pull retrieved page text out of an Anthropic response, if the web-search
// tool returns it. EXAMPLE-CALL.md warns that the tool's shape is versioned
// and will drift, so this is written defensively and reports what it found
// rather than assuming a shape.
//
// UNVERIFIED AS OF 2026-09-01: no API call has been made. If these blocks
// carry page text, source capture costs ZERO ADDITIONAL FETCHES. If they do
// not, fetchInto() below supplies the same input from the pass REQ-GATE-2
// already makes. The run report records which path actually fed the gate, so
// the first real run answers the question instead of a design note guessing.
function harvestFromResponse(response, store, urlToId) {
  let found = 0;
  for (const block of response.content || []) {
    if (block.type !== 'web_search_tool_result') continue;
    const results = Array.isArray(block.content) ? block.content : [block.content];
    for (const r of results) {
      if (!r || typeof r !== 'object') continue;
      const text = r.page_content || r.content || r.text || r.encrypted_content;
      const url = r.url;
      if (!text || !url || typeof text !== 'string') continue;
      const id = urlToId(url);
      if (!id) continue;
      store.set(id, text, 'web_search_tool_result');
      found++;
    }
  }
  return found;
}

// Extract readable text from HTML. Deliberately crude: G-A1.3 only needs to
// know whether a token APPEARS, so a perfect reader-mode extraction would be
// precision this gate cannot use. Scripts and styles are stripped because
// their contents produce false ACCEPTS -- a proper noun inside a tracking
// script would verify a line that the article never supported.
function textFromHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetch one item's page into the store. Failure is NOT an error: a page that
// cannot be read leaves the gate running against the brief alone for that
// item, which is the pre-Option-B behaviour rather than a new failure mode.
async function fetchInto(store, item, fetchImpl = globalThis.fetch) {
  if (store.has(item.id)) return 'already-held';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(item.url, { redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return 'http-' + res.status;
    const ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
    if (ct && !/text\/html|text\/plain|application\/xhtml/i.test(ct)) return 'skipped-content-type';
    store.set(item.id, textFromHtml(await res.text()), 'fetch');
    return 'ok';
  } catch (e) {
    return e.name === 'AbortError' ? 'timeout' : 'error';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { SourceTextStore, harvestFromResponse, fetchInto, textFromHtml, MAX_CHARS_PER_ITEM };
