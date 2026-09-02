// Historical sprint burn-up baseline.
//
// Answers: "At X% through a sprint, what % of points are USUALLY done?"
// so a mid-flight number like "10% done at 35% through" can be judged against
// the norm instead of in a vacuum.
//
// Method: for each CLOSED sprint we sample the sprint at fixed elapsed-time
// fractions (0%, 5%, ... 100%). At each fraction t we replay changelogs to
// compute, using the SAME moving-denominator definition the daily active-sprint
// brief uses:
//     pct_done(t) = done_points_in_sprint_at_t / total_points_in_sprint_at_t
// where "in sprint at t" = carried-in (present from start) OR the Sprint field
// included this sprint by time t (committed at start / added mid-sprint), and
// "done" = the isDone() status set (deployed/completed/…/awaiting release).
//
// Then we aggregate across sprints (median + mean + range) to get a typical
// burn-up curve. Reuses the .cache/changelogs.json that sprint-breakdown.js
// populates, so reruns are fast.
//
// Run:  node src/burnup-history.js            (all closed sprints)
//       node src/burnup-history.js --last 12  (most recent 12 closed sprints)
//       node src/burnup-history.js --at 35    (also print the baseline @ 35% through)

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { jiraFetch } from './jira.js';
import { fetchCurrentSprintMemberships } from './sprint-membership.js';
import { isComplete } from './status.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'KEEN';
const CACHE_DIR = '.cache';
const CACHE_FILE = path.join(CACHE_DIR, 'changelogs.json');

const args = process.argv.slice(2);
const lastN = (() => {
  const i = args.indexOf('--last');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : null;
})();
const atPct = (() => {
  const i = args.indexOf('--at');
  return i >= 0 && args[i + 1] ? parseFloat(args[i + 1]) : null;
})();

// Sample points along the sprint (fraction of elapsed time), 0..1 in 5% steps.
const FRACTIONS = Array.from({ length: 21 }, (_, i) => i / 20);

// ----- cache -----
function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
  }
  return {};
}
function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

