# KEEN board configuration

Generated 2026-05-21 by `src/board-config.js`. Re-run when board columns or statuses change.

- Board: **KEENE** (id 54)
- Type: scrum
- Project key: KEEN

## Columns on the board

Each column groups one or more Jira statuses. When you see *"the board"*, you are seeing tickets bucketed into these columns.

| Column | Maps to statuses |
|---|---|
| **Blocked** | Blocked |
| **Ready for Development** | Backlog, Groomed, Ready for LOE, Ready for Dev |
| **In Development** | In Development, Feedback Requested |
| **Ready for QA** | Ready for QA |
| **QA Approved** | Ready for Release |
| **Done** | Deployed, Canceled |

Constraint type: `none`

## All statuses available on KEEN tickets

Grouped by Jira's status category. The board may map several of these into a single column.

### Done
- Canceled
- Completed
- Deployed

### In Progress
- Feedback Requested
- In Development
- In Progress
- Ready for QA
- Ready for Release

### To Do
- Backlog
- Blocked
- Groomed
- Open
- Ready for Dev
- Ready for LOE
- Reopened

## "Done" for this project

Status categories: anything in the "Done" category above is treated as done. The script's `isDone()` check also matches by name against: `deployed, completed, done, closed, resolved` (case-insensitive).
