import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { ownerApi, RUNNER_ONLY_COMMANDS, type OwnerApiContext } from '../src/owner-api.ts';
import { installHost } from '../src/host-io.ts';
import { installNodeHost } from '../src/host-node.ts';
import { pluginOwnerCommand } from '../plugin/server/owner-api.ts';

function makeFakeCtx(overrides?: Partial<OwnerApiContext>) {
  const queries: Array<{ sql: string; params?: any }> = [];
  const fakeDb = {
    query: async (sql: string, params?: any) => {
      queries.push({ sql, params });
      return [[]];
    },
    select: async () => undefined,
  };
  return {
    ctx: {
      db: { db: fakeDb } as any,
      core: {} as any,
      owner: {} as any,
      workforce: {} as any,
      messages: {} as any,
      opsRepo: '/fake/ops',
      ...overrides,
    } as OwnerApiContext,
    queries,
  };
}

// ---- ITEM 1: Idempotency ----
test('idempotencyKey produces identical key on retry, random UUID when omitted', async () => {
  const recordedKeys: string[] = [];
  const fakeOwner = {
    addDirection: async (input: { text: string; source: string; key: string }) => {
      recordedKeys.push(input.key);
      return { id: 'd1' };
    },
  };
  const { ctx } = makeFakeCtx({ owner: fakeOwner as any });

  const idempKey = 'retry-test-key-12345';
  await ownerApi(ctx, { command: 'direction.add', text: 'goal text', idempotencyKey: idempKey }, 'test-agent');
  await ownerApi(ctx, { command: 'direction.add', text: 'goal text', idempotencyKey: idempKey }, 'test-agent');
  expect(recordedKeys[0]).toBe(recordedKeys[1]);
  expect(recordedKeys[0]).toBe(`owner:test-agent:direction.add:${idempKey}`);

  await ownerApi(ctx, { command: 'direction.add', text: 'goal text' }, 'test-agent');
  await ownerApi(ctx, { command: 'direction.add', text: 'goal text' }, 'test-agent');
  expect(recordedKeys[2]).not.toBe(recordedKeys[3]);
  expect(recordedKeys[2]).toStartWith('owner:test-agent:direction.add:');
  expect(recordedKeys[3]).toStartWith('owner:test-agent:direction.add:');
});

// ---- ITEM 2: task.update audit ----
test('task.update writes an audit row with actor owner:<via> and changed fields', async () => {
  const queries: Array<{ sql: string; params?: any }> = [];
  const updatedTask = { id: new RecordId('task', 't1'), requirement: 'new req', title: 'new title' };
  const fakeDb = {
    query: async (sql: string, params?: any) => {
      queries.push({ sql, params });
      if (sql.includes('UPDATE $task MERGE $patch RETURN AFTER;')) {
        return [[updatedTask]];
      }
      return [[]];
    },
  };
  const { ctx } = makeFakeCtx({ db: { db: fakeDb } as any });

  const result = await ownerApi(ctx, { command: 'task.update', taskId: 't1', requirement: 'new req', title: 'new title' }, 'agent1');
  expect(result).toEqual(updatedTask);

  expect(queries.length).toBe(2);
  expect(queries[0].sql).toBe('UPDATE $task MERGE $patch RETURN AFTER;');
  expect(queries[0].params.patch).toEqual({ requirement: 'new req', title: 'new title' });

  expect(queries[1].sql).toContain('CREATE audit CONTENT');
  expect(queries[1].params.actor).toBe('owner:agent1');
  expect(queries[1].params.evidence).toContain('requirement');
  expect(queries[1].params.evidence).toContain('title');
  expect(queries[1].params.task.toString()).toBe('task:t1');
});

// ---- ITEM 3: New commands ----
test('direction.add calls ctx.owner.addDirection with text, source, key', async () => {
  let recorded: any;
  const fakeOwner = {
    addDirection: async (args: any) => { recorded = args; },
  };
  const { ctx } = makeFakeCtx({ owner: fakeOwner as any });
  const res = await ownerApi(ctx, { command: 'direction.add', text: 'New direction' }, 'cli');
  expect(res).toEqual({ ok: true });
  expect(recorded.text).toBe('New direction');
  expect(recorded.source).toBe('owner:cli');
  expect(recorded.key).toStartWith('owner:cli:direction.add:');
});

