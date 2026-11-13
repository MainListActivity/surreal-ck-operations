/**
 * 云端通道的订阅额度读取（在执行端进程内运行，沙箱外）：
 * - codex-cloud：GET https://chatgpt.com/backend-api/wham/usage（~/.codex/auth.json 的 tokens）。
 *   实测响应：rate_limit.primary_window/secondary_window{used_percent,limit_window_seconds,reset_at}、plan_type。
 * - jules：stateRoot/jules-usage.json 里桥接进程记录的会话创建时间，按滚动 24 小时计数对照 dailyLimit。
 * - devin-cloud：供应商没有可读的用量端点，交由 provider_health 耗尽冷却覆盖。
 * 任何一步失败都 fail open：返回 undefined，调用方不写入额度行（缺数据不等于额度为零）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderUsage } from '../host.ts';

export interface WhamWindow { used_percent?: number; limit_window_seconds?: number; reset_at?: number | string }
export interface WhamUsage {
  rate_limit?: { primary_window?: WhamWindow; secondary_window?: WhamWindow };
  plan_type?: string;
  email?: string;
}

function window(id: string, label: string, w: WhamWindow | undefined): { id: string; label: string; remainingPct: number; resetsAt: string | null } | undefined {
  if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return undefined;
  const resets = typeof w.reset_at === 'number' ? new Date(w.reset_at * 1000).toISOString()
    : typeof w.reset_at === 'string' ? w.reset_at : null;
  return { id, label, remainingPct: Math.max(0, Math.min(100, 100 - w.used_percent)), resetsAt: resets };
}

/** wham/usage 响应 → company_meta:quota_codex-cloud 行用的额度项；没有可用窗口返回 undefined。 */
export function whamToUsageEntry(body: WhamUsage): ProviderUsage | undefined {
  const windows = [
    window('five_hour', '5 小时窗口', body?.rate_limit?.primary_window),
    window('weekly', '周窗口', body?.rate_limit?.secondary_window),
  ].filter((w): w is NonNullable<typeof w> => w !== undefined);
  if (!windows.length) return undefined;
  return {
    providerId: 'codex-cloud',
    status: 'available',
    planLabel: body?.plan_type ?? null,
    windows,
  };
}

/** ~/.codex/auth.json → wham/usage 请求头；文件缺失或字段不齐返回 undefined。 */
export function codexAuthHeaders(home = homedir()): Record<string, string> | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'));
    const token = auth?.tokens?.access_token;
    const account = auth?.tokens?.account_id;
    if (typeof token !== 'string' || !token) return undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (typeof account === 'string' && account) headers['ChatGPT-Account-Id'] = account;
    return headers;
  } catch { return undefined; }
}

export async function readCodexCloudUsage(options: { home?: string; fetchImpl?: typeof fetch } = {}): Promise<ProviderUsage | undefined> {
  const headers = codexAuthHeaders(options.home);
  if (!headers) return undefined;
  try {
    const r = await (options.fetchImpl ?? fetch)('https://chatgpt.com/backend-api/wham/usage', { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return undefined;
    return whamToUsageEntry(await r.json() as WhamUsage);
  } catch { return undefined; }
}

/** 桥接进程记录的滚动 24 小时会话数。 */
export function julesUsageCount(stateRoot: string | undefined, now = Date.now()): number {
  if (!stateRoot) return 0;
  const file = join(stateRoot, 'jules-usage.json');
  if (!existsSync(file)) return 0;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(value)) return 0;
    return value.filter(v => typeof v === 'number' && v > now - 86_400_000).length;
  } catch { return 0; }
}

export function julesUsageEntry(stateRoot: string | undefined, dailyLimit: number, now = Date.now()): ProviderUsage {
  const used = julesUsageCount(stateRoot, now);
  const remaining = dailyLimit <= 0 ? 0 : Math.max(0, 100 - Math.round(used / dailyLimit * 100));
  return {
    providerId: 'jules',
    status: 'available',
    planLabel: 'Google AI Pro',
    windows: [{ id: 'daily', label: `24 小时会话（${used}/${dailyLimit}）`, remainingPct: remaining, resetsAt: null }],
  };
}
