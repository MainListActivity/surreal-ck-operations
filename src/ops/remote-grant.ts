/**
 * remote grant：给远程 VPS 发一次性兑换码，换成某测试账号的 IdP token。
 * 只存 sha256 base64url 码 hash（与 ma_hono 一致）；码只存在于返回值，
 * 不写审计、不写日志、不进密封库。
 */
import { createHash, randomBytes } from 'node:crypto';
import { CompanyError } from '../core-errors.ts';
import { canonicalAlias, accountUsername, accountEmail, ensureAccount } from './accounts.ts';
import { sha256Base64Url } from './idp-principals.ts';
import { productRequest } from './product.ts';
import type { D1Client } from './d1.ts';
import type { Fetcher } from './fetcher.ts';
import type { BrokerConfig } from './config.ts';

const invalid = (m: string) => new CompanyError('invalid', m);
const conflict = (m: string) => new CompanyError('conflict', m);

export interface RemoteGrantRemoteBlock {
  clientId: string;
  testManagerAlias: string;
  /** 兑换码有效期（小时），默认 168（7 天），上限 168。 */
  codeTtlHours?: number;
}

/** `admin project broker` 写入时的 remote 块结构校验。 */
export function validateRemoteBlock(raw: unknown): RemoteGrantRemoteBlock {
  const block = raw as Partial<RemoteGrantRemoteBlock> | null;
  if (!block || typeof block !== 'object') throw invalid('remote block must be an object');
  if (typeof block.clientId !== 'string' || block.clientId.trim() === '') {
    throw invalid('remote.clientId is required');
  }
  if (typeof block.testManagerAlias !== 'string' || block.testManagerAlias.trim() === '') {
    throw invalid('remote.testManagerAlias is required');
  }
  const ttl = block.codeTtlHours ?? 168;
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 168) {
    throw invalid('remote.codeTtlHours must be between 1 and 168');
  }
  return { clientId: block.clientId.trim(), testManagerAlias: block.testManagerAlias.trim(), codeTtlHours: ttl };
}

export interface RemoteGrantDeps {
  d1: D1Client;
  fetch?: Fetcher;
  now?: () => number;
  /** 兑换码随机源（默认 32B 随机 base64url）。 */
  randomCode?: () => string;
  /** 测试账号的密封密码（alias → 明文），仅建号时需要。 */
  sealedPassword?: (alias: string) => Promise<string | undefined>;
  /** 写密码到密封库（alias → password），仅建号时需要。 */
  sealPassword?: (alias: string, password: string) => Promise<void>;
  /** alias 客户会话 access token（产品 audience）。 */
  customerToken?: (alias: string) => Promise<string>;
  /** remote.testManagerAlias 运营会话 access token（ops audience）。 */
  operatorToken?: () => Promise<string>;
  /** 审计（绝不含码）。 */
  audit?: (action: string, evidence: string) => Promise<void>;
}

export interface IssueRemoteGrantInput {
  cfg: BrokerConfig;
  taskId: string;
  alias: string;
  /** 测试账号有效期天数，1..31，默认 30。 */
  days?: number;
  /** 需要平台内容写/发布能力时 true。 */
  content?: boolean;
}

export interface RemoteGrantIssue {
  grantId: string;
  url: string;
  expiresAt: string;
  workspaceSlug: string;
  subject: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const DAY_MS = 24 * 3600_000;
const MAX_SUBJECT_TTL_MS = 31 * DAY_MS;

const mintCode = (): string => randomBytes(32).toString('base64url');

function requireRemote(cfg: BrokerConfig): RemoteGrantRemoteBlock {
  if (cfg.remote === undefined) throw new CompanyError('not_configured', 'project env broker.remote is not configured');
  return validateRemoteBlock(cfg.remote);
}

function opsAudienceOf(cfg: BrokerConfig): string | undefined {
  return cfg.idp.ops?.audience ?? cfg.ops?.resource;
}

/** 由 data.url 推导 WSS rpc 地址；http(s)→ws(s)，保证 /rpc 尾径。 */
export function dbWsUrl(cfg: BrokerConfig): string {
  const raw = cfg.data?.url;
  if (!raw) return 'wss://data.maplayer.top/rpc';
  const base = raw.replace(/^http/, 'ws').replace(/\/+$/, '');
  return base.endsWith('/rpc') ? base : `${base}/rpc`;
}

export function remoteGrantUrl(cfg: BrokerConfig, code: string, content: boolean): string {
  const remote = requireRemote(cfg);
  const e = encodeURIComponent;
  const parts = [
    `code=${e(code)}`,
    `client_id=${e(remote.clientId)}`,
    `api=${e(cfg.product.url)}`,
    `aud=${e(cfg.idp.audience ?? '')}`,
  ];
  const opsAud = opsAudienceOf(cfg);
  if (content && opsAud) parts.push(`ops_aud=${e(opsAud)}`);
  parts.push(`db_url=${e(dbWsUrl(cfg))}`);
  return `${cfg.idp.issuer}/remote#${parts.join('&')}`;
}

interface UserRow { id: string; expires_at: string | null }

export async function issueRemoteGrant(
  deps: RemoteGrantDeps,
  input: IssueRemoteGrantInput,
): Promise<RemoteGrantIssue> {
  const cfg = input.cfg;
  const remote = requireRemote(cfg);
  if (!cfg.d1?.tenantId) throw new CompanyError('not_configured', 'broker.d1.tenantId is required');
  const tenantId = cfg.d1.tenantId;
  const now = deps.now?.() ?? Date.now();
  const days = input.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 31) throw invalid('days must be an integer between 1 and 31');
  if (!cfg.idp.audience) throw new CompanyError('not_configured', 'broker.idp.audience is required for the grant resources');

