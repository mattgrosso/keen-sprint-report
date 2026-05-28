// One-off: per-engineer load in active sprint vs historical post-22 throughput.
import 'dotenv/config';
import { jiraFetch } from './jira.js';
import fs from 'node:fs';

const BOARD_ID = process.env.JIRA_BOARD_ID;
const CACHE = JSON.parse(fs.readFileSync('.cache/changelogs.json', 'utf8'));

const DONE = new Set(['deployed', 'completed', 'done', 'closed', 'resolved']);

async function fetchAllSprints() {
  let startAt = 0; const all = [];
  while (true) {
    const data = await jiraFetch(`/rest/agile/1.0/board/${BOARD_ID}/sprint?startAt=${startAt}&maxResults=50`);
    all.push(...data.values);
    if (data.isLast || data.values.length < 50) break;
    startAt += 50;
  }
  return all;
}

async function fetchSprintIssues(sprintId) {
  let startAt = 0; const all = [];
  while (true) {
    const data = await jiraFetch(`/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=summary,status,assignee,customfield_10023,customfield_10019`);
    all.push(...data.issues);
    if (all.length >= data.total) break;
    startAt += 100;
  }
  return all;
}

function parseSprintList(s) { return (s||'').split(',').map(x=>x.trim()).filter(Boolean); }

// Replay a ticket's sprint membership to find sprints it was a member of when each one closed,
// and whether it was completed by that sprint's end.
function ticketSprintHistory(issue) {
  const events = [];
  for (const h of issue.changelog?.histories || []) {
    for (const it of h.items) {
      if (it.field === 'Sprint') {
        events.push({ ts: new Date(h.created), from: parseSprintList(it.fromString), to: parseSprintList(it.toString) });
      }
      if (it.field === 'status') {
        events.push({ ts: new Date(h.created), statusTo: it.toString });
      }
    }
  }
  events.sort((a,b)=>a.ts-b.ts);
  return events;
}

