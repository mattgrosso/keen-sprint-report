// Fetch and dump the KEEN board's column-to-status mapping plus the
// project's full status list. Writes to docs/BOARD-CONFIG.md so it's
// a durable reference future Claude sessions can read.
//
// Run with: node src/board-config.js

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { jiraFetch } from './jira.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'KEEN';
const OUT_FILE = 'docs/BOARD-CONFIG.md';

async function main() {
  const config = await jiraFetch(`/rest/agile/1.0/board/${BOARD_ID}/configuration`);
  const projectStatuses = await jiraFetch(`/rest/api/3/project/${PROJECT_KEY}/statuses`);

  const allStatusesMap = new Map();
  for (const issueType of projectStatuses) {
    for (const s of issueType.statuses) {
      if (!allStatusesMap.has(s.id)) {
        allStatusesMap.set(s.id, { id: s.id, name: s.name, category: s.statusCategory?.name });
      }
    }
  }

  const lines = [];
  lines.push(`# KEEN board configuration`);
  lines.push('');
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)} by \`src/board-config.js\`. Re-run when board columns or statuses change.`);
  lines.push('');
  lines.push(`- Board: **${config.name}** (id ${config.id})`);
  lines.push(`- Type: ${config.type}`);
  lines.push(`- Project key: ${PROJECT_KEY}`);
  lines.push('');

  lines.push(`## Columns on the board`);
  lines.push('');
  lines.push(`Each column groups one or more Jira statuses. When you see *"the board"*, you are seeing tickets bucketed into these columns.`);
  lines.push('');
  lines.push(`| Column | Maps to statuses |`);
  lines.push(`|---|---|`);
  for (const col of config.columnConfig.columns) {
    const statuses = col.statuses.map((s) => {
      const meta = allStatusesMap.get(s.id);
      return meta ? meta.name : `(id ${s.id})`;
    });
    lines.push(`| **${col.name}** | ${statuses.join(', ') || '_(no statuses)_'} |`);
  }
  lines.push('');

  if (config.columnConfig.constraintType) {
    lines.push(`Constraint type: \`${config.columnConfig.constraintType}\``);
    lines.push('');
  }

  lines.push(`## All statuses available on KEEN tickets`);
  lines.push('');
  lines.push(`Grouped by Jira's status category. The board may map several of these into a single column.`);
  lines.push('');

  const byCategory = {};
  for (const s of allStatusesMap.values()) {
    const cat = s.category || 'Uncategorized';
    (byCategory[cat] = byCategory[cat] || []).push(s.name);
  }
  for (const cat of Object.keys(byCategory).sort()) {
    lines.push(`### ${cat}`);
    for (const n of byCategory[cat].sort()) {
      lines.push(`- ${n}`);
    }
    lines.push('');
  }

  lines.push(`## "Done" for this project`);
  lines.push('');
  lines.push(`Status categories: anything in the "Done" category above is treated as done. The script's \`isDone()\` check also matches by name against: \`deployed, completed, done, closed, resolved\` (case-insensitive).`);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n');
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
