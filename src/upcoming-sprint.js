// Sneak preview of the next sprint:
//   - What's already in the future sprint (the team's planning so far)
//   - What's likely to carry over from the active sprint
//   - Combined starting load vs. recent post-22 norms
//   - Pointing hygiene: how many tickets are unpointed
//
// Run with: node src/upcoming-sprint.js

import 'dotenv/config';
import { jiraFetch } from './jira.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;

function isDone(s) {
  return ['deployed', 'completed', 'done', 'closed', 'resolved']
    .includes((s || '').toLowerCase());
}
function isLikelyToLand(s) {
  // Ready for Release essentially ships on its own; Ready for QA usually does too.
  return ['ready for release', 'ready for qa'].includes((s || '').toLowerCase());
}

async function fetchAllSprints(boardId) {
  let startAt = 0;
  const all = [];
  while (true) {
    const data = await jiraFetch(
      `/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}&maxResults=50`,
    );
    all.push(...data.values);
    if (data.isLast || data.values.length < 50) break;
    startAt += 50;
  }
  return all;
}

async function fetchSprintIssues(sprintId) {
  let startAt = 0;
  const all = [];
  while (true) {
    const data = await jiraFetch(
      `/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=summary,status,issuetype,assignee,customfield_10023`,
    );
    all.push(...data.issues);
    if (all.length >= data.total) break;
    startAt += 100;
  }
  return all;
}

function describe(issues, label) {
  let pts = 0, unpointedT = 0;
  const types = {};
  const statuses = {};
  for (const i of issues) {
    const p = i.fields.customfield_10023;
    if (typeof p === 'number') pts += p;
    else unpointedT++;
    const t = i.fields.issuetype?.name || '?';
    types[t] = (types[t] || 0) + 1;
    const s = i.fields.status?.name || '?';
    statuses[s] = (statuses[s] || 0) + 1;
  }
  return { count: issues.length, pts, unpointedT, types, statuses };
}

async function main() {
  const sprints = await fetchAllSprints(BOARD_ID);
  const active = sprints.find((s) => s.state === 'active');
  // The next "future" sprint with the earliest start date (or by sprint number).
  const futures = sprints
    .filter((s) => s.state === 'future')
    .sort((a, b) => {
      const da = a.startDate ? new Date(a.startDate).getTime() : Infinity;
      const db = b.startDate ? new Date(b.startDate).getTime() : Infinity;
      return da - db;
    });
  // Pick the next chronologically-real sprint (not "Ready for Dev"/"Ready for LOE" parking lots).
  const upcoming = futures.find((s) => /^\d+/.test(s.name) || /^Sprint\s+\d+/i.test(s.name));
  if (!active || !upcoming) {
    console.log('Could not locate both active and upcoming sprints.');
    return;
  }

  console.log(`Active:   ${active.name} (ends ${active.endDate?.slice(0, 10)})`);
  console.log(`Upcoming: ${upcoming.name} (${upcoming.startDate?.slice(0, 10)} → ${upcoming.endDate?.slice(0, 10)})\n`);

  const activeIssues = await fetchSprintIssues(active.id);
  const upcomingIssues = await fetchSprintIssues(upcoming.id);

  // Likely carryover = active sprint issues neither Done nor Ready for Release/QA.
  const likelyCarry = activeIssues.filter((i) => {
    const s = i.fields.status?.name;
    return !isDone(s) && !isLikelyToLand(s);
  });
  // "Optimistic" carryover = also keep anything that hasn't actually deployed yet.
  const pessimisticCarry = activeIssues.filter((i) => !isDone(i.fields.status?.name));

  const inUpcoming = describe(upcomingIssues, 'upcoming');
  const carry = describe(likelyCarry, 'likely carry');
  const carryPess = describe(pessimisticCarry, 'pessimistic carry');

  console.log(`Currently scheduled in ${upcoming.name}:`);
  console.log(`  ${inUpcoming.count} tickets / ${inUpcoming.pts} pts`);
  console.log(`  Unpointed: ${inUpcoming.unpointedT}`);
  console.log(`  Types:`, inUpcoming.types);
  console.log(`  Statuses:`, inUpcoming.statuses);

  console.log(`\nLikely carry-over from ${active.name} (excluding Ready for Release/QA which usually ships):`);
  console.log(`  ${carry.count} tickets / ${carry.pts} pts`);
  console.log(`  Unpointed: ${carry.unpointedT}`);
  console.log(`  Statuses:`, carry.statuses);

  console.log(`\nPessimistic carry-over (everything not yet Deployed/Completed):`);
  console.log(`  ${carryPess.count} tickets / ${carryPess.pts} pts`);

  // Combine
  const combined = inUpcoming.pts + carry.pts;
  const combinedTickets = inUpcoming.count + carry.count;
  const combinedUnpointed = inUpcoming.unpointedT + carry.unpointedT;
  const combinedPessimistic = inUpcoming.pts + carryPess.pts;

  console.log(`\n=== Projected starting load for ${upcoming.name} ===\n`);
  console.log(`Likely:        ${combinedTickets} tickets / ${combined} pts (+ ${combinedUnpointed} unpointed)`);
  console.log(`Pessimistic:   ${inUpcoming.count + carryPess.count} tickets / ${combinedPessimistic} pts`);
  console.log(`\nRecent post-22 sprint starts (committed at start, before mid-sprint adds):`);
  console.log(`  Sprint 22: 175p  |  Sprint 24: 159p  |  Sprint 25: 158p  |  Sprint 26: 157p  |  Sprint 27: 146p`);
  console.log(`  Typical completion: ~70p per sprint. Typical carry-over: ~95p.`);

  // List the upcoming-but-unpointed for visibility
  const unpointedInUpcoming = upcomingIssues.filter(
    (i) => typeof i.fields.customfield_10023 !== 'number',
  );
  if (unpointedInUpcoming.length) {
    console.log(`\nUnpointed tickets in ${upcoming.name}:`);
    for (const i of unpointedInUpcoming) {
      console.log(
        `  [${i.key}] ${(i.fields.issuetype?.name || '').padEnd(12)} ${(i.fields.status?.name || '').padEnd(16)} — ${(i.fields.summary || '').slice(0, 70)}`,
      );
    }
  }

  // List the likely carry-over for visibility
  console.log(`\nLikely-carryover tickets from ${active.name}:`);
  const sorted = likelyCarry.slice().sort((a, b) => {
    const sa = a.fields.status?.name || '';
    const sb = b.fields.status?.name || '';
    return sa.localeCompare(sb);
  });
  for (const i of sorted) {
    const p = i.fields.customfield_10023;
    console.log(
      `  [${i.key}] ${(p == null ? '?' : p).toString().padStart(2)}p ${(i.fields.status?.name || '').padEnd(18)} ${(i.fields.assignee?.displayName || '—').padEnd(20)} — ${(i.fields.summary || '').slice(0, 60)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
