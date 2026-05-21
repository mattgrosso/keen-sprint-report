# Context for future Claude (or any analyst landing here)

This document is written so a future LLM session — or a human picking up this project — can quickly get back to where Matt and I left off in May 2026. It covers what we built, what we found, what we deliberately didn't build, and the gotchas that took us a while to figure out.

## Who Matt is

Matt Grosso is one of two team leads on the **KEEN** team at Framebridge, recently promoted. JavaScript/Node.js background, comfortable with web dev, less comfortable with infrastructure-heavy stuff. Prefers Vue 3 and yarn. Works on Mac. His goal in starting this project was to build a habit of looking at team data regularly so he can speak fluently about velocity and process health, not to build a tool for its own sake.

## What KEEN is

KEEN owns Framebridge's customer-facing surfaces: the Shopify storefront (Glaze-Joinery codebase), the iOS app, the in-store POS (Start Framing app), the framing flow internals, and supporting admin tools. The board is `id=54`, name "KEENE", project key `KEEN`. Active. Two-week sprints. ~12-15 contributors.

## Things we discovered about how KEEN actually works

These are pulled from CSV analysis (1,028 tickets over 360 days) and changelog analysis (36 closed sprints). They're observations to keep in mind when reasoning about the team:

### Sprint cadence and naming
- Two-week sprints, with new sprints created in advance (~5 "future" sprints visible at any time)
- Naming convention has shifted three times: Taylor Swift songs (very early 2025, possibly a parallel board), then animal/emoji themes briefly, then **Billboard #1 hits starting with "1: Lose Control / Teddy Swims"** (April 2025), then naked numbers like "29", "30" starting around sprint 29. The Billboard naming is what most velocity analysis should reference.
- Two non-time-boxed "future" sprints exist as parking lots: **"Ready for Dev"** and **"Ready for LOE"**. Tickets get tagged with these during grooming. They aren't real sprints but they appear in the Sprint field. The script filters them out by requiring `state == 'closed'`.

### The big workflow change around sprint 22
**This is the single most important pattern in the data.** Before ~sprint 22, the team's sprints had small commitments at start (often 10-25 points) and huge mid-sprint additions (often 80-130 points). After sprint 22, commitments grew to 120-160 points at start and mid-sprint additions dropped to 15-25 points. Translation: at some point the team started actually planning at sprint planning. We don't know exactly when or why this happened — that's a question Matt should ask his co-lead and his team.

This pattern means: **never analyze pre-sprint-22 data and post-sprint-22 data together** without segmenting. The mechanics of what "commitment" means are different before and after.

### Recent steady-state (post-sprint-22 numbers)
- Committed at start: ~137 points (~45 tickets)
- Added mid-sprint: ~24 points (~10 tickets), ~20% of commitment
- Completed: ~64 points (~25 tickets)
- Carried over: ~95 points (~30 tickets)
- Completion rate: ~41%

The carry-over is larger than what gets completed. Every sprint starts with more than a full sprint's worth of unfinished work. The team appears to be functionally running Scrumban while calling it Scrum.

### Other patterns worth knowing
- **Zero formal sprint removals, ever.** Across all 36 closed sprints, no ticket was ever moved out of an active sprint. Things are added but never explicitly de-scoped. This is a real cultural observation, not a data artifact.
- **Resolution field is empty on every ticket.** The team uses Status to indicate done-ness. The terminal status is `Deployed` (for most work) or `Completed` (for epics). Any JQL or report keying on `resolution` will return nothing.
- **Story points are concentrated on a 1/2/3/5 scale** with about 75% of tickets pointed. ~25% are unpointed; ~35 are unpointed *and* "In Progress" simultaneously, which is a hygiene gap.
- **There are stale clusters that need triage**: ~14 ADA accessibility tickets stuck in Backlog/Ready-for-LOE for ~350 days, ~18 currently Blocked tickets (most with no assignee, indicating abandoned-in-place), and ~128 in-flight tickets untouched in >60 days.
- **Workflow states in use**: Open → Backlog → Groomed → Ready for LOE → Ready for Dev → In Progress / In Development → Feedback Requested → Ready for QA → Ready for Release → Deployed → Completed. Plus Blocked, Canceled. "In Progress" and "In Development" coexist; we don't know if they're meaningfully distinct.
- **There are two leads on KEEN.** Matt is one; we don't know who the other is yet. Worth asking about explicitly — finding their assigned/reported footprint in Jira would be a useful exercise.

