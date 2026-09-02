// Ticket status snapshot — the engine behind per-project progress views.
//
// Give it a set of Jira keys or a JQL query; it reports each ticket bucketed by
// Jira's built-in status CATEGORY into created (To Do) / in-progress / done,
// with assignee, points, and created/updated dates. Used to answer "how is
// project X progressing?" alongside the narrative in remindme's projects/*.md.
//
// Run:
//   node src/ticket-status.js KEEN-1156 KEEN-1238 KEEN-1309   # explicit keys
//   node src/ticket-status.js --jql 'labels = "mounting-matting"'   # a query
//   node src/ticket-status.js --jql '"Epic Link" = KEEN-1000'       # an epic
//   (add --json for machine-readable output)

import 'dotenv/config';
import { jiraFetch } from './jira.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const jqlIdx = args.indexOf('--jql');
const jql = jqlIdx >= 0 ? args[jqlIdx + 1] : null;
const keys = args.filter((a, i) => /^KEEN-\d+$/i.test(a));

const FIELDS = 'summary,status,assignee,created,updated,customfield_10023,issuetype';

async function searchByJql(jqlStr) {
  // /rest/api/3/search is retired (410 Gone); use /search/jql with token pagination.
  const all = [];
  let nextPageToken = null;
  while (true) {
    const tokenParam = nextPageToken ? `&nextPageToken=${encodeURIComponent(nextPageToken)}` : '';
    const data = await jiraFetch(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jqlStr)}&maxResults=100&fields=${FIELDS}${tokenParam}`,
    );
    all.push(...(data.issues || []));
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return all;
}

async function fetchKeys(keyList) {
  const jqlStr = `key in (${keyList.join(',')})`;
  return searchByJql(jqlStr);
}

// Jira status categories: "new" = To Do (created/not started),
// "indeterminate" = In Progress (started), "done" = Done (finished).
function bucketOf(issue) {
  const cat = issue.fields.status?.statusCategory?.key;
  if (cat === 'done') return 'done';
  if (cat === 'indeterminate') return 'in_progress';
  return 'created';
}

function pts(issue) {
  const v = issue.fields.customfield_10023;
  return typeof v === 'number' ? v : 0;
}

function fmtDate(s) { return s ? s.slice(0, 10) : '—'; }

async function main() {
  if (!jql && keys.length === 0) {
    console.error('Usage: node src/ticket-status.js KEEN-1 KEEN-2 ...  |  --jql "<jql>"  [--json]');
    process.exit(1);
  }

  const issues = jql ? await searchByJql(jql) : await fetchKeys(keys);

  const buckets = { created: [], in_progress: [], done: [] };
  for (const i of issues) buckets[bucketOf(i)].push(i);

  if (asJson) {
    console.log(JSON.stringify(
      issues.map((i) => ({
        key: i.key, summary: i.fields.summary, status: i.fields.status?.name,
        bucket: bucketOf(i), assignee: i.fields.assignee?.displayName || null,
        points: pts(i), created: fmtDate(i.fields.created), updated: fmtDate(i.fields.updated),
      })),
      null, 2,
    ));
    return;
  }

  const sumP = (arr) => arr.reduce((a, i) => a + pts(i), 0);
  const totalP = sumP(issues);
  console.log(`\n=== Ticket snapshot (${issues.length} tickets, ${totalP}p) ===`);
  console.log(
    `  created/not-started: ${buckets.created.length}t/${sumP(buckets.created)}p  |  ` +
    `in progress: ${buckets.in_progress.length}t/${sumP(buckets.in_progress)}p  |  ` +
    `done: ${buckets.done.length}t/${sumP(buckets.done)}p`,
  );
  const order = [['done', '✅ DONE'], ['in_progress', '🔨 IN PROGRESS'], ['created', '📋 NOT STARTED']];
  for (const [k, label] of order) {
    if (!buckets[k].length) continue;
    console.log(`\n${label} (${buckets[k].length})`);
    for (const i of buckets[k].sort((a, b) => new Date(b.fields.updated) - new Date(a.fields.updated))) {
      const who = i.fields.assignee?.displayName?.split(' ')[0] || '—';
      console.log(`  [${i.key}] ${String(pts(i)).padStart(2)}p ${i.fields.status?.name.padEnd(20)} ${who.padEnd(10)} upd ${fmtDate(i.fields.updated)} — ${i.fields.summary.slice(0, 50)}`);
    }
  }
}

main().catch((err) => { console.error('\nFailed:', err.message); process.exit(1); });
