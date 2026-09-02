// check-config.js - run this FIRST on a board you haven't used before.
//
// Reads the board's actual column -> status mapping from Jira and cross-checks it
// against what this tool currently treats as finished. Catches the silent failure
// mode: a status this tool doesn't recognise is treated as UNFINISHED, so every
// completion rate and carry-out number comes out wrong but plausible.
//
//   node src/check-config.js
//
// Fix any mismatch by setting DONE_STATUSES / AWAITING_RELEASE_STATUSES in .env.

import 'dotenv/config';
import { jiraFetch } from './jira.js';
import { TERMINAL, AWAITING_RELEASE, BASELINE_SPRINT_NUM } from './status.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;

(async () => {
  if (!BOARD_ID) {
    console.error('JIRA_BOARD_ID not set in .env. Run: node src/find-boards.js');
    process.exit(1);
  }

  const cfg = await jiraFetch(`/rest/agile/1.0/board/${BOARD_ID}/configuration`);
  const all = await jiraFetch('/rest/api/3/status');
  const nameById = Object.fromEntries(all.map((s) => [String(s.id), s.name]));

  console.log(`Board ${BOARD_ID}: ${cfg.name}\n`);
  console.log('Columns, left to right, and how this tool classifies each status:\n');

  const known = new Set([...TERMINAL, ...AWAITING_RELEASE]);
  const unrecognised = [];
  const columns = cfg.columnConfig?.columns || [];

  columns.forEach((col, i) => {
    const isLast = i >= columns.length - 2; // last couple of columns are usually "done"-ish
    console.log(`  ${col.name}`);
    const statuses = (col.statuses || []).map((s) => nameById[String(s.id)] || s.id);
    if (!statuses.length) console.log('      (no statuses mapped)');
    for (const name of statuses) {
      const low = name.toLowerCase();
      let label;
      if (TERMINAL.includes(low)) label = 'shipped  (isShipped + isComplete)';
      else if (AWAITING_RELEASE.includes(low)) label = 'complete (isComplete only)';
      else {
        label = 'NOT finished';
        if (isLast) unrecognised.push({ col: col.name, name });
      }
      console.log(`      ${name.padEnd(26)} -> ${label}`);
    }
  });

  console.log('\nCurrent settings:');
  console.log(`  DONE_STATUSES              = ${TERMINAL.join(', ')}`);
  console.log(`  AWAITING_RELEASE_STATUSES  = ${AWAITING_RELEASE.join(', ')}`);
  console.log(`  BASELINE_SPRINT_NUM        = ${BASELINE_SPRINT_NUM}`);

  // Statuses this tool knows about that the board never uses - usually harmless
  const onBoard = new Set(
    columns.flatMap((c) => (c.statuses || []).map((s) => (nameById[String(s.id)] || '').toLowerCase())),
  );
  const unused = [...known].filter((k) => !onBoard.has(k));

  if (unrecognised.length) {
    console.log('\n*** ACTION NEEDED ***');
    console.log('These statuses sit in the final columns but are counted as UNFINISHED:');
    for (const u of unrecognised) console.log(`  - "${u.name}"  (column: ${u.col})`);
    console.log('\nAdd them to DONE_STATUSES (actually shipped) or AWAITING_RELEASE_STATUSES');
    console.log('(passed QA, waiting on a release) in .env, then re-run this check.');
  } else {
    console.log('\nNo unrecognised statuses in the final columns - configuration looks right.');
  }

  if (unused.length) {
    console.log(`\nFYI, configured but unused on this board: ${unused.join(', ')}`);
  }

  console.log('\nAlso worth setting for a new board: BASELINE_SPRINT_NUM, the first sprint');
  console.log('number to include in historical baselines (defaults to 22, which is KEEN-specific).');
})();
