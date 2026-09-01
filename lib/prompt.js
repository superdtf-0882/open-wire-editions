'use strict';
// The synthesis prompt as a NAMED VERSIONED CONSTANT.
//
// Spec §9.4: "The prompt is a versioned artifact, not a string literal buried
// in code ... treat a prompt change like a code change -- reviewed, and
// observable in the diff of the resulting edition."
//
// GOVERNANCE STATUS -- read this before changing anything below.
// P-07 (Prompt Versioning and Approval Gate) binds this file, and its
// cp_scope is "All production AI routes across the davidfacer.com portfolio".
// WP-WIRE-01 activity 5 requires DAVID'S APPROVAL BEFORE PRODUCTION.
// AS OF 2026-09-01 THAT APPROVAL HAS NOT BEEN GIVEN. The constant exists so
// activity 4 has something to call and so the text is reviewable in a diff;
// it is NOT approved, and generate.js refuses a production run without
// OPEN_WIRE_PROMPT_APPROVED set. Activity 5 closes this.
//
// PROMPT_VERSION is stamped into every edition's runReport. Bump it in the
// same commit as any text change below, and in wire.config.yaml's
// promptVersion, or the two disagree and the edition misreports its own
// provenance.

const PROMPT_VERSION = '1.0.0';

// Verbatim from open-wire-spec.md v1.0 §9.1. Not paraphrased.
const SYSTEM_PROMPT = `You are a research assistant compiling a paywall-free news digest. You have
web search available and you must use it: your training data is stale and
every item you return must come from a search result you actually retrieved
in this session.

Absolute rules:

1. NEVER invent a headline, URL, figure, quotation or date. If you cannot
   verify something from a retrieved page, omit it.
2. NEVER link a paywalled or metered page. The denied domains are listed in
   the user message. If a significant story exists only behind a paywall,
   report it in the \`paywalled\` array with its headline and outlet, and no URL.
3. NEVER reproduce source text. Briefs must be your own summary. Quote at
   most one short fragment per item, in quotation marks, where the exact
   wording matters.
4. Return fewer real items rather than padding to a target. A short section
   is acceptable; a fabricated one is not.
5. On political subjects -- American, Utah and foreign -- report what happened
   and what is at stake. Do not editorialize, take sides, or characterize
   motives beyond what sources state.

Search first, then call record_digest exactly once with your complete result.
Output only the requested JSON. No preamble, no commentary, no explanation
of what you did.`;

// Verbatim from §9.2, with {{...}} resolved from config rather than by a
// template engine -- the substitutions are few and explicit.
function userMessage({ topics, sources, now, minSearches }) {
  const list = (a) => (a && a.length ? a.join(', ') : '(none configured)');
  const topicBlocks = topics.map((t) => [
    '### ' + t.id + ' -- ' + t.label,
    (t.guidance || '').trim(),
    'Target ' + t.targetItems + ' items, minimum ' + t.minItems + '.',
    'Time window: ' + t.resolvedWindow + '.',
  ].join('\n')).join('\n\n');

  return `Today is ${now.toISOString().slice(0, 10)} (${now.toLocaleString('en-US', { timeZone: 'America/Denver' })} in America/Denver).

Compile digest items for these topics:

${topicBlocks}

## Source rules

DENIED -- never link, for any reason:
${(sources.deny || []).map((d) => '- ' + d).join('\n')}

PREFERRED -- free and open:
- Wires and open outlets: ${list(sources.prefer && sources.prefer.wires)}
- Open-access analysis: ${list(sources.prefer && sources.prefer.analysis)}
- Primary and official documents: ${list(sources.prefer && sources.prefer.primary)}
- Utah free outlets and official sources: ${list(sources.prefer && sources.prefer.utah)}

Use primary sources actively where they exist -- an agency release, a court
filing, a contract announcement or a statistical release is better than
coverage of it.

## Search approach

Run at least ${minSearches} distinct searches across these topics. Vary
your phrasing. Check the preferred outlets directly, not only via general
queries. Prioritise what is newest; a story already widely covered yesterday
is worth including only if it has materially advanced.

## Per-item requirements

- \`headline\`: descriptive, under 160 characters, not the outlet's clickbait
  variant if a plainer framing is more accurate.
- \`source\`: the outlet's human-readable name.
- \`url\`: the canonical article URL, https, no tracking parameters.
- \`publishedDate\`: the article's own publication date, ISO YYYY-MM-DD.
- \`kind\`: "primary" for official documents, agency releases and company
  statements; "analysis" for think-tank and open-access analytical work;
  "news" otherwise. Tag honestly -- do not inflate.
- \`brief\`: two to three sentences. Concrete and factual, with real figures
  where they exist. No adjectives that a wire service would not use.
- \`why\`: one or two sentences of analysis for this specific reader.

## The reader

A product manager and enterprise architect based in Utah who writes
political, economic-development and defense-policy analysis. He is fluent
in: geopolitical realism and deterrence theory; institutions economics
(Acemoglu and Robinson) and development economics (Hausmann-Hidalgo
complexity); ITAR and the ITAR-free procurement trend; European strategic
autonomy and tactical communications (Link 16, ESSOR, SATURN, GCAP);
constitutional law (Youngstown, the War Powers Resolution, separation of
powers, Humphrey's Executor); democratic-backsliding literature; AI's
organizational role -- where it pays off in well-defined processes with
tight feedback loops versus exploratory ones, and the T-shaped specialist;
and Utah's political and academic community.

Write the \`why\` line for that reader. Name the mechanism, the precedent, or
the second-order effect. Assume he already knows the background. Never
write "this could have implications", "it remains to be seen", or any
sentence that would be true of any story in the section.

Return JSON matching the provided schema.`;
}

// The client-side tool that carries structured output. EXAMPLE-CALL.md is
// explicit that tool_choice CANNOT be forced here: the model must stay free to
// call the server-side web_search tool first, so the sequencing lives in the
// system prompt rather than in an API parameter.
const RECORD_DIGEST_TOOL = {
  name: 'record_digest',
  description: 'Record the compiled digest items. Call exactly once, after searching.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            headline: { type: 'string' },
            source: { type: 'string' },
            url: { type: 'string' },
            publishedDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            kind: { type: 'string', enum: ['news', 'analysis', 'primary'] },
            brief: { type: 'string' },
            why: { type: 'string' },
            topicId: { type: 'string' },
          },
          required: ['headline', 'source', 'url', 'publishedDate', 'kind', 'brief', 'why', 'topicId'],
        },
      },
      paywalled: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            area: { type: 'string' },
            headline: { type: 'string' },
            outlet: { type: 'string' },
          },
          required: ['headline', 'outlet'],
        },
      },
    },
    required: ['items'],
  },
};

module.exports = { PROMPT_VERSION, SYSTEM_PROMPT, userMessage, RECORD_DIGEST_TOOL };