  const alias = canonicalAlias(input.alias);
  const username = accountUsername(alias, cfg.accounts.prefix);
  const email = accountEmail(username, cfg.accounts.emailDomain);
  const tenant = tenantId;

  // b) 测试账号：已存在的非测试账号（expires_at NULL）拒绝，防止把长期账号变成会被删的账号。
  const [user] = await deps.d1.query<UserRow>(
    'SELECT id, expires_at FROM users WHERE tenant_id = ? AND username = ? LIMIT 1', [tenant, username]);
  const requestedExpiryMs = now + days * DAY_MS;
  let subject: string;
  if (user === undefined) {
    if (deps.sealedPassword === undefined || deps.sealPassword === undefined) {
      throw new CompanyError('not_configured', 'sealed credential wiring is required to create the test account');
    }
    const sealed = await deps.sealedPassword(alias);
    await ensureAccount({
      d1: deps.d1, tenantId: tenant, username, email,
      ...(sealed !== undefined ? { sealed } : {}),
      seal: async (password) => deps.sealPassword!(alias, password),
    });
    const [created] = await deps.d1.query<UserRow>(
      'SELECT id, expires_at FROM users WHERE tenant_id = ? AND username = ? LIMIT 1', [tenant, username]);
    if (created === undefined) throw new CompanyError('upstream_error', 'test account insert did not resolve');
    subject = created.id;
    await deps.d1.query(
      'UPDATE users SET expires_at = ?, test_origin = ?, updated_at = ? WHERE id = ?',
      [iso(requestedExpiryMs), input.taskId, iso(now), subject]);
  } else {
    if (user.expires_at === null) {
      throw conflict(`account ${username} is a formal/long-term account (expires_at NULL); pick a new alias`);
    }
    // 取 max(现值, 新值)，且不超过 now+31 天。
    const effectiveExpiryMs = Math.min(
      Math.max(Date.parse(user.expires_at), requestedExpiryMs),
      now + MAX_SUBJECT_TTL_MS,
    );
    subject = user.id;
    await deps.d1.query(
      'UPDATE users SET expires_at = ?, test_origin = ?, updated_at = ? WHERE id = ?',
      [iso(effectiveExpiryMs), input.taskId, iso(now), subject]);
  }

  // c) 产品侧登记测试主体（先于 workspace 创建，workspace 才能被标记）。
  if (deps.operatorToken === undefined) throw new CompanyError('not_configured', 'operator token wiring is required');
  const contentCapabilities = input.content === true
    ? ['content.read', 'content.submit', 'content.publish']
    : [];
  const put = await productRequest(cfg, await deps.operatorToken(), {
    method: 'PUT',
    path: `/api/ops/test-subjects/${encodeURIComponent(subject)}`,
    body: {
      email,
      expiresAt: iso(requestedExpiryMs),
      origin: input.taskId,
      ...(contentCapabilities.length > 0 ? { contentCapabilities } : {}),
    },
  }, { fetch: deps.fetch });
  if (!put.ok) {
    throw new CompanyError('upstream_error', `test-subject registration failed (HTTP ${put.status})`);
  }

  // d) 测试 workspace：slug = <prefix><alias小写>-<taskId前8位>。
  if (deps.customerToken === undefined) throw new CompanyError('not_configured', 'customer token wiring is required');
  const customerToken = await deps.customerToken(alias);
  const slug = `${cfg.accounts.workspacePrefix}${alias.toLowerCase().replaceAll('_', '-')}-${input.taskId.slice(0, 8)}`;
  const listing = await productRequest(cfg, customerToken, { method: 'GET', path: '/api/session/workspaces' }, { fetch: deps.fetch });
  const workspaces = ((listing.body ?? {}) as { workspaces?: { slug?: string }[] }).workspaces ?? [];
  if (!workspaces.some((w) => w.slug === slug)) {
    const create = await productRequest(cfg, customerToken, {
      method: 'POST', path: '/api/workspaces',
      body: { name: `remote-${input.taskId.slice(0, 8)}`, slug },
    }, { fetch: deps.fetch });
    if (!create.ok) {
      throw new CompanyError('upstream_error', `workspace creation failed (HTTP ${create.status})`);
    }
  }

