import { LIFECYCLE_COMMANDS } from '../../src/lifecycle-policy.ts';
import { ITERATION_COMMANDS } from '../src/iteration-commands.ts';
import { describe, expect, test } from 'bun:test';

import {
  COMPANY_HOST, DEFAULT_PROTECTED_D1_IDS, DEFAULT_PROTECTED_SCRIPTS, hardTargetOwnerOnly, lockTargetsOf, OWNER_ONLY_FOR_AGENTS,
  pathSegments, TARGET_LOCKS, type LockTargets,
} from '../src/owner-locks.ts';

// 按目标的硬锁（owner-locks.ts）是纯函数：不访问网络与数据库，直接断言返回的拒绝理由是否存在。
const COMPANY_ID = '46aa29a6-9ee8-4052-bccd-7923f98220d7';
const D1_ID = '621dbcf7-ddcc-4099-8df2-3ec076830857';
const targets: LockTargets = lockTargetsOf(COMPANY_ID);
const unconfigured: LockTargets = lockTargetsOf('');

const locked = (command: string, input: Record<string, unknown>, lockTargets: LockTargets = targets) =>
  hardTargetOwnerOnly(command, input, lockTargets);

describe('lockTargetsOf：默认项加上配置的追加项', () => {
  test('默认含老板端 Worker、ma_hono 的脚本与 D1；配置只能追加，去重、小写、去空白', () => {
    const merged = lockTargetsOf(' 46AA29A6-9EE8-4052-BCCD-7923F98220D7 ', [' Extra-Worker ', 'company-owner-end', ''], ['AAAA-1111', D1_ID]);
    expect(merged.companyTenantId).toBe(COMPANY_ID);
    expect(merged.scripts).toEqual(['company-owner-end', 'ma-auth', 'extra-worker']);
    expect(merged.d1Ids).toEqual([D1_ID, 'aaaa-1111']);
  });

  test('默认项不能被配置移除；未配置公司租户时 companyTenantId 为空串', () => {
    const merged = lockTargetsOf('', [], []);
    expect(DEFAULT_PROTECTED_SCRIPTS).toEqual(['company-owner-end', 'ma-auth']);
    expect(DEFAULT_PROTECTED_D1_IDS).toEqual([D1_ID]);
    expect(merged.scripts).toEqual([...DEFAULT_PROTECTED_SCRIPTS]);
    expect(merged.d1Ids).toEqual([...DEFAULT_PROTECTED_D1_IDS]);
    expect(merged.companyTenantId).toBe('');
  });
});

describe('pathSegments：路径切段', () => {
  test('去掉查询串与片段、转小写、去掉空段', () => {
    expect(pathSegments('/Admin//Tenants/?slug=x#y')).toEqual(['admin', 'tenants']);
    expect(pathSegments('/admin/tenants#frag')).toEqual(['admin', 'tenants']);
    expect(pathSegments(undefined)).toEqual([]);
  });
});

