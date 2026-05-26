// Do certain reporters' tickets tend to close faster than others'?
//
// Framing: this is about understanding which *stakeholder signals* the team
// is most responsive to — not about ranking individuals. The reporter is
// often the dev who discovered the bug, the PM who wrote the spec, or
// (sometimes) an exec stakeholder. Pattern in "who reports what closes
// fast" is a signal about where prioritization energy goes.
//
// Caveats baked into the output:
//   - Cycle time from creation → done is contaminated by backlog dwell.
//     We additionally measure time from "first added to a sprint" → done.
//   - Bug-heavy reporters look faster because bugs are typically smaller.
//     We track issue-type mix per reporter so you can spot that.
//   - Small samples mean nothing. We filter to reporters with N>=10 tickets.

import 'dotenv/config';
import fs from 'fs';
import { jiraFetch } from './jira.js';

const CACHE_FILE = '.cache/changelogs.json';

function isDone(s) {
  return ['deployed', 'completed', 'done', 'closed', 'resolved']
    .includes((s || '').toLowerCase());
}
function parseSprintList(str) {
  if (!str) return [];
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Bulk-fetch reporter + issuetype + Sprint for every KEEN ticket.
 * Returns Map<key, { reporter, issuetype, sprints }>.
 */
async function fetchReporterMeta(projectKey = 'KEEN') {
  const map = new Map();
  let nextPageToken;
  while (true) {
    const body = {
      jql: `project=${projectKey}`,
      fields: ['reporter', 'issuetype', 'customfield_10019'],
      maxResults: 100,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await jiraFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const issue of data.issues || []) {
      map.set(issue.key, {
        reporter: issue.fields?.reporter?.displayName || '(none)',
        issuetype: issue.fields?.issuetype?.name || 'Unknown',
        sprints: (issue.fields?.customfield_10019 || [])
          .map((s) => s?.name)
          .filter(Boolean),
      });
    }
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return map;
}

/**
 * Find the earliest "Sprint" change event where the ticket was added
 * (i.e. went from no sprint membership to having one). Returns Date or null.
 */
function firstAddedToSprintAt(issue) {
  const histories = (issue.changelog?.histories || []).slice().sort(
    (a, b) => new Date(a.created) - new Date(b.created),
  );
  for (const h of histories) {
    for (const it of h.items) {
      if (it.field === 'Sprint') {
        const to = parseSprintList(it.toString);
        if (to.length > 0) return new Date(h.created);
      }
    }
  }
  return null;
}

function firstDoneAt(issue) {
  const histories = (issue.changelog?.histories || []).slice().sort(
    (a, b) => new Date(a.created) - new Date(b.created),
  );
  for (const h of histories) {
    for (const it of h.items) {
      if (it.field === 'status' && isDone(it.toString)) {
        return new Date(h.created);
      }
    }
  }
  // Fallback: status currently done, no transition recorded
  if (isDone(issue.fields?.status?.name)) {
    return new Date(issue.fields.updated || 0);
  }
  return null;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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
  console.log(`Loaded ${tickets.length} unique tickets from cache.`);

  console.log(`Fetching reporter / issuetype for every KEEN ticket...`);
  const meta = await fetchReporterMeta('KEEN');
  console.log(`  got ${meta.size} reporter records\n`);

  // Per-reporter stats
  const byReporter = new Map();

  for (const issue of tickets) {
    const m = meta.get(issue.key);
    if (!m) continue;
    const created = new Date(issue.fields.created);
    const doneAt = firstDoneAt(issue);
    const sprintAddAt = firstAddedToSprintAt(issue);

    const r = byReporter.get(m.reporter) || {
      reporter: m.reporter,
      total: 0,
      done: 0,
      issueTypes: {},
      cycleCreateToDone: [],
      cycleSprintToDone: [],
    };
    r.total++;
    r.issueTypes[m.issuetype] = (r.issueTypes[m.issuetype] || 0) + 1;

    if (doneAt) {
      r.done++;
      r.cycleCreateToDone.push((doneAt - created) / 86400000);
      if (sprintAddAt && doneAt > sprintAddAt) {
        r.cycleSprintToDone.push((doneAt - sprintAddAt) / 86400000);
      }
    }
    byReporter.set(m.reporter, r);
  }

  // Filter to reporters with enough volume to be meaningful
  const MIN_TICKETS = 10;
  const rows = [];
  for (const r of byReporter.values()) {
    if (r.total < MIN_TICKETS) continue;
    rows.push({
      reporter: r.reporter,
      total: r.total,
      done: r.done,
      donePct: ((100 * r.done) / r.total).toFixed(0),
      medianCreateToDone: median(r.cycleCreateToDone),
      medianSprintToDone: median(r.cycleSprintToDone),
      typeMix: r.issueTypes,
    });
  }
  rows.sort((a, b) => {
    const ax = a.medianSprintToDone ?? Infinity;
    const bx = b.medianSprintToDone ?? Infinity;
    return ax - bx;
  });

  console.log(`Reporters with >= ${MIN_TICKETS} tickets, sorted by median time-from-sprint-add to done:\n`);
  console.log(
    `Reporter                       Tot  Done %done  med d (create→done)  med d (sprint-add→done)  top issue types`,
  );
  console.log('-'.repeat(140));
  for (const r of rows) {
    const types = Object.entries(r.typeMix)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t, n]) => `${t}:${n}`)
      .join(' ');
    console.log(
      `${r.reporter.padEnd(30).slice(0, 30)} ${String(r.total).padStart(3)}  ${String(r.done).padStart(3)}  ${String(r.donePct).padStart(3)}%   ${(r.medianCreateToDone == null ? '—' : r.medianCreateToDone.toFixed(1)).padStart(8)}            ${(r.medianSprintToDone == null ? '—' : r.medianSprintToDone.toFixed(1)).padStart(8)}             ${types}`,
    );
  }

  // Also show the "long tail" — reporters with < MIN, aggregated
  let longTailCount = 0,
    longTailDone = 0;
  for (const r of byReporter.values()) {
    if (r.total < MIN_TICKETS) {
      longTailCount += r.total;
      longTailDone += r.done;
    }
  }
  console.log(
    `\n(Reporters with <${MIN_TICKETS} tickets aggregated: ${byReporter.size - rows.length} people, ${longTailCount} tickets, ${longTailDone} done)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