test('instruct calls ctx.owner.instruct with text, source, key', async () => {
  let recorded: any;
  const fakeOwner = {
    instruct: async (args: any) => { recorded = args; return { taskId: 'task-inst-1' }; },
  };
  const { ctx } = makeFakeCtx({ owner: fakeOwner as any });
  const res = await ownerApi(ctx, { command: 'instruct', text: 'Check blocker' }, 'desk');
  expect(res).toEqual({ taskId: 'task-inst-1' });
  expect(recorded.text).toBe('Check blocker');
  expect(recorded.source).toBe('owner:desk');
  expect(recorded.key).toStartWith('owner:desk:instruct:');
});

test('notice.resolve calls ctx.owner.resolveNotice with key', async () => {
  let recordedKey: string | undefined;
  const fakeOwner = {
    resolveNotice: async (key: string) => { recordedKey = key; },
  };
  const { ctx } = makeFakeCtx({ owner: fakeOwner as any });
  const res = await ownerApi(ctx, { command: 'notice.resolve', key: 'notice-abc' }, 'cli');
  expect(res).toEqual({ ok: true });
  expect(recordedKey).toBe('notice-abc');
});

test('notice.list calls ctx.owner.openNotices', async () => {
  const fakeNotices = [{ key: 'n1', text: 'notice 1', at: '2026-01-01' }];
  const fakeOwner = {
    openNotices: async () => fakeNotices,
  };
  const { ctx } = makeFakeCtx({ owner: fakeOwner as any });
  const res = await ownerApi(ctx, { command: 'notice.list' }, 'cli');
  expect(res).toEqual({ notices: fakeNotices });
});

test('task.cost reads task cost for single task', async () => {
  const fakeCost = { taskId: 't1', usd: 0.1234, requests: 5, sessions: 1, complete: true, source: 'magpie-requests' };
  const fakeDb = {
    select: async (id: RecordId) => {
      if (String(id) === 'task_cost:t1') {
        return { cost: fakeCost };
      }
      return undefined;
    },
    query: async () => [[]],
  };
  const { ctx } = makeFakeCtx({ db: { db: fakeDb } as any });
  const res = await ownerApi(ctx, { command: 'task.cost', taskId: 't1' }, 'cli') as any;
  expect(res).toEqual({ cost: fakeCost });
});

// ---- Runner-only commands: a process without an execution host answers them as unavailable ----
test('runner-only upgrade commands fail as unavailable without an execution host; other commands still answer', async () => {
  const { ctx } = makeFakeCtx();
  installHost(undefined);
  try {
    expect([...RUNNER_ONLY_COMMANDS].sort()).toEqual(['task.create', 'upgrade.automatic', 'upgrade.list', 'upgrade.start']);
    for (const command of RUNNER_ONLY_COMMANDS) {
      const error: unknown = await ownerApi(ctx, { command, taskId: 't1', taskVersion: 1, digest: 'd1', enabled: true }, 'cli').then(() => undefined, e => e);
      expect(error).toMatchObject({ name: 'CompanyError', code: 'unavailable' });
      expect((error as Error).message).toContain('需要执行端');
    }
    const { ctx: plain } = makeFakeCtx({ owner: { openNotices: async () => [] } as any });
    expect(await ownerApi(plain, { command: 'notice.list' }, 'cli')).toEqual({ notices: [] });
  } finally {
    installNodeHost();
  }
});

test('upgrade commands keep their answers on a host that has no upgrade desk', async () => {
  const { ctx } = makeFakeCtx();
  expect(await ownerApi(ctx, { command: 'upgrade.list' }, 'cli')).toEqual({ upgrades: { items: [] } });
  expect(await ownerApi(ctx, { command: 'upgrade.automatic', enabled: true }, 'cli')).toEqual({ ok: false });
  expect(await ownerApi(ctx, { command: 'upgrade.start', taskId: 't1', taskVersion: 1, digest: 'd1' }, 'cli')).toEqual({ ok: false });
});