describe('idp.*：公司租户与服务主体的写入', () => {
  test('读取不受限：idp.status、idp.user.list_agents 与 GET 的管理路径（含服务主体、公司租户）', () => {
    expect(locked('idp.status', {})).toBeUndefined();
    expect(locked('idp.user.list_agents', {})).toBeUndefined();
    expect(locked('idp.request', { method: 'GET', path: '/admin/tenants' })).toBeUndefined();
    expect(locked('idp.request', { method: 'GET', path: `/admin/tenants/${COMPANY_ID}/users` })).toBeUndefined();
    expect(locked('idp.request', { method: 'GET', path: '/admin/service-principals' })).toBeUndefined();
  });

  test('idp.tenant.create：slug 为 company（忽略大小写与首尾空白）锁定；其它租户放行', () => {
    expect(locked('idp.tenant.create', { slug: 'company', displayName: '公司' })).toContain('公司租户的开户');
    expect(locked('idp.tenant.create', { slug: ' Company ' })).toBeDefined();
    expect(locked('idp.tenant.create', { slug: 'client-a', displayName: 'A' })).toBeUndefined();
  });

  test('idp.client.*（客户端的创建、重置与声明）与未知的 idp 写命令一律锁定，因为它们都作用于公司租户', () => {
    for (const command of ['idp.client.ensure', 'idp.client.create', 'idp.client.reset', 'idp.client.reset_secret', 'idp.client.claims.set', 'idp.future.write']) {
      expect(locked(command, { clientId: 'c' })).toMatch(/^按目标锁定：/);
    }
  });

  test('idp.request：公司租户的写入（路径含公司租户 id 或 slug company，大小写与查询串不影响）锁定；其它租户的路径放行', () => {
    expect(locked('idp.request', { method: 'POST', path: `/admin/tenants/${COMPANY_ID}/clients` })).toBeDefined();
    expect(locked('idp.request', { method: 'PATCH', path: `/admin/tenants/${COMPANY_ID.toUpperCase()}/users/u1` })).toBeDefined();
    expect(locked('idp.request', { method: 'POST', path: `/admin/tenants/${COMPANY_ID}?x=1` })).toBeDefined();
    expect(locked('idp.request', { method: 'DELETE', path: '/admin/tenants/company/clients/c1' })).toBeDefined();
    expect(locked('idp.request', { method: 'POST', path: '/admin/tenants/other-tenant/clients', body: {} })).toBeUndefined();
    expect(locked('idp.request', { method: 'POST', path: '/admin/tenants', body: { slug: 'client-a' } })).toBeUndefined();
  });

  test('idp.request：请求体的 slug 为 company 时，POST /admin/tenants 锁定', () => {
    expect(locked('idp.request', { method: 'POST', path: '/admin/tenants', body: { slug: 'Company' } })).toBeDefined();
  });

  test('idp.request：服务主体与其它管理路径的写入一律锁定（默认拒绝）', () => {
    expect(locked('idp.request', { method: 'POST', path: '/admin/service-principals', body: {} })).toBeDefined();
    expect(locked('idp.request', { method: 'PATCH', path: '/admin/service-principals/sp1' })).toBeDefined();
    expect(locked('idp.request', { method: 'POST', path: '/admin/signing-keys' })).toBeDefined();
  });

  test('idp.request：/admin/login 读写都锁定（老板登录方式）；非 /admin 根的路径锁定', () => {
    expect(locked('idp.request', { method: 'POST', path: '/admin/login' })).toBeDefined();
    expect(locked('idp.request', { method: 'GET', path: '/admin/login' })).toBeDefined();
    expect(locked('idp.request', { method: 'GET', path: '/other/tenants' })).toBeDefined();
  });

  test('idp.request：未配置公司租户 id 时，租户路径的写入失败即锁（无法识别是否公司租户）；读取与开其它租户仍放行', () => {
    expect(locked('idp.request', { method: 'POST', path: '/admin/tenants/some-id/clients' }, unconfigured)).toContain('IDP_TENANT_ID 未配置');
    expect(locked('idp.request', { method: 'GET', path: '/admin/tenants/some-id' }, unconfigured)).toBeUndefined();
    expect(locked('idp.request', { method: 'POST', path: '/admin/tenants', body: { slug: 'client-a' } }, unconfigured)).toBeUndefined();
  });
});

