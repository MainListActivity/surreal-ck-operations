import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerApiFetch } from '../plugin/server/owner-api.ts';

const home = mkdtempSync(join(tmpdir(), 'owner-api-auth-'));
// The token only ever exists as a file path; the test never prints it.
const tokenPath = join(home, 'private/owner-token');
const ownerFetch = createOwnerApiFetch({
  home,
  company: async () => { throw new Error('authenticated company must not be reached without a valid token'); },
});
const url = 'http://127.0.0.1:18777/api/owner/goal.list';
const post = (headers: Record<string, string> = {}) => ownerFetch(new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
}));

test('the owner token file is created 0600 and read only by path', () => {
  const mode = statSync(tokenPath).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(readFileSync(tokenPath, 'utf8').length).toBeGreaterThan(0);
});

test('a request without the owner token is refused 401', async () => {
  const response = await post();
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ error: 'owner token required' });
});

test('a request with the wrong owner token is refused 401', async () => {
  const response = await post({ authorization: 'Bearer sck_wrong' });
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ error: 'invalid owner token' });
});

test('a request with a same-length wrong owner token is refused 401', async () => {
  const tokenLen = readFileSync(tokenPath, 'utf8').trim().length;
  const sameLenWrong = '0'.repeat(tokenLen);
  const response = await post({ authorization: `Bearer ${sameLenWrong}` });
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ error: 'invalid owner token' });
});

test('the console page route still exchanges a page token for the owner token', async () => {
  // /o/<token>/ stays a page route; the exchange endpoint returns the same token the CLI reads by path.
  const { createConsoleFetch } = await import('../plugin/server/console.ts');
  const pageFetch = createConsoleFetch({ home, lanBase: () => 'http://127.0.0.1:18777',
    company: async () => { throw new Error('no company in auth test'); } });
  const pageToken = readFileSync(join(home, 'private', 'console-token'), 'utf8').trim();
  const response = await pageFetch(new Request(`http://127.0.0.1:18777/o/${pageToken}/api/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageToken }),
  }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ownerToken: readFileSync(tokenPath, 'utf8').trim() });
});

test('a wrong page token cannot exchange for the owner token', async () => {
  const { createConsoleFetch } = await import('../plugin/server/console.ts');
  const pageFetch = createConsoleFetch({ home, lanBase: () => 'http://127.0.0.1:18777',
    company: async () => { throw new Error('no company in auth test'); } });
  const pageToken = readFileSync(join(home, 'private', 'console-token'), 'utf8').trim();
  const response = await pageFetch(new Request(`http://127.0.0.1:18777/o/${pageToken}/api/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageToken: 'wrong' }),
  }));
  expect(response.status).toBe(401);
});

test('the prefixed console owner route demands the owner Bearer token', async () => {
  // The signature face has no /api/owner/* route, so the page writes through /o/<token>/owner/<cmd>.
  const { createConsoleFetch } = await import('../plugin/server/console.ts');
  const pageFetch = createConsoleFetch({ home, lanBase: () => 'http://127.0.0.1:18777',
    company: async () => { throw new Error('a company must not be reached before the token is checked'); } });
  const pageToken = readFileSync(join(home, 'private', 'console-token'), 'utf8').trim();
  const url = `http://127.0.0.1:18777/o/${pageToken}/owner/goal.list`;
  const refused = await pageFetch(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"command":"goal.list"}',
  }));
  expect(refused.status).toBe(401);
  await expect(refused.json()).resolves.toMatchObject({ error: 'owner token required' });
  const wrong = await pageFetch(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sck_wrong' }, body: '{"command":"goal.list"}',
  }));
  expect(wrong.status).toBe(401);
  // With the real token the request reaches the owner handler; the throwing company proves that step was entered.
  const ownerToken = readFileSync(tokenPath, 'utf8').trim();
  const accepted = await pageFetch(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` }, body: '{"command":"goal.list"}',
  }));
  expect(accepted.status).toBe(500);
  await expect(accepted.json()).resolves.toMatchObject({ error: 'a company must not be reached before the token is checked' });
});

test('the console page writes through owner/ and its script parses', async () => {
  const { createConsoleFetch } = await import('../plugin/server/console.ts');
  const pageFetch = createConsoleFetch({ home, lanBase: () => 'http://127.0.0.1:18777',
    company: async () => { throw new Error('no company for the page HTML'); } });
  const pageToken = readFileSync(join(home, 'private', 'console-token'), 'utf8').trim();
  const response = await pageFetch(new Request(`http://127.0.0.1:18777/o/${pageToken}/`));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("fetch('owner/'+cmd");
  expect(html).not.toContain('/api/owner/');
  // The inline page script is delivered as-is; a syntax error would leave the owner console dead.
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  expect(() => new Function(script!)).not.toThrow();
});