test('upgrade commands go to the upgrade desk when the process has one', async () => {
  const calls: unknown[] = [];
  const upgrades = {
    inbox: async () => ({ upgrades: { items: [{ id: 'u1' }] } }),
    setAuto: async (enabled: boolean, source: string) => { calls.push(['auto', enabled, source]); return { ok: true }; },
    start: async (input: unknown, source: string) => { calls.push(['start', input, source]); return { jobId: 'j1' }; },
  };
  const { ctx } = makeFakeCtx({ upgrades: upgrades as any });
  expect(await ownerApi(ctx, { command: 'upgrade.list' }, 'cli')).toEqual({ upgrades: { items: [{ id: 'u1' }] } });
  await ownerApi(ctx, { command: 'upgrade.automatic', enabled: true }, 'cli');
  await ownerApi(ctx, { command: 'upgrade.start', taskId: 't1', taskVersion: 2, digest: 'd1' }, 'cli');
  expect(calls).toEqual([
    ['auto', true, 'owner:cli'],
    ['start', { taskId: 't1', taskVersion: 2, digest: 'd1' }, 'owner:cli'],
  ]);
});

// ---- Lane-note consolidation commands ----
test('note.consolidate previews or runs a pass for one lane or every lane, as the owner actor', async () => {
  const { ctx, queries } = makeFakeCtx();
  const preview = await ownerApi(ctx, { command: 'note.consolidate', lane: 'surreal_ck:qa', dryRun: true }, 'cli') as any;
  expect(preview).toMatchObject({ dryRun: true, actor: 'owner:cli', lanes: [], changes: [] });
  expect(queries.some(q => q.params?.lane === 'surreal_ck:qa')).toBe(true);
  // Nothing to change, so the pass returns its plan without writing a record.
  const all = await ownerApi(ctx, { command: 'note.consolidate' }, 'cli') as any;
  expect(all).toMatchObject({ dryRun: false, actor: 'owner:cli', changes: [] });
  expect(all.id).toBeUndefined();
});

test('note.consolidations passes the limit on; note.consolidation.undo needs an id and a recorded run', async () => {
  const { ctx, queries } = makeFakeCtx();
  expect(await ownerApi(ctx, { command: 'note.consolidations', limit: 5 }, 'cli')).toEqual({ consolidations: [] });
  expect(queries.at(-1)?.params).toEqual({ limit: 5 });
  await expect(ownerApi(ctx, { command: 'note.consolidation.undo' }, 'cli')).rejects.toMatchObject({ code: 'invalid' });
  await expect(ownerApi(ctx, { command: 'note.consolidation.undo', id: 'c1' }, 'cli')).rejects.toMatchObject({ code: 'not_found' });
});

