// Analyze carry-over aging:
// For each post-sprint-22 sprint N, find tickets that were carried out
// (in sprint N at end, not done at end), then measure how long after
// sprint N+1's start they reached a "done" status.
//
// Buckets:
//   day 0-1   "instant" (likely a status-update lag, work was effectively done)
//   day 2-6   "first half of next sprint"
//   day 7-13  "second half of next sprint"
//   14+ days  "lingered past one full sprint"
//   never     "still not done as of the most recent closed sprint"
//
// Reads .cache/changelogs.json and queries Jira for the sprint list.
// (Sprint list is small + cached implicitly by node; we just need start/end dates.)

import 'dotenv/config';
import fs from 'fs';
import { jiraFetch } from './jira.js';
import { fetchCurrentSprintMemberships } from './sprint-membership.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;
const CACHE_FILE = '.cache/changelogs.json';

// Sprint 22 is the cutoff per CLAUDE.md analytical guardrails.
const POST22_NAME_PREFIX_RE = /^(\d+):/; // matches "22: ..." through "27: ..."
const POST22_MIN_NUMBER = 22;

function isDone(s) {
  return ['deployed', 'completed', 'done', 'closed', 'resolved']
    .includes((s || '').toLowerCase());
}

function parseSprintList(str) {
  if (!str) return [];
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

function sprintNumberFromName(name) {
  // Handles "22: In Da Club / 50 Cent", "Sprint 17 - Low / Flo Rida", "Sprint 18 - Irreplaceable/Bey"
  const m1 = name.match(/^(\d+):/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = name.match(/^Sprint\s+(\d+)\b/i);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

function buildSprintTimeline(issue, currentSprintNames = []) {
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
  const initial = events.length ? events[0].from : currentSprintNames.slice();
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
  const histories = (issue.changelog?.histories || []).slice().sort(
    (a, b) => new Date(a.created) - new Date(b.created),
  );
  const tMs = new Date(t).getTime();
  let initial = issue.fields.status?.name || 'Unknown';
  for (const h of histories) {
    let found = false;
    for (const it of h.items) {
      if (it.field === 'status') {
        initial = it.fromString;
        found = true;
        break;
      }
    }
    if (found) break;
  }
  let current = initial;
  for (const h of histories) {
    if (new Date(h.created).getTime() > tMs) break;
    for (const it of h.items) {
      if (it.field === 'status') current = it.toString;
    }
  }
  return current;
}

/**
 * Find the timestamp the ticket first reached a done status AFTER `afterTs`.
 * Returns null if never.
 */
function firstDoneAfter(issue, afterTs) {
  const histories = (issue.changelog?.histories || []).slice().sort(
    (a, b) => new Date(a.created) - new Date(b.created),
  );
  const cutoff = new Date(afterTs).getTime();
  for (const h of histories) {
    const t = new Date(h.created).getTime();
    if (t <= cutoff) continue;
    for (const it of h.items) {
      if (it.field === 'status' && isDone(it.toString)) {
        return new Date(h.created);
      }
    }
  }
  // Also handle the case where the *current* status is done and there's no later
  // change after `afterTs` — fall back to issue.fields.updated.
  if (isDone(issue.fields.status?.name)) {
    // Only count if updated is after cutoff
    const upd = new Date(issue.fields.updated || 0).getTime();
    if (upd > cutoff) return new Date(issue.fields.updated);
  }
  return null;
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

async function main() {
  if (!BOARD_ID) {
    console.error('JIRA_BOARD_ID not set');
    process.exit(1);
  }

  // Load cache and dedup tickets by key, keeping the latest entry per ticket.
  const cacheRaw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const byKey = new Map();
  for (const [k, v] of Object.entries(cacheRaw)) {
    const updated = new Date(v.fields?.updated || 0).getTime();
    const existing = byKey.get(v.key);
    if (!existing || existing._updated < updated) {
      byKey.set(v.key, { ...v, _updated: updated });
    }
  }
  const tickets = [...byKey.values()];
  console.log(`Loaded ${tickets.length} unique tickets from cache.`);

  console.log(`Fetching current Sprint memberships for fallback...`);
  const currentMemberships = await fetchCurrentSprintMemberships('KEEN');
  console.log(`  got ${currentMemberships.size} memberships\n`);

  // Get sprint metadata (start/end/name) — small enough to just refetch.
  const sprints = (await fetchAllSprints(BOARD_ID))
    .filter((s) => s.state === 'closed' && s.startDate && s.completeDate)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  // Build post-22 sprint sequence keyed by name.
  const post22 = sprints
    .map((s) => ({ ...s, num: sprintNumberFromName(s.name) }))
    .filter((s) => s.num != null && s.num >= POST22_MIN_NUMBER)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  console.log(`Post-22 closed sprints: ${post22.map((s) => s.num).join(', ')}\n`);

  // For each sprint N from 22 onward, find carry-over tickets and their journey.
  const buckets = {
    'day 0-1 (likely status-lag)': 0,
    'day 2-6 (first half of next sprint)': 0,
    'day 7-13 (second half of next sprint)': 0,
    'day 14-27 (next sprint or one beyond)': 0,
    'day 28+ (lingered past two sprints)': 0,
    'never done (still open)': 0,
  };

  // Track per-source-sprint detail for examples
  const examples = []; // {fromSprintNum, key, days, summary}

  for (let i = 0; i < post22.length; i++) {
    const sprint = post22[i];
    const nextSprint = post22[i + 1]; // may be undefined for the latest
    const sprintEnd = new Date(sprint.completeDate);
    // Anchor for "after carryover" is the next sprint's start. If there's no
    // next post-22 sprint, anchor to sprint.completeDate itself.
    const nextStart = nextSprint ? new Date(nextSprint.startDate) : sprintEnd;

    let carryCount = 0;
    for (const issue of tickets) {
      const timeline = buildSprintTimeline(issue, currentMemberships.get(issue.key) || []);
      const namesAtEnd = sprintsAt(timeline, sprintEnd);
      if (!namesAtEnd.includes(sprint.name)) continue;
      const stEnd = statusAt(issue, sprintEnd);
      if (isDone(stEnd)) continue;
      // Carry-over confirmed.
      carryCount++;

      const doneAt = firstDoneAfter(issue, sprintEnd);
      if (!doneAt) {
        buckets['never done (still open)']++;
        examples.push({
          fromSprintNum: sprint.num,
          key: issue.key,
          days: null,
          summary: issue.fields.summary,
        });
        continue;
      }
      const days = (doneAt - nextStart) / (1000 * 60 * 60 * 24);
      let bucket;
      if (days < 2) bucket = 'day 0-1 (likely status-lag)';
      else if (days < 7) bucket = 'day 2-6 (first half of next sprint)';
      else if (days < 14) bucket = 'day 7-13 (second half of next sprint)';
      else if (days < 28) bucket = 'day 14-27 (next sprint or one beyond)';
      else bucket = 'day 28+ (lingered past two sprints)';
      buckets[bucket]++;
      examples.push({
        fromSprintNum: sprint.num,
        key: issue.key,
        days: Math.round(days * 10) / 10,
        summary: issue.fields.summary,
      });
    }
    console.log(`Sprint ${sprint.num} (${sprint.name}): ${carryCount} carry-overs out`);
  }

  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  console.log(`\n=== Carry-over aging across ${post22.length} post-22 sprints ===`);
  console.log(`Total carry-over events analyzed: ${total}\n`);
  for (const [label, n] of Object.entries(buckets)) {
    const pct = total ? ((100 * n) / total).toFixed(1) : '0.0';
    console.log(`  ${label.padEnd(50)} ${String(n).padStart(4)}  (${pct}%)`);
  }

  // Quick assignee-agnostic example listing
  console.log(`\n=== Sample fast-closes (day 0-1) ===`);
  examples
    .filter((e) => e.days != null && e.days < 2)
    .slice(0, 10)
    .forEach((e) =>
      console.log(`  [${e.key}] from sprint ${e.fromSprintNum}: closed ${e.days}d after next start — ${e.summary?.slice(0, 70)}`),
    );

  console.log(`\n=== Sample lingerers (day 14+ or never) ===`);
  examples
    .filter((e) => e.days == null || e.days >= 14)
    .slice(0, 10)
    .forEach((e) =>
      console.log(`  [${e.key}] from sprint ${e.fromSprintNum}: ${e.days == null ? 'never' : e.days + 'd'} — ${e.summary?.slice(0, 70)}`),
    );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
