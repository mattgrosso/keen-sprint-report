# KEEN Sprint Report

A Node.js CLI that pulls real sprint composition data from Jira — committed vs. added vs. completed vs. carried-over — by replaying issue changelogs. Built for the KEEN team's bi-weekly retros.

## Why this exists

A standard Jira CSV export is a snapshot of *current state*. It can tell you which sprints a ticket is in, but not when it was added, what its estimate was at the time, or what status it was in at sprint close. To get the real "what did we commit to vs. what did we actually do" view, you need to replay the issue's history. That's what this script does.

## What it produces

`output/sprint-breakdown.csv` — one row per closed sprint with:

| Column | Meaning |
|---|---|
| `committed_tickets` / `committed_pts` | In the sprint at activation |
| `added_tickets` / `added_pts` | Added between activation and close |
| `removed_tickets` / `removed_pts` | Removed between activation and close |
| `completed_tickets` / `completed_pts` | In sprint at close AND in a Done-equivalent status |
| `carried_over_tickets` / `carried_over_pts` | In sprint at close AND not Done |
| `completion_rate_pct` | completed_pts ÷ (committed_pts + added_pts) |

## Setup

Requires Node 18+ and `yarn`.

```bash
git clone <this-repo>
cd keen-sprint-report
yarn install
cp .env.example .env
```

Then edit `.env` and fill in:

- `JIRA_EMAIL` — your Atlassian login email
- `JIRA_API_TOKEN` — create one at https://id.atlassian.com/manage-profile/security/api-tokens
- `JIRA_BOARD_ID` — for KEEN this is `54`. To find another team's, run `node src/find-boards.js`

`JIRA_BASE_URL` and `JIRA_PROJECT_KEY` already have sensible defaults.

## Using this on another board

The tool was built for KEEN, but nothing about it is KEEN-only except a few
workflow assumptions. To point it at a different team's board:

1. **Find the board id** and put it in `.env`:
   ```bash
   node src/find-boards.js
   ```

2. **Run the config check. Do this before trusting any output.**
   ```bash
   node src/check-config.js
   ```
   It prints your board's columns, every status in them, and how this tool
   classifies each one. Anything in your final columns reported as
   `NOT finished` is a problem — see below.

3. **Set the workflow statuses** it tells you about, in `.env`:
   ```
   DONE_STATUSES=deployed,completed,done,closed,resolved,canceled
   AWAITING_RELEASE_STATUSES=ready for theme deploy,awaiting release date
   BASELINE_SPRINT_NUM=22
   ```
   Re-run `check-config.js` until it reports no unrecognised statuses.

### Why step 2 matters

Status names are workflow-specific, and **the failure mode is silent.** A status
this tool doesn't recognise is treated as *unfinished* — so completion rates and
carry-over figures come out wrong, with no error and no obvious tell. On the KEEN
board, "Awaiting Release Date" and "Ready for Theme Deploy" count as complete;
another team will have different names, or none at all.

`BASELINE_SPRINT_NUM` is the first sprint number to include in historical
baselines. It defaults to 22 because that's where KEEN's process settled — pick
whatever is meaningful for your board, or set it low to include everything.

### Two definitions of "done", on purpose

`src/status.js` exports two functions, and each report declares which it uses:

| | Includes | Used for |
|---|---|---|
| `isComplete()` | terminal statuses **+ the awaiting-release column** | sprint progress, completion rate, carry-out |
| `isShipped()` | terminal statuses only | elapsed time to done, forecasting what's still on the board |

Both count `Canceled` as finished — a canceled ticket doesn't carry into the next
sprint, so counting it unfinished inflates carry-over.

## Verify your setup

```bash
node src/whoami.js          # confirms credentials work
node src/check-config.js    # confirms your board's statuses are classified correctly
node src/list-sprints.js    # lists all sprints on the board
```

## Run a report

```bash
# Last 3 closed sprints (fast — useful for post-sprint review)
node src/sprint-breakdown.js --last 3

# All closed sprints (slow first run, fast on rerun thanks to cache)
node src/sprint-breakdown.js
```

The first full run takes 3-5 minutes because it fetches every issue's changelog. Subsequent runs use `.cache/changelogs.json` and only re-fetch issues that have been updated since the last run. Delete `.cache/` to force a fresh pull.

## How it works

1. `fetchAllSprints` lists every sprint on the configured board
2. For each closed sprint, `fetchSprintIssues` gets the issues currently associated with it
3. For each issue, `fetchIssueChangelog` pulls the full change history
4. `buildSprintTimeline` and `statusAt` replay each issue's timeline to determine its sprint membership and status at the sprint's start and end dates
5. The results are bucketed (committed / added / removed / completed / carried over) and written to CSV

## File layout

```
keen-sprint-report/
├── .env                    # secrets (gitignored)
├── .env.example            # template — committed
├── .cache/                 # changelog cache (gitignored)
├── output/                 # generated reports (gitignored)
├── src/
│   ├── jira.js             # shared API client
│   ├── whoami.js           # auth sanity check
│   ├── find-boards.js      # board ID discovery
│   ├── list-sprints.js     # list sprints on the board
│   ├── find-points-field.js # one-shot helper to find story-points custom field
│   └── sprint-breakdown.js # the main analyzer
└── docs/
    ├── CONTEXT.md          # background and patterns observed in KEEN data
    └── NEXT.md             # backlog of ideas not yet built
```

## Known limitations

- **The "current" sprint is excluded** — sprints in state `active` or `future` are skipped because their composition isn't final yet.
- **"Done" is hardcoded** to mean status name in `{deployed, completed, done, closed, resolved}`. If KEEN ever renames its terminal status, update `isDone()` in `src/sprint-breakdown.js`.
- **The Story Points custom field is hardcoded** to `customfield_10023` (verified on this Jira instance). If used on a different Jira instance, run `node src/find-points-field.js` first to discover the right field.
- **Sprint names must be unique.** The changelog records sprint membership by name, not ID. If two sprints share an exact name, this script will count tickets against both. KEEN's sprint names are unique today.
- **The "Removed" bucket has always been zero** in KEEN's history. This is a real finding (the team doesn't formally remove tickets mid-sprint), not a bug.

## Bi-weekly cadence

When a sprint closes:

```bash
node src/sprint-breakdown.js
```

The newly-closed sprint gets fetched fresh; everything else loads from cache in seconds. Then either open `output/sprint-breakdown.csv` directly, or paste it into a chat for analysis.

## Security

- `.env` is gitignored. Never commit it.
- The API token has the same permissions as your Jira account — it can see what you can see, do what you can do.
- Revoke any token you no longer need at https://id.atlassian.com/manage-profile/security/api-tokens