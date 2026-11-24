import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerHttp } from '../src/runner/owner-http.ts';

const home = mkdtempSync(join(tmpdir(), 'owner-api-auth-'));
// The token only ever exists as a file path; the test never prints it.
const tokenPath = join(home, 'private/owner-token');
const ownerFetch = createOwnerHttp({
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

test('createOwnerHttp 把 c.steward 转给 ownerApi，message.draft 成功起草', async () => {
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
  const { createOwnerHttp: make } = await import('../src/runner/owner-http.ts');
  const drafted = make({
    home: home2,
    company: async () => ({
      steward: { draft: async (input: unknown) => { drafts.push(input as Record<string, unknown>); return '请把甲做完并自验。'; } },
      db: { db: fakeDb }, core: {}, owner: undefined, workforce: undefined, opsRepo: '/fixture',
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
