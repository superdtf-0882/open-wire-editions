'use strict';
// wire.config.yaml is the source of truth for coverage (REQ-CFG-1): editing it
// must change behaviour with no code change. Nothing in lib/ hardcodes a
// topic, a window, a threshold or a deny-list entry.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WINDOW_MS = { h: 3600e3, d: 86400e3 };

function load(file) {
  const p = file || path.join(__dirname, '..', 'wire.config.yaml');
  const cfg = yaml.load(fs.readFileSync(p, 'utf8'));

  // Fail loudly at load rather than at 06:00 on a schedule nobody is watching.
  const need = ['schemaVersion', 'promptVersion', 'schedule', 'budget', 'windows', 'model', 'gates', 'sources', 'clusters', 'groups'];
  const missing = need.filter((k) => cfg[k] === undefined);
  if (missing.length) throw new Error('wire.config.yaml missing: ' + missing.join(', '));
  if (/^<.*>$/.test(String(cfg.model.id))) {
    throw new Error('wire.config.yaml model.id is still the placeholder -- pin an exact model id');
  }

  cfg.allTopics = () => cfg.groups.flatMap((g) => g.topics.map((t) => ({ ...t, groupId: g.id })));
  cfg.topic = (id) => cfg.allTopics().find((t) => t.id === id);
  cfg.utahTopicIds = () =>
    cfg.allTopics().filter((t) => t.window && t.window !== 'default').map((t) => t.id);
  cfg.windowMs = (spec) => {
    const m = String(spec).match(/^(\d+)([hd])$/);
    if (!m) throw new Error('unparseable window: ' + spec);
    return Number(m[1]) * WINDOW_MS[m[2]];
  };
  cfg.cluster = (id) => cfg.clusters.find((c) => c.id === id);
  return cfg;
}

module.exports = { load };