// ----- Jira fetch helpers (mirrors sprint-breakdown.js) -----
async function fetchAllSprints(boardId) {
  let startAt = 0;
  const all = [];
  while (true) {
    const data = await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}&maxResults=50`);
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
async function fetchIssueChangelog(issueKey) {
  return jiraFetch(`/rest/api/3/issue/${issueKey}?expand=changelog`);
}
async function pMap(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  const total = items.length;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); } catch (e) { results[i] = { __error: e.message }; }
      done++;
      if (done % 25 === 0 || done === total) process.stderr.write(`\r    fetched ${done}/${total} issues...`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stderr.write('\n');
  return results;
}

// ----- changelog replay (mirrors sprint-breakdown.js) -----
function parseSprintList(str) {
  if (!str) return [];
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}
function buildSprintTimeline(issue, currentSprintNames = []) {
  const histories = (issue.changelog?.histories || []).slice().sort((a, b) => new Date(a.created) - new Date(b.created));
  const events = [];
  for (const h of histories) {
    for (const it of h.items) {
      if (it.field === 'Sprint') {
        events.push({ ts: new Date(h.created), from: parseSprintList(it.fromString), to: parseSprintList(it.toString) });
      }
    }
  }
  const initial = events.length > 0 ? events[0].from : currentSprintNames.slice();
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
function statusAt(issue, t) {
  const histories = (issue.changelog?.histories || []).slice().sort((a, b) => new Date(a.created) - new Date(b.created));
  const tMs = new Date(t).getTime();
  let initial = issue.fields.status?.name || 'Unknown';
  for (const h of histories) {
    let found = false;
    for (const it of h.items) {
      if (it.field === 'status') { initial = it.fromString; found = true; break; }
    }
    if (found) break;
  }
  let current = initial;
  for (const h of histories) {
    if (new Date(h.created).getTime() > tMs) break;
    for (const it of h.items) if (it.field === 'status') current = it.toString;
  }
  return current;
}
// "Finished" here means: progress curve
const isDone = isComplete;
function pickStoryPoints(issue) {
  const v = issue.fields?.customfield_10023;
  return typeof v === 'number' ? v : 0;
}

// Was the issue a member of this sprint at moment t?
function inSprintAt(issue, sprintName, start, t, currentMemberships) {
  const sprintField = Array.isArray(issue.fields.customfield_10019) ? issue.fields.customfield_10019 : [];
  const carriedIn = sprintField.some((s) => s?.startDate && new Date(s.startDate) < start);
  if (carriedIn) return true; // present from the start of this sprint
  const timeline = buildSprintTimeline(issue, currentMemberships.get(issue.key) || []);
  return sprintsAt(timeline, t).includes(sprintName);
}

// ----- stats -----
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

// ----- main -----
async function main() {
  if (!BOARD_ID) { console.error('JIRA_BOARD_ID not set'); process.exit(1); }

  console.error(`Fetching sprints for board ${BOARD_ID}...`);
  let sprints = (await fetchAllSprints(BOARD_ID))
    .filter((s) => s.state === 'closed' && s.startDate && s.completeDate)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  if (lastN) sprints = sprints.slice(-lastN);
  console.error(`Analyzing ${sprints.length} closed sprints.\n`);

  const cache = loadCache();
  let cacheChanged = false;
  const currentMemberships = await fetchCurrentSprintMemberships(PROJECT_KEY);

  // curves[fractionIndex] = array of pct_done across sprints
  const curves = FRACTIONS.map(() => []);
  const perSprint = [];

  for (const sprint of sprints) {
    const start = new Date(sprint.startDate);
    const end = new Date(sprint.completeDate);
    const durMs = end - start;
    if (durMs <= 0) continue;

    const issues = await fetchSprintIssues(sprint.id);
    const enriched = await pMap(issues, async (stub) => {
      const key = `${stub.key}@${stub.fields.updated || ''}@v2`;
      if (cache[key]) return cache[key];
      const full = await fetchIssueChangelog(stub.key);
      const stripped = {
        key: full.key,
        fields: {
          created: full.fields.created, updated: full.fields.updated, status: full.fields.status,
          issuetype: full.fields.issuetype, assignee: full.fields.assignee, summary: full.fields.summary,
          customfield_10023: full.fields.customfield_10023, customfield_10019: full.fields.customfield_10019,
        },
        changelog: full.changelog,
      };
      cache[key] = stripped; cacheChanged = true;
      return stripped;
    }, 8);
    if (cacheChanged) { saveCache(cache); cacheChanged = false; }

    const valid = enriched.filter((i) => !i.__error);
    const row = { id: sprint.id, name: sprint.name, start: sprint.startDate.slice(0, 10), pts: [] };

    FRACTIONS.forEach((f, fi) => {
      const t = new Date(start.getTime() + f * durMs);
      let totalP = 0, doneP = 0;
      for (const issue of valid) {
        if (!inSprintAt(issue, sprint.name, start, t, currentMemberships)) continue;
        const p = pickStoryPoints(issue);
        totalP += p;
        if (isDone(statusAt(issue, t))) doneP += p;
      }
      const pct = totalP > 0 ? (100 * doneP) / totalP : 0;
      curves[fi].push(pct);
      row.pts.push(pct);
    });
    perSprint.push(row);
    console.error(`  ${sprint.name}: final ${row.pts[row.pts.length - 1].toFixed(0)}% done`);
  }

  if (cacheChanged) saveCache(cache);

  // ----- output -----
  console.log(`\n=== Sprint burn-up baseline (${perSprint.length} closed sprints) ===`);
  console.log(`Using the daily brief's moving-denominator definition: done_pts / total_pts_in_sprint at each moment.\n`);
  console.log(`  % through | median done | mean done |  range (min–max)`);
  console.log(`  ----------|-------------|-----------|-----------------`);
  FRACTIONS.forEach((f, fi) => {
    const xs = curves[fi];
    const md = median(xs), mn = mean(xs);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    console.log(
      `     ${String(Math.round(f * 100)).padStart(4)}% | ${md.toFixed(0).padStart(9)}%  | ${mn.toFixed(0).padStart(7)}%  |  ${lo.toFixed(0)}%–${hi.toFixed(0)}%`,
    );
  });

  if (atPct != null) {
    // interpolate baseline at an arbitrary % through
    const f = atPct / 100;
    let fi = FRACTIONS.findIndex((x) => x >= f);
    if (fi < 0) fi = FRACTIONS.length - 1;
    const xs = curves[fi];
    console.log(`\n>>> At ~${atPct}% through a sprint, historically: median ${median(xs).toFixed(0)}% done, mean ${mean(xs).toFixed(0)}% done (range ${Math.min(...xs).toFixed(0)}%–${Math.max(...xs).toFixed(0)}%).`);
  }

  // per-sprint curve dump (compact) for spotting outliers
  console.log(`\n=== Per-sprint (% done at each 25% mark) ===`);
  console.log(`  sprint                         | 25% | 50% | 75% | end`);
  for (const r of perSprint) {
    const p = (frac) => r.pts[FRACTIONS.indexOf(frac)].toFixed(0).padStart(3);
    console.log(`  ${r.name.slice(0, 30).padEnd(30)} | ${p(0.25)}%| ${p(0.5)}%| ${p(0.75)}%| ${r.pts[r.pts.length - 1].toFixed(0).padStart(3)}%`);
  }
}

main().catch((err) => { console.error('\nFailed:', err.message); console.error(err.stack); process.exit(1); });