test('createOwnerApiFetch 把 c.steward 转给 ownerApi，message.draft 成功起草', async () => {
  const { installNodeHost } = await import('../src/host-node.ts');
  installNodeHost();
  const { RecordId } = await import('surrealdb');
  const { createHash } = await import('node:crypto');
  const drafts: Array<Record<string, unknown>> = [];
  const home2 = mkdtempSync(join(tmpdir(), 'owner-api-steward-'));
  const row: Record<string, any> = { id: new RecordId('outbound_message', 'm1'), task: new RecordId('task', 't1'),
    step: 'execute', role: 'engineering', body: '原稿', state: 'held', hold: true, created_at: '2026-01-01T00:00:00Z' };
  const fakeDb = {
    query: async (sql: string, vars: Record<string, any> = {}) => {
      if (sql.includes('FROM $task') && sql.includes('title'))
        return [[{ title: '需求甲', requirement: '实现甲', resources: '资源', acceptance_text: '测试通过', project: 'p1', discipline: 'code' }]];
      if (sql.includes('FROM owner_style_memory')) return [[]];
      if (sql.startsWith('SELECT * FROM outbound_message WHERE task')) return [[{ ...row }]];
      if (sql.startsWith('UPDATE $msg SET body')) {
        row.body = vars.body; row.body_edited = true; row.edited_by = vars.actor;
        return [[{ ...row }]];
      }
      return [[]];
    },
    // 已存在的 owner 员工：digest 与 token 文件一致，ensureOwner 直接返回，不写库。
    select: async () => ({ credential_digest: createHash('sha256').update(
      readFileSync(join(home2, 'private/owner-token'), 'utf8').trim()).digest('hex') }),
  };
  const { createOwnerApiFetch: make } = await import('../plugin/server/owner-api.ts');
  const drafted = make({
    home: home2,
    company: async () => ({
      steward: { draft: async (input: unknown) => { drafts.push(input as Record<string, unknown>); return '请把甲做完并自验。'; } },
      db: { db: fakeDb }, core: {}, owner: undefined, workforce: undefined, opsRepo: '/fixture', paseo: undefined,
    }) as never,
  });
  const token = readFileSync(join(home2, 'private/owner-token'), 'utf8').trim();
  const response = await drafted(new Request('http://127.0.0.1:18777/api/owner/message.draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ command: 'message.draft', taskId: 't1', step: 'execute', channel: 'native' }),
  }));
  const body = await response.json() as { error?: string; message?: { body?: string }; styleSamplesUsed?: number };
  expect(body.error).toBeUndefined();
  expect(response.status).toBe(200);
  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({ step: 'execute', channel: 'native', task: { title: '需求甲' } });
  expect(body).toMatchObject({ message: { body: '请把甲做完并自验。' }, styleSamplesUsed: 0 });

  // 对照：没有 steward 时同一请求必须报「NodeSteward 需要执行端」——证明成功路径确实来自 ctx.steward 转发。
  const { ownerApi } = await import('../src/owner-api.ts');
  const { OutboundMessageStore } = await import('../src/outbound-messages.ts');
  await expect(ownerApi({ db: { db: fakeDb } as never, messages: new OutboundMessageStore(fakeDb as never), opsRepo: '/fixture' } as never,
    { command: 'message.draft', taskId: 't1', step: 'execute' }, 'test')).rejects.toThrow('NodeSteward 需要执行端');
});
