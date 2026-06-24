// Sprint 30 (next) breakdown: load, by person, by epic.
import 'dotenv/config';
import { jiraFetch } from './jira.js';

const SPRINT_ID = 3297;
const DONE = new Set(['deployed', 'completed', 'done', 'closed', 'resolved']);
const NEAR = new Set(['ready for release', 'ready for qa', 'feedback requested']);

async function fetchSprintIssues(sprintId) {
  let startAt = 0; const all = [];
  while (true) {
    const data = await jiraFetch(`/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=summary,status,assignee,customfield_10023,parent,customfield_10019`);
    all.push(...data.issues);
    if (all.length >= data.total) break;
    startAt += 100;
  }
  return all;
}

async function main() {
  const issues = await fetchSprintIssues(SPRINT_ID);
  console.log(`Sprint 30 — Gangsta's Paradise — ${issues.length} issues currently planned\n`);

  // Compute carryovers: tickets that were also in sprint 29
  let carryT = 0, carryP = 0;
  let freshT = 0, freshP = 0;
  let unpointed = 0;
  const byPerson = {};
  const byEpic = {};
  const carryList = [], freshList = [];
  for (const iss of issues) {
    const pts = iss.fields.customfield_10023;
    const sprints = (iss.fields.customfield_10019||[]).map(s=>s?.name||'').filter(Boolean);
    const wasIn29 = sprints.some(n => n.includes('Macarena') || n.startsWith('29'));
    const status = iss.fields.status.name;
    const assignee = iss.fields.assignee?.displayName || 'unassigned';
    const epic = iss.fields.parent?.fields?.summary || '(no epic)';
    const row = { key: iss.key, pts: pts ?? 0, status, assignee, epic, summary: iss.fields.summary, hasPts: pts !== null && pts !== undefined };
    if (!row.hasPts) unpointed++;
    if (wasIn29) { carryT++; carryP += row.pts; carryList.push(row); }
    else { freshT++; freshP += row.pts; freshList.push(row); }
    byPerson[assignee] = byPerson[assignee] || { t: 0, p: 0, items: [] };
    byPerson[assignee].t++;
    byPerson[assignee].p += row.pts;
    byPerson[assignee].items.push(row);
    byEpic[epic] = byEpic[epic] || { t: 0, p: 0, items: [] };
    byEpic[epic].t++;
    byEpic[epic].p += row.pts;
  }

  const total = issues.length;
  const totalP = carryP + freshP;
  console.log(`Total: ${total} tickets / ${totalP}p`);
  console.log(`  Carry-over from sprint 29: ${carryT}t / ${carryP}p`);
  console.log(`  Fresh for sprint 30:        ${freshT}t / ${freshP}p`);
  console.log(`  Unpointed:                  ${unpointed} tickets`);

  console.log(`\n=== By person ===\n`);
  console.log('Person                      | Total    | Tickets');
  console.log('----------------------------+----------+---------');
  for (const [p, d] of Object.entries(byPerson).sort((a,b)=>b[1].p-a[1].p)) {
    console.log(p.padEnd(28) + ' | ' + `${d.t}t/${d.p}p`.padEnd(8) + ' | ' + d.items.map(i=>i.key+'('+(i.hasPts?i.pts+'p':'?')+')').join(' '));
  }

  console.log(`\n=== Carry-over from sprint 29 (${carryT}t / ${carryP}p) ===\n`);
  carryList.sort((a,b)=> (b.pts||0)-(a.pts||0));
  for (const r of carryList) console.log(`  [${r.key}] ${r.hasPts?r.pts+'p':'?p'} ${r.status.padEnd(20)} ${(r.assignee||'').padEnd(18)} — ${(r.summary||'').slice(0,55)}`);

  console.log(`\n=== Fresh tickets in sprint 30 (${freshT}t / ${freshP}p) ===\n`);
  freshList.sort((a,b)=> (b.pts||0)-(a.pts||0));
  for (const r of freshList) console.log(`  [${r.key}] ${r.hasPts?r.pts+'p':'?p'} ${r.status.padEnd(20)} ${(r.assignee||'').padEnd(18)} — ${(r.summary||'').slice(0,55)}`);

  console.log(`\n=== By epic ===\n`);
  for (const [e, d] of Object.entries(byEpic).sort((a,b)=>b[1].p-a[1].p)) {
    console.log(`${e}  — ${d.t}t / ${d.p}p`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
