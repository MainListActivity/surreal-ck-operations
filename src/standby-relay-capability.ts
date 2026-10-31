/**
 * FV06 P0/P1 standby relay capability: the protocol marker the release switch guard probes.
 *
 * A release may only take over company state when both its core and its plugin vendor tree carry
 * the standby protocol (the bounded-standby resume write in core.ts, the supervision branch in
 * dispatcher.ts and the view fields in contracts.ts). scripts/standby-relay-guard.sh reads these
 * files as text — declarations only, comment text cannot pass — and refuses a switch when either
 * face is missing the contract (fail-closed, no zero-row exception).
 */
export const STANDBY_RELAY_PROTOCOL = 'standby-relay/1';
/** Default standby budget in seconds when the company config does not set one (≤ 600). */
export const STANDBY_BUDGET_SECONDS_DEFAULT = 600;
/** Throttle of the standby wake: one session wake per holder per this many seconds. */
export const STANDBY_WAKE_RETRY_SECONDS = 60;
