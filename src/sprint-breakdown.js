// Compute true sprint composition from Jira changelogs.
//
// For each closed sprint, we replay each ticket's history to determine:
//   - Was it in this sprint at activation (committed)?
//   - Was it added during the sprint (added mid-sprint)?
//   - Was it removed during the sprint (removed mid-sprint)?
//   - Was it Done before sprint close (completed)?
//   - Was it still open at sprint close and moved to a later sprint (carried out)?
//
// Caches per-issue changelogs to .cache/changelogs.json so reruns are fast.
//
// Run with: node src/sprint-breakdown.js
// Or to limit sprints: node src/sprint-breakdown.js --last 10

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { jiraFetch } from './jira.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'KEEN';
const CACHE_DIR = '.cache';
const CACHE_FILE = path.join(CACHE_DIR, 'changelogs.json');
const OUTPUT_FILE = 'output/sprint-breakdown.csv';

// CLI args
const args = process.argv.slice(2);
const lastN = (() => {
  const i = args.indexOf('--last');
  if (i >= 0 && args[i + 1]) return parseInt(args[i + 1], 10);
  return null;
})();

// ----- Helpers -----

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveCache(cache) {
  ensureDir(CACHE_DIR);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
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
  // Issues currently associated with a sprint (whatever the state).
  // Paginate to be safe — some sprints can be large.
  let startAt = 0;
  const all = [];
  while (true) {
    const data = await jiraFetch(
      `/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=summary,status,issuetype,assignee,created,updated,customfield_10023`,
    );
    all.push(...data.issues);
    if (all.length >= data.total) break;
    startAt += 100;
  }
  return all;
}

async function fetchIssueChangelog(issueKey) {
  return jiraFetch(`/rest/api/3/issue/${issueKey}?expand=changelog`);
}