async function main() {
  const sprints = await fetchAllSprints();
  const active = sprints.find(s => s.state === 'active');
  const closed = sprints.filter(s => s.state === 'closed').sort((a,b)=>new Date(a.startDate)-new Date(b.startDate));

  // Identify post-sprint-22 closed sprints (sprint 22 was 2026-02-18 → 2026-03-04)
  const post22 = closed.filter(s => s.startDate && s.startDate >= '2026-02-18' && s.name && !/Ready for (Dev|LOE)/i.test(s.name));
  console.log('Post-22 closed sprints:', post22.map(s => s.id + ' ' + s.name).join('\n  '));

  // For each post-22 closed sprint, get tickets the assignee actually completed
  // Definition: ticket was a member of sprint S at its end AND reached a DONE status by sprint end.
  // Use changelog cache where possible (it's keyed by `${key}@${updated}`)
  const perPersonByCompletedSprint = {}; // person -> { sprintName -> {tickets, points} }
  const perPersonCommittedNow = {}; // person -> {tickets, points} in active sprint

  // Build a map: key -> latest cached changelog
  const byKey = {};
  for (const [k, issue] of Object.entries(CACHE)) {
    const baseKey = issue.key;
    if (!byKey[baseKey] || (issue.fields?.updated || '') > (byKey[baseKey].fields?.updated || '')) byKey[baseKey] = issue;
  }

  // For each cached issue, replay sprint membership and detect: in sprint S at end, done by then, assignee at end
  // To get assignee at sprint end, we have to also replay assignee changes.
  function assigneeAt(issue, t) {
    const events = [];
    for (const h of issue.changelog?.histories || []) {
      for (const it of h.items) {
        if (it.field === 'assignee') events.push({ ts: new Date(h.created), to: it.toString || null });
      }
    }
    events.sort((a,b)=>a.ts-b.ts);
    // Find latest event with ts<=t; if none, use the issue's current assignee minus all events
    let current = issue.fields?.assignee?.displayName || null;
    // If there were no events, current is the assignee throughout.
    if (events.length === 0) return current;
    // Reconstruct: assume the very first 'to' value is what they became *after* that event, before that event was the 'from'.
    // Easier: walk backward from now to find the value at time t.
    let val = current;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.ts.getTime() > t.getTime()) {
        // 'val' was set by this event; before this event, val was previous (which we don't directly track unless next event has from)
        // Need fromString. Let me re-iterate using fromString.
      } else {
        return val;
      }
      // For walking backward, the value before this event is "from" — re-walk with fromString:
    }
    // Re-do with fromString more robustly:
    const evs2 = [];
    for (const h of issue.changelog?.histories || []) {
      for (const it of h.items) {
        if (it.field === 'assignee') evs2.push({ ts: new Date(h.created), from: it.fromString || null, to: it.toString || null });
      }
    }
    evs2.sort((a,b)=>a.ts-b.ts);
    if (evs2.length === 0) return current;
    // value at time t: find latest event with ts<=t; if none, value is the first event's "from"
    let assigned = evs2[0].from;
    for (const ev of evs2) {
      if (ev.ts.getTime() <= t.getTime()) assigned = ev.to;
      else break;
    }
    return assigned;
  }

  function statusAt(issue, t) {
    const evs = [];
    for (const h of issue.changelog?.histories || []) {
      for (const it of h.items) {
        if (it.field === 'status') evs.push({ ts: new Date(h.created), from: it.fromString, to: it.toString });
      }
    }
    evs.sort((a,b)=>a.ts-b.ts);
    const current = issue.fields?.status?.name;
    if (evs.length === 0) return current;
    let st = evs[0].from;
    for (const ev of evs) {
      if (ev.ts.getTime() <= t.getTime()) st = ev.to;
      else break;
    }
    return st;
  }

  function sprintsAt(issue, t) {
    const evs = [];
    for (const h of issue.changelog?.histories || []) {
      for (const it of h.items) {
        if (it.field === 'Sprint') evs.push({ ts: new Date(h.created), from: parseSprintList(it.fromString), to: parseSprintList(it.toString) });
      }
    }
    evs.sort((a,b)=>a.ts-b.ts);
    // initial = first event's from, or current Sprint field if no events
    let initial = [];
    if (evs.length === 0) {
      const v = issue.fields?.customfield_10019;
      if (Array.isArray(v)) initial = v.map(s=>s?.name).filter(Boolean);
    } else {
      initial = evs[0].from;
    }
    let cur = initial.slice();
    for (const ev of evs) {
      if (ev.ts.getTime() <= t.getTime()) cur = ev.to.slice();
      else break;
    }
    return cur;
  }

  for (const issue of Object.values(byKey)) {
    const pts = issue.fields?.customfield_10023 || 0;
    for (const sprint of post22) {
      const endT = new Date(sprint.completeDate || sprint.endDate);
      const sprintMembers = sprintsAt(issue, endT);
      if (!sprintMembers.includes(sprint.name)) continue;
      const st = statusAt(issue, endT);
      if (!DONE.has((st||'').toLowerCase())) continue;
      const assignee = assigneeAt(issue, endT) || 'unassigned';
      perPersonByCompletedSprint[assignee] = perPersonByCompletedSprint[assignee] || {};
      perPersonByCompletedSprint[assignee][sprint.name] = perPersonByCompletedSprint[assignee][sprint.name] || { t: 0, p: 0 };
      perPersonByCompletedSprint[assignee][sprint.name].t++;
      perPersonByCompletedSprint[assignee][sprint.name].p += pts;
    }
  }

  // Active sprint assignments
  const activeIssues = await fetchSprintIssues(active.id);
  console.log(`\nActive sprint: ${active.name} — ${activeIssues.length} issues currently associated`);
  for (const iss of activeIssues) {
    const pts = iss.fields?.customfield_10023 || 0;
    const assignee = iss.fields?.assignee?.displayName || 'unassigned';
    const st = iss.fields?.status?.name;
    perPersonCommittedNow[assignee] = perPersonCommittedNow[assignee] || { t: 0, p: 0, byStatus: {}, items: [] };
    perPersonCommittedNow[assignee].t++;
    perPersonCommittedNow[assignee].p += pts;
    perPersonCommittedNow[assignee].byStatus[st] = (perPersonCommittedNow[assignee].byStatus[st] || 0) + 1;
    perPersonCommittedNow[assignee].items.push({ key: iss.key, pts, st, sum: iss.fields?.summary });
  }

  // Compute per-person historical: mean and median of completed points per closed sprint (post-22)
  function summarize(person) {
    const map = perPersonByCompletedSprint[person] || {};
    // For each post-22 sprint, even if 0
    const pts = post22.map(s => (map[s.name]?.p || 0));
    const tix = post22.map(s => (map[s.name]?.t || 0));
    pts.sort((a,b)=>a-b); tix.sort((a,b)=>a-b);
    const mean = arr => arr.reduce((a,b)=>a+b,0) / arr.length;
    const median = arr => arr.length%2 ? arr[(arr.length-1)/2] : (arr[arr.length/2-1] + arr[arr.length/2])/2;
    return {
      avgP: mean(pts), medP: median(pts), maxP: Math.max(...pts), minP: Math.min(...pts),
      avgT: mean(tix), medT: median(tix), maxT: Math.max(...tix), minT: Math.min(...tix),
      perSprint: post22.map(s => ({ name: s.name.split(/[:\-]/)[0].trim(), p: map[s.name]?.p || 0, t: map[s.name]?.t || 0 })),
    };
  }

  // Combine: everyone in active sprint OR with historical completions
  const allPeople = new Set([...Object.keys(perPersonCommittedNow), ...Object.keys(perPersonByCompletedSprint)]);

  // Sort by active-sprint points descending
  const rows = [...allPeople].map(p => ({ p, now: perPersonCommittedNow[p] || { t:0, p:0 }, hist: summarize(p) }));
  rows.sort((a,b) => b.now.p - a.now.p);

  console.log(`\nPer-engineer load — sprint 29 vs post-sprint-22 history (${post22.length} sprints)\n`);
  console.log('Person                      | Now(t/p) | Hist avg(t/p) | Hist med(t/p) | Max(t/p) | Per-sprint pts (chronological)');
  console.log('----------------------------+----------+---------------+---------------+----------+-------------------------------');
  for (const r of rows) {
    const persp = r.hist.perSprint.map(x => x.p).join(',');
    console.log(
      r.p.slice(0, 26).padEnd(27) + ' | ' +
      (`${r.now.t}t/${r.now.p}p`).padEnd(8) + ' | ' +
      (`${r.hist.avgT.toFixed(1)}t/${r.hist.avgP.toFixed(1)}p`).padEnd(13) + ' | ' +
      (`${r.hist.medT}t/${r.hist.medP}p`).padEnd(13) + ' | ' +
      (`${r.hist.maxT}t/${r.hist.maxP}p`).padEnd(8) + ' | ' +
      persp
    );
  }

  console.log(`\nActive sprint items by person:`);
  for (const r of rows) {
    if (r.now.t === 0) continue;
    console.log(`\n${r.p} — ${r.now.t} tickets / ${r.now.p}p`);
    const items = perPersonCommittedNow[r.p].items.sort((a,b) => (b.pts||0) - (a.pts||0));
    for (const it of items) console.log(`  [${it.key}] ${it.pts}p ${it.st} — ${(it.sum||'').slice(0,55)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
