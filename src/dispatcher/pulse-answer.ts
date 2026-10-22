/**
 * The pulse answer, bounded (SYS-DISP R6). Every list the owner page reads is capped by a count and by a byte share, and the shares
 * sum below the whole-answer budget, so the answer cannot grow with the company. Nothing is cut silently: each list reports how many
 * it had (`total`) and whether it left items out (`truncated`). The plugin's pulse handler and the size test both call pulseAnswer,
 * so the test measures the answer the owner receives.
 */
import { boundList, type ListBound } from './dispatch-list.ts';

/** The whole pulse answer stays inside this many serialized UTF-8 bytes, the SYS01 whole-response budget. */
export const PULSE_BUDGET_BYTES = 48 * 1024;

/** Caps per list: at most `items` rows, and at most `bytes` serialized bytes. The byte shares sum below PULSE_BUDGET_BYTES. */
export const PULSE_LIST_CAPS = {
  dispatchBlocked: { items: 40, bytes: 16 * 1024 },
  goalBlockers: { items: 40, bytes: 12 * 1024 },
  workflowWaits: { items: 20, bytes: 2 * 1024 },
  ready: { items: 40, bytes: 4 * 1024 },
  doing: { items: 40, bytes: 3 * 1024 },
  stuck: { items: 30, bytes: 2 * 1024 },
  waiting: { items: 30, bytes: 2 * 1024 },
  recentDone: { items: 8, bytes: 1024 },
  goals: { items: 20, bytes: 1024 },
  resources: { items: 20, bytes: 2 * 1024 },
} as const;

export type PulseListName = keyof typeof PULSE_LIST_CAPS;
export type PulseBounds = Record<PulseListName, ListBound>;

/** The raw lists and scalars of one pulse, before the caps. Rows are typed by the caller; the caps only count and measure them. */
export interface PulseParts {
  at: string;
  /** When the dispatch conclusions were checked (the pass's snapshot), ISO 8601; absent before the first pass. */
  dispatchAt?: string;
  paused: boolean;
  doing: readonly unknown[];
  ready: readonly unknown[];
  dispatchBlocked: readonly unknown[];
  goalBlockers: readonly unknown[];
  workflowWaits: readonly unknown[];
  workflowWaitSummary: { source: 'workflow-graph'; available: boolean; checkedAt?: string; totalRoots: number; truncated: boolean; reason?: string };
  stuck: readonly unknown[];
  waiting: readonly unknown[];
  recentDone: readonly unknown[];
  goals: readonly unknown[];
  resources: readonly unknown[];
  last24h: unknown;
  churn: unknown;
}

/** The pulse answer: every list capped, and the bounds that say what each list had and what the answer shows. */
export type PulseAnswer = Omit<PulseParts, keyof PulseLists> & PulseLists & { bounds: PulseBounds };
type PulseLists = { [K in PulseListName]: unknown[] };

/** Caps every list of the pulse. The scalars pass through unchanged. */
export function pulseAnswer(parts: PulseParts): PulseAnswer {
  const bounds = {} as PulseBounds;
  const lists = {} as PulseLists;
  for (const name of Object.keys(PULSE_LIST_CAPS) as PulseListName[]) {
    const cap = PULSE_LIST_CAPS[name];
    const kept = boundList(parts[name], cap.items, cap.bytes);
    lists[name] = kept.items;
    bounds[name] = kept.bound;
  }
  return { ...parts, ...lists, bounds };
}
