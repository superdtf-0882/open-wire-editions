'use strict';
// S5 gates on the "Why It Matters" line. WIRE-SPEC-A1 section 6.
//
// Deterministic gates only -- G-A1.1, G-A1.2, G-A1.3. The two judge-model
// gates (G-A1.4 substance, G-A1.5 evenhandedness) need a model call and are
// NOT implemented here; judgeInputs() below assembles what they would receive,
// so the harness exists and the call is the only missing piece.
//
// These gates run per line and are INDEPENDENT of the edition gates in
// gates.js. A dropped `w` does not drop its item: A1-011 requires that an
// edition is never blocked by S4 failure alone. That is a deliberate
// difference from the closing gates, and section 4 of the activity-5 brief
// records that it needs reconciling with AC-011's fail-closed clause.

const { fillerLexicon } = require('./prompts');

const pass = (id, detail) => ({ id, status: 'pass', detail });
const fail = (id, detail, hard) => ({ id, status: 'fail', detail, hard: !!hard });

// --- G-A1.1: no filler ------------------------------------------------------
function gA1_1(w, lexicon = fillerLexicon()) {
  const hay = w.toLowerCase();
  const hits = lexicon.filter((p) => hay.includes(p));
  return hits.length
    ? fail('G-A1.1', 'filler phrase: "' + hits.join('", "') + '"')
    : pass('G-A1.1', 'no filler phrase from the lexicon');
}

// --- G-A1.2: shape ----------------------------------------------------------
// A1-005: one to three sentences, 30 to 80 words.
function sentenceCount(w) {
  // Abbreviations and decimals must not split a sentence: "U.S." and "3.7%"
  // are one token each, and an em-dash is not a terminator.
  const masked = w
    .replace(/\b(?:[A-Z]\.){2,}/g, 'X')
    .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sen|Rep|Gov|St|vs|etc|approx|no)\./gi, 'X')
    .replace(/\d\.\d/g, '0');
  return (masked.match(/[.!?](?:\s|$)/g) || []).length || 1;
}

function gA1_2(w, bounds = { minWords: 30, maxWords: 80, maxSentences: 3 }) {
  const words = w.split(/\s+/).filter(Boolean).length;
  const sentences = sentenceCount(w);
  const errs = [];
  if (words < bounds.minWords || words > bounds.maxWords) {
    errs.push(words + ' words (bounds ' + bounds.minWords + '-' + bounds.maxWords + ')');
  }
  if (sentences > bounds.maxSentences) errs.push(sentences + ' sentences (max ' + bounds.maxSentences + ')');
  return errs.length ? fail('G-A1.2', errs.join('; ')) : pass('G-A1.2', words + ' words, ' + sentences + ' sentence(s)');
}

// --- G-A1.3: no unverified specifics -- HARD FAIL ---------------------------
// "Numerals and proper nouns in `w` are a subset of those in `b` plus the
// fetched source text." This is the counterpart to AD A1.1 at the field level:
// extraction is verified, so anything specific in analysis that was not in
// extraction is by definition unverified and is not published.
//
// SCOPE NARROWING, STATED RATHER THAN HIDDEN: the pipeline does not retain
// fetched source text, so this checks `w` against the item's BRIEF AND
// HEADLINE ONLY. That is strictly stricter than the spec -- it can flag a
// figure that was genuinely in the source but not in the brief. The spec
// anticipates exactly this and routes flagged cases to the judge before a
// drop; findings are therefore returned as `hard` and are meant to be
// adjudicated, not applied blindly.

const STOPWORDS = new Set([
  'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'It', 'Its', 'If', 'In', 'On', 'At', 'By',
  'For', 'From', 'With', 'And', 'But', 'Or', 'So', 'As', 'To', 'Of', 'Their', 'They', 'What',
  'When', 'Where', 'Which', 'While', 'Who', 'Why', 'How', 'Not', 'No', 'Once', 'Unlike', 'Both',
  'Each', 'Every', 'Where', 'Here', 'There', 'Now', 'Then', 'Because', 'Since', 'After', 'Before',
]);

function numerals(s) {
  // Bare integers, decimals, percentages and currency, normalised so that
  // "$4,400" in a brief matches "4400" in a line.
  return new Set((s.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '').replace(/,/g, '')));
}

