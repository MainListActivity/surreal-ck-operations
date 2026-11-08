/**
 * 身份命令（只由老板调用）：ma_hono 的租户、机器客户端、员工的 agent 用户，以及员工与 agent 用户的对应关系（agent_identity）。
 * ma_hono 的服务主体只有 tenant.read、user.read、user.provision 三种权限：开租户与管理客户端需要人工管理员会话，
 * 服务主体调用会得到 ma_hono 的 forbidden，网关如实返回。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from '../../src/core-errors.ts';
import type { Config } from './env.ts';
import {
  adminRequest, createMachineClient, createTenant, ensureAgentUser, ensureMachineClient, fixedClaimsFor, IdpError,
  listAgentUsers, machineClientSpec, resetClientSecret, updateClientClaims, type AdminMethod, type IdpAdminConfig, type MachineRole,
} from './idp/index.ts';

/** 本模块处理的命令名。 */
export const IDENTITY_COMMANDS: ReadonlySet<string> = new Set([
  'idp.status', 'idp.tenant.create', 'idp.client.ensure', 'idp.client.create', 'idp.client.reset', 'idp.client.reset_secret',
  'idp.client.claims.set', 'idp.user.list_agents', 'idp.request', 'agent.identity.ensure', 'agent.create',
]);

const MACHINE_ROLES: readonly MachineRole[] = ['gateway', 'viewer', 'automation', 'runner', 'migrator', 'agentClaims'];
const EMPLOYEE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 不允许 %：百分号编码经 URL 归一化后可能跳出 /admin 前缀（如 %2e%2e）。 */
const ADMIN_PATH = /^\/admin\/[A-Za-z0-9/_.\-?=&]{0,400}$/;
const METHODS: readonly AdminMethod[] = ['GET', 'POST', 'PATCH', 'DELETE'];

/** 把 ma_hono 的错误转为网关错误。 */
async function viaIdp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof IdpError) throw new CompanyError(error.code, error.message);
    throw error;
  }
}

/** ma_hono 管理接口的配置。fetchImpl 只给测试注入假的 ma_hono 时使用。 */
export function adminOf(cfg: Config, fetchImpl?: typeof fetch): IdpAdminConfig {
  if (!cfg.admin) throw new CompanyError('not_configured', '缺少 IDP_ADMIN_TOKEN（ma_hono 服务主体令牌，只用 wrangler secret 设置）');
  return {
    adminBase: cfg.admin.adminBase,
    adminToken: cfg.admin.adminToken,
    tenantId: cfg.admin.tenantId,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

/** 需要租户路径的接口（用户、客户端）：缺少租户 id 时报 not_configured。 */
function tenantOf(cfg: Config, fetchImpl?: typeof fetch): IdpAdminConfig {
  const admin = adminOf(cfg, fetchImpl);
  if (!admin.tenantId) throw new CompanyError('not_configured', '缺少 IDP_TENANT_ID（公司租户 id，建租户后写入 wrangler.jsonc）');
  return admin;
}

/** agent 用户的邮箱：员工编号加公司配置的邮箱域。 */
export function agentEmailOf(cfg: Config, employee: string): string {
  if (!cfg.idp.agentEmailDomain) throw new CompanyError('not_configured', '缺少 AGENT_EMAIL_DOMAIN（agent 用户的邮箱域）');
  return `${employee}@${cfg.idp.agentEmailDomain}`;
}

/** 记入员工与 agent 用户的对应关系。幂等：同一员工重复写入只更新。 */
export async function linkIdentity(db: Surreal, employee: string, userId: string, now: Date = new Date()): Promise<void> {
  await db.query('UPSERT $rid SET employee = $employee, idp_user = $userId, updated_at = $now, created_at = created_at ?? $now;', {
    rid: new RecordId('agent_identity', employee), employee, userId, now,
  });
}

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new CompanyError('invalid', `${field} invalid`);
  }
  return value.trim();
}

function employeeOf(value: unknown): string {
  const id = text(value, 'employee', 64);
  if (!EMPLOYEE_ID.test(id)) throw new CompanyError('invalid', 'employee invalid');
  return id;
}

function roleOf(value: unknown): MachineRole {
  const role = text(value, 'role', 40) as MachineRole;
  if (!MACHINE_ROLES.includes(role)) throw new CompanyError('invalid', 'role invalid');
  return role;
}

