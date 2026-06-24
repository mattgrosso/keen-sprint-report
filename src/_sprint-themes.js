// Group active sprint work by epic / parent for a thematic summary.
import 'dotenv/config';
import { jiraFetch } from './jira.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;
const DONE = new Set(['deployed', 'completed', 'done', 'closed', 'resolved']);
const NEAR = new Set(['ready for release', 'ready for qa', 'feedback requested']);

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
    const data = await jiraFetch(`/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=summary,status,assignee,customfield_10023,parent,labels,components,issuetype`);
    all.push(...data.issues);
    if (all.length >= data.total) break;
    startAt += 100;
  }
  return all;
}

async function main() {
  const sprints = await fetchAllSprints();
  const active = sprints.find(s => s.state === 'active');
  const issues = await fetchSprintIssues(active.id);

  const byEpic = {}; // key -> { name, items: [] }
  const noEpic = [];

  for (const iss of issues) {
    const parent = iss.fields.parent;
    const item = {
      key: iss.key,
      summary: iss.fields.summary,
      pts: iss.fields.customfield_10023 || 0,
      status: iss.fields.status.name,
      assignee: iss.fields.assignee?.displayName || 'unassigned',
      issuetype: iss.fields.issuetype?.name,
    };
    if (parent) {
      const k = parent.key;
      byEpic[k] = byEpic[k] || { key: k, name: parent.fields?.summary || k, type: parent.fields?.issuetype?.name, items: [] };
      byEpic[k].items.push(item);
    } else {
      noEpic.push(item);
    }
  }

  const groups = Object.values(byEpic).map(g => {
    let doneP = 0, nearP = 0, openP = 0, doneT = 0, nearT = 0, openT = 0;
    for (const it of g.items) {
      const stl = it.status.toLowerCase();
      if (DONE.has(stl)) { doneP += it.pts; doneT++; }
      else if (NEAR.has(stl)) { nearP += it.pts; nearT++; }
      else { openP += it.pts; openT++; }
    }
    return { ...g, totalP: doneP+nearP+openP, totalT: g.items.length, doneT, doneP, nearT, nearP, openT, openP };
  }).sort((a,b) => b.totalP - a.totalP);

  console.log(`Active sprint: ${active.name} — ${issues.length} issues\n`);
  console.log(`Grouped by epic / parent (${groups.length} epics + ${noEpic.length} unparented):\n`);

  for (const g of groups) {
    console.log(`${g.key} — ${g.name}  [${g.type || 'Epic'}]`);
    console.log(`  Total ${g.totalT}t / ${g.totalP}p  |  Done ${g.doneT}t/${g.doneP}p  |  Near ${g.nearT}t/${g.nearP}p  |  Open ${g.openT}t/${g.openP}p`);
    const sorted = g.items.slice().sort((a,b) => {
      const order = ['Deployed','Completed','Done','Ready for Release','Ready for QA','Feedback Requested','In Development','In Progress','Ready for Dev','Groomed','Backlog','Blocked'];
      return (order.indexOf(a.status) === -1 ? 99 : order.indexOf(a.status)) - (order.indexOf(b.status) === -1 ? 99 : order.indexOf(b.status));
    });
    for (const it of sorted) {
      console.log(`    [${it.key}] ${it.pts}p ${it.status.padEnd(18)} ${(it.assignee||'').padEnd(18)} — ${(it.summary||'').slice(0,55)}`);
    }
    console.log('');
  }

  if (noEpic.length) {
    console.log(`Unparented (${noEpic.length} tickets):`);
    const sorted = noEpic.slice().sort((a,b) => {
      const order = ['Deployed','Completed','Done','Ready for Release','Ready for QA','Feedback Requested','In Development','In Progress','Ready for Dev','Groomed','Backlog','Blocked'];
      return (order.indexOf(a.status) === -1 ? 99 : order.indexOf(a.status)) - (order.indexOf(b.status) === -1 ? 99 : order.indexOf(b.status));
    });
    for (const it of sorted) {
      console.log(`    [${it.key}] ${it.pts}p ${it.status.padEnd(18)} ${(it.assignee||'').padEnd(18)} — ${(it.summary||'').slice(0,55)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
