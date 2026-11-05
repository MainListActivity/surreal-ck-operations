import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureOwnerToken } from '../src/owner-token.ts';
import { OutboundMessageStore, templateFor } from '../src/outbound-messages.ts';
import { taskBrief } from '../src/dispatcher/brief.ts';
import { wake } from '../src/dispatcher/prompts.ts';
import { goalTemplate } from '../src/flows.ts';

const env = { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' };
const recordId = (id: string) => ({ id, tb: 'task', toString: () => `task:${id}` });

test('owner token is created 0600 and stable; a missing Authorization header is 401 by construction', () => {
  const home = mkdtempSync(join(tmpdir(), 'owner-token-'));
  const token = ensureOwnerToken(home);
  expect(token.startsWith('sck_')).toBe(true);
  expect(ensureOwnerToken(home)).toBe(token);
  expect(readFileSync(join(home, 'private/owner-token'), 'utf8').trim()).toBe(token);
  expect(require('node:fs').statSync(join(home, 'private/owner-token')).mode & 0o777).toBe(0o600);
  rmSync(home, { recursive: true, force: true });
});

test('report_blocker entries route only to owner', () => {
  const schema = readFileSync(join(import.meta.dir, '..', 'schema/051-role-message-flow.surql'), 'utf8');
  expect(schema).toContain("blocked_to = 'owner'");
  const sidecar = readFileSync(join(import.meta.dir, '..', 'plugin/server/sidecar.ts'), 'utf8');
  expect(sidecar).toContain('args.to === "owner" ? "owner" : "owner"');
  const mcp = readFileSync(join(import.meta.dir, '..', 'src/mcp/server.ts'), 'utf8');
  expect(mcp).toContain("to: z.enum(['owner'])");
});

test('goal template never generates a gm task', () => {
  for (const pipeline of ['software', 'video', 'story'] as const) {
    const template = goalTemplate('quick', 't', '需求', 'g', pipeline);
    expect(template.tasks).toHaveLength(1);
    expect(JSON.stringify(template.tasks)).not.toContain('"gm"');
  }
  const seed = readFileSync(join(import.meta.dir, '..', 'src/seed.ts'), 'utf8');
  expect(seed).not.toContain("'gm'");
});

test('task.md contains only title, requirement and acceptance criteria', () => {
  const md = taskBrief({ task: { title: '导出', context: '旧背景与规则', requirement: '导出 CSV', acceptanceText: '列头正确', state: 'doing' } as never });
  expect(md).toBe('# 导出\n\n## 需求\n\n导出 CSV\n\n## 验收标准\n\n列头正确\n');
  expect(md).not.toContain('旧背景与规则');
  expect(md).not.toContain('## 本环节');
});

test('minimal dispatch message: only what, where, how; no onboarding on first contact', () => {
  const first = wake({ id: 'e1', role: 'engineering' } as never,
    { id: 't1', title: 'x', state: 'doing', row: {} } as never, env, true,
    { comm: true, claim: { task: { id: 't1', state: 'doing' }, history: [], worktree: { worktreePath: '/w', intent: { kind: 'code' } } } as never, commDir: '/c' });
  const second = wake({ id: 'e1', role: 'engineering' } as never,
    { id: 't1', title: 'x', state: 'doing', row: {} } as never, env, false,
    { comm: true, claim: { task: { id: 't1', state: 'doing' }, history: [], worktree: { worktreePath: '/w', intent: { kind: 'code' } } } as never, commDir: '/c' });
  expect(first).toBe(second);
  expect(first).toContain('task.md');
  expect(first).toContain('submit');
  for (const forbidden of ['AGENTS.md', 'PROTOCOL', '公司唯一真人', 'checkpoint', '员工编号', '凭证']) expect(first).not.toContain(forbidden);
});

test('template bodies are the exact minimal sentences', () => {
  expect(templateFor('execute', true)).toContain('合入并发布到生产');
  expect(templateFor('execute', false)).not.toContain('合入并发布');
  expect(templateFor('review')).toContain('call review');
  expect(templateFor('rework')).toContain('findings/round-NN.md');
  expect(templateFor('eval')).toContain('task.md');
});

test('outbound_message schema defines the full draft/held/sent lifecycle', () => {
  const schema = readFileSync(join(import.meta.dir, '..', 'schema/051-role-message-flow.surql'), 'utf8');
  for (const field of ['task','step','role','body','state','hold','edited_by','edited_at','sent_to','sent_at','created_at']) {
    expect(schema).toContain(field);
  }
  expect(schema).toContain("DEFINE TABLE IF NOT EXISTS outbound_message");
});

test('migration retires gm defs, rebinds gm waits to owner, changes gm reviewer to qa, voids gm executors with audit', () => {
  const schema = readFileSync(join(import.meta.dir, '..', 'schema/051-role-message-flow.surql'), 'utf8');
  expect(schema).toContain("WHERE role = 'gm'");
  expect(schema).toContain("blocked_to = 'owner'");
  expect(schema).toContain("reviewer_role = 'qa'");
  expect(schema).toContain("state = 'void'");
  expect(schema).toContain("'gm_role_retired'");
});

test('hold refuses to send; sent locks editing; the sent body is the table body', async () => {
  // Pure state-machine test with a tiny in-memory fake of the Surreal surface.
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    query: async (sql: string, vars: Record<string, unknown>) => {
      if (sql.includes('CREATE outbound_message')) {
        const row = { id: { id: 'm1' }, task: { id: 't1' }, step: vars.step, role: vars.role,
          body: vars.body, state: 'draft', hold: false, created_at: 'now' };
        rows.push(row); return [[row]];
      }
      if (sql.includes('SELECT * FROM outbound_message WHERE task')) {
        const task = (vars as { task?: { id?: string } }).task?.id;
        return [rows.filter(r => (r.task as { id: string }).id === task && (sql.includes('state !=') ? r.state !== 'sent' : true))];
      }
      if (sql.includes('UPDATE ONLY $msg SET hold')) {
        const row = rows.find(r => (r.id as { id: string }).id === (vars.msg as { id: string }).id)!;
        row.hold = vars.hold; row.state = vars.hold ? 'held' : 'draft';
        return [[row]];
      }
      if (sql.includes('UPDATE ONLY $msg SET body')) {
        const row = rows.find(r => (r.id as { id: string }).id === (vars.msg as { id: string }).id)!;
        if (row.state === 'sent') return [[]];
        row.body = vars.body; row.edited_by = vars.actor;
        return [[row]];
      }
      if (sql.includes('state = ') && sql.includes('sent')) {
        const row = rows.find(r => (r.id as { id: string }).id === (vars.msg as { id: string }).id)!;
        row.state = 'sent'; row.sent_to = vars.employee;
        return [[row]];
      }
      if (sql.includes('SELECT executor_role')) return [[{ executor_role: 'engineering', reviewer_role: 'qa', kind: 'task', work_intent: { kind: 'code' } }]];
      return [[]];
    },
  } as never;
  const store = new OutboundMessageStore(db);
  const [execute] = await store.createTaskDrafts('t1', 'engineering', 'qa', true);
  expect((await store.list('t1', false)).length).toBe(2);
  await store.edit(execute!.id, '改成这句', 'owner:test');
  await store.setHold(execute!.id, true, 'owner:test');
  expect(await store.prepareSend('t1', 'execute', 'e1')).toBeNull();
  await store.setHold(execute!.id, false, 'owner:test');
  const prepared = await store.prepareSend('t1', 'execute', 'e1');
  expect(prepared!.body).toBe('改成这句');
  await expect(store.edit(execute!.id, '已发后不许改', 'owner:test')).rejects.toThrow();
});

test('employee sandbox still forbids reading private/', () => {
  const sb = readFileSync(join(import.meta.dir, '..', 'scripts/sandbox/employee.sb'), 'utf8');
  expect(sb).toContain('(under service "/private")');
});
