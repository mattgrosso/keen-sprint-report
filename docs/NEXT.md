# Backlog of ideas

Things Matt and Claude discussed but didn't build. Listed roughly in order of value-per-effort. Pick one when there's appetite.

## Reports & analyses

### Retro-prep view (high value, low effort)
Take a sprint name as CLI arg, dump:
- All carried-over tickets with assignee, points, age, parent epic
- All mid-sprint additions with who added them (changelog `author` field), when, and which they displaced
- Tickets that bounced status multiple times during the sprint (a "thrash" indicator)

Output as markdown ready to paste into a retro doc.

### Per-assignee throughput
Same data, sliced by assignee. Show points completed per sprint per person, average ticket size, ratio of bug-fix to new-feature work. **Use carefully — this is the kind of view that can feel surveillance-y. Frame it for self-reflection, not performance management.**

### Mid-sprint addition report
Just the orange band, broken out by ticket. Useful for the "where is the scope creep coming from?" conversation. Authors of additions can be pulled from the changelog `author` field.

### Cycle time from real transitions
Replace the "created → last updated" proxy with real "moved to In Progress → moved to Done" transitions. The changelog already has this; we just don't extract it yet. Per ticket, per type, per assignee.

### Blocked-ticket age tracker
Specifically for the persistent-blockers problem. Output: every Blocked ticket with how long it's been blocked (last transition into Blocked), who put it there, whether anyone has commented on it recently. Weekly run.

### ADA-cluster status
The accessibility backlog (~14 tickets stuck ~350 days) is a known concern. A small report that just answers "are any of these moving?" would be useful for ongoing conversations.

## Infrastructure

### Push to GitHub
Right now this repo only exists on Matt's laptop. Push to a private GitHub repo so it survives a laptop loss and so the co-lead could clone it.

### Add a yarn script for the common runs
`package.json` scripts:
```json
"scripts": {
  "report": "node src/sprint-breakdown.js",
  "recent": "node src/sprint-breakdown.js --last 3",
  "boards": "node src/find-boards.js",
  "sprints": "node src/list-sprints.js",
  "whoami": "node src/whoami.js"
}
```
Then `yarn report` etc.

### Silence the Fetch warning
Either add `node --no-warnings` to the yarn scripts or upgrade to Node 20+.

### Make the project key configurable per board
Currently hardcoded for KEEN. If the co-lead or another team wants to use this, the project/board fields just need to be parameters. Already mostly in `.env` — verify all hardcoded references are gone.

## Output formats

### Markdown summary alongside the CSV
The CSV is the source of truth, but a markdown summary written alongside it (with the headline numbers, week-over-week deltas, and call-outs) is what Matt would actually paste into Slack or a status doc.

### Direct paste-into-chat output
A "report me the latest" command that emits a single text blob ready to drop into a Claude chat, with the standing prompt prepended. Closes the loop on the "weekly meeting with Claude" workflow.

## Bigger lifts

### Web UI
A small dashboard that reads `output/sprint-breakdown.csv` and renders the charts in-browser. Vue 3 (per Matt's preferences). Static — no server needed. Useful if other team members want to look at the data without running Node.

### MCP server wrapper
Turn this whole thing into an MCP server that exposes "get sprint breakdown" as a tool Claude can call directly. Then Matt wouldn't need to run the CLI and paste — he could just ask. Big lift; only worth doing if the bi-weekly habit really sticks.