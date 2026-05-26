// Do mid-sprint adds get prioritized?
//
// For each post-sprint-22 closed sprint, split tickets into:
//   - "committed":  in the sprint at activation
//   - "added":      not in at activation but in at close
// Then compare their completion rates (tickets and points) and the
// average size of each.
//
// Caveats to keep in mind when interpreting:
//   - Added tickets skew smaller/bug-shaped in general; smaller tickets
//     close faster regardless of priority. Track avg size to spot that.
//   - "Done by sprint end" measures landed-by-close, which is what
//     matters for the priority question — but tickets added on day 13
//     have less chance to finish than ones added on day 2. We'll report
//     avg days-in-sprint for adds to spot that distortion.

import 'dotenv/config';
import fs from 'fs';
import { jiraFetch } from './jira.js';
import { fetchCurrentSprintMemberships } from './sprint-membership.js';

const CACHE_FILE = '.cache/changelogs.json';
const BOARD_ID = process.env.JIRA_BOARD_ID;
const POST22_MIN = 22;

function isDone(s) {
  return ['deployed', 'completed', 'done', 'closed', 'resolved']
    .includes((s || '').toLowerCase());
}
function parseSprintList(str) {
  if (!str) return [];
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}
function buildSprintTimeline(issue, fallback = []) {
  const histories = (issue.changelog?.histories || []).slice().sort(
    (a, b) => new Date(a.created) - new Date(b.created),
  );
  const events = [];
  for (const h of histories) {
    for (const it of h.items) {
      if (it.field === 'Sprint') {
        events.push({
          ts: new Date(h.created),
          from: parseSprintList(it.fromString),
          to: parseSprintList(it.toString),
        });
      }
    }
  }
  const initial = events.length ? events[0].from : fallback.slice();
  return { initial, events };
}
function sprintsAt(timeline, t) {
  const tMs = new Date(t).getTime();
  let current = timeline.initial.slice();
  for (const ev of timeline.events) {
    if (ev.ts.getTime() <= tMs) current = ev.to.slice();
    else break;
  }
  return current;
}
function statusAt(issue, t) {
  const histories = (issue.changelog?.histories || []).slice().sort(
    (a, b) => new Date(a.created) - new Date(b.created),
  );
  const tMs = new Date(t).getTime();
  let initial = issue.fields.status?.name || 'Unknown';
  for (const h of histories) {
    let found = false;
    for (const it of h.items) {
      if (it.field === 'status') {
        initial = it.fromString;
        found = true;
        break;
      }
    }
    if (found) break;
  }
  let current = initial;
  for (const h of histories) {
    if (new Date(h.created).getTime() > tMs) break;
    for (const it of h.items) {
      if (it.field === 'status') current = it.toString;
    }
  }
  return current;
}
function pts(issue) {
  const v = issue.fields?.customfield_10023;
  return typeof v === 'number' ? v : 0;
}
function sprintNumberFromName(name) {
  const m1 = name.match(/^(\d+):/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = name.match(/^Sprint\s+(\d+)\b/i);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

/** When was the ticket added to `sprintName`? Returns Date or null if never via event. */
function addedToSprintAt(issue, sprintName) {
  const histories = (issue.changelog?.histories || []).slice().sort(
    (a, b) => new Date(a.created) - new Date(b.created),
  );
  for (const h of histories) {
    for (const it of h.items) {
      if (it.field === 'Sprint') {
        const from = parseSprintList(it.fromString);
        const to = parseSprintList(it.toString);
        if (!from.includes(sprintName) && to.includes(sprintName)) {
          return new Date(h.created);
        }
      }
    }
  }
  return null;
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

async function main() {
  const cacheRaw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const byKey = new Map();
  for (const v of Object.values(cacheRaw)) {
    const u = new Date(v.fields?.updated || 0).getTime();
    const ex = byKey.get(v.key);
    if (!ex || ex._u < u) byKey.set(v.key, { ...v, _u: u });
  }
  const tickets = [...byKey.values()];

  console.log(`Fetching current Sprint memberships...`);
  const current = await fetchCurrentSprintMemberships('KEEN');

  const sprints = (await fetchAllSprints(BOARD_ID))
    .filter((s) => s.state === 'closed' && s.startDate && s.completeDate)
    .map((s) => ({ ...s, num: sprintNumberFromName(s.name) }))
    .filter((s) => s.num != null && s.num >= POST22_MIN)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  console.log(`\nPost-22 sprints: ${sprints.map((s) => s.num).join(', ')}\n`);

  // Per-sprint results
  const rows = [];
  // Aggregates
  const tot = {
    committedT: 0, committedP: 0, committedDoneT: 0, committedDoneP: 0,
    addedT: 0, addedP: 0, addedDoneT: 0, addedDoneP: 0,
    addedDaysSum: 0, addedDaysCount: 0,
    sprintLen: 0,
  };

  for (const sprint of sprints) {
    const start = new Date(sprint.startDate);
    const end = new Date(sprint.completeDate);
    const sprintLenDays = (end - start) / 86400000;

    let cT = 0, cP = 0, cDT = 0, cDP = 0;
    let aT = 0, aP = 0, aDT = 0, aDP = 0;
    const addedDays = [];

    for (const issue of tickets) {
      const tl = buildSprintTimeline(issue, current.get(issue.key) || []);
      const atStart = sprintsAt(tl, start).includes(sprint.name);
      const atEnd = sprintsAt(tl, end).includes(sprint.name);
      if (!atStart && !atEnd) continue;
      const done = isDone(statusAt(issue, end));
      const p = pts(issue);
      if (atStart) {
        cT++; cP += p;
        if (atEnd && done) { cDT++; cDP += p; }
      } else if (atEnd) {
        aT++; aP += p;
        if (done) { aDT++; aDP += p; }
        const addedAt = addedToSprintAt(issue, sprint.name);
        if (addedAt && addedAt >= start && addedAt <= end) {
          addedDays.push((addedAt - start) / 86400000);
        }
      }
    }

    const cRate = cP ? (100 * cDP / cP).toFixed(0) : '—';
    const aRate = aP ? (100 * aDP / aP).toFixed(0) : '—';
    const avgAddedDay = addedDays.length
      ? (addedDays.reduce((a, b) => a + b, 0) / addedDays.length).toFixed(1)
      : '—';
    const cAvgSize = cT ? (cP / cT).toFixed(1) : '—';
    const aAvgSize = aT ? (aP / aT).toFixed(1) : '—';

    rows.push({
      num: sprint.num,
      sprintLenDays: sprintLenDays.toFixed(1),
      cT, cP, cDT, cDP, cRate, cAvgSize,
      aT, aP, aDT, aDP, aRate, aAvgSize,
      avgAddedDay,
    });

    tot.committedT += cT; tot.committedP += cP;
    tot.committedDoneT += cDT; tot.committedDoneP += cDP;
    tot.addedT += aT; tot.addedP += aP;
    tot.addedDoneT += aDT; tot.addedDoneP += aDP;
    tot.addedDaysSum += addedDays.reduce((a, b) => a + b, 0);
    tot.addedDaysCount += addedDays.length;
    tot.sprintLen += sprintLenDays;
  }

  console.log(`Per-sprint comparison (post-22):\n`);
  console.log(`Sprint | Committed: tickets / pts (done % by pts, avg size) | Added: tickets / pts (done % by pts, avg size) | avg day adds arrived`);
  console.log(`-------|---------------------------------------------------|-------------------------------------------------|---------------------`);
  for (const r of rows) {
    console.log(
      `  ${String(r.num).padStart(2)}   | ${String(r.cT).padStart(3)}t / ${String(r.cP).padStart(3)}p   done ${String(r.cRate).padStart(3)}%, avg ${r.cAvgSize}p | ${String(r.aT).padStart(3)}t / ${String(r.aP).padStart(3)}p   done ${String(r.aRate).padStart(3)}%, avg ${r.aAvgSize}p | day ${r.avgAddedDay} of ${r.sprintLenDays}`,
    );
  }

  const cRateTot = tot.committedP ? (100 * tot.committedDoneP / tot.committedP).toFixed(1) : '—';
  const aRateTot = tot.addedP ? (100 * tot.addedDoneP / tot.addedP).toFixed(1) : '—';
  const cByTicket = tot.committedT ? (100 * tot.committedDoneT / tot.committedT).toFixed(1) : '—';
  const aByTicket = tot.addedT ? (100 * tot.addedDoneT / tot.addedT).toFixed(1) : '—';
  const cAvg = tot.committedT ? (tot.committedP / tot.committedT).toFixed(2) : '—';
  const aAvg = tot.addedT ? (tot.addedP / tot.addedT).toFixed(2) : '—';
  const avgAdd = tot.addedDaysCount ? (tot.addedDaysSum / tot.addedDaysCount).toFixed(1) : '—';
  const avgSprint = (tot.sprintLen / rows.length).toFixed(1);

  console.log(`\n=== Aggregate across ${rows.length} post-22 sprints ===\n`);
  console.log(`Committed at start:`);
  console.log(`  ${tot.committedT} tickets / ${tot.committedP} pts`);
  console.log(`  Done by sprint close: ${tot.committedDoneT}t / ${tot.committedDoneP}p`);
  console.log(`  Completion rate:      ${cByTicket}% of tickets, ${cRateTot}% of points`);
  console.log(`  Avg ticket size:      ${cAvg}p`);
  console.log(`\nAdded mid-sprint:`);
  console.log(`  ${tot.addedT} tickets / ${tot.addedP} pts`);
  console.log(`  Done by sprint close: ${tot.addedDoneT}t / ${tot.addedDoneP}p`);
  console.log(`  Completion rate:      ${aByTicket}% of tickets, ${aRateTot}% of points`);
  console.log(`  Avg ticket size:      ${aAvg}p`);
  console.log(`  Avg day-of-sprint they arrived: day ${avgAdd} of ${avgSprint}-day sprint`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
