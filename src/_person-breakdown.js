// Per-person breakdown of the active sprint: load and progress by status.
import 'dotenv/config';
import { jiraFetch } from './jira.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;
const DONE = new Set(['deployed', 'completed', 'done', 'closed', 'resolved']);
const NEAR_DONE = new Set(['ready for release', 'ready for qa', 'feedback requested']);

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
    const data = await jiraFetch(`/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=summary,status,assignee,customfield_10023`);
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
  console.log(`Active sprint: ${active.name} — ${issues.length} issues currently associated\n`);

  const byPerson = {};
  for (const iss of issues) {
    const a = iss.fields.assignee?.displayName || 'unassigned';
    byPerson[a] = byPerson[a] || { tickets: 0, points: 0, doneT: 0, doneP: 0, nearT: 0, nearP: 0, openT: 0, openP: 0, items: [] };
    const p = iss.fields.customfield_10023 || 0;
    const st = iss.fields.status.name;
    byPerson[a].tickets++;
    byPerson[a].points += p;
    const stl = st.toLowerCase();
    if (DONE.has(stl)) { byPerson[a].doneT++; byPerson[a].doneP += p; }
    else if (NEAR_DONE.has(stl)) { byPerson[a].nearT++; byPerson[a].nearP += p; }
    else { byPerson[a].openT++; byPerson[a].openP += p; }
    byPerson[a].items.push({ key: iss.key, pts: p, st, sum: iss.fields.summary });
  }

  const people = Object.entries(byPerson).sort((a, b) => b[1].points - a[1].points);
  console.log('Person                       | Total    | Done     | Near done | Open     ');
  console.log('-----------------------------+----------+----------+-----------+----------');
  for (const [p, d] of people) {
    console.log(p.padEnd(28) + ' | ' +
      `${d.tickets}t/${d.points}p`.padEnd(8) + ' | ' +
      `${d.doneT}t/${d.doneP}p`.padEnd(8) + ' | ' +
      `${d.nearT}t/${d.nearP}p`.padEnd(9) + ' | ' +
      `${d.openT}t/${d.openP}p`);
  }

  console.log('\n=== Detail ===\n');
  const statusOrder = ['Deployed', 'Completed', 'Done', 'Ready for Release', 'Ready for QA', 'Feedback Requested', 'In Development', 'In Progress', 'Ready for Dev', 'Groomed', 'Backlog', 'Blocked'];
  for (const [p, d] of people) {
    console.log(`${p} — ${d.tickets}t / ${d.points}p  (done ${d.doneT}t/${d.doneP}p · near ${d.nearT}t/${d.nearP}p · open ${d.openT}t/${d.openP}p)`);
    d.items.sort((a, b) => {
      const ai = statusOrder.indexOf(a.st); const bi = statusOrder.indexOf(b.st);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || b.pts - a.pts;
    });
    for (const it of d.items) console.log(`  [${it.key}] ${it.pts}p ${it.st.padEnd(20)} — ${(it.sum || '').slice(0, 60)}`);
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
