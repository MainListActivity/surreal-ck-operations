// The persistent review-wait protocol (RW06). A release may take over the company state only when its own code carries this
// contract: the dependency-wait machinery that defers a review-phase task and restores that phase when the wait ends, and the
// task-view facts that name the phase and role being restored.
//
// The switch guard (scripts/review-wait-guard.sh) reads these markers from the target release's own files. Those files are bound
// to their commit by scripts/release-content.sh before the guard runs, so a marker is evidence of the reviewed code, not of a
// claim a release can make about itself: an old release does not contain this module at all, and a release that fakes it would
// still have to carry the unlock logic the markers name.
export const REVIEW_WAIT_PROTOCOL = 'review-wait/1';

/**
 * The unlock statement that restores the blocked phase instead of hard-writing `ready` (the pre-RW06 behaviour an old target
 * keeps). The guard requires both halves in the target's core, and the view fields in its contracts.
 */
export const REVIEW_WAIT_CORE_MARKERS = [
  "$restore_phase = IF $source_phase = 'review' THEN 'review' ELSE 'ready' END",
  'resume_state',
] as const;
export const REVIEW_WAIT_CONTRACT_MARKERS = ['resumeState', 'resumeRole'] as const;

/** Paths the guard reads inside a release tree (and inside plugin/server/vendor, which runs the same core in the plugin). */
export const REVIEW_WAIT_GUARD_PATHS = {
  capability: 'src/review-wait-capability.ts',
  core: 'src/core.ts',
  contracts: 'src/contracts.ts',
} as const;
