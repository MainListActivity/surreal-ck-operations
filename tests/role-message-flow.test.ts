import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureOwnerToken } from '../src/owner-token.ts';
import { OutboundMessageStore, renderMessage, templateFor, type OutboundMessage } from '../src/outbound-messages.ts';
import { taskBrief } from '../src/dispatcher/brief.ts';
import { wake } from '../src/dispatcher/prompts.ts';
import { scrubEnv } from '../plugin/server/scrub.ts';
import { Workforce } from '../src/workforce.ts';

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
  const sidecar = readFileSync(join(import.meta.dir, '..', 'src/runner/sidecar.ts'), 'utf8');
  expect(sidecar).toContain('args.to === "owner" ? "owner" : "owner"');
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
    { claim: { task: { id: 't1', state: 'doing' }, history: [], worktree: { worktreePath: '/w', intent: { kind: 'code' } } } as never, commDir: '/c' });
  const second = wake({ id: 'e1', role: 'engineering' } as never,
    { id: 't1', title: 'x', state: 'doing', row: {} } as never, env, false,
    { claim: { task: { id: 't1', state: 'doing' }, history: [], worktree: { worktreePath: '/w', intent: { kind: 'code' } } } as never, commDir: '/c' });
  expect(first).toBe(second);
  expect(first).toContain('task.md');
  expect(first).toContain('执行端自动保存');
  expect(first).not.toContain('submit');
  for (const forbidden of ['AGENTS.md', 'PROTOCOL', '公司唯一真人', 'checkpoint', '员工编号', '凭证']) expect(first).not.toContain(forbidden);
});

test('默认派工模板只要求工作产出，辅助工具仍可用', () => {
  const opts = { sckBin: '/bin/sck', commDir: '/c', taskId: 't1' };
  for (const step of ['execute', 'review', 'rework', 'nudge'] as const) for (const code of [false, true]) {
    const body = templateFor(step, code);
    expect(body).toContain('task.md');
    expect(body).toContain('sck call company_cmd_catalog');
    expect(body).not.toMatch(/call (submit|review|checkpoint|heartbeat|claim_next)/);
    expect(body).not.toContain('idempotencyKey');
    expect(renderMessage(body, opts)).toContain("'/bin/sck' call company_cmd_catalog");
  }
  expect(templateFor('review', true)).toContain('复核结论：通过');
  expect(templateFor('review', true)).toContain('最终合入提交上核对');
  expect(templateFor('review', false)).not.toContain('最终合入提交');
  expect(templateFor('rework')).toContain('findings/round-NN.md');
});

test('machineCriterionId reads the first required machine criterion and falls back when absent', async () => {
  const rows: Record<string, unknown>[] = [{
    acceptance_criteria: [
      { id: 'AC-H', kind: 'human', required: true },
      { id: 'AC-OPT', kind: 'machine', required: false },
      { id: 'AC-7', kind: 'machine', required: true },
      { id: 'AC-8', kind: 'machine', required: true },
    ],
  }];
  const store = new OutboundMessageStore({ query: async () => [rows] } as never);
  expect(await store.machineCriterionId('t1')).toBe('AC-7');
  const empty = new OutboundMessageStore({ query: async () => [[]] } as never);
  expect(await empty.machineCriterionId('t1')).toBe('AC-BASE-DEPLOY-1');
  const noMachine = new OutboundMessageStore({ query: async () => [[{ acceptance_criteria: [{ id: 'AC-H', kind: 'human', required: true }] }]] } as never);
  expect(await noMachine.machineCriterionId('t1')).toBe('AC-BASE-DEPLOY-1');
});

test('review drafts and no-draft review sends use the same code flag as execute', async () => {
  const created: Array<{ step: string; body: string }> = [];
  let latest: Record<string, unknown> | undefined;
  const fake = (task: Record<string, unknown>) => new OutboundMessageStore({
    query: async (sql: string, vars: Record<string, any>) => {
      if (sql.includes('CREATE outbound_message')) {
        created.push({ step: vars.step, body: vars.body });
        latest = { id: { id: `m${created.length}` }, task: { id: 't1' }, step: vars.step, role: vars.role,
          body: vars.body, state: 'draft', hold: false, created_at: 'now' }; return [[latest]];
      }
      if (sql.includes('AS dispatch_revision')) return [latest ? [{ ...latest, dispatch_revision: 'fixture-token' }] : []];
      if (sql.includes('SELECT executor_role')) return [[task]];
      if (sql.includes('SELECT body, created_at FROM outbound_message')) return [[]];
      return [[]];
    },
  } as never);
  // 建单草稿：code=true 时执行和复核都按软件线模板。
  await fake({}).createTaskDrafts('t1', 'engineering', 'qa', true);
  expect(created.find(c => c.step === 'execute')!.body).toContain('在最终提交上');
  expect(created.find(c => c.step === 'review')!.body).toContain('先查验收标准第 1 条');
  // 旧任务没有复核草稿：prepareSend 即时生成时也必须按工作种类选模板。
  created.length = 0;
  const codeSend = await fake({ executor_role: 'engineering', reviewer_role: 'qa', kind: 'task', work_intent: { kind: 'code' } })
    .prepareSend('t1', 'review', 'e1');
  expect(codeSend!.body).toContain('最终合入提交上核对');
  created.length = 0;
  const storySend = await fake({ executor_role: 'story-author', reviewer_role: 'qa', kind: 'task', work_intent: { kind: 'assets' } })
    .prepareSend('t1', 'review', 'e1');
  expect(storySend!.body).not.toContain('在生产');
  expect(storySend!.body).toContain('逐条复验');
});

