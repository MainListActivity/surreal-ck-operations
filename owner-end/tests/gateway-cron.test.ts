import { describe, expect, test } from 'bun:test';
import type { Surreal } from 'surrealdb';

import { bodyHash } from '../../src/outbound-messages.ts';
import {
  DAILY_CRON,
  MINUTE_CRON,
  TRANSLATIONS_PER_RUN,
  refreshTranslations,
  runScheduled,
  syncAgentIdentities,
} from '../src/cron.ts';
import { fakeDb, fakeSessions, json, scriptedFetch, testConfig, type FakeCall } from './_support.ts';

const MAGPIE_ENV = {
  MAGPIE_BASE_URL: 'https://magpie.test.invalid/v1',
  MAGPIE_MODEL: 'm',
  MAGPIE_API_KEY: 'k',
};
const IDP_ENV = {
  IDP_ADMIN_TOKEN: 'admin-token',
  IDP_TENANT_ID: 'tenant-1',
  AGENT_EMAIL_DOMAIN: 'agents.test.invalid',
};
/** 由 IDP_ISSUER（https://o.test.invalid/t/company）得到的管理 API 根地址。 */
const ORIGIN = 'https://o.test.invalid';
const USERS_URL = `${ORIGIN}/admin/tenants/tenant-1/users`;
const CHAT_URL = 'https://magpie.test.invalid/v1/chat/completions';
const NOW = new Date('2026-01-02T19:30:00.000Z');

const chatReply = (content: unknown): Response => json({ choices: [{ message: { content } }] });

/** 按语句文本里的子串选择结果行，未命中返回空。 */
function respondWith(rules: Array<[needle: string, rows: unknown[]]>) {
  return (sql: string): unknown[] => {
    for (const [needle, rows] of rules) if (sql.includes(needle)) return rows;
    return [];
  };
}

/** 收集所有写 agent_identity 的语句的变量。 */
const identityWrites = (calls: FakeCall[]) => calls.filter((c) => c.sql.startsWith('UPSERT $rid'));

/** 静默 console.error（失败分支会记录日志），返回恢复函数。 */
function quietErrors(): () => void {
  const original = console.error;
  console.error = () => undefined;
  return () => {
    console.error = original;
  };
}

/** 本次调用的失败（抛错）时仍要恢复 console.error。 */
async function withQuietErrors<T>(run: () => Promise<T>): Promise<T> {
  const restore = quietErrors();
  try {
    return await run();
  } finally {
    restore();
  }
}

const employeeRow = (id: string, def?: string) => ({ id, role: 'dev', def });

