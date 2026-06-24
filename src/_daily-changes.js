// One-off: what changed across active-sprint tickets in the last N days.
import 'dotenv/config';
import { jiraFetch } from './jira.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;
const SINCE = process.argv[2] || '2026-05-28T00:00:00';

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

async function fetchChangelog(key) {
  return jiraFetch(`/rest/api/3/issue/${key}?expand=changelog`);
}

async function pMap(items, fn, conc = 8) {
  const out = new Array(items.length); let i = 0;
  async function worker() { while (true) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx]); } }
  await Promise.all(Array.from({length: conc}, worker));
  return out;
}

async function main() {
  const sprints = await fetchAllSprints();
  const active = sprints.find(s => s.state === 'active');
  console.log(`Active sprint: ${active.name}`);
  const issues = await fetchSprintIssues(active.id);
  console.log(`Fetching ${issues.length} changelogs...`);
  const enriched = await pMap(issues, i => fetchChangelog(i.key), 8);

  const statusChanges = [], newAssign = [], sprintAdds = [], sprintRemoves = [], pointsChanges = [];
  for (const issue of enriched) {
    for (const h of issue.changelog?.histories || []) {
      if (h.created < SINCE) continue;
      const who = h.author?.displayName || '?';
      const when = h.created.slice(0,16).replace('T',' ');
      for (const item of h.items) {
        if (item.field === 'status') {
          statusChanges.push({ when, who, key: issue.key, from: item.fromString, to: item.toString, sum: issue.fields.summary, assignee: issue.fields.assignee?.displayName, pts: issue.fields.customfield_10023 });
        }
        if (item.field === 'assignee') {
          newAssign.push({ when, who, key: issue.key, from: item.fromString||'∅', to: item.toString||'∅', sum: issue.fields.summary });
        }
        if (item.field === 'Sprint') {
          const fromList = (item.fromString||'').split(',').map(s=>s.trim()).filter(Boolean);
          const toList = (item.toString||'').split(',').map(s=>s.trim()).filter(Boolean);
          for (const a of toList.filter(s=>!fromList.includes(s))) if (a.includes(active.name) || a.includes('Macarena')) sprintAdds.push({ when, who, key: issue.key, sum: issue.fields.summary, assignee: issue.fields.assignee?.displayName, pts: issue.fields.customfield_10023 });
          for (const r of fromList.filter(s=>!toList.includes(s))) if (r.includes(active.name) || r.includes('Macarena')) sprintRemoves.push({ when, who, key: issue.key, sum: issue.fields.summary });
        }
        if (item.field === 'Story point estimate' || /point/i.test(item.field||'')) {
          pointsChanges.push({ when, who, key: issue.key, from: item.fromString, to: item.toString, sum: issue.fields.summary });
        }
      }
    }
  }
  const print = (label, arr, fmt) => {
    console.log('\n== ' + label + ' (' + arr.length + ') ==');
    arr.sort((a,b)=>a.when.localeCompare(b.when));
    for (const x of arr) console.log('  ' + fmt(x));
  };
  print(`Added to sprint since ${SINCE.slice(0,10)}`, sprintAdds, x => x.when + ' ' + x.key.padEnd(9) + ' ' + (x.pts||0) + 'p (assignee: ' + (x.assignee||'unassigned') + ') by ' + x.who + ' — ' + (x.sum||'').slice(0,50));
  print('Removed from sprint', sprintRemoves, x => x.when + ' ' + x.key.padEnd(9) + ' by ' + x.who + ' — ' + (x.sum||'').slice(0,55));
  print('Status changes', statusChanges, x => x.when + ' ' + x.key.padEnd(9) + ' [' + (x.assignee||'?').padEnd(18) + '] ' + (x.from||'∅').padEnd(18) + ' -> ' + (x.to||'∅').padEnd(18) + ' (' + x.who + ')');
  print('Assignee changes', newAssign, x => x.when + ' ' + x.key.padEnd(9) + ' ' + x.from + ' -> ' + x.to + ' (by ' + x.who + ') — ' + (x.sum||'').slice(0,55));
  print('Points changes', pointsChanges, x => x.when + ' ' + x.key.padEnd(9) + ' ' + (x.from||'∅') + ' -> ' + (x.to||'∅') + ' (by ' + x.who + ') — ' + (x.sum||'').slice(0,55));
}

main().catch(e => { console.error(e); process.exit(1); });
