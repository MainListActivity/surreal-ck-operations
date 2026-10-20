/**
 * The roster answer, bounded (SYS-DISP R6, AC06). Every list the roster page reads is capped by a count and by a byte share, and the
 * shares sum below the whole-answer budget, so the answer cannot grow with the review backlog or with the company. Nothing is cut
 * silently: each list reports how many it had (`total`) and whether it left items out (`truncated`). The plugin's roster handler and
 * the tests both call rosterAnswer, so the test measures the answer the owner receives.
 */
import { boundList, type ListBound } from './dispatch-list.ts';

/** The whole roster answer stays inside this many serialized UTF-8 bytes, the SYS01 whole-response budget. */
export const ROSTER_BUDGET_BYTES = 48 * 1024;

/**
 * Caps per list: at most `items` rows and at most `bytes` serialized bytes. The shares sum to 46 KiB, which leaves about 2 KiB for
 * the scalars and the bounds object (the size test measures it with every list full). Review previews grow with the review backlog,
 * pools with the roles and projects, and the rest with the configured company; none of them can push the answer past the budget.
 */
export const ROSTER_LIST_CAPS = {
  dispatchBlocked: { items: 40, bytes: 8 * 1024 },
  reviewPools: { items: 40, bytes: 10 * 1024 },
  pools: { items: 40, bytes: 10 * 1024 },
  instances: { items: 100, bytes: 6 * 1024 },
  defs: { items: 60, bytes: 6 * 1024 },
  usage: { items: 10, bytes: 4 * 1024 },
  health: { items: 20, bytes: 2 * 1024 },
} as const;

export type RosterListName = keyof typeof ROSTER_LIST_CAPS;
export type RosterBounds = Record<RosterListName, ListBound>;

/** The raw lists and scalars of one roster, before the caps. The caps only count and measure the rows; the caller types them. */
export interface RosterParts {
  paused: boolean;
  opsRepo: string;
  sessionsObservedAt?: string;
  dispatchAt?: string;
  usage: readonly unknown[];
  defs: readonly unknown[];
  instances: readonly unknown[];
  health: readonly unknown[];
  pools: readonly unknown[];
  reviewPools: readonly unknown[];
  dispatchBlocked: readonly unknown[];
}

/** The roster answer: every list capped, and the bounds that say what each list had and what the answer shows. */
export interface RosterAnswer {
  paused: boolean;
  opsRepo: string;
  sessionsObservedAt?: string;
  dispatchAt?: string;
  usage: unknown[];
  defs: unknown[];
  instances: unknown[];
  health: unknown[];
  pools: unknown[];
  reviewPools: unknown[];
  dispatchBlocked: unknown[];
  bounds: RosterBounds;
}

/** Caps every list of the roster. The scalars pass through unchanged. */
export function rosterAnswer(parts: RosterParts): RosterAnswer {
  const bounds = {} as RosterBounds;
  const lists = {} as Record<RosterListName, unknown[]>;
  for (const name of Object.keys(ROSTER_LIST_CAPS) as RosterListName[]) {
    const cap = ROSTER_LIST_CAPS[name];
    const kept = boundList(parts[name], cap.items, cap.bytes);
    lists[name] = kept.items;
    bounds[name] = kept.bound;
  }
  return { paused: parts.paused, opsRepo: parts.opsRepo, sessionsObservedAt: parts.sessionsObservedAt, dispatchAt: parts.dispatchAt, ...lists, bounds };
}
