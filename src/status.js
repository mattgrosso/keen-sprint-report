// Shared definition of "finished" for the KEEN board.
//
// There are deliberately TWO answers, because the reports ask two different
// questions. Pick the one that matches your question and say so at the call site.
//
//   isComplete()  — generous. Work the team should get credit for: it has passed
//                   QA and is only waiting on a release/deploy date. Use for sprint
//                   progress, completion rate, carry-out.
//
//   isShipped()   — strict. Work that has actually gone out. Use when measuring
//                   ELAPSED TIME to done (stopping the clock at QA-pass would hide
//                   release-queue delay, which is a real bottleneck here) or when
//                   forecasting what is still physically on the board next sprint.
//
// Both treat Canceled as finished: a canceled ticket does not carry over, so
// counting it as unfinished inflates carry-out (Matt's call, 2026-09-02).
//
// Board 54 column -> status mapping, for reference:
//   Awaiting Release  = "Awaiting Release Date", "Ready for Theme Deploy"
//   QA Approved       = "Ready for Release"      <-- NOT finished under either definition
//   Done              = "Deployed", "Canceled"

const TERMINAL = ['deployed', 'completed', 'done', 'closed', 'resolved', 'canceled', 'cancelled'];
const AWAITING_RELEASE = ['ready for theme deploy', 'awaiting release date'];

export function isComplete(s) {
  return [...TERMINAL, ...AWAITING_RELEASE].includes((s || '').toLowerCase());
}

export function isShipped(s) {
  return TERMINAL.includes((s || '').toLowerCase());
}
