'use strict';
// Assembles the live (combined-stage) call from prompt FILES.
//
// A1-014: prompt files in prompts/wire/ are the only source of prompt text.
// THIS FILE HOLDS NO PROMPT TEXT. It loads, substitutes and returns; the
// system prompt lives in task.combined.md and the user-message template in
// run-context.combined.md. test/analysis.test.js scans lib/ for long template
// literals and fails the build if prompt text creeps back in.
//
// A1-015: the model and the version come from manifest.yaml, not from here.
//
// GOVERNANCE STATUS: APPROVED. P-07 requires a production prompt to be a
// named versioned artifact AND approved by David before Production.
// APPROVED 2026-09-01, to CC directly per RULE-5: "I approve the Open Wire
// prompts ... David Facer 9/1/2026". Recorded in manifest.yaml under
// approval: and as PROMPT-WIRE-V1 in the corpus prompt register.
// THE APPROVAL ATTACHES TO THESE FILES AT THIS VERSION. Editing a prompt
// bumps the stage version in manifest.yaml and needs its own approval before
// Production -- the gate in generate.js stays, it is now satisfied.

const { loadStage } = require('./prompts');

// The prompt body is fenced inside its .md file so the file is readable as a
// document. Extract the fence; if there is none, the whole file is the prompt.
function body(md) {
  const m = md.match(/```\r?\n([\s\S]*?)\r?\n```/);
  return (m ? m[1] : md).trim();
}

function stage() {
  return loadStage('combined');
}

// The system prompt: the analyst profile followed by the task contract, which
// is A1-017's cache-prefix order. Both are files.
function systemPrompt() {
  const s = stage();
  return [s.profile ? body(s.profile) : null, body(s.task)].filter(Boolean).join('\n\n---\n\n');
}

// The run context. Placeholders are substituted here; the TEXT is not here.
function userMessage({ topics, sources, now, minSearches }) {
  const list = (a) => (a && a.length ? a.join(', ') : '(none configured)');
  const topicBlocks = topics.map((t) => [
    '### ' + t.id + ' -- ' + t.label,
    (t.guidance || '').trim(),
    'Target ' + t.targetItems + ' items, minimum ' + t.minItems + '.',
    'Time window: ' + t.resolvedWindow + '.',
  ].join('\n')).join('\n\n');

  const values = {
    today_iso: now.toISOString().slice(0, 10),
    today_local: now.toLocaleString('en-US', { timeZone: 'America/Denver' }),
    topic_blocks: topicBlocks,
    deny_list: (sources.deny || []).map((d) => '- ' + d).join('\n'),
    prefer_wires: list(sources.prefer && sources.prefer.wires),
    prefer_analysis: list(sources.prefer && sources.prefer.analysis),
    prefer_primary: list(sources.prefer && sources.prefer.primary),
    prefer_utah: list(sources.prefer && sources.prefer.utah),
    min_searches: String(minSearches),
  };

  const template = body(require('fs').readFileSync(
    require('path').join(require('./prompts').DIR, 'run-context.combined.md'), 'utf8'));

  // An unsubstituted placeholder means the template and this code have drifted
  // apart, which is a defect rather than a cosmetic issue -- so it refuses.
  const out = template.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in values)) throw new Error('run-context.combined.md uses {{' + k + '}}, which lib/prompt.js does not supply');
    return values[k];
  });
  const left = out.match(/\{\{\w+\}\}/g);
  if (left) throw new Error('unsubstituted placeholders remain: ' + left.join(', '));
  return out;
}

// The client-side tool that carries structured output. This is a SCHEMA, not
// prompt text, and belongs in code: EXAMPLE-CALL.md is explicit that
// tool_choice cannot be forced here, because the model must stay free to call
// the server-side web_search tool first -- so the sequencing lives in the
// system prompt (a file) rather than in an API parameter.
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
          properties: { area: { type: 'string' }, headline: { type: 'string' }, outlet: { type: 'string' } },
          required: ['headline', 'outlet'],
        },
      },
    },
    required: ['items'],
  },
};

// Kept as a named export because generate.js and the run report both cite it.
// It now RESOLVES FROM THE MANIFEST rather than being declared here, so a
// version bump happens in one place.
Object.defineProperty(module.exports, 'PROMPT_VERSION', { get: () => stage().version, enumerable: true });

module.exports.systemPrompt = systemPrompt;
module.exports.userMessage = userMessage;
module.exports.RECORD_DIGEST_TOOL = RECORD_DIGEST_TOOL;
module.exports.body = body;