function properNouns(s) {
  const out = new Set();
  // Sentence-initial words are excluded -- capitalisation there carries no
  // information, and including them produced false positives on "The".
  for (const m of s.matchAll(/(^|[.!?]\s+|\s)([A-Z][a-zA-Z'’.-]*(?:\s+[A-Z][a-zA-Z'’.-]*)*)/g)) {
    const isSentenceStart = m[1] !== ' ';
    const phrase = m[2].trim();
    for (const tok of phrase.split(/\s+/)) {
      const clean = tok.replace(/[^A-Za-z'’.-]/g, '');
      if (!clean || clean.length < 2) continue;
      if (STOPWORDS.has(clean)) continue;
      if (isSentenceStart && phrase.split(/\s+/).length === 1) continue;
      out.add(clean.replace(/[.'’-]+$/, ''));
    }
  }
  return out;
}

function gA1_3(w, item, sourceText = '') {
  const verified = [item.brief || '', item.headline || '', item.source || '', sourceText].join(' ');
  const vNum = numerals(verified);
  const vNoun = properNouns(verified);
  // A proper noun already present as a substring of the verified text counts,
  // so "Beijing's" in a line matches "Beijing" in a brief.
  const vFlat = verified.toLowerCase();

  const badNum = [...numerals(w)].filter((n) => !vNum.has(n) && !vFlat.includes(n));
  const badNoun = [...properNouns(w)].filter((n) => !vNoun.has(n) && !vFlat.includes(n.toLowerCase()));

  const errs = [];
  if (badNum.length) errs.push('unverified numeral(s): ' + badNum.join(', '));
  if (badNoun.length) errs.push('unverified proper noun(s): ' + badNoun.join(', '));
  return errs.length
    ? fail('G-A1.3', errs.join('; ') + ' -- adjudicate before drop', true)
    : pass('G-A1.3', 'all numerals and proper nouns appear in the verified fields');
}

// --- the deterministic pass -------------------------------------------------
// Returns { ok, checks, hardFail }. ok=false means regenerate once then drop
// the line; hardFail=true means never publish this line regardless.
function runDeterministic(w, item, opts = {}) {
  const lexicon = opts.lexicon || fillerLexicon();
  const checks = [gA1_1(w, lexicon), gA1_2(w, opts.bounds), gA1_3(w, item, opts.sourceText)];
  return {
    ok: !checks.some((c) => c.status === 'fail'),
    hardFail: checks.some((c) => c.status === 'fail' && c.hard),
    checks,
  };
}

// What the judge gates would receive. Assembled here so the boundary is
// defined and testable even though the model call is not built.
function judgeInputs(w, item, politicallyTagged = false) {
  return {
    gate: politicallyTagged ? ['G-A1.4', 'G-A1.5'] : ['G-A1.4'],
    headline: item.headline,
    brief: item.brief,
    line: w,
    politicallyTagged,
    threshold: 2,
  };
}

// A1-003 / A1-004: the S4 response must cover exactly the ids supplied and
// carry nothing but id and w. The pipeline joins by id; the model never writes
// an item field. This is AD A1.3, the addendum's load-bearing control.
function validateResponse(response, suppliedIds) {
  if (!Array.isArray(response)) return { ok: false, detail: 'response is not an array' };
  const supplied = new Set(suppliedIds);
  const seen = new Set();
  for (const row of response) {
    const keys = Object.keys(row);
    if (keys.length !== 2 || !keys.includes('id') || !keys.includes('w')) {
      return { ok: false, detail: 'row carries fields other than id and w: ' + keys.join(', ') };
    }
    if (!supplied.has(row.id)) return { ok: false, detail: 'unknown id: ' + row.id };
    if (seen.has(row.id)) return { ok: false, detail: 'duplicate id: ' + row.id };
    seen.add(row.id);
  }
  const missing = [...supplied].filter((id) => !seen.has(id));
  if (missing.length) return { ok: false, detail: missing.length + ' supplied id(s) omitted: ' + missing.slice(0, 3).join(', ') };
  return { ok: true, detail: seen.size + ' ids, exactly those supplied, id and w only' };
}

module.exports = { gA1_1, gA1_2, gA1_3, runDeterministic, judgeInputs, validateResponse, sentenceCount, numerals, properNouns };