## Gotchas we hit while building

### Story Points field
The Story Points custom field is `customfield_10023` on this Jira instance. We initially guessed `customfield_10016` (the most common default) and got all-zero point columns. `src/find-points-field.js` is a one-shot diagnostic that finds the right field by inspecting a known-pointed ticket. If this tool is ever ported to a different Jira instance, run it first.

### Sprint membership is tracked by name, not ID
The Jira changelog records sprint field changes with comma-separated sprint *names*, not IDs. This means:
1. Sprint names must be unique (they are, for KEEN)
2. Renaming a closed sprint after the fact would break historical analysis
3. The "Ready for Dev" and "Ready for LOE" parking lots show up in some tickets' sprint history alongside real sprints

### `closedSprints()` JQL function vs. our approach
We considered relying on JQL's `closedSprints()` but ended up using the Jira Agile API directly (`/rest/agile/1.0/board/{id}/sprint`) because it gives us start/end dates and state in one call, which we need for the changelog replay anyway.

### Pre-Billboard sprints have weird/empty data
Sprints 11, 12, 21 show as completely empty (0 committed, 0 added, 0 done). This is almost certainly because during that window the Sprint field wasn't being set consistently. Don't treat these as "the team did nothing those weeks" — they're data anomalies.

### Caching
`.cache/changelogs.json` keys each entry by `{issueKey}@{updatedTimestamp}`. When a ticket's updated time changes in Jira, the old cache key naturally goes stale and a fresh fetch happens. Safe to delete the cache; only cost is a longer next run.

### Concurrency
The script fetches 8 issues' changelogs in parallel. We haven't hit rate limits at this level. If Atlassian ever throttles, lower the concurrency in `pMap` calls.

### Node Fetch experimental warning
On Node 18.x, `fetch` triggers an `ExperimentalWarning`. Harmless. Gone in Node 20+. Can be silenced with `node --no-warnings`.

## How we got here (chat history summary)

1. Matt asked for help getting comfortable with KEEN as a new lead, focused on velocity and process health.
2. We discovered the MCP-based Jira tools available to me were too limited for structured analysis (only individual ticket reads, no JQL).
3. Matt exported a 360-day CSV. We analyzed 1,028 tickets, built a velocity chart, status mix, blocked/stale lists, top epics.
4. Matt asked for a sprint-by-sprint composition table (committed/added/carried/completed). The CSV alone can only approximate this — it's a current-state snapshot, no change history.
5. We built this Node project to query Jira directly and replay changelogs for the real composition data.
6. The real data confirmed the approximation roughly but revealed the **sprint-22 workflow shift** that the CSV couldn't show, and gave defensible exact numbers for retro conversations.

## What Matt cares about

When picking what to analyze or build next, weight these:

- **He wants to be a thoughtful lead, not a metrics-obsessed one.** Numbers are for grounding conversations, not for performance management. Don't generate things that would feel surveillance-y.
- **He wants to surface patterns his team can act on collectively**, not call out individuals. Per-assignee throughput exists in the data but should be used carefully.
- **He's not in a rush.** "I want the most complete view" — happy to go deep when it's worth it.
- **He values honesty about uncertainty.** When numbers might be misleading or approximate, say so clearly. Don't oversell.

## Useful prompts for ongoing weekly/bi-weekly use

When Matt drops in a fresh CSV or sprint-breakdown output, he probably wants one of:

- **Post-sprint review**: "Sprint X just closed. What's different from the last few? Anything notable about what got carried over or added mid-sprint?"
- **Trend check-in**: "Look at the last 6 sprints. Any concerning trends? Anything to praise?"
- **Retro prep**: "Pull the carried-over tickets from sprint X with assignees and ages. Group by epic. What stories should we tell at retro?"
- **Drill-down**: "Why does sprint X look different? Tell me what was in it that was different from sprint Y."