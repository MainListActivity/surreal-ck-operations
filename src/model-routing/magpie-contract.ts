/**
 * The VPS magpie contract, shared by the employee launcher (employee-env.ts, Node) and the owner Worker's cost code
 * (task-cost.ts). Pure on purpose: no node:fs or node:path here, so the Worker dependency graph can reach it.
 */
import { digest, employeeTier, type Tier } from "./policy.ts";

/** magpie on the VPS: the only model endpoint a company employee session talks to. */
export const MAGPIE_BASE = "https://data.maplayer.top/ofm";
/** What magpie declares for every sck group: Claude Code otherwise assumes a 200k window for a custom model id. */
export const GROUP_CONTEXT_TOKENS = 1048576;

/** The model an employee session runs on. fable is owner-only and clamps to the employee's own tier. */
export function groupModel(tier: Tier, role?: string): string {
  return `group/sck-${tier === "fable" ? employeeTier(role) : tier}`;
}

export const isGroupModel = (model: string | undefined): boolean => /^group\/sck-(opus|sonnet|haiku)$/.test(model ?? "");

/** One magpie session per (task, employee). Usage rows are matched by this exact key. */
export const sessionKey = (task: string, employee: string): string => `sck-${digest(`${task}:${employee}`)}`;