  // e) 兑换码只存 hash；resources = 产品 audience（content 时加运营 audience）。
  const code = deps.randomCode?.() ?? mintCode();
  const codeHash = await sha256Base64Url(code);
  const resources = [cfg.idp.audience];
  const opsAud = opsAudienceOf(cfg);
  if (input.content === true && opsAud) resources.push(opsAud);
  const codeTtlHours = remote.codeTtlHours ?? 168;
  const grantId = `rg_${crypto.randomUUID()}`;
  await deps.d1.query(
    `INSERT INTO remote_grants (id, tenant_id, user_id, client_id, code_hash,
      code_expires_at, code_consumed_at, resources_json, task_ref,
      expires_at, status, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'active', ?, NULL)`,
    [
      grantId, tenant, subject, remote.clientId, codeHash,
      iso(now + codeTtlHours * 3600_000), JSON.stringify(resources), input.taskId,
      iso(requestedExpiryMs), iso(now),
    ]);

  await deps.audit?.(
    'ops_remote_grant.issue',
    `task ${input.taskId} grant ${grantId} alias ${alias} ws ${slug} subject ${subject} exp ${iso(requestedExpiryMs)}`,
  );

  return {
    grantId,
    url: remoteGrantUrl(cfg, code, input.content === true),
    expiresAt: iso(requestedExpiryMs),
    workspaceSlug: slug,
    subject,
  };
}

export async function revokeRemoteGrant(
  deps: RemoteGrantDeps,
  input: { cfg: BrokerConfig; grantId?: string; taskId?: string; purge?: boolean },
): Promise<{ revoked: number; purged?: boolean }> {
  const cfg = input.cfg;
  if (!cfg.d1?.tenantId) throw new CompanyError('not_configured', 'broker.d1.tenantId is required');
  if (!input.grantId && !input.taskId) throw invalid('grantId or taskId is required');
  const now = iso(deps.now?.() ?? Date.now());
  const rows = await deps.d1.query<{ id: string; user_id: string }>(
    `UPDATE remote_grants SET status = 'revoked', revoked_at = ?
     WHERE tenant_id = ? AND status = 'active' AND (id = ? OR task_ref = ?)
     RETURNING id, user_id`,
    [now, cfg.d1.tenantId, input.grantId ?? '', input.taskId ?? '']);

  let purged = false;
  if (input.purge === true && rows.length > 0) {
    if (deps.operatorToken === undefined) throw new CompanyError('not_configured', 'operator token wiring is required');
    const token = await deps.operatorToken();
    for (const row of rows) {
      const del = await productRequest(cfg, token, {
        method: 'DELETE',
        path: `/api/ops/test-subjects/${encodeURIComponent(row.user_id)}`,
      }, { fetch: deps.fetch });
      if (!del.ok) throw new CompanyError('upstream_error', `test-subject purge failed (HTTP ${del.status})`);
    }
    await deps.d1.query(
      'UPDATE users SET expires_at = ?, updated_at = ? WHERE tenant_id = ? AND id IN (SELECT user_id FROM remote_grants WHERE id = ? OR task_ref = ?)',
      [now, now, cfg.d1.tenantId, input.grantId ?? '', input.taskId ?? '']);
    purged = true;
  }

  await deps.audit?.(
    'ops_remote_grant.revoke',
    `grant ${input.grantId ?? '-'} task ${input.taskId ?? '-'} revoked ${rows.length} purge ${purged}`,
  );
  return { revoked: rows.length, purged };
}

export interface RemoteGrantRow {
  id: string;
  user_id: string;
  client_id: string;
  code_expires_at: string;
  code_consumed_at: string | null;
  resources_json: string;
  task_ref: string | null;
  expires_at: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

export async function listRemoteGrants(
  deps: Pick<RemoteGrantDeps, 'd1'>,
  input: { cfg: BrokerConfig; taskId?: string },
): Promise<RemoteGrantRow[]> {
  if (!input.cfg.d1?.tenantId) throw new CompanyError('not_configured', 'broker.d1.tenantId is required');
  return deps.d1.query<RemoteGrantRow>(
    `SELECT id, user_id, client_id, code_expires_at, code_consumed_at, resources_json,
            task_ref, expires_at, status, created_at, revoked_at
     FROM remote_grants
     WHERE tenant_id = ? AND (? = '' OR task_ref = ?)
     ORDER BY created_at DESC`,
    [input.cfg.d1.tenantId, input.taskId ?? '', input.taskId ?? '']);
}

/** 生成 32B base64url 兑换码（公开给测试与签发路径；与 ma_hono 约定一致）。 */
export const generateRemoteCode = mintCode;

export { sha256Base64Url };
