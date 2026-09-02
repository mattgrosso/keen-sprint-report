// Per-person trajectory profiles: historical dev velocity + current-sprint freshness.
//
// Two outputs:
//   1. Historical profile table — median days in "In Development" before moving to QA,
//      median post-dev pipeline time, and total cycle time. Built from the cached changelogs
//      so it covers all closed sprints without extra API calls.
//
//   2. Current-sprint status — for each person's in-flight tickets: days in current status,
//      estimated days until they clear dev (vs. their historical median), and a flag for
//      anyone who looks like they'll need a new ticket soon.
//
// Run with: node src/person-trajectory.js

import 'dotenv/config';
import fs from 'fs';
import { jiraFetch } from './jira.js';
import { isComplete } from './status.js';

const BOARD_ID = process.env.JIRA_BOARD_ID;
const CACHE_FILE = '.cache/changelogs.json';

// Statuses that count as "in active development" (the dev is building)
const IN_DEV = new Set(['in development', 'in progress']);

// Statuses that mean dev work is done and the ticket is downstream
const POST_DEV = new Set([
  'ready for qa', 'feedback requested', 'ready for release',
  'ready for theme deploy', 'awaiting release date',
  'deployed', 'completed', 'done', 'closed', 'resolved',
]);

// "Finished" here means: per-person completion
const isDone = isComplete;

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function iqr(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return {
    p25: s[Math.floor(s.length * 0.25)],
    p75: s[Math.floor(s.length * 0.75)],
  };
}

/**
 * Extract status transition timings from a ticket's changelog.
 * Returns the first time it entered dev, first time it exited dev (to a post-dev
 * status), and first time it reached done.
 */
function extractStatusTimings(issue) {
  const histories = (issue.changelog?.histories || [])
    .slice()
    .sort((a, b) => new Date(a.created) - new Date(b.created));

  let firstEnteredDevAt = null;
  let firstExitedDevAt = null;
  let firstDoneAt = null;
  let inDev = false;

  for (const h of histories) {
    for (const it of h.items) {
      if (it.field !== 'status') continue;
      const to = (it.toString || '').toLowerCase();
      const ts = new Date(h.created);

      if (IN_DEV.has(to) && !firstEnteredDevAt) {
        firstEnteredDevAt = ts;
        inDev = true;
      }
      if (inDev && POST_DEV.has(to) && !firstExitedDevAt) {
        firstExitedDevAt = ts;
        inDev = false;
      }
      if (isDone(it.toString) && !firstDoneAt) {
        firstDoneAt = ts;
      }
    }
  }

  // If the ticket is currently done but has no done transition recorded, use updated time.
  if (!firstDoneAt && isDone(issue.fields?.status?.name)) {
    firstDoneAt = new Date(issue.fields.updated || 0);
  }

  return { firstEnteredDevAt, firstExitedDevAt, firstDoneAt };
}

/**
 * Return the timestamp when the ticket last entered its current status.
 * Used to compute "days in current status" freshness.
 */
function lastEnteredCurrentStatusAt(issue) {
  const current = (issue.fields?.status?.name || '').toLowerCase();
  const histories = (issue.changelog?.histories || [])
    .slice()
    .sort((a, b) => new Date(a.created) - new Date(b.created));

  let lastEntered = null;
  for (const h of histories) {
    for (const it of h.items) {
      if (it.field === 'status' && (it.toString || '').toLowerCase() === current) {
        lastEntered = new Date(h.created);
      }
    }
  }
  return lastEntered;
}

async function fetchAllSprints() {
  let startAt = 0;
  const all = [];
  while (true) {
    const data = await jiraFetch(
      `/rest/agile/1.0/board/${BOARD_ID}/sprint?startAt=${startAt}&maxResults=50`,
    );
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
      `/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100` +
      `&fields=summary,status,assignee,customfield_10023`,
    );
    all.push(...data.issues);
    if (all.length >= data.total) break;
    startAt += 100;
  }
  return all;
}

