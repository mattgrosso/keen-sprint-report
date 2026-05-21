// List all sprints on the configured board, newest first.
// Run with: node src/list-sprints.js

import 'dotenv/config';
import { jiraFetch } from './jira.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;
if (!BOARD_ID) {
  console.error('JIRA_BOARD_ID is not set in .env');
  process.exit(1);
}

async function fetchAllSprints(boardId) {
  let startAt = 0;
  const pageSize = 50;
  const all = [];
  while (true) {
    const data = await jiraFetch(
      `/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}&maxResults=${pageSize}`,
    );
    all.push(...data.values);
    if (data.isLast || data.values.length < pageSize) break;
    startAt += pageSize;
  }
  return all;
}

const sprints = await fetchAllSprints(BOARD_ID);

// Sort newest first by start date (closed sprints have one; future ones may not)
sprints.sort((a, b) => {
  const da = a.startDate ? new Date(a.startDate).getTime() : 0;
  const db = b.startDate ? new Date(b.startDate).getTime() : 0;
  return db - da;
});

console.log(`Found ${sprints.length} sprints on board ${BOARD_ID}\n`);
console.log(
  `${'id'.padEnd(8)} ${'state'.padEnd(10)} ${'start'.padEnd(12)} ${'end'.padEnd(12)} name`,
);
console.log('-'.repeat(80));
for (const s of sprints) {
  const start = s.startDate ? s.startDate.slice(0, 10) : '—';
  const end = s.completeDate
    ? s.completeDate.slice(0, 10)
    : s.endDate
      ? s.endDate.slice(0, 10)
      : '—';
  console.log(
    `${String(s.id).padEnd(8)} ${s.state.padEnd(10)} ${start.padEnd(12)} ${end.padEnd(12)} ${s.name}`,
  );
}

// Summary counts
const byState = sprints.reduce((acc, s) => {
  acc[s.state] = (acc[s.state] || 0) + 1;
  return acc;
}, {});
console.log(`\nBy state:`, byState);