describe('cf.api：老板端与 ma_hono 的 Worker、D1、API 令牌与自定义域名', () => {
  test('老板端 Worker 的子资源（脚本、机密、设置）读写都锁定', () => {
    for (const path of [
      '/accounts/acc1/workers/scripts/company-owner-end',
      '/accounts/acc1/workers/scripts/company-owner-end/secrets',
      '/accounts/acc1/workers/scripts/company-owner-end/settings',
    ]) {
      expect(locked('cf.api', { method: 'GET', path })).toBeDefined();
      expect(locked('cf.api', { method: 'PUT', path, body: {} })).toBeDefined();
    }
  });

  test('ma_hono 的 Worker（ma-auth）与 D1（621dbcf7…）锁定；配置追加的脚本与数据库同样锁定', () => {
    expect(locked('cf.api', { method: 'PUT', path: '/accounts/acc1/workers/scripts/ma-auth/secrets', body: {} })).toBeDefined();
    expect(locked('cf.api', { method: 'POST', path: `/accounts/acc1/d1/database/${D1_ID}/query`, body: { sql: 'SELECT 1' } })).toBeDefined();
    const extra = lockTargetsOf('', ['Extra-Worker'], ['aaaa-1111']);
    expect(locked('cf.api', { method: 'PUT', path: '/accounts/acc1/workers/scripts/extra-worker/secrets' }, extra)).toBeDefined();
    expect(locked('cf.api', { method: 'GET', path: '/accounts/acc1/d1/database/AAAA-1111' }, extra)).toBeDefined();
  });

  test('API 令牌的管理锁定：/accounts/<账号>/tokens 与 /user/tokens', () => {
    expect(locked('cf.api', { method: 'GET', path: '/accounts/acc1/tokens' })).toBeDefined();
    expect(locked('cf.api', { method: 'POST', path: '/accounts/acc1/tokens/verify' })).toBeDefined();
    expect(locked('cf.api', { method: 'GET', path: '/user/tokens' })).toBeDefined();
  });

  test('自定义域名：写入锁定，读取放行', () => {
    expect(locked('cf.api', { method: 'PUT', path: '/accounts/acc1/workers/domains/records/d1', body: {} })).toBeDefined();
    expect(locked('cf.api', { method: 'DELETE', path: '/accounts/acc1/workers/domains/records/d1' })).toBeDefined();
    expect(locked('cf.api', { method: 'GET', path: '/accounts/acc1/workers/domains' })).toBeUndefined();
  });

  test('请求内容提到公司域名或受保护的资源（D1 绑定、脚本名）时锁定，即使路径是其它脚本', () => {
    expect(locked('cf.api', { method: 'PUT', path: '/accounts/acc1/workers/scripts/other-worker', body: { bindings: [{ type: 'd1', id: D1_ID }] } })).toBeDefined();
    expect(locked('cf.api', { method: 'PUT', path: '/accounts/acc1/workers/scripts/other-worker', body: { route: 'Company.Maplayer.top/*' } })).toBeDefined();
    expect(locked('cf.api', { method: 'PUT', path: '/accounts/acc1/workers/scripts/other-worker', body: { bindings: [{ name: 'company-owner-end' }] } })).toBeDefined();
  });

  test('其它账号资源放行：读写其它 Worker 的设置与机密、R2、其它 D1（不含受保护的 id）', () => {
    expect(locked('cf.api', { method: 'GET', path: '/accounts/acc1/workers/scripts/other-worker/settings' })).toBeUndefined();
    expect(locked('cf.api', { method: 'PUT', path: '/accounts/acc1/workers/scripts/other-worker/secrets', body: { name: 'K' } })).toBeUndefined();
    expect(locked('cf.api', { method: 'POST', path: '/accounts/acc1/r2/buckets', body: { name: 'b' } })).toBeUndefined();
    expect(locked('cf.api', { method: 'POST', path: '/accounts/acc1/d1/database/other-db-id/query', body: { sql: 'SELECT 1' } })).toBeUndefined();
  });

  test('cf.api 路径大小写不影响判定', () => {
    expect(locked('cf.api', { method: 'PUT', path: '/accounts/acc1/workers/scripts/Company-Owner-End/secrets' })).toBeDefined();
    expect(locked('cf.api', { method: 'GET', path: '/Accounts/acc1/Tokens' })).toBeDefined();
  });
});

describe('其它命令与常量', () => {
  test('其它命令（消息、运行器命令）不由目标锁判定', () => {
    expect(hardTargetOwnerOnly('message.edit', { id: 'x' }, targets)).toBeUndefined();
    expect(hardTargetOwnerOnly('ops_call', {}, targets)).toBeUndefined();
  });

  test('TARGET_LOCKS 只列 idp.* 与 cf.api 两条；OWNER_ONLY_FOR_AGENTS 为 ops.job.list 与 audit.list；公司域名固定', () => {
    expect(TARGET_LOCKS.map((lock) => lock.command)).toEqual(['idp.*', 'cf.api']);
    expect([...OWNER_ONLY_FOR_AGENTS]).toEqual(['ops.job.list', 'audit.list', ...ITERATION_COMMANDS, ...LIFECYCLE_COMMANDS]);
    expect(COMPANY_HOST).toBe('company.maplayer.top');
  });
});

describe('cf.api：认证与数据入口的域名与 zone', () => {
  const ZONE = '6ace211d0a7ac7c16b52177a37c77f88';
  test('maplayer.top zone 的写操作锁定，读取放行', () => {
    expect(locked('cf.api', { method: 'PATCH', path: `/zones/${ZONE}/dns_records/abc`, body: { content: '1.2.3.4' } })).toBeDefined();
    expect(locked('cf.api', { method: 'POST', path: `/zones/${ZONE}/workers/routes`, body: { pattern: 'x/*', script: 'evil' } })).toBeDefined();
    expect(locked('cf.api', { method: 'GET', path: `/zones/${ZONE}/dns_records` })).toBeUndefined();
  });
  test('请求内容提到 o.maplayer.top 或 data.maplayer.top 锁定；其它 zone 的写入放行', () => {
    expect(locked('cf.api', { method: 'POST', path: '/zones/otherzone/dns_records', body: { name: 'o.maplayer.top' } })).toBeDefined();
    expect(locked('cf.api', { method: 'POST', path: '/zones/otherzone/dns_records', body: { name: 'data.maplayer.top' } })).toBeDefined();
    expect(locked('cf.api', { method: 'POST', path: '/zones/otherzone/dns_records', body: { name: 'www.example.com' } })).toBeUndefined();
  });
});
