// Snapshot of the currently-active sprint:
//   - Committed at start (replayed from changelogs)
//   - Added mid-sprint so far
//   - Status mix as of now
//   - Days elapsed / days remaining
//
// Run with: node src/active-sprint.js

import 'dotenv/config';
import { jiraFetch } from './jira.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;

function isDone(s) {
  return ['deployed', 'completed', 'done', 'closed', 'resolved']
    .includes((s || '').toLowerCase());
}

function parseSprintList(str) {
  if (!str) return [];
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

function currentSprintNamesFromField(issue) {
  // The Sprint custom field returns an array of sprint objects on Jira Cloud.
  const v = issue.fields?.customfield_10019;
  if (!Array.isArray(v)) return [];
  return v.map((s) => s?.name).filter(Boolean);
}

function buildSprintTimeline(issue) {
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
  // If there are no Sprint change events, the ticket has been in its current
  // sprints since creation. Without this fallback, tickets created directly
  // into a sprint look like they belong to no sprint at all.
  const initial = events.length ? events[0].from : currentSprintNamesFromField(issue);
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
      `/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=summary,status,issuetype,assignee,created,updated,customfield_10023,customfield_10019`,
    );
    all.push(...data.issues);
    if (all.length >= data.total) break;
    startAt += 100;
  }
  return all;
}

async function fetchChangelog(key) {
  return jiraFetch(`/rest/api/3/issue/${key}?expand=changelog`);
}

async function pMap(items, fn, conc = 8) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
      if ((idx + 1) % 20 === 0) process.stderr.write(`\r  fetched ${idx + 1}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  process.stderr.write(`\r  fetched ${items.length}/${items.length}\n`);
  return out;
}

async function main() {
  const sprints = await fetchAllSprints(BOARD_ID);
  const active = sprints.find((s) => s.state === 'active');
  if (!active) {
    console.log('No active sprint found.');
    return;
  }
  const start = new Date(active.startDate);
  const endPlanned = new Date(active.endDate);
  const now = new Date();
  const elapsedDays = (now - start) / 86400000;
  const totalDays = (endPlanned - start) / 86400000;

  console.log(`Active sprint: ${active.name} (id ${active.id})`);
  console.log(`  Start: ${active.startDate.slice(0, 10)}  Planned end: ${active.endDate.slice(0, 10)}`);
  console.log(`  Day ${elapsedDays.toFixed(1)} of ${totalDays.toFixed(1)} (${(100 * elapsedDays / totalDays).toFixed(0)}%)\n`);

  const issues = await fetchSprintIssues(active.id);
  console.log(`  ${issues.length} issues currently associated\n`);
  console.log(`Fetching changelogs...`);
  const enriched = await pMap(issues, (i) => fetchChangelog(i.key), 8);

  let committedT = 0, committedP = 0;
  let addedT = 0, addedP = 0;
  let doneT = 0, doneP = 0;
  let inProgressT = 0, inProgressP = 0;
  let openT = 0, openP = 0;
  const statusCounts = {};
  const addedByAuthor = {};
  const addedRows = [];
  const doneRows = [];
  const inFlightRows = [];

  for (const issue of enriched) {
    const tl = buildSprintTimeline(issue);
    const atStart = sprintsAt(tl, start).includes(active.name);
    const atNow = sprintsAt(tl, now).includes(active.name);
    if (!atNow) continue; // removed mid-sprint
    const pts = issue.fields.customfield_10023 || 0;
    const st = issue.fields.status?.name || 'Unknown';
    statusCounts[st] = (statusCounts[st] || 0) + 1;

    if (atStart) {
      committedT++;
      committedP += pts;
    } else {
      addedT++;
      addedP += pts;
      // Find when it was added and by whom
      const ev = (issue.changelog?.histories || []).find((h) =>
        h.items.some((it) => it.field === 'Sprint' && parseSprintList(it.toString).includes(active.name)),
      );
      const author = ev?.author?.displayName || 'unknown';
      addedByAuthor[author] = (addedByAuthor[author] || 0) + 1;
      addedRows.push({
        key: issue.key,
        pts,
        author,
        when: ev?.created?.slice(0, 10) || '',
        st,
        summary: issue.fields.summary,
      });
    }

    if (isDone(st)) {
      doneT++;
      doneP += pts;
      doneRows.push({ key: issue.key, pts, st, summary: issue.fields.summary });
    } else if (/^(in progress|in development|ready for qa|ready for release|feedback)/i.test(st)) {
      inProgressT++;
      inProgressP += pts;
      inFlightRows.push({ key: issue.key, pts, st, summary: issue.fields.summary, assignee: issue.fields.assignee?.displayName || '—' });
    } else {
      openT++;
      openP += pts;
    }
  }

  console.log(`\n=== ${active.name} mid-flight snapshot ===`);
  console.log(`Committed at start:  ${committedT}t / ${committedP}p`);
  console.log(`Added so far:        ${addedT}t / ${addedP}p`);
  console.log(`Total in sprint:     ${committedT + addedT}t / ${committedP + addedP}p\n`);
  console.log(`Done already:        ${doneT}t / ${doneP}p`);
  console.log(`In flight (active):  ${inProgressT}t / ${inProgressP}p`);
  console.log(`Not yet started:     ${openT}t / ${openP}p\n`);

  console.log(`Status breakdown:`);
  for (const [s, n] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(28)} ${n}`);
  }

  if (addedRows.length) {
    console.log(`\nAdded mid-sprint (${addedT} tickets, ${addedP}p):`);
    for (const [a, n] of Object.entries(addedByAuthor).sort((a, b) => b[1] - a[1])) {
      console.log(`  added by ${a.padEnd(22)} ${n}`);
    }
    console.log(`\n  examples:`);
    for (const r of addedRows.slice(0, 8)) {
      console.log(`    [${r.key}] ${r.pts}p ${r.when} (${r.author}) ${r.st} — ${(r.summary || '').slice(0, 70)}`);
    }
  }

  console.log(`\nDone already (${doneT} tickets, ${doneP}p):`);
  for (const r of doneRows.slice(0, 10)) {
    console.log(`  [${r.key}] ${r.pts}p ${r.st} — ${(r.summary || '').slice(0, 70)}`);
  }
  if (doneRows.length > 10) console.log(`  ... and ${doneRows.length - 10} more`);

  console.log(`\nIn flight (${inProgressT} tickets, ${inProgressP}p) — most-advanced status first:`);
  const statusOrder = ['Ready for Release', 'Ready for QA', 'Feedback Requested', 'In Development', 'In Progress'];
  inFlightRows.sort((a, b) => statusOrder.indexOf(a.st) - statusOrder.indexOf(b.st));
  for (const r of inFlightRows.slice(0, 15)) {
    console.log(`  [${r.key}] ${r.pts}p ${r.st.padEnd(20)} ${r.assignee.padEnd(20)} — ${(r.summary || '').slice(0, 60)}`);
  }
  if (inFlightRows.length > 15) console.log(`  ... and ${inFlightRows.length - 15} more`);

  // Pace check
  const completionRate = (committedP + addedP) > 0 ? (100 * doneP) / (committedP + addedP) : 0;
  const pctElapsed = (100 * elapsedDays) / totalDays;
  console.log(`\nPace: ${completionRate.toFixed(0)}% of points done at ${pctElapsed.toFixed(0)}% through the sprint.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
