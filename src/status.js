// Shared definition of "finished".
//
// There are deliberately TWO answers, because the reports ask two different
// questions. Pick the one that matches your question and say so at the call site.
//
//   isComplete()  - generous. Work the team should get credit for: it has passed
//                   QA and is only waiting on a release/deploy date. Use for sprint
//                   progress, completion rate, carry-out.
//
//   isShipped()   - strict. Work that has actually gone out. Use when measuring
//                   ELAPSED TIME to done (stopping the clock at QA-pass would hide
//                   release-queue delay) or when forecasting what is still
//                   physically on the board next sprint.
//
// Both treat Canceled as finished: a canceled ticket does not carry over, so
// counting it as unfinished inflates carry-out.
//
// STATUS NAMES ARE WORKFLOW-SPECIFIC. The defaults below are the KEEN board's.
// On any other board, set DONE_STATUSES / AWAITING_RELEASE_STATUSES in .env and
// run `node src/check-config.js` to verify nothing is misclassified. The failure
// mode is silent, not loud: an unmatched status is simply treated as unfinished,
// so every completion rate and carry-out figure comes out wrong but plausible.

import 'dotenv/config';

const DEFAULT_DONE = 'deployed,completed,done,closed,resolved,canceled,cancelled';
const DEFAULT_AWAITING_RELEASE = 'ready for theme deploy,awaiting release date';

const parse = (v, fallback) =>
  (v ?? fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const TERMINAL = parse(process.env.DONE_STATUSES, DEFAULT_DONE);
export const AWAITING_RELEASE = parse(
  process.env.AWAITING_RELEASE_STATUSES,
  DEFAULT_AWAITING_RELEASE,
);

/** Generous: passed QA, may still be awaiting a release date. */
export function isComplete(s) {
  return [...TERMINAL, ...AWAITING_RELEASE].includes((s || '').toLowerCase());
}

/** Strict: actually shipped (or canceled). */
export function isShipped(s) {
  return TERMINAL.includes((s || '').toLowerCase());
}

/** First sprint number to include in historical baselines (board-specific). */
export const BASELINE_SPRINT_NUM = Number(process.env.BASELINE_SPRINT_NUM ?? 22);