// Concurrency-limited mapper
async function pMap(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  const total = items.length;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { __error: e.message };
      }
      done++;
      if (done % 25 === 0 || done === total) {
        process.stderr.write(`\r  fetched ${done}/${total} issues...`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stderr.write('\n');
  return results;
}

// ----- Changelog replay -----
//
// A Jira changelog is a list of "histories", each with:
//   created: timestamp
//   items: [{ field, from, fromString, to, toString }, ...]
//
// For sprint membership, the field is "Sprint" and fromString/toString
// are comma-separated lists of sprint NAMES (not IDs).
//
// For status, field is "status" and fromString/toString are status names.

function parseSprintList(str) {
  if (!str) return [];
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Build a list of (timestamp, toSprintList) showing what sprints
 * this issue was in over time.
 */
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

  // The earliest event's "from" tells us the initial sprint membership
  // before any changes. If there are no sprint events, we assume empty.
  let initial = [];
  if (events.length > 0) {
    initial = events[0].from;
  }

  return { initial, events };
}

/** What sprints was the issue in at moment t? */
function sprintsAt(timeline, t) {
  const tMs = new Date(t).getTime();
  let current = timeline.initial.slice();
  for (const ev of timeline.events) {
    if (ev.ts.getTime() <= tMs) {
      current = ev.to.slice();
    } else {
      break;
    }
  }
  return current;
}

/** Status at moment t. */
function statusAt(issue, t) {
  const histories = (issue.changelog?.histories || []).slice().sort(
    (a, b) => new Date(a.created) - new Date(b.created),
  );
  const tMs = new Date(t).getTime();

  // Find initial status (the "fromString" of the earliest status change)
  let initial = issue.fields.status?.name || 'Unknown';
  for (const h of histories) {
    let foundChange = false;
    for (const it of h.items) {
      if (it.field === 'status') {
        initial = it.fromString;
        foundChange = true;
        break;
      }
    }
    if (foundChange) break;
  }

  let current = initial;
  for (const h of histories) {
    if (new Date(h.created).getTime() > tMs) break;
    for (const it of h.items) {
      if (it.field === 'status') {
        current = it.toString;
      }
    }
  }
  return current;
}

function isDone(statusName) {
  const n = (statusName || '').toLowerCase();
  return ['deployed', 'completed', 'done', 'closed', 'resolved'].includes(n);
}

function pickStoryPoints(issue) {
  const v = issue.fields?.customfield_10023;
  return typeof v === 'number' ? v : null;
}

// ----- Main -----

async function main() {
  if (!BOARD_ID) {
    console.error('JIRA_BOARD_ID not set');
    process.exit(1);
  }

  console.log(`Fetching sprints for board ${BOARD_ID}...`);
  const sprints = (await fetchAllSprints(BOARD_ID))
    .filter((s) => s.state === 'closed' && s.startDate && s.completeDate)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  let workingSet = sprints;
  if (lastN) workingSet = sprints.slice(-lastN);
  console.log(
    `Analyzing ${workingSet.length} closed sprints (of ${sprints.length} total closed).\n`,
  );

  const cache = loadCache();
  let cacheChanged = false;

  const results = [];

  for (const sprint of workingSet) {
    console.log(`\nSprint ${sprint.id} — ${sprint.name}`);
    console.log(
      `  ${sprint.startDate.slice(0, 10)} → ${sprint.completeDate.slice(0, 10)}`,
    );

    const issues = await fetchSprintIssues(sprint.id);
    console.log(`  ${issues.length} issues currently associated`);

    const enriched = await pMap(
      issues,
      async (issueStub) => {
        const cacheKey = `${issueStub.key}@${issueStub.fields.updated || ''}`;
        if (cache[cacheKey]) return cache[cacheKey];
        const full = await fetchIssueChangelog(issueStub.key);
        const stripped = {
          key: full.key,
          fields: {
            created: full.fields.created,
            updated: full.fields.updated,
            status: full.fields.status,
            issuetype: full.fields.issuetype,
            assignee: full.fields.assignee,
            summary: full.fields.summary,
            customfield_10023: full.fields.customfield_10023,
          },
          changelog: full.changelog,
        };
        cache[cacheKey] = stripped;
        cacheChanged = true;
        return stripped;
      },
      8,
    );

    if (cacheChanged) {
      saveCache(cache);
      cacheChanged = false;
    }

    const sprintName = sprint.name;
    const start = new Date(sprint.startDate);
    const end = new Date(sprint.completeDate);

    let committedTickets = 0,
      committedPts = 0;
    let addedTickets = 0,
      addedPts = 0;
    let removedTickets = 0,
      removedPts = 0;
    let completedTickets = 0,
      completedPts = 0;
    let carriedOverTickets = 0,
      carriedOverPts = 0;

    for (const issue of enriched) {
      if (issue.__error) continue;
      const timeline = buildSprintTimeline(issue);
      const atStart = sprintsAt(timeline, start).includes(sprintName);
      const atEnd = sprintsAt(timeline, end).includes(sprintName);
      const statusAtEnd = statusAt(issue, end);
      const wasDoneByEnd = isDone(statusAtEnd);
      const pts = pickStoryPoints(issue) || 0;

      if (atStart) {
        committedTickets++;
        committedPts += pts;
      }
      if (!atStart && atEnd) {
        addedTickets++;
        addedPts += pts;
      }
      if (atStart && !atEnd) {
        removedTickets++;
        removedPts += pts;
      }
      if (atEnd && wasDoneByEnd) {
        completedTickets++;
        completedPts += pts;
      }
      if (atEnd && !wasDoneByEnd) {
        carriedOverTickets++;
        carriedOverPts += pts;
      }
    }

    const completionRate =
      committedPts + addedPts > 0
        ? (100 * completedPts) / (committedPts + addedPts)
        : 0;

    console.log(
      `  Committed: ${committedTickets}t/${committedPts}p  ` +
        `Added: ${addedTickets}t/${addedPts}p  ` +
        `Removed: ${removedTickets}t/${removedPts}p  ` +
        `Completed: ${completedTickets}t/${completedPts}p  ` +
        `Carried over: ${carriedOverTickets}t/${carriedOverPts}p  ` +
        `Completion: ${completionRate.toFixed(0)}%`,
    );

    results.push({
      sprint_id: sprint.id,
      sprint_name: sprint.name,
      start: sprint.startDate.slice(0, 10),
      end: sprint.completeDate.slice(0, 10),
      committed_tickets: committedTickets,
      committed_pts: committedPts,
      added_tickets: addedTickets,
      added_pts: addedPts,
      removed_tickets: removedTickets,
      removed_pts: removedPts,
      completed_tickets: completedTickets,
      completed_pts: completedPts,
      carried_over_tickets: carriedOverTickets,
      carried_over_pts: carriedOverPts,
      completion_rate_pct: completionRate.toFixed(1),
    });
  }

  ensureDir('output');
  if (results.length === 0) {
    console.log('No sprints analyzed.');
    return;
  }
  const headers = Object.keys(results[0]);
  const csv = [
    headers.join(','),
    ...results.map((r) =>
      headers.map((h) => String(r[h]).replace(/,/g, ';')).join(','),
    ),
  ].join('\n');
  fs.writeFileSync(OUTPUT_FILE, csv);
  console.log(`\nWrote ${results.length} rows to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  console.error(err.stack);
  process.exit(1);
});