import { createHash } from 'node:crypto';
import { CompanyError } from './core-errors.ts';

/**
 * FV06 恢复取证子租约（recovery read grant）的固定面。
 *
 * 签发、绑定、计数和失败停止都在 core；通道绑定在 plugin sidecar；broker 只把每次调用送进
 * core 的原子 reserve/settle。这里放四者共用的常量与判据，避免四面各写一份而漂移。
 */

/** 唯一允许的运营别名；grant 不能把它换成任何别的账号。 */
export const RECOVERY_READ_ALIAS = 'LCA04_OPS';

/** 四条的精确路径与固定顺序（1→2→3→4）。多一条、少一条、换顺序都不是有效 grant。 */
export const RECOVERY_READ_PATHS = [
  '/api/ops/internal-ai/endpoint-probe/temporary-grant',
  '/api/ops/platform-operators',
  '/api/ops/internal-ai/runtime',
  '/api/ops/runtime-version',
] as const;
export type RecoveryReadPath = typeof RECOVERY_READ_PATHS[number];

/** recovery 分支唯一放行的工具；其余工具（含所有写工具）一律 forbidden。 */
export const RECOVERY_READ_TOOLS = ['ops_operator_login', 'ops_request', 'ops_logout'] as const;
export type RecoveryReadTool = typeof RECOVERY_READ_TOOLS[number];

export const RECOVERY_READ_MIN_TTL_MS = 60_000;
export const RECOVERY_READ_MAX_TTL_MS = 30 * 60_000;
/** inFlight 覆盖一次调用的最大预算；超时未 settle 即 stopped(unknown_outcome)，不重试该路径。 */
export const RECOVERY_READ_CALL_DEADLINE_MS = 90_000;
export const RECOVERY_READ_MAX_LOGIN = 1;
export const RECOVERY_READ_MAX_CALLS_PER_PATH = 1;

export type RecoveryReadState = 'issued' | 'bound' | 'running' | 'completed' | 'stopped' | 'revoked' | 'expired';

/** 必须恰好是四条、顺序一致、无重复：paths 不是可裁剪的允许列表，而是 grant 的全部内容。 */
export function exactRecoveryPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length !== RECOVERY_READ_PATHS.length) {
    throw new CompanyError('invalid', `paths must be exactly the four recovery GET paths in order`);
  }
  for (let i = 0; i < RECOVERY_READ_PATHS.length; i++) {
    if (paths[i] !== RECOVERY_READ_PATHS[i]) {
      throw new CompanyError('invalid', `paths[${i}] must be ${RECOVERY_READ_PATHS[i]}`);
    }
  }
  return [...RECOVERY_READ_PATHS];
}

/** TTL 是 [1min, 30min]；契约值不随调用方改变，调用方只能在这个窗口里选。 */
export function parseRecoveryExpiry(expiresAt: unknown, now: number): Date {
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
    throw new CompanyError('invalid', 'expiresAt must be an ISO 8601 instant with a timezone offset');
  }
  const at = Date.parse(expiresAt);
  const ttl = at - now;
  if (ttl < RECOVERY_READ_MIN_TTL_MS || ttl > RECOVERY_READ_MAX_TTL_MS) {
    throw new CompanyError('invalid', 'expiresAt must be between 1 and 30 minutes from now');
  }
  return new Date(at);
}

/** Deterministic JSON so the same body always hashes the same (insertion order never decides evidence). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** 只存摘要：审计行里永远没有响应 body（body 只回到调用者的工具结果里）。 */
export function recoveryBodyDigest(body: unknown): string {
  return createHash('sha256').update(stableJson(body)).digest('hex');
}

export interface RecoveryReadVerdict {
  ok: boolean;
  outcome: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function recordOf(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

/**
 * 逐项成功判据（规格 §4.2 H3）。第一项的 503 是预期取证结果，不是失败；其余非 200 或视图不完整
 * 一律停止。outcome 只描述判据名，不回显 body 内容。
 */
export function classifyRecoveryRead(path: string, status: number | undefined, body: unknown): RecoveryReadVerdict {
  const bodyRecord = recordOf(body);
  switch (path) {
    case '/api/ops/internal-ai/endpoint-probe/temporary-grant': {
      const error = recordOf(bodyRecord?.error);
      if (status === 503 && error?.code === 'endpoint-probe-temporary-grant-not-configured') {
        return { ok: true, outcome: 'not_configured_503' };
      }
      if (status === 503) return { ok: false, outcome: 'unexpected_503_code' };
      return { ok: false, outcome: `unexpected_${status ?? 'no_status'}` };
    }
    case '/api/ops/platform-operators': {
      if (status !== 200) return { ok: false, outcome: `unexpected_${status ?? 'no_status'}` };
      if (!bodyRecord || bodyRecord.format_version !== 1 || !Array.isArray(bodyRecord.operators)) {
        return { ok: false, outcome: 'unexpected_body' };
      }
      return { ok: true, outcome: 'operators_v1' };
    }
    case '/api/ops/internal-ai/runtime': {
      if (status !== 200) return { ok: false, outcome: `unexpected_${status ?? 'no_status'}` };
      const binding = recordOf(bodyRecord?.endpointBinding);
      const host = bodyRecord?.endpointHost;
      const complete = !!bodyRecord
        && typeof bodyRecord.provider === 'string' && bodyRecord.provider.length > 0
        && typeof bodyRecord.model === 'string' && bodyRecord.model.length > 0
        && typeof host === 'string' && host.length > 0
        && typeof bodyRecord.jevModel === 'string'
        && typeof bodyRecord.mastraVersion === 'string'
        && Array.isArray(bodyRecord.priceCertificates)
        && typeof bodyRecord.defaultEnabled === 'boolean'
        && typeof bodyRecord.implicitRetries === 'number'
        && !!recordOf(bodyRecord.balance)
        && !!binding && binding.host === host;
      if (!complete) return { ok: false, outcome: 'unexpected_body' };
      // 生产内部的模型网关必须仍在 loopback：换到外部主机是环境变化，不能当成功读回。
      if (!LOOPBACK_HOSTS.has(host)) return { ok: false, outcome: 'unexpected_endpoint_host' };
      return { ok: true, outcome: 'runtime_projection' };
    }
    case '/api/ops/runtime-version': {
      if (status !== 200) return { ok: false, outcome: `unexpected_${status ?? 'no_status'}` };
      const origin = recordOf(bodyRecord?.origin);
      if (!origin || origin.state !== 'known') return { ok: false, outcome: 'origin_unknown' };
      if (typeof origin.sha !== 'string' || !/^[0-9a-f]{40}$/.test(origin.sha)) return { ok: false, outcome: 'origin_sha_invalid' };
      if (typeof origin.deploymentId !== 'string' || !/^\d+-\d+$/.test(origin.deploymentId)) {
        return { ok: false, outcome: 'deployment_id_invalid' };
      }
      return { ok: true, outcome: 'origin_known' };
    }
    default:
      return { ok: false, outcome: 'path_not_allowlisted' };
  }
}

/** 工具参数里这些键由通道注入，员工不能自带或覆盖。 */
export const RECOVERY_RESERVED_ARGS = ['taskId', 'sourceTaskId', 'grantId', 'grantFence', 'fence'] as const;
