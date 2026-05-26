// Quick diagnostic: which sprint 28 tickets does active-sprint.js skip?
import 'dotenv/config';
import { jiraFetch } from './jira.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;

function parseSprintList(str) {
  if (!str) return [];
  return str.split(',').map((s) => s.trim()).filter(Boolean);
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
  let initial = events.length ? events[0].from : [];
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

const sprints = await jiraFetch(`/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active`);
const active = sprints.values[0];
console.log(`Active: ${active.name}\n`);

const issuesData = await jiraFetch(`/rest/agile/1.0/sprint/${active.id}/issue?maxResults=100&fields=summary,status,created`);
const issues = issuesData.issues;
console.log(`Sprint has ${issues.length} issues\n`);

let counted = 0;
let skipped = 0;
const skippedList = [];

for (const stub of issues) {
  const full = await jiraFetch(`/rest/api/3/issue/${stub.key}?expand=changelog`);
  const tl = buildSprintTimeline(full);
  const atNow = sprintsAt(tl, new Date()).includes(active.name);
  if (atNow) {
    counted++;
  } else {
    skipped++;
    skippedList.push({
      key: full.key,
      status: full.fields.status?.name,
      created: full.fields.created?.slice(0, 10),
      sprintEvents: tl.events.length,
      summary: full.fields.summary,
    });
  }
}

console.log(`Counted: ${counted}`);
console.log(`Skipped: ${skipped}\n`);
console.log(`Skipped tickets (atNow=false per changelog replay):`);
for (const s of skippedList) {
  console.log(`  [${s.key}] status=${s.status.padEnd(18)} created=${s.created} sprintChangeEvents=${s.sprintEvents}`);
  console.log(`      ${s.summary?.slice(0, 80)}`);
}