// ---- ITEM 4: Docs and code stay in sync ----
test('docs/owner-api.md and both owner API layers stay in sync with zero duplicates', () => {
  const docContent = readFileSync(join(import.meta.dir, '../docs/owner-api.md'), 'utf8');
  const docCmds = [...docContent.matchAll(/`sck owner ([a-zA-Z0-9_.-]+)/g)].map(m => m[1]);

  const srcContent = readFileSync(join(import.meta.dir, '../src/owner-api.ts'), 'utf8');
  const srcCmds = [...srcContent.matchAll(/case\s+'([^']+)'\s*:/g)].map(m => m[1]);

  // Plugin-only commands live in the plugin wrapper; the docs must cover both layers.
  const pluginContent = readFileSync(join(import.meta.dir, '../plugin/server/owner-api.ts'), 'utf8');
  const pluginCmds = [...pluginContent.matchAll(/case\s+'([^']+)'\s*:/g)].map(m => m[1]);

  // No duplicate rows in documentation
  const docSet = new Set(docCmds);
  expect(docCmds.length).toBe(docSet.size);

  const codeSet = new Set([...srcCmds, ...pluginCmds]);
  expect(docSet).toEqual(codeSet);
  expect([...docSet].sort()).toEqual([...codeSet].sort());
});

// ---- ITEM 5: Plugin-only owner commands ----
function fakeCompany(overrides: Record<string, unknown> = {}) {
  const queries: Array<{ sql: string; params?: any }> = [];
  return {
    company: {
      db: { db: { query: async (sql: string, params?: any) => { queries.push({ sql, params }); return [[]]; }, select: async () => undefined } },
      paseo: undefined,
      ...overrides,
    } as never,
    queries,
  };
}
const home = () => mkdtempSync(join(tmpdir(), 'owner-plugin-'));

test('plugin permission.list reads the fake paseo and filters company agents', async () => {
  const refreshed: string[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: [
        { id: 'a1', title: 'QA', labels: { company: 'surreal-ck', employee_id: 'e1', role: 'qa' }, pendingPermissions: [{ id: 'r1' }] },
        { id: 'a2', title: 'Other', labels: { company: 'someone-else' }, pendingPermissions: [{ id: 'r9' }] },
      ] }),
      ref: (id: string) => ({ refresh: async () => { refreshed.push(id); return { pendingPermissions: [{ id: 'r2', kind: 'shell', summary: 'run tests', detail: 'x' }] }; } }),
    },
  };
  const { company } = fakeCompany({ paseo });
  const result = await pluginOwnerCommand(company, home(), { command: 'permission.list' });
  expect(result.handled).toBe(true);
  if (result.handled) {
    expect((result.value as any).items).toEqual([{ agentId: 'a1', title: 'QA', employeeId: 'e1', role: 'qa',
      request: { id: 'r2', kind: 'shell', summary: 'run tests', detail: 'x' } }]);
  }
  expect(refreshed).toEqual(['a1']);
});

test('plugin permission.answer validates behavior and responds on the fake paseo', async () => {
  const answers: any[] = [];
  const paseo = { agents: { ref: (id: string) => ({ respondToPermission: async (input: unknown) => { answers.push({ id, input }); } }) } };
  const { company } = fakeCompany({ paseo });
  const result = await pluginOwnerCommand(company, home(), { command: 'permission.answer', agentId: 'a1', requestId: 'r1', behavior: 'allow', message: 'ok' });
  expect(result).toEqual({ handled: true, value: { ok: true } });
  expect(answers).toEqual([{ id: 'a1', input: { requestId: 'r1', response: { behavior: 'allow', message: 'ok' } } }]);
  await expect(pluginOwnerCommand(company, home(), { command: 'permission.answer', agentId: 'a1', requestId: 'r1', behavior: 'maybe' })).rejects.toThrow(/invalid/);
  await expect(pluginOwnerCommand(fakeCompany().company, home(), { command: 'permission.list' })).rejects.toThrow(/temporarily_unavailable/);
});

test('plugin task.attachments lists the evidence dir and attachment.url builds the LAN URL', async () => {
  const serviceHome = home();
  mkdirSync(join(serviceHome, 'evidence', 't1'), { recursive: true });
  writeFileSync(join(serviceHome, 'evidence', 't1', 'report.md'), '# report');
  const listed = await pluginOwnerCommand(fakeCompany().company, serviceHome, { command: 'task.attachments', taskId: 't1' });
  expect(listed.handled).toBe(true);
  if (listed.handled) expect((listed.value as any).attachments.map((a: any) => a.relPath)).toEqual(['report.md']);
  const url = await pluginOwnerCommand(fakeCompany().company, serviceHome, { command: 'attachment.url', taskId: 't1', file: 'report.md' });
  expect(url.handled).toBe(true);
  if (url.handled) expect((url.value as any).url).toEndWith('/e/t1/report.md');
  await expect(pluginOwnerCommand(fakeCompany().company, serviceHome, { command: 'attachment.url', taskId: 't1', file: '../x' })).rejects.toThrow(/附件不存在或越界/);
});

test('plugin wrapper leaves every src command untouched', async () => {
  const result = await pluginOwnerCommand(fakeCompany().company, home(), { command: 'goal.list' });
  expect(result).toEqual({ handled: false });
});

// ---- ITEM 5: Token not on the process command line ----
test('scripts/sck.sh passes token file path and does not pass token in argv', () => {
  const scriptContent = readFileSync(join(import.meta.dir, '../scripts/sck.sh'), 'utf8');
  const pythonExecMatch = scriptContent.match(/\/usr\/bin\/python3 -I -[^\n]+/);
  expect(pythonExecMatch).toBeTruthy();
  const execLine = pythonExecMatch![0];
  expect(execLine).not.toContain('"$token"');
  expect(execLine).not.toContain('$token ');
  expect(execLine).toContain('"$token_file"');

  expect(scriptContent).not.toMatch(/^\s*token=\$\(/m);
  expect(scriptContent).toContain('with open(token_file, "r"');
  expect(scriptContent).toContain('token = f.readline().strip()');
});