test('outbound_message schema defines the full draft/held/sent lifecycle', () => {
  const schema = readFileSync(join(import.meta.dir, '..', 'schema/051-role-message-flow.surql'), 'utf8');
  for (const field of ['task','step','role','body','state','hold','edited_by','edited_at','sent_to','sent_at','created_at']) {
    expect(schema).toContain(field);
  }
  expect(schema).toContain("DEFINE TABLE IF NOT EXISTS outbound_message");
});

test('migration retires gm defs, rebinds gm waits to owner, reroutes gm reviewer, converts gm executors to product with manager continuation and audit', () => {
  const schema = readFileSync(join(import.meta.dir, '..', 'schema/051-role-message-flow.surql'), 'utf8');
  expect(schema).toContain("WHERE role = 'gm'");
  expect(schema).toContain("blocked_to = 'owner'");
  expect(schema).toContain("reviewer_role = 'qa'");
  expect(schema).toContain("dependency_continuation");
  expect(schema).toContain("executor_role = 'product'");
  expect(schema).not.toContain("state = 'void'");
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
      if (sql.includes('AS dispatch_revision')) return [rows.filter(r => (r.id as { id: string }).id === (vars.msg as { id: string }).id).map(r => ({ ...r, dispatch_revision: 'fixture-token' }))];
      if (sql.includes('SELECT state FROM $msg')) return [rows.filter(r => (r.id as { id: string }).id === (vars.msg as { id: string }).id)];
      if (sql.includes('UPDATE $msg SET hold')) {
        const row = rows.find(r => (r.id as { id: string }).id === (vars.msg as { id: string }).id)!;
        if (row.state === 'sent') return [[]];
        row.hold = vars.hold; row.state = vars.hold ? 'held' : 'draft';
        return [[row]];
      }
      if (sql.includes('UPDATE $msg SET body')) {
        const row = rows.find(r => (r.id as { id: string }).id === (vars.msg as { id: string }).id)!;
        if (row.state === 'sent') return [[]];
        row.body = vars.body; row.edited_by = vars.actor;
        return [[row]];
      }
      if (sql.includes('state = ') && sql.includes('sent')) {
        const row = rows.find(r => (r.id as { id: string }).id === (vars.msg as { id: string }).id)!;
        if (!row || row.state === 'sent') return [[]];
        row.state = 'sent'; row.sent_to = vars.employee; row.hold = false;
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
  await store.markSent(execute!.id, 'e1', prepared!.body);
  await expect(store.edit(execute!.id, '已发后不许改', 'owner:test')).rejects.toThrow('locked');
  await expect(store.setHold(execute!.id, true, 'owner:test')).rejects.toThrow('locked');
  const locked = (await store.list('t1')).find(m => m.id === execute!.id)!;
  expect(locked.body).toBe('改成这句');
  expect(locked.state).toBe('sent');
  expect(locked.hold).toBe(false);
});

test('dispatch finalizer keeps employee attribution, message audit and binding inside one transaction', async () => {
  const calls: Array<{ sql: string; vars: Record<string, unknown> }> = [];
  const wf = new Workforce({ db: { query: async (sql: string, vars: Record<string, unknown>) => { calls.push({ sql, vars }); return []; } } } as never);
  await wf.finishDispatchAttempt('attempt-fixture', 'agent-fixture');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.sql).toContain('BEGIN;');
  expect(calls[0]!.sql).toContain('sent_to = $a.employee');
  expect(calls[0]!.sql).toContain('paseo_agent_id = $agent');
  expect(calls[0]!.sql).toContain('dispatch finalization generation changed');
});

test('dispatch finalizer resolves hold notice in the same commit as sent-lock', async () => {
  let sql = '';
  const wf = new Workforce({ db: { query: async (query: string) => { sql = query; return []; } } } as never);
  await wf.finishDispatchAttempt('attempt-fixture', 'agent-fixture');
  expect(sql).toContain('UPDATE owner_notice SET resolved_at');
  expect(sql.indexOf('UPDATE owner_notice')).toBeLessThan(sql.indexOf('COMMIT;'));
});

test('dispatch finalizer propagates transaction failure without an unguarded fallback', async () => {
  let calls = 0;
  const wf = new Workforce({ db: { query: async () => { calls++; throw new Error('rpc disconnect'); } } } as never);
  await expect(wf.finishDispatchAttempt('attempt-fixture', 'agent-fixture')).rejects.toThrow('rpc disconnect');
  expect(calls).toBe(1);
});

test('employee sandbox still forbids reading private/', () => {
  const sb = readFileSync(join(import.meta.dir, '..', 'scripts/sandbox/employee.sb'), 'utf8');
  expect(sb).toContain('(under service "/private")');
});

test('the owner token variable is blanked in every company session launch', () => {
  expect(scrubEnv({}, { SCK_OWNER_TOKEN: 'fixture' }).SCK_OWNER_TOKEN).toBe('');
});
