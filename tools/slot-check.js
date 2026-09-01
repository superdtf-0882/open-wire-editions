#!/usr/bin/env node
'use strict';
// REQ-OPS-1's other half. The workflow fires hourly on UTC; this decides
// whether the local America/Denver hour matches a configured slot, so DST is
// handled by the timezone database rather than by remembering to edit a cron
// expression twice a year.
//
// Writes a GITHUB_OUTPUT line. Prints its reasoning to stderr so the decision
// is legible in the run log even when the answer is "no".

const { load } = require('../lib/config');

const cfg = load();
const now = new Date();
const localHour = Number(
  new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.schedule.timezone, hour: '2-digit', hour12: false,
  }).format(now)
);
const slots = cfg.schedule.slots.map((s) => Number(String(s).split(':')[0]));
const match = slots.includes(localHour);

process.stderr.write(
  'slot-check: ' + now.toISOString() + ' is hour ' + localHour + ' in ' + cfg.schedule.timezone +
  '; slots ' + slots.join(',') + ' -> ' + (match ? 'RUN' : 'no-op') + '\n'
);
process.stdout.write('run=' + match + '\n');
