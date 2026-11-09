import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const number = z.number().finite().nonnegative();
export const usageFilterSchema = z.object({
  after: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  period: z.enum(["today", "7d", "30d"]).default("today"),
  provider: z.string().max(300).optional(),
  model: z.string().max(300).optional(),
  terminal: z.string().max(100).optional(),
  offset: number.int().max(1000000).default(0),
  limit: number.int().min(1).max(50).default(50),
});
export const usageTotalsSchema = z.object({
  requests: number,
  errors: number,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number.optional(),
  unpriced: number,
  ttftMs: number.optional(),
  decodeTokensPerSecond: number.optional(),
});
export const usageGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string().optional(),
  ...usageTotalsSchema.shape,
});
export const usageRequestSchema = z.object({
  id: z.string(),
  at: number,
  terminal: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  accountId: z.string().optional(),
  accountLabel: z.string().optional(),
  accountLinked: z.boolean(),
  completed: z.boolean().optional(),
  status: number,
  totalMs: number.optional(),
  ttftMs: number.optional(),
  firstTextMs: number.optional(),
  input: number.optional(),
  output: number.optional(),
  cacheRead: number.optional(),
  cacheWrite: number.optional(),
  cost: number.optional(),
  decodeTokensPerSecond: number.optional(),
});
export const usageQuotaSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  accountLabel: z.string().optional(),
  status: z.enum(["available", "error", "unknown"]),
  windows: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        remainingPct: number.max(100).optional(),
        usedPct: number.max(100).optional(),
        resetsAt: z.string().optional(),
        display: z.string().optional(),
        unlimited: z.boolean().optional(),
      }),
    )
    .max(30),
  readAt: number.optional(),
  balance: z.string().optional(),
  plan: z.string().optional(),
});
export const usageOverviewSchema = z.object({
  at: number,
  source: z.literal("magpie"),
  stale: z.boolean(),
  totals: usageTotalsSchema,
  models: z.array(usageGroupSchema).max(500),
  terminals: z.array(usageGroupSchema).max(100),
  providers: z.array(usageGroupSchema).max(500),
  series: z
    .array(
      z.object({ at: number, requests: number, errors: number, input: number, output: number }),
    )
    .max(800),
  quotas: z.array(usageQuotaSchema).max(500),
  partial: z.boolean(),
});
export const usagePageSchema = z.object({
  hasMore: z.boolean(),
  at: number,
  stale: z.boolean(),
  total: number,
  offset: number,
  limit: number,
  rows: z.array(usageRequestSchema).max(50),
});
export const usageLiveSchema = z.object({
  at: number,
  available: z.boolean(),
  requests: z.array(usageRequestSchema).max(60),
  quotas: z.array(usageQuotaSchema).max(500),
  note: z.string().optional(),
});
export const usageOverview = defineRpc({
  name: "company.usage.overview",
  input: usageFilterSchema,
  output: usageOverviewSchema,
});
export const usageRequests = defineRpc({
  name: "company.usage.requests",
  input: usageFilterSchema,
  output: usagePageSchema,
});
export const usageLive = defineRpc({
  name: "company.usage.live",
  input: z.object({
    agentId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
  }),
  output: usageLiveSchema,
});
export type UsageFilter = z.output<typeof usageFilterSchema>;
export type UsageTotals = z.output<typeof usageTotalsSchema>;
export type UsageGroup = z.output<typeof usageGroupSchema>;
export type UsageRequest = z.output<typeof usageRequestSchema>;
export type UsageQuota = z.output<typeof usageQuotaSchema>;
export type UsageOverview = z.output<typeof usageOverviewSchema>;
export type UsagePage = z.output<typeof usagePageSchema>;
export type UsageLive = z.output<typeof usageLiveSchema>;

// 数值展示辅助函数（仅用于格式化用量数字）。
export const metricNumber = (v: number | undefined, decimals = 1) => (v === undefined ? "未知" : v.toFixed(decimals));
export const metricSeconds = (v: number | undefined) => (v === undefined ? "未知" : `${(v / 1000).toFixed(2)} 秒`);
