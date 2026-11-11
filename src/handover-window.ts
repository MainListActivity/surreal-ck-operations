/**
 * A claim reads at most this many of its task's newest protocol entries and newest ops entries for the handover (SYS01 R3).
 * The whole history is counted, so a claim that read less says so: historyComplete is false and historyCount is the total.
 * The echo of the claim fits as many of the entries it was given as the budget allows; get_task_history pages the rest.
 * Review claims additionally pin the latest submission (at most one extra row) for the runner's task.md handover.
 *
 * Shared with the owner board: the findings round a rework message names is read from the same window the claim saw.
 */
export const HANDOVER_ROWS = 60;
export const HANDOVER_OPS_ROWS = 20;
