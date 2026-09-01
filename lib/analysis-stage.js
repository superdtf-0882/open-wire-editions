'use strict';
// The S5 analysis-gate pass over an assembled edition. Option B wiring.
//
// David's ruling 2026-09-01: "Take option B -- hold source text in the
// runner." This is the consumer that makes the store worth having.
//
// ENFORCEMENT IS OFF BY DEFAULT AND THAT IS A DELIBERATE, REVERSIBLE CALL.
// Measured 2026-09-01 against the 85-line golden set WITH real article text
// retrieved for 72 of them:
//
//   pass                                  16
//   fail, no text retrieved (403 etc)     11
//   fail, text under 3000 chars (shell)    4
//   fail, SUBSTANTIAL text retrieved      54   <- of which only 9 involve a numeral
//
// Enforcing G-A1.3 today would strip the analysis line from roughly two thirds
// of items -- including lines a human wrote and published. The residue is
// dominated by ORDINARY ANALYTICAL ENGLISH that a token-subset test cannot
// pass: "Beijing" where the article says "China", "Himalayan" for a region the
// article describes geographically, "European" for the EU. Those are metonymy
// and paraphrase, not fabrication, and no quantity of source text resolves
// them.
//
// So the pass RUNS and RECORDS on every item, and drops nothing, until the
// calibration is ruled. Flip wire.config.yaml's gates.analysisEnforcement to
// "enforce" when it is. The verdicts are in every run report either way, so
// the flip is made on evidence that accumulates in the meantime rather than on
// this one fixture.

const { runDeterministic } = require('./analysis-gates');
const { allItems } = require('./gates');

// A1-010: on a failed gate the item is regenerated once, and on a second
// failure publishes with `w` omitted. Regeneration needs another model call
// and is NOT built -- so under "enforce" this drops straight to omission and
// says so, rather than silently skipping a step the spec requires.
function runAnalysisGates(edition, cfg, sourceText, opts = {}) {
  const mode = (cfg.gates && cfg.gates.analysisEnforcement) || 'report';
  const items = allItems(edition);
  const verdicts = [];
  let dropped = 0, hard = 0, soft = 0;
  const nounObservations = {};

  for (const it of items) {
    const w = it.why;
    if (!w) continue;
    const r = runDeterministic(w, it, {
      lexicon: opts.lexicon,
      sourceText: sourceText ? sourceText.get(it.id) : '',
    });
    for (const n of r.unverifiedNouns || []) nounObservations[n] = (nounObservations[n] || 0) + 1;
    if (!r.ok) {
      (r.hardFail ? (hard++, 0) : (soft++, 0));
      verdicts.push({
        id: it.id,
        topicId: it.topicId,
        hard: r.hardFail,
        failed: r.checks.filter((c) => c.status === 'fail').map((c) => c.id + ': ' + c.detail),
        hadSourceText: sourceText ? sourceText.has(it.id) : false,
      });
      if (mode === 'enforce') {
        delete it.why;              // A1-011: the ITEM still publishes
        dropped++;
      }
    }
  }

  return {
    mode,
    itemsChecked: items.filter((i) => i.why !== undefined || true).length,
    linesFailing: verdicts.length,
    hardFailures: hard,
    softFailures: soft,
    linesDropped: dropped,
    regenerationImplemented: false,   // A1-010's first half is not built
    // OBSERVATION, NOT A VERDICT. G-A1.3 was narrowed to numerals on David's
    // ruling 2026-09-01, which accepts that a fabricated NAME passes. This
    // counts what the dropped half would have flagged, so the risk is
    // measurable over real runs instead of argued from one fixture.
    unverifiedNounsObserved: Object.entries(nounObservations).sort((a, b) => b[1] - a[1]).slice(0, 30),
    verdicts: verdicts.slice(0, 40),  // bounded: the run report is read by humans
    note: mode === 'report'
      ? 'REPORT ONLY -- no line dropped. The G-A1.3 calibration IS ruled (narrowed to numerals, David 2026-09-01) and the rate is now 14/85 rather than 72/85. Enforcement is still off for a DIFFERENT reason: A1-010 requires regenerate-once before omission and that is not built, so enforcing today would omit on first failure. One edit in wire.config.yaml flips it.'
      : 'ENFORCING -- failing lines dropped, items still published (A1-011). Regeneration (A1-010) is not built, so this omits on first failure.',
  };
}

module.exports = { runAnalysisGates };