/**
 * 为一个员工确保 agent 用户存在，并记入 agent_identity。先按邮箱在 ma_hono 查找，找到就复用，找不到才开户。
 * cron 只为还没有 agent_identity 的员工调用；手动命令 agent.identity.ensure 每次都会核对（ma_hono 里的用户被删后会重开）。
 * fetchImpl 只给测试注入假的 ma_hono 时使用。
 */
export async function ensureEmployeeIdentity(
  cfg: Config,
  db: Surreal,
  employee: string,
  displayName: string,
  fetchImpl?: typeof fetch,
): Promise<{ employee: string; userId: string; created: boolean }> {
  const email = agentEmailOf(cfg, employee);
  const admin = tenantOf(cfg, fetchImpl);
  const { userId, created } = await viaIdp(() => ensureAgentUser(admin, { email, displayName: displayName || employee }));
  await linkIdentity(db, employee, userId);
  return { employee, userId, created };
}

/** 身份命令。只能处理 IDENTITY_COMMANDS 中的命令。 */
export async function identityCommand(
  cfg: Config,
  db: Surreal,
  command: string,
  input: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  switch (command) {
    case 'idp.status': {
      return {
        tenantId: cfg.idp.tenantId || null,
        configured: {
          admin: cfg.admin !== undefined,
          tenant: cfg.idp.tenantId.length > 0,
          gateway: cfg.gateway !== undefined,
          cron: cfg.cron !== undefined,
          viewer: cfg.viewer !== undefined,
          cf: cfg.cf !== undefined,
          magpie: cfg.magpie !== undefined,
        },
      };
    }
    case 'idp.tenant.create': {
      const slug = text(input.slug, 'slug', 64);
      const displayName = text(input.displayName, 'displayName', 120);
      return viaIdp(() => createTenant(adminOf(cfg, fetchImpl), { slug, displayName }));
    }
    case 'idp.client.ensure': {
      const role = roleOf(input.role);
      const spec = clientSpecOf(cfg, role, input);
      return viaIdp(() => ensureMachineClient(tenantOf(cfg, fetchImpl), spec));
    }
    case 'idp.client.create': {
      const role = roleOf(input.role);
      const spec = clientSpecOf(cfg, role, input);
      return viaIdp(() => createMachineClient(tenantOf(cfg, fetchImpl), spec));
    }
    case 'idp.client.reset':
    case 'idp.client.reset_secret': {
      const clientId = text(input.clientId, 'clientId', 80);
      return viaIdp(() => resetClientSecret(tenantOf(cfg, fetchImpl), clientId));
    }
    case 'idp.client.claims.set': {
      const clientId = text(input.clientId, 'clientId', 80);
      const role = roleOf(input.role);
      const claims = fixedClaimsFor(role, { ns: cfg.db.namespace, db: cfg.db.database });
      return viaIdp(() => updateClientClaims(tenantOf(cfg, fetchImpl), clientId, claims));
    }
    case 'idp.user.list_agents': {
      const users = await viaIdp(() => listAgentUsers(tenantOf(cfg, fetchImpl)));
      return { users };
    }
    case 'idp.request': {
      const method = text(input.method, 'method', 10).toUpperCase() as AdminMethod;
      if (!METHODS.includes(method)) throw new CompanyError('invalid', 'method invalid');
      const path = text(input.path, 'path', 500);
      if (!ADMIN_PATH.test(path) || path.includes('..')) throw new CompanyError('invalid', '只允许 /admin/ 下的路径');
      if (input.body !== undefined && (typeof input.body !== 'object' || input.body === null)) {
        throw new CompanyError('invalid', 'body invalid');
      }
      return viaIdp(() => adminRequest(adminOf(cfg, fetchImpl), method, path, input.body));
    }
    case 'agent.identity.ensure':
    case 'agent.create': {
      const employee = employeeOf(input.employee);
      const displayName = typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : employee;
      return ensureEmployeeIdentity(cfg, db, employee, displayName, fetchImpl);
    }
    default:
      throw new CompanyError('invalid', `unknown identity command: ${command}`);
  }
}

function clientSpecOf(cfg: Config, role: MachineRole, input: Record<string, unknown>) {
  return machineClientSpec(role, {
    clientName: typeof input.clientName === 'string' && input.clientName.trim() ? input.clientName.trim() : `company-${role}`,
    ns: cfg.db.namespace,
    db: cfg.db.database,
    ttlSeconds: typeof input.ttlSeconds === 'number' ? input.ttlSeconds : undefined,
    agentClaimSourceClientId: typeof input.agentClaimSourceClientId === 'string' ? input.agentClaimSourceClientId : undefined,
    allowAgentExchange: input.allowAgentExchange === true,
  });
}
