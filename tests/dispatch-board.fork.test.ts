import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import { Dispatcher, staffingPool, type PassInputs } from '../src/dispatcher/dispatcher.ts';
import { BLOCK_TEXT } from '../src/dispatcher/dispatch-blocked.ts';
import { RUNNER_BEAT_MS, readBoard, writeBoardView, writeRunnerHeartbeat } from '../src/board.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { ownerApi } from '../src/owner-api.ts';
import { DEFAULT_MACHINE_CRITERION, dispatchText, renderMessage } from '../src/outbound-render.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';

// W2 owner board on a real company fork: two engineers, one lease each, queued work and unsent messages. Every row the board
// shows is checked against the scheduler's own candidate check, and every message text against what a real dispatch sends.
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'isolated-board-test-only';
const SCK = '/fixture/sck';
const ENGINEERING = 'fixture-engineering';
const TIMEOUT_MS = 120_000;

interface Sent { id: string; prompt: string }

const keyOf = (value: unknown): string =>
  value !== null && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : String(value ?? '');
/** The fake Paseo names a spawned session after its employee, so the agent of an employee is known without a lookup. */
const agentOf = (employeeId: string): string => `agent-${employeeId}`;

async function startFork(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `board-fork-${name}-`));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD, '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  // SurrealDB reads a hyphen in a bare identifier as subtraction, so the namespace uses underscores only.
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: ROOT_PASSWORD, namespace: `isolated_board_${name.replaceAll('-', '_')}`, database: 'control_plane' });
  let pool: SidecarPool | undefined;
  const agentRows = new Map<string, { id: string; status: string }>();
  const sends: Sent[] = [];
  const spawns: Sent[] = [];
  const close = async () => {
    for (const id of agentRows.keys()) pool?.detachAgent(id);
    pool?.close();
    await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true);
    await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db), enrollment = new LocalEnrollmentAdmin(db), owner = new OwnerDesk(db);
    const gm = await enrollment.enroll('fixture-manager', 'owner', ['execute', 'review', 'manage']);
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ jev_decisions: false, quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0 });
    const wf = new Workforce(db);
    const rawQuery = db.db.query.bind(db.db) as unknown as typeof db.db.query;
    const ops = { tools: ['ops_info'], call: async () => ({ available: true }), release: () => {} };
    pool = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
    const paseo: PaseoGateway = {
      list: async () => new Map(agentRows),
      status: async id => !agentRows.has(id) ? undefined : { status: agentRows.get(id)!.status, pendingPermissions: 0 },
      lastError: async () => '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
      spawn: async b => { const id = agentOf(b.labels.employee_id); agentRows.set(id, { id, status: 'running' }); spawns.push({ id, prompt: b.prompt }); return id; },
      send: async (id, prompt) => { agentRows.get(id)!.status = 'running'; sends.push({ id, prompt }); },
      stop: async id => { agentRows.get(id)!.status = 'idle'; }, reload: async id => { agentRows.get(id)!.status = 'idle'; },
      archive: async id => { agentRows.get(id)!.status = 'archived'; pool?.detachAgent(id); },
      listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
    const newDispatcher = () => new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
      env: { opsRepo: dir, sckBin: SCK, paseoBin: '/fixture/paseo' } });
    return { dir, database: db, owner, surreal: db.db, core, wf, gm, rawQuery, agentRows, sends, spawns, pool: pool!, newDispatcher, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type Fork = Awaited<ReturnType<typeof startFork>>;

const rowsOf = async <T,>(w: Fork, sql: string, vars?: Record<string, unknown>): Promise<T[]> =>
  ((await w.rawQuery<[T[]]>(sql, vars))[0] ?? []) as T[];

/** The newest unsent draft of a task's step: what the next dispatch of that step would send. */
const unsentDraft = async (w: Fork, taskId: string, step: string) => {
  const [row] = await rowsOf<{ id: unknown; body: string }>(w,
    "SELECT id, body, created_at FROM outbound_message WHERE task = $task AND step = $step AND state != 'sent' ORDER BY created_at DESC;",
    { task: new RecordId('task', taskId), step });
  return row ? { id: keyOf(row.id), body: row.body } : undefined;
};
const unsentCount = async (w: Fork, taskId: string): Promise<number> =>
  (await rowsOf(w, "SELECT id FROM outbound_message WHERE task = $task AND state != 'sent';", { task: new RecordId('task', taskId) })).length;
const currentEmployeeOf = async (w: Fork, taskId: string): Promise<string | undefined> => {
  const [row] = await rowsOf<{ current_employee?: unknown }>(w, 'SELECT current_employee FROM $task;', { task: new RecordId('task', taskId) });
  return row?.current_employee === undefined || row.current_employee === null ? undefined : keyOf(row.current_employee);
};

/** The text a real dispatch of this task to this employee sends: the same render and join the send path makes. */
const dispatchedText = async (w: Fork, employeeId: string, taskId: string, body?: string): Promise<string> => {
  const stored = body ?? (await unsentDraft(w, taskId, 'execute'))!.body;
  return dispatchText(renderMessage(stored, { sckBin: SCK, commDir: w.pool.commDirFor(employeeId), taskId, acId: DEFAULT_MACHINE_CRITERION }));
};

/**
 * The reuse rows the scheduler's own candidate check gives each employee for the queued tasks, in queue order. It rebuilds the pass
 * inputs the tick used and calls staffingPool, the function the dispatch picks with, so the board's rows are checked against it.
 */
const schedulerRows = (dispatcher: Dispatcher, dir: string, queue: readonly string[]): Map<string, Array<{ taskId: string; eligible: boolean }>> => {
  const p = (dispatcher as unknown as { passInputs?: PassInputs }).passInputs!;
  const busyBy = new Map<string, number>();
  for (const inst of p.insts) if (p.states.get(inst.id) === 'busy') busyBy.set(inst.provider ?? '', (busyBy.get(inst.provider ?? '') ?? 0) + 1);
  const holding = new Set(p.tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
  const base = { defs: p.defs, insts: p.insts, states: p.states, holding, health: p.health, quotaBlocked: p.quotaBlocked,
    factoryQueue: p.factoryQueue, busyBy, providerMax: p.cfg.providerMax, slots: p.slots, runtimeModels: p.runtimeModels,
    opsRepo: dir, sidecar: true, now: p.now, assigned: p.assigned };
  const rows = new Map<string, Array<{ taskId: string; eligible: boolean }>>();
  for (const taskId of queue) {
    const task = p.tasks.find(t => t.id === taskId)!;
    for (const entry of staffingPool({ ...base, role: task.executorRole as string, home: task.repoPath ?? dir, task, excludeSubmitter: false, exclusion: undefined })) {
      if (entry.kind !== 'reuse' || !entry.inst) continue;
      rows.set(entry.inst.id, [...rows.get(entry.inst.id) ?? [], { taskId, eligible: entry.eligible }]);
    }
  }
  return rows;
};

/** What the plugin does after every pass: the scheduler's view is written for the owner board to read. */
const publish = async (w: Fork, dispatcher: Dispatcher): Promise<void> => {
  const view = dispatcher.dispatchSnapshot().board;
  expect(view).toBeDefined();
  await writeBoardView(w.surreal, view!);
};

interface Scenario {
  dispatcher: Dispatcher;
  titles: Map<string, string>;
  /** Keeps its lease, with a checkpoint on record. */
  first: { task: string; employee: string };
  /** Gave its lease back; its session stays busy and is bound to this task, so it can take only this task's next step. */
  second: { task: string; employee: string };
  /** Queued and still open. */
  open: string;
  /** Queued, then voided after the pass that queued it. */
  voided: string;
  /** Queued, then closed (done) after the pass that queued it. */
  closed: string;
}

/**
 * The state both tests start from. Two engineers are spawned for the first two tasks. The first keeps its lease and gets a
 * checkpoint. The second gives its lease back and its session stays busy. Three more tasks wait behind them. One of those is
 * voided and one closed after the pass, so the board read sees a view that no longer matches the database.
 */
async function scenario(w: Fork): Promise<Scenario> {
  await w.wf.upsertDef(ENGINEERING, { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 2, enabled: true });
  const titles = new Map<string, string>();
  for (const [index, title] of ['看板任务一', '看板任务二', '看板任务三', '看板任务四', '看板任务五'].entries()) {
    const task = await w.core.createTask(w.gm, { title, context: '合成数据：仅用于看板回归测试', executorRole: 'engineering',
      reviewerRole: 'owner', idempotencyKey: `board-create-${index}` });
    titles.set(task.id, title);
  }
  const dispatcher = w.newDispatcher();
  await dispatcher.tick();
  const holders = await rowsOf<{ id: unknown; current_employee: unknown }>(w, 'SELECT id, current_employee FROM task WHERE current_employee != NONE;');
  expect(holders.length).toBe(2);
  const leases = holders.map(row => ({ task: keyOf(row.id), employee: keyOf(row.current_employee) }));
  const first = leases[0]!, second = leases[1]!;
  await w.rawQuery(`CREATE audit CONTENT { task: $task, actor: $actor, action: 'checkpoint', evidence: '第一段进展\n第二行说明',
    version: 0, at: time::now() };`, { task: new RecordId('task', first.task), actor: new RecordId('employee', first.employee) });
  await w.pool.releaseClaim(second.employee, second.task, '【看板测试】释放第二位员工的租约，会话仍在忙');
  await dispatcher.tick();
  await publish(w, dispatcher);
  const [open, voided, closed] = [...titles.keys()].filter(id => id !== first.task && id !== second.task);
  await w.rawQuery("UPDATE $task SET state = 'void';", { task: new RecordId('task', voided!) });
  await w.rawQuery("UPDATE $task SET state = 'done';", { task: new RecordId('task', closed!) });
  return { dispatcher, titles, first, second, open: open!, voided: voided!, closed: closed! };
}

run('owner board: leases, idle employee, queue and next rows, and closed tasks leave the board', async () => {
  const w = await startFork('board-read');
  try {
    const s = await scenario(w);
    const now = Date.now();
    const board = await readBoard(w.surreal, { now });
    const employee = (id: string) => board.employees.find(row => row.id === id)!;

    // The lease holder shows its task, phase, lease and latest progress; the released employee shows idle.
    expect(employee(s.first.employee).now).toMatchObject({ state: 'leased', taskId: s.first.task, title: s.titles.get(s.first.task),
      phase: 'execute', leaseActive: true, progress: { action: 'checkpoint', summary: '第一段进展' } });
    const lease = employee(s.first.employee).now;
    expect(lease.state === 'leased' && lease.leaseStartedAt !== undefined && lease.leaseStartedAt <= now).toBe(true);
    expect(lease.state === 'leased' && lease.elapsedSeconds !== undefined && lease.elapsedSeconds >= 0).toBe(true);
    expect(employee(s.second.employee).now).toMatchObject({ state: 'idle' });

    // The queue holds exactly the open queued tasks: the released one and the untouched one. The voided and closed tasks are gone.
    const order = board.unassigned.map(row => row.taskId);
    expect([...order].sort()).toEqual([s.second.task, s.open].sort());
    for (const row of board.unassigned) {
      expect(row.eligible).toBe(false);
      expect(row.reason).toMatch(/^排在第 \d 位/);
    }

    // A session serves one task. The lease holder's session has no row for queued work, and the released session has a row only for
    // its own task. Each row is the scheduler's own reuse row for the same inputs.
    const expected = schedulerRows(s.dispatcher, w.dir, order);
    expect(expected.get(s.first.employee)).toBeUndefined();
    expect(expected.get(s.second.employee)?.map(row => row.taskId)).toEqual([s.second.task]);
    for (const id of [s.first.employee, s.second.employee]) {
      expect(employee(id).next.map(row => ({ taskId: row.taskId, eligible: row.eligible }))).toEqual(expected.get(id) ?? []);
    }
    expect(employee(s.first.employee).next).toEqual([]);
    expect(employee(s.second.employee).next.map(row => row.reason)).toEqual([
      `排在第 ${order.indexOf(s.second.task) + 1} 位；${BLOCK_TEXT.session_busy}`]);

    // Each outbox row is the text a dispatch to that employee would send, and it lists the next rows' open tasks only.
    for (const id of [s.first.employee, s.second.employee]) {
      const rows = employee(id).outbox;
      expect(rows.map(row => row.taskId)).toEqual(employee(id).next.map(row => row.taskId));
      for (const row of rows) {
        expect(row.body).toBe(await dispatchedText(w, id, row.taskId));
        expect(row).toMatchObject({ step: 'execute', hold: false, lang: 'zh', editable: true, workdirPending: true });
      }
    }
    for (const taskId of [s.voided, s.closed]) {
      expect(await unsentCount(w, taskId)).toBeGreaterThan(0);
      expect(order).not.toContain(taskId);
      for (const row of board.employees) {
        expect(row.next.map(entry => entry.taskId)).not.toContain(taskId);
        expect(row.outbox.map(entry => entry.taskId)).not.toContain(taskId);
      }
    }

    // Recent activity is company-wide and capped; the first claim is on record.
    expect(board.recent.length).toBeLessThanOrEqual(20);
    expect(board.recent.find(row => row.taskId === s.first.task && row.action === 'claim')?.actor).toBe(s.first.employee);

    // The runner row: unknown before any beat, online on a fresh beat, offline once three beats are missed.
    expect(board.runner.state).toBe('unknown');
    await writeRunnerHeartbeat(w.surreal, { runner: 'plugin:test', host: 'test-host', version: '0.0.0-test' });
    expect((await readBoard(w.surreal, { now: Date.now() })).runner).toMatchObject({ state: 'online', id: 'plugin:test', host: 'test-host', version: '0.0.0-test' });
    expect((await readBoard(w.surreal, { now: Date.now() + 3 * RUNNER_BEAT_MS + 1000 })).runner.state).toBe('offline');
  } finally {
    await w.close();
  }
}, TIMEOUT_MS);

run('owner board: a held message stays home, and an owner edit is what the employee receives', async () => {
  const w = await startFork('board-deliver');
  try {
    const s = await scenario(w);
    const store = new OutboundMessageStore(w.surreal);
    // The released session can take only its own task, so that task's message is the one its next dispatch would send.
    const draft = (await unsentDraft(w, s.second.task, 'execute'))!;
    await store.setHold(draft.id, true, 'owner');

    // While held, the board reads the employee's row and the queued row as waiting for the owner, and the outbox says so.
    const held = await readBoard(w.surreal, { now: Date.now() });
    const heldRow = held.employees.find(row => row.id === s.second.employee)!.next.find(row => row.taskId === s.second.task)!;
    expect(heldRow).toMatchObject({ eligible: false, reason: expect.stringContaining('消息待老板放行') });
    expect(held.unassigned.find(row => row.taskId === s.second.task)).toMatchObject({ eligible: false, blocked: true });
    expect(held.employees.find(row => row.id === s.second.employee)!.outbox.find(row => row.taskId === s.second.task)?.hold).toBe(true);

    // Idle the released session and close the other open task, so the only queued work is the held message.
    w.agentRows.get(agentOf(s.second.employee))!.status = 'idle';
    await w.rawQuery("UPDATE $task SET state = 'void';", { task: new RecordId('task', s.open) });
    const sentBefore = w.sends.length;
    // The session is idle and the message is held: the tick neither claims the task nor sends anything.
    await s.dispatcher.tick();
    await publish(w, s.dispatcher);
    expect(w.sends.length).toBe(sentBefore);
    expect(await currentEmployeeOf(w, s.second.task)).toBeUndefined();

    // The owner releases the hold and edits the text. The board then shows the edited text, and it is what the next dispatch sends.
    await store.setHold(draft.id, false, 'owner');
    const edited = `${draft.body}\n老板补充：先核对验收标准第 3 条。`;
    await store.edit(draft.id, edited, 'owner');
    const released = await readBoard(w.surreal, { now: Date.now() });
    const row = released.employees.find(item => item.id === s.second.employee)!.outbox.find(item => item.taskId === s.second.task)!;
    expect(row.body).toBe(await dispatchedText(w, s.second.employee, s.second.task, edited));
    expect(row.body).toContain('老板补充：先核对验收标准第 3 条。');
    expect(row).toMatchObject({ hold: false, workdirPending: true });
    expect(released.employees.find(item => item.id === s.second.employee)!.next.find(item => item.taskId === s.second.task))
      .toMatchObject({ eligible: true, reason: '排在第 1 位，可接' });

    await s.dispatcher.tick();
    expect(w.sends.slice(sentBefore)).toEqual([{ id: agentOf(s.second.employee), prompt: row.body }]);
    expect(await currentEmployeeOf(w, s.second.task)).toBe(s.second.employee);
  } finally {
    await w.close();
  }
}, TIMEOUT_MS);

run('owner board: an edit of the shown text is saved as the stored body, and the board then shows what the employee gets', async () => {
  const w = await startFork('board-edit');
  try {
    const s = await scenario(w);
    const desk = { db: w.database, core: w.core as never, owner: w.owner, workforce: w.wf, messages: new OutboundMessageStore(w.surreal), opsRepo: w.dir };
    const edit = (messageId: string, employeeId: string, rendered: string) =>
      ownerApi(desk, { command: 'message.edit_rendered', messageId, employeeId, rendered }, 'test');
    const commDir = w.pool.commDirFor(s.second.employee);
    const shown = (await readBoard(w.surreal, { now: Date.now() })).employees.find(row => row.id === s.second.employee)!.outbox.find(row => row.taskId === s.second.task)!;
    const stored = (await unsentDraft(w, s.second.task, 'execute'))!.body;

    // A path the stored body cannot carry is refused, and the stored body stays as it was.
    await expect(edit(shown.messageId, s.second.employee, shown.body.replace(`${commDir}/task.md`, 'task.md'))).rejects.toThrow(/invalid/);
    expect((await unsentDraft(w, s.second.task, 'execute'))!.body).toBe(stored);
    // An unknown employee and an unknown message are refused.
    await expect(edit(shown.messageId, 'nobody', shown.body)).rejects.toThrow(/not found/);
    await expect(edit('missing', s.second.employee, shown.body)).rejects.toThrow(/not found/);

    // The owner adds a line to the text the board shows. The stored body keeps placeholders, not this employee's paths.
    const edited = `${shown.body}\n老板补充：先核对验收标准第 3 条。`;
    await edit(shown.messageId, s.second.employee, edited);
    const next = (await unsentDraft(w, s.second.task, 'execute'))!.body;
    expect(next).toContain('老板补充：先核对验收标准第 3 条。');
    expect(next).not.toContain(commDir);
    // The board shows the edited text, and a dispatch would send exactly that text.
    const after = (await readBoard(w.surreal, { now: Date.now() })).employees.find(row => row.id === s.second.employee)!.outbox.find(row => row.taskId === s.second.task)!;
    expect(after.body).toBe(edited);
    expect(after.body).toBe(await dispatchedText(w, s.second.employee, s.second.task, next));

    // The next dispatch sends that text: the released session is idle and the other queued task is voided, so the tick sends it.
    w.agentRows.get(agentOf(s.second.employee))!.status = 'idle';
    await w.rawQuery("UPDATE $task SET state = 'void';", { task: new RecordId('task', s.open) });
    const sentBefore = w.sends.length;
    await s.dispatcher.tick();
    expect(w.sends.slice(sentBefore)).toEqual([{ id: agentOf(s.second.employee), prompt: edited }]);
    expect(await currentEmployeeOf(w, s.second.task)).toBe(s.second.employee);

    // Once the message is sent it is locked against edits.
    await expect(edit(shown.messageId, s.second.employee, edited)).rejects.toThrow(/conflict/);
  } finally {
    await w.close();
  }
}, TIMEOUT_MS);

run('owner board: a task gets a session of its own, and an idle session of another task is never reused', async () => {
  const w = await startFork('session-own');
  try {
    const s = await scenario(w);
    // Both earlier sessions are idle and their tasks are gone, so the open task is the only queued work.
    w.agentRows.get(agentOf(s.second.employee))!.status = 'idle';
    await w.pool.releaseClaim(s.first.employee, s.first.task, '【看板测试】释放第一位员工的租约，准备派发新任务');
    w.agentRows.get(agentOf(s.first.employee))!.status = 'idle';
    await w.rawQuery("UPDATE $task SET state = 'void';", { task: new RecordId('task', s.first.task) });
    await w.rawQuery("UPDATE $task SET state = 'void';", { task: new RecordId('task', s.second.task) });
    const spawnedBefore = w.spawns.length;
    await s.dispatcher.tick();

    // The open task goes to a new session, not to either idle one, and the spawn binds that session to the open task.
    const holder = await currentEmployeeOf(w, s.open);
    expect(holder).toBeDefined();
    expect([s.first.employee, s.second.employee]).not.toContain(holder!);
    expect(w.spawns.slice(spawnedBefore).map(row => row.id)).toEqual([agentOf(holder!)]);
    const [row] = await rowsOf<{ session_task?: string | null }>(w, 'SELECT session_task FROM $employee;', { employee: new RecordId('employee', holder!) });
    expect(row?.session_task).toBe(s.open);
  } finally {
    await w.close();
  }
}, TIMEOUT_MS);