describe('syncAgentIdentities 身份同步：未配置', () => {
  test('缺少 IDP_ADMIN_TOKEN 时返回 skipped=not_configured，不查询也不发请求', async () => {
    const { db, calls } = fakeDb();
    const { fetch, requests } = scriptedFetch([]);
    const result = await syncAgentIdentities(testConfig({ IDP_TENANT_ID: 'tenant-1', AGENT_EMAIL_DOMAIN: 'agents.test.invalid' }), db, { fetch, now: NOW });

    expect(result).toEqual({ linked: 0, created: 0, failed: [], skipped: 'not_configured' });
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('缺少 IDP_TENANT_ID 时返回 skipped=not_configured，不发请求', async () => {
    const { db, calls } = fakeDb();
    const { fetch, requests } = scriptedFetch([]);
    const result = await syncAgentIdentities(testConfig({ IDP_ADMIN_TOKEN: 'admin-token', AGENT_EMAIL_DOMAIN: 'agents.test.invalid' }), db, { fetch, now: NOW });

    expect(result.skipped).toBe('not_configured');
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('缺少 AGENT_EMAIL_DOMAIN 时返回 skipped=not_configured，不发请求', async () => {
    const { db, calls } = fakeDb();
    const { fetch, requests } = scriptedFetch([]);
    const result = await syncAgentIdentities(testConfig({ IDP_ADMIN_TOKEN: 'admin-token', IDP_TENANT_ID: 'tenant-1' }), db, { fetch, now: NOW });

    expect(result.skipped).toBe('not_configured');
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('syncAgentIdentities 身份同步：完整路径', () => {
  const cfg = () => testConfig({ ...IDP_ENV, ...MAGPIE_ENV });

  test('只为未登记的在岗员工开户：e1 已登记不查询，e2 先 GET 再 POST，最后 UPSERT agent_identity', async () => {
    const { db, calls } = fakeDb(respondWith([
      ['FROM agent_identity', [{ employee: 'e1' }]],
      ['FROM employee WHERE', [employeeRow('e1'), employeeRow('e2', 'def-e2')]],
    ]));
    const { fetch, requests } = scriptedFetch([
      () => json({ users: [] }),
      () => json({ user: { id: 'u2' } }, 201),
    ]);
    const result = await syncAgentIdentities(cfg(), db, { fetch, now: NOW });

    expect(result).toEqual({ linked: 1, created: 1, failed: [] });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${USERS_URL}?kind=agent`,
      `POST ${USERS_URL}`,
    ]);
    for (const request of requests) {
      expect(request.headers.get('authorization')).toBe('Bearer admin-token');
    }
    const post = (await requests[1]!.json()) as Record<string, unknown>;
    expect(post).toEqual({ email: 'e2@agents.test.invalid', display_name: 'def-e2', kind: 'agent' });

    const writes = identityWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.vars.employee).toBe('e2');
    expect(writes[0]!.vars.userId).toBe('u2');
  });

  test('ma_hono 已有同邮箱的 agent 用户（仅大小写不同）：不 POST，只写入 agent_identity', async () => {
    const { db, calls } = fakeDb(respondWith([
      ['FROM agent_identity', []],
      ['FROM employee WHERE', [employeeRow('e2')]],
    ]));
    const { fetch, requests } = scriptedFetch([
      () => json({
        users: [{ id: 'u2', email: 'E2@Agents.Test.Invalid', display_name: 'e2', status: 'active' }],
      }),
    ]);
    const result = await syncAgentIdentities(cfg(), db, { fetch, now: NOW });

    expect(result).toEqual({ linked: 1, created: 0, failed: [] });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${USERS_URL}?kind=agent`]);
    const writes = identityWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.vars.userId).toBe('u2');
  });

  test('ma_hono 对某员工的开户返回 409：记入 failed，其余员工照常处理', async () => {
    const { db, calls } = fakeDb(respondWith([
      ['FROM agent_identity', []],
      ['FROM employee WHERE', [employeeRow('e1'), employeeRow('e2')]],
    ]));
    const { fetch, requests } = scriptedFetch([
      () => json({ users: [] }),
      () => json({ error: 'conflict' }, 409),
      () => json({ users: [] }),
      () => json({ user: { id: 'u2' } }, 201),
    ]);
    const result = await withQuietErrors(() => syncAgentIdentities(cfg(), db, { fetch, now: NOW }));

    expect(result).toEqual({ linked: 1, created: 1, failed: ['e1'] });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${USERS_URL}?kind=agent`,
      `POST ${USERS_URL}`,
      `GET ${USERS_URL}?kind=agent`,
      `POST ${USERS_URL}`,
    ]);
    const writes = identityWrites(calls);
    expect(writes.map((c) => c.vars.employee)).toEqual(['e2']);
  });

  test('ma_hono 对某员工的开户返回 500：记入 failed，其余员工照常处理', async () => {
    const { db, calls } = fakeDb(respondWith([
      ['FROM agent_identity', []],
      ['FROM employee WHERE', [employeeRow('e1'), employeeRow('e2')]],
    ]));
    const { fetch, requests } = scriptedFetch([
      () => json({ users: [] }),
      () => json({ error: 'internal' }, 500),
      () => json({ users: [] }),
      () => json({ user: { id: 'u2' } }, 201),
    ]);
    const result = await withQuietErrors(() => syncAgentIdentities(cfg(), db, { fetch, now: NOW }));

    expect(result).toEqual({ linked: 1, created: 1, failed: ['e1'] });
    expect(requests).toHaveLength(4);
    expect(identityWrites(calls).map((c) => c.vars.employee)).toEqual(['e2']);
  });
});

describe('refreshTranslations 补译', () => {
  const cfg = () => testConfig(MAGPIE_ENV);

  /** 一条待发消息行（与 rowView 读取的字段对应）。 */
  const messageRow = (id: string, extra: Record<string, unknown> = {}) => ({
    id, task: 't1', step: 'execute', role: 'dev', body: `请确认验收 ${id}`, state: 'draft', hold: false,
    lang: 'en', created_at: '2026-01-01T00:00:00.000Z', ...extra,
  });

  test('未配置 magpie 时返回 skipped=not_configured，不查询也不发请求', async () => {
    const { db, calls } = fakeDb();
    const { fetch, requests } = scriptedFetch([]);
    const result = await refreshTranslations(testConfig({}), db, { fetch });

    expect(result).toEqual({ translated: 0, failed: 0, skipped: 'not_configured' });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test('过期译文（哈希不一致）：调用 translateChecked（stub 的 chat 请求），再 setTranslation 写回', async () => {
    const source = '请确认验收 m1';
    const { db, calls } = fakeDb(respondWith([
      ['FROM outbound_message', [messageRow('m1', { body: source, translated_text: 'old', translated_from_hash: 'stale' })]],
      ['UPDATE $msg SET lang', [{ id: 'updated' }]],
    ]));
    const { fetch, requests } = scriptedFetch([() => chatReply('Please confirm acceptance m1')]);
    const result = await refreshTranslations(cfg(), db, { fetch });

    expect(result).toEqual({ translated: 1, failed: 0 });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${CHAT_URL}`]);
    expect(calls[0]!.sql).toContain("state != 'sent'");
    const update = calls.find((c) => c.sql.startsWith('UPDATE $msg SET lang'));
    expect(update).toBeDefined();
    expect(update!.vars.lang).toBe('en');
    expect(update!.vars.text).toBe('Please confirm acceptance m1');
    expect(update!.vars.expectedBody).toBe(source);
    expect(update!.vars.hash).toBe(await bodyHash(source));
  });

  test('没有语言的消息，或译文仍新鲜的消息：跳过，不发请求、不写库', async () => {
    const source = '请确认验收 fresh';
    const { db, calls } = fakeDb(respondWith([
      ['FROM outbound_message', [
        messageRow('no-lang', { lang: undefined }),
        messageRow('fresh', { body: source, translated_text: 'Confirm fresh', translated_from_hash: await bodyHash(source) }),
      ]],
    ]));
    const { fetch, requests } = scriptedFetch([]);
    const result = await refreshTranslations(cfg(), db, { fetch });

    expect(result).toEqual({ translated: 0, failed: 0 });
    expect(requests).toHaveLength(0);
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  test(`一次最多处理 TRANSLATIONS_PER_RUN（${TRANSLATIONS_PER_RUN}）条：7 条待译只译 5 条`, async () => {
    expect(TRANSLATIONS_PER_RUN).toBe(5);
    const rows = Array.from({ length: 7 }, (_, index) => messageRow(`m${index + 1}`, { translated_from_hash: 'stale' }));
    const { db, calls } = fakeDb(respondWith([
      ['FROM outbound_message', rows],
      ['UPDATE $msg SET lang', [{ id: 'updated' }]],
    ]));
    const { fetch, requests } = scriptedFetch(
      Array.from({ length: 5 }, (_, index) => () => chatReply(`Please confirm acceptance ${index + 1}`)),
    );
    const result = await refreshTranslations(cfg(), db, { fetch });

    expect(result).toEqual({ translated: 5, failed: 0 });
    expect(requests.map((r) => r.url)).toEqual(Array.from({ length: 5 }, () => CHAT_URL));
    expect(calls.filter((c) => c.sql.startsWith('UPDATE $msg SET lang'))).toHaveLength(5);
  });

  test('译不出的消息不挡住其它消息：前五条每轮都失败，第二轮先译没失败过的第六条', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const rows = ids.map((id) => messageRow(id, { body: `请确认验收 ${id}`, translated_from_hash: 'stale' }));
    // 有状态的假库：补译失败会记下时间（按调用顺序递增），之后的查询把它带回到候选行上。
    const failedAt = new Map<string, string>();
    let tick = 0;
    const { db, calls } = fakeDb((sql, vars) => {
      if (sql.startsWith('UPDATE $msg SET translate_failed_at')) {
        tick += 1;
        failedAt.set((vars.msg as { id: string }).id, new Date(NOW.getTime() + tick * 1000).toISOString());
        return [];
      }
      if (sql.includes('FROM outbound_message')) {
        return rows.map((row) => (failedAt.has(row.id) ? { ...row, translate_failed_at: failedAt.get(row.id) } : row));
      }
      return sql.startsWith('UPDATE $msg SET lang') ? [{ id: 'updated' }] : [];
    });
    // m6 能译出；m1 到 m5 的译文服务一律返回 500。
    const attempted: string[] = [];
    const translateFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Request(input, init).text();
      const id = ids.find((candidate) => body.includes(`请确认验收 ${candidate}`)) ?? '';
      attempted.push(id);
      return id === 'm6' ? chatReply(`Please confirm acceptance ${id}`) : new Response('down', { status: 500 });
    }) as typeof fetch;

    await withQuietErrors(async () => {
      expect(await refreshTranslations(cfg(), db, { fetch: translateFetch })).toEqual({ translated: 0, failed: 5 });
      expect(await refreshTranslations(cfg(), db, { fetch: translateFetch })).toEqual({ translated: 1, failed: 4 });
    });

    expect(attempted.slice(0, 5)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(attempted[5]).toBe('m6');
    expect(calls.filter((c) => c.sql.startsWith('UPDATE $msg SET translate_failed_at'))).toHaveLength(9);
  });
});

describe('runScheduled 按 cron 表达式分派', () => {
  test('未配置身份与译文服务时，每分钟任务两步都返回 skipped，且不发请求', async () => {
    const { db, calls } = fakeDb();
    const { fetch, requests } = scriptedFetch([]);
    const result = await withQuietErrors(() => runScheduled(testConfig({}), fakeSessions(db), MINUTE_CRON, { fetch, now: NOW }));

    expect(result).toEqual({
      identities: { linked: 0, created: 0, failed: [], skipped: 'not_configured' },
      translations: { translated: 0, failed: 0, skipped: 'not_configured' },
    });
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('每分钟任务（* * * * *）：身份同步与补译都执行，并依次发出管理 API 与译文的请求', async () => {
    const { db, calls } = fakeDb(respondWith([
      ['FROM agent_identity', []],
      ['FROM employee WHERE', [employeeRow('e1')]],
      ['FROM outbound_message', [{
        id: 'm1', task: 't1', step: 'execute', role: 'dev', body: '请确认验收', state: 'draft', hold: false,
        lang: 'en', translated_from_hash: 'stale', created_at: '2026-01-01T00:00:00.000Z',
      }]],
      ['UPDATE $msg SET lang', [{ id: 'updated' }]],
    ]));
    const { fetch, requests } = scriptedFetch([
      () => json({ users: [] }),
      () => json({ user: { id: 'u1' } }, 201),
      () => chatReply('Please confirm acceptance'),
    ]);
    const cfg = testConfig({ ...IDP_ENV, ...MAGPIE_ENV });
    const result = await runScheduled(cfg, fakeSessions(db), MINUTE_CRON, { fetch, now: NOW });

    expect(result).toEqual({
      identities: { linked: 1, created: 1, failed: [] },
      translations: { translated: 1, failed: 0 },
    });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${USERS_URL}?kind=agent`,
      `POST ${USERS_URL}`,
      `POST ${CHAT_URL}`,
    ]);
    expect(identityWrites(calls).map((c) => c.vars.userId)).toEqual(['u1']);
  });

  test('每日任务（30 19 * * *）：只跑笔记整理，不做身份同步与补译；没有笔记时为 no-change', async () => {
    const { db, calls } = fakeDb(respondWith([
      ['FROM agent_identity', [{ employee: 'e1' }]],
      ['FROM employee WHERE', [employeeRow('e1')]],
      ['FROM outbound_message', [{ id: 'm1', lang: 'en', body: 'x', state: 'draft' }]],
    ]));
    // 笔记整理需要 db.select（取上次检查的标记）；这里让标记不存在，并且没有任何笔记。
    const withSelect = Object.assign(db as Surreal, { select: async () => undefined }) as Surreal;
    const { fetch, requests } = scriptedFetch([]);
    const result = await runScheduled(testConfig({ ...IDP_ENV, ...MAGPIE_ENV }), fakeSessions(withSelect), DAILY_CRON, { fetch, now: NOW });

    expect(result).toEqual({ consolidated: 'no-change' });
    expect(requests).toHaveLength(0);
    expect(calls.some((c) => c.sql.includes('agent_identity') || c.sql.includes('outbound_message'))).toBe(false);
    expect(calls.some((c) => c.sql.startsWith('UPSERT $marker'))).toBe(true);
  });

  test('每日任务：上次检查距今不足 24 小时则返回 not-due，不读取笔记', async () => {
    const { db, calls } = fakeDb();
    const lastChecked = new Date(NOW.getTime() - 60 * 60 * 1000);
    const withSelect = Object.assign(db as Surreal, { select: async () => ({ checked_at: lastChecked }) }) as Surreal;
    const { fetch, requests } = scriptedFetch([]);
    const result = await runScheduled(testConfig(MAGPIE_ENV), fakeSessions(withSelect), DAILY_CRON, { fetch, now: NOW });

    expect(result).toEqual({ consolidated: 'not-due' });
    expect(requests).toHaveLength(0);
    expect(calls.some((c) => c.sql.includes('lane_note'))).toBe(false);
  });
});