async function pMap(items, fn, concurrency = 8) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
      if ((idx + 1) % 20 === 0)
        process.stderr.write(`\r  fetched ${idx + 1}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write(`\r  fetched ${items.length}/${items.length}\n`);
  return out;
}

async function main() {
  // ── 1. Build historical profiles from the changelog cache ──────────────────

  if (!fs.existsSync(CACHE_FILE)) {
    console.error(`Cache not found at ${CACHE_FILE}. Run sprint-breakdown.js first.`);
    process.exit(1);
  }
  const cacheRaw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

  // Deduplicate — cache keys can be sprint-scoped (e.g. "KEEN-1@v2"), keep newest per ticket
  const byKey = new Map();
  for (const v of Object.values(cacheRaw)) {
    const u = new Date(v.fields?.updated || 0).getTime();
    const ex = byKey.get(v.key);
    if (!ex || ex._u < u) byKey.set(v.key, { ...v, _u: u });
  }
  const cachedTickets = [...byKey.values()];
  console.log(`Loaded ${cachedTickets.length} unique tickets from cache.\n`);

  // Per-person arrays of observations (in days)
  const profiles = new Map();

  for (const issue of cachedTickets) {
    const assignee = issue.fields?.assignee?.displayName;
    if (!assignee) continue;

    const { firstEnteredDevAt, firstExitedDevAt, firstDoneAt } =
      extractStatusTimings(issue);
    if (!firstEnteredDevAt) continue; // never went through In Development

    const p = profiles.get(assignee) || {
      devDays: [],      // In Dev → first exit to QA/beyond
      postDevDays: [],  // first exit from dev → done
      cycleDays: [],    // In Dev → done
    };

    if (firstExitedDevAt) {
      const d = (firstExitedDevAt - firstEnteredDevAt) / 86400000;
      if (d >= 0 && d < 60) p.devDays.push(d);
    }
    if (firstExitedDevAt && firstDoneAt && firstDoneAt > firstExitedDevAt) {
      const d = (firstDoneAt - firstExitedDevAt) / 86400000;
      if (d >= 0 && d < 60) p.postDevDays.push(d);
    }
    if (firstDoneAt && firstDoneAt > firstEnteredDevAt) {
      const d = (firstDoneAt - firstEnteredDevAt) / 86400000;
      if (d >= 0 && d < 60) p.cycleDays.push(d);
    }

    profiles.set(assignee, p);
  }

  // ── 2. Active sprint: per-person in-flight freshness ──────────────────────

  const sprints = await fetchAllSprints();
  const active = sprints.find((s) => s.state === 'active');
  if (!active) { console.log('No active sprint found.'); return; }

  const now = new Date();
  const sprintEnd = new Date(active.endDate);
  const daysLeft = (sprintEnd - now) / 86400000;

  console.log(`Active sprint: ${active.name}`);
  console.log(`  ${daysLeft.toFixed(1)} days remaining (ends ${active.endDate.slice(0, 10)})\n`);

  const sprintIssues = await fetchSprintIssues(active.id);
  console.log(`Fetching changelogs for ${sprintIssues.length} active-sprint tickets...`);
  const enriched = await pMap(
    sprintIssues,
    (iss) => jiraFetch(`/rest/api/3/issue/${iss.key}?expand=changelog`),
  );

  // Categorize every ticket by person and status bucket
  const DONE_STATUSES = new Set(['deployed', 'completed', 'done', 'closed', 'resolved',
                                  'ready for theme deploy', 'awaiting release date']);
  const IN_FLIGHT_STATUSES = new Set([
    'in development', 'in progress', 'ready for qa',
    'feedback requested', 'ready for release', 'blocked',
  ]);

  // personData: name → { done, inFlight, notStarted }
  const personData = new Map();

  for (const issue of enriched) {
    const assignee = issue.fields?.assignee?.displayName || 'unassigned';
    const st = issue.fields?.status?.name || 'Unknown';
    const stl = st.toLowerCase();
    const pts = issue.fields?.customfield_10023 || 0;

    const person = personData.get(assignee) || { done: [], inFlight: [], notStarted: [] };

    if (DONE_STATUSES.has(stl)) {
      person.done.push({ key: issue.key, pts, st });
    } else if (IN_FLIGHT_STATUSES.has(stl)) {
      const { firstEnteredDevAt } = extractStatusTimings(issue);
      const lastEnteredAt = lastEnteredCurrentStatusAt(issue);
      const daysInCurrentStatus = lastEnteredAt
        ? (now - lastEnteredAt) / 86400000
        : null;

      let daysInDev = null;
      let estRemainingDev = null;
      let overrunFactor = null;

      if (IN_DEV.has(stl) && firstEnteredDevAt) {
        daysInDev = (now - firstEnteredDevAt) / 86400000;
        const profile = profiles.get(assignee);
        const medDev = profile ? median(profile.devDays) : null;
        if (medDev !== null && medDev > 0) {
          estRemainingDev = Math.max(0, medDev - daysInDev);
          overrunFactor = daysInDev / medDev; // >1 means taking longer than usual
        }
      }

      person.inFlight.push({
        key: issue.key, pts, st, stl, summary: issue.fields.summary,
        daysInCurrentStatus, daysInDev, estRemainingDev, overrunFactor,
      });
    } else {
      person.notStarted.push({ key: issue.key, pts, st });
    }

    personData.set(assignee, person);
  }

  // ── 3. Print historical profiles ──────────────────────────────────────────

  console.log('\n=== Historical Throughput Profiles ===');
  console.log('(In Development → QA, post-dev pipeline, full cycle — median with IQR)\n');

  const fmt = (v) => (v == null ? '—' : v.toFixed(1) + 'd');
  const fmtIqr = (vals) => {
    if (!vals.length) return '—';
    const r = iqr(vals);
    return `${fmt(median(vals))} [${fmt(r?.p25)}–${fmt(r?.p75)}]`;
  };

  // Print people who are in the active sprint first, then others from cache
  const activePeople = new Set(
    [...personData.keys()].filter((n) => n !== 'unassigned'),
  );
  const allPeople = [
    ...[...activePeople].sort(),
    ...[...profiles.keys()].filter((n) => !activePeople.has(n)).sort(),
  ];

  const MIN_OBS = 3;
  console.log(
    'Person                       | n   | In Dev → QA             | Post-dev pipeline       | Full cycle',
  );
  console.log(
    '-----------------------------+-----+-------------------------+-------------------------+-------------------------',
  );

  for (const name of allPeople) {
    const p = profiles.get(name);
    if (!p || p.devDays.length < MIN_OBS) continue;
    const inActive = activePeople.has(name) ? '' : ' *';
    console.log(
      `${(name + inActive).padEnd(28)} | ${String(p.devDays.length).padStart(3)} | ${fmtIqr(p.devDays).padEnd(23)} | ${fmtIqr(p.postDevDays).padEnd(23)} | ${fmtIqr(p.cycleDays)}`,
    );
  }
  console.log('(* not in active sprint  |  n = number of completed tickets with dev time recorded)');

  // ── 4. Print current-sprint per-person view ────────────────────────────────

  console.log('\n=== Current Sprint — Status by Person ===\n');

  // Sort: people with soonest-projected completion first (most likely to need work)
  const statusPriority = [
    'blocked', 'ready for release', 'feedback requested',
    'ready for qa', 'in development', 'in progress',
  ];

  const activeEntries = [...personData.entries()]
    .filter(([n]) => n !== 'unassigned')
    .sort((a, b) => {
      // Score by minimum estimated remaining dev time across in-flight tickets
      const score = (entries) => {
        const [, d] = entries;
        if (d.inFlight.length === 0) return -Infinity; // already clear
        const mins = d.inFlight.map((t) => t.estRemainingDev ?? Infinity);
        return Math.min(...mins);
      };
      return score(a) - score(b);
    });

  for (const [name, data] of activeEntries) {
    const profile = profiles.get(name);
    const medDev = profile ? median(profile.devDays) : null;

    const doneCount = data.done.length;
    const donePoints = data.done.reduce((s, t) => s + t.pts, 0);
    const inFlightCount = data.inFlight.length;
    const notStartedCount = data.notStarted.length;

    // Determine flag
    const allClearOrSoon =
      data.inFlight.length === 0 ||
      data.inFlight.every(
        (t) =>
          POST_DEV.has(t.stl) ||
          (t.estRemainingDev !== null && t.estRemainingDev < 1.5),
      );
    const needsWork = allClearOrSoon && daysLeft > 2 && notStartedCount === 0;
    const flag = needsWork ? '  ⚑ NEEDS WORK SOON' : '';

    console.log(
      `${name}${flag}  (done: ${doneCount}t/${donePoints}p · in-flight: ${inFlightCount}t · not started: ${notStartedCount}t)`,
    );

    if (medDev !== null) {
      console.log(
        `  Typical dev time: ${medDev.toFixed(1)}d median (${profile.devDays.length} tickets)`,
      );
    }

    if (data.inFlight.length === 0) {
      if (daysLeft > 2) console.log('  No in-flight work — likely available for a new ticket.');
    } else {
      data.inFlight.sort(
        (a, b) =>
          statusPriority.indexOf(a.stl) - statusPriority.indexOf(b.stl),
      );

      for (const t of data.inFlight) {
        const daysSt =
          t.daysInCurrentStatus != null
            ? `${t.daysInCurrentStatus.toFixed(1)}d in status`
            : '';

        // Flag overruns in dev
        let devNote = '';
        if (IN_DEV.has(t.stl)) {
          if (t.overrunFactor !== null && t.overrunFactor > 1.5) {
            devNote = ` ← ${t.overrunFactor.toFixed(1)}× typical (overrun)`;
          } else if (t.estRemainingDev !== null) {
            devNote =
              t.estRemainingDev < 0.5
                ? ' → about to finish dev'
                : ` → ~${t.estRemainingDev.toFixed(1)}d left in dev`;
          }
        }

        console.log(
          `  [${t.key}] ${t.pts}p  ${t.st.padEnd(22)} ${daysSt.padEnd(18)}${devNote}`,
        );
        console.log(`           ${(t.summary || '').slice(0, 80)}`);
      }
    }
    console.log('');
  }

  // Unassigned in-flight tickets
  const unassigned = personData.get('unassigned');
  if (unassigned?.inFlight.length) {
    console.log(`Unassigned in-flight (${unassigned.inFlight.length}t):`);
    for (const t of unassigned.inFlight) {
      console.log(`  [${t.key}] ${t.pts}p  ${t.st}  — ${(t.summary || '').slice(0, 70)}`);
    }
  }

  // ── 5. Summary: who needs work ─────────────────────────────────────────────

  console.log('=== Summary: Capacity Signals ===\n');
  const needsWorkList = activeEntries
    .filter(([name, data]) => {
      const allClearOrSoon =
        data.inFlight.length === 0 ||
        data.inFlight.every(
          (t) =>
            POST_DEV.has(t.stl) ||
            (t.estRemainingDev !== null && t.estRemainingDev < 1.5),
        );
      return allClearOrSoon && daysLeft > 2 && data.notStarted.length === 0;
    })
    .map(([name]) => name);

  if (needsWorkList.length) {
    console.log('Likely need a new ticket (all work near done + sprint has time left):');
    for (const n of needsWorkList) console.log(`  • ${n}`);
  } else {
    console.log('Everyone appears to have enough work to fill the sprint.');
  }

  const overruns = activeEntries.flatMap(([name, data]) =>
    data.inFlight
      .filter((t) => IN_DEV.has(t.stl) && t.overrunFactor !== null && t.overrunFactor > 1.5)
      .map((t) => ({ name, ...t })),
  );
  if (overruns.length) {
    console.log('\nTickets running long in dev (>1.5× their owner\'s typical):');
    for (const t of overruns) {
      console.log(
        `  [${t.key}] ${t.name} — ${t.daysInDev?.toFixed(1)}d in dev vs ${median(profiles.get(t.name)?.devDays)?.toFixed(1)}d typical  (${t.overrunFactor.toFixed(1)}×)`,
      );
      console.log(`           ${(t.summary || '').slice(0, 70)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
