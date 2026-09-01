'use strict';
// Prompt loading. WIRE-SPEC-A1 section 4 and requirements A1-014 to A1-017.
//
// A1-014: prompt files in prompts/wire/ are THE ONLY SOURCE OF PROMPT TEXT.
// No prompt string literals in application source, no prompt text in a
// database or content system, no runtime mutation. This module is the only
// place that reads them, and it exposes no setter.
//
// A1-015: manifest.yaml binds each stage to a prompt file, a model id and a
// semantic version, and is THE SINGLE POINT OF MODEL SELECTION.
//
// A1-017: the cache prefix is the analyst profile then the task contract, in
// that order, with run context following. The cache key is the content hash of
// the prefix -- computed here from the bytes actually loaded, so it cannot
// drift from the files it describes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const DIR = path.join(__dirname, '..', 'prompts', 'wire');
const PROFILE_WORD_CAP = 1200;   // section 7. Enforced, not advised.

function readFile(name) {
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) throw new Error('prompt file missing: prompts/wire/' + name);
  return fs.readFileSync(p, 'utf8');
}

function wordCount(s) {
  return s.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
}

function manifest() {
  const m = yaml.load(readFile('manifest.yaml'));
  if (!m || !m.stages) throw new Error('manifest.yaml has no stages');
  if (!m.manifestVersion) throw new Error('manifest.yaml has no manifestVersion');
  return m;
}

// The filler lexicon is DATA, not prose (section 4's own classification), so it
// is parsed rather than injected into a prompt. Comments and blanks dropped.
function fillerLexicon() {
  return readFile('filler-lexicon.txt')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.toLowerCase());
}

// Load one stage. Returns everything needed to make the call and everything
// needed to record provenance afterwards (A1-016).
function loadStage(name) {
  const m = manifest();
  const s = m.stages[name];
  if (!s) throw new Error('manifest.yaml has no stage "' + name + '"; have: ' + Object.keys(m.stages).join(', '));

  const task = readFile(s.prompt);
  const profile = s.profile ? readFile(s.profile) : null;

  // Section 7's cap is a control: a profile that can only grow becomes
  // sediment, so an over-long profile REFUSES rather than warns.
  if (profile) {
    const n = wordCount(profile);
    if (n > PROFILE_WORD_CAP) {
      throw new Error(
        s.profile + ' is ' + n + ' words, over the ' + PROFILE_WORD_CAP + '-word cap (WIRE-SPEC-A1 section 7). ' +
        'Retire a worked example rather than raising the cap -- the cap is the mechanism.');
    }
  }

  // A1-017: prefix order comes from the manifest, not from this code.
  const order = (m.cachePrefix && m.cachePrefix.order) || ['profile', 'task'];
  const prefix = order.map((k) => (k === 'profile' ? profile : task)).filter(Boolean).join('\n\n---\n\n');

  return {
    stage: name,
    status: s.status,
    model: s.model,
    version: s.version,
    manifestVersion: m.manifestVersion,
    profile,
    task,
    prefix,
    cacheKey: crypto.createHash('sha256').update(prefix).digest('hex').slice(0, 16),
    crossEditionContext: m.crossEditionContext || { editions: 6, ratified: false },
  };
}

// A1-016's provenance block. The commit SHA is passed in rather than shelled
// for, so this stays pure and testable; generate.js supplies it from the
// environment on a runner and from git locally.
function provenance(stages, commitSha) {
  const m = manifest();
  return {
    manifestVersion: m.manifestVersion,
    commitSha: commitSha || process.env.GITHUB_SHA || null,
    models: Object.fromEntries(stages.map((n) => [n, m.stages[n] && m.stages[n].model])),
    promptVersions: Object.fromEntries(stages.map((n) => [n, m.stages[n] && m.stages[n].version])),
  };
}

module.exports = { loadStage, manifest, fillerLexicon, provenance, wordCount, PROFILE_WORD_CAP, DIR };
