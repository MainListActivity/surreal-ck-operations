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
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { BLOCK_TEXT } from '../src/dispatcher/dispatch-blocked.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';

// SYS-DISP review round v44 (B2, B3): dispatch-blocked episodes and unknown states on a real company fork.
// Every behavioural claim is also read back from the database (owner_notice, task, audit, dispatch rows).
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'isolated-channel-test-only';

interface TaskFact { state: string; version: number; current_employee?: unknown; dispatch_blocked_phase?: string | null; dispatch_blocked_since?: number | null }
interface AuditFact { id: unknown; action: string; actor: unknown; evidence?: string; version?: number; at: unknown }
interface NoticeFact { key: string; text: string; resolved_at?: unknown }

async function startFork(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `channel-fork-${name}-`));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD, '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  // SurrealDB reads a hyphen in a bare identifier as subtraction, so the namespace uses underscores only.
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: ROOT_PASSWORD, namespace: `isolated_b2b3_${name.replaceAll('-', '_')}`, database: 'control_plane' });
  let pool: SidecarPool | undefined;
  const agentRows = new Map<string, { id: string; status: string }>();
  const hidden = new Set<string>();
  const envs = new Map<string, Record<string, string>>();
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
    // The original query stays reachable for every assertion below, even when a test wraps db.db.query to inject a failure.
    const rawQuery = db.db.query.bind(db.db) as unknown as typeof db.db.query;
    const ops = { tools: ['ops_info'], call: async () => ({ available: true }), release: () => {} };
    pool = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
    const paseo: PaseoGateway = {
      // A hidden session is one the CLI gives no usable answer for: absent from the roster, and its status is unknown.
      // `undefined` is reserved for a confirmed AGENT_NOT_FOUND, which the dispatcher reads as a missing session.
      list: async () => new Map([...agentRows].filter(([id]) => !hidden.has(id))),
      status: async id => !agentRows.has(id) ? undefined : hidden.has(id) ? { status: 'unknown', pendingPermissions: 0 } : { status: agentRows.get(id)!.status, pendingPermissions: 0 },
      lastError: async () => '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
      spawn: async b => { const id = `agent-${b.labels.employee_id}`; agentRows.set(id, { id, status: 'running' }); envs.set(id, b.env); return id; },
      send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; }, reload: async id => { agentRows.get(id)!.status = 'idle'; },
      archive: async id => { agentRows.get(id)!.status = 'archived'; pool?.detachAgent(id); },
      listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
    // Every dispatcher is built on the same database; a new one is a process restart with no memory kept.
    const newDispatcher = () => new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
      env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
    // Every write of the episode start goes through this spy, so a persisted-once claim is counted, not inferred.
    const dispatchBlockCalls: Array<{ taskId: string; phase: string | undefined; since?: number }> = [];
    const realSetDispatchBlock = wf.setDispatchBlock.bind(wf);
    wf.setDispatchBlock = async (taskId, phase, since) => { dispatchBlockCalls.push({ taskId, phase, since }); await realSetDispatchBlock(taskId, phase, since); };
    const taskRow = async (taskId: string) => (await rawQuery<[TaskFact]>('SELECT state, version, current_employee, dispatch_blocked_phase, dispatch_blocked_since FROM ONLY $t;',
      { t: new RecordId('task', taskId) }))[0] as TaskFact;
    const auditRows = async (taskId: string) => ((await rawQuery<[AuditFact[]]>(
      'SELECT id, action, actor, evidence, version, at FROM audit WHERE task = $t ORDER BY at ASC, id ASC;', { t: new RecordId('task', taskId) }))[0] ?? []);
    const noticeRows = async (prefix: string) => ((await rawQuery<[NoticeFact[]]>(
      'SELECT key, text, resolved_at FROM owner_notice WHERE string::starts_with(key, $prefix) ORDER BY key;', { prefix }))[0] ?? []);
    const dispatchRows = async (taskId: string) => ((await rawQuery<[unknown[]]>('SELECT purpose, employee FROM dispatch WHERE task = $t;', { t: taskId }))[0] ?? []);
    const verdictOf = (dispatcher: Dispatcher, taskId: string) => dispatcher.dispatchVerdicts().find(v => v.taskId === taskId && v.phase === 'execute');
    return {
      core, owner, wf, db, gm, hidden, agentRows, envs, rawQuery, dispatchBlockCalls,
      newDispatcher, taskRow, auditRows, noticeRows, dispatchRows, verdictOf, close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const claimsOf = (rows: AuditFact[]) => rows.filter(row => row.action === 'claim');

run('B2 (SYS-DISP AC03/AC06): ten real ticks with a restart in the middle keep one open dispatch-blocked notice, claim nothing, wake nothing and persist the episode start once; a changed reason rewrites the same notice', async () => {
  const w = await startFork('b2-episode');
  try {
    // A qa def keeps the pass out of the budget gate, while no engineering seat exists: the execute item has no candidate at all.
    await w.wf.upsertDef('fixture-qa', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'B2 dispatch-blocked episode', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'owner', idempotencyKey: 'b2-create' });
    const key = `dispatch-blocked:${task.id}:execute`;
    const created = await w.taskRow(task.id);
    const auditAtCreate = await w.auditRows(task.id);
    const notified: string[] = [];
    let dispatcher = w.newDispatcher();
    let since: number | undefined;
    for (let tick = 1; tick <= 10; tick++) {
      if (tick === 6) dispatcher = w.newDispatcher(); // the restart in the middle of the ten ticks
      const report = await dispatcher.tick();
      notified.push(...report.notices.filter(k => k === key));
      expect(report.woke.filter(x => x.task === task.id)).toEqual([]);
      const row = await w.taskRow(task.id);
      if (tick === 1) since = row.dispatch_blocked_since ?? undefined;
      expect(row.dispatch_blocked_phase).toBe('execute');
      expect(row.dispatch_blocked_since).toBe(since);
    }
    expect(typeof since).toBe('number');
    const verdict = w.verdictOf(dispatcher, task.id);
    expect(verdict?.reasons.map(r => r.code)).toEqual(['no_candidate']);
    expect(verdict?.since).toBe(new Date(since! * 1000).toISOString());

    // Direct database checks after the ten ticks.
    const rows = await w.noticeRows(`dispatch-blocked:${task.id}:`);
    console.log('B2 notice rows after ten ticks', JSON.stringify(rows));
    expect(rows.map(r => r.key)).toEqual([key]);
    expect(rows[0]!.resolved_at).toBeFalsy();
    expect(rows[0]!.text).toContain(BLOCK_TEXT.no_candidate);
    expect(notified).toEqual([key]);
    expect((await w.owner.openNotices()).filter(n => n.key.startsWith(`dispatch-blocked:${task.id}:`))).toHaveLength(1);
    const afterTen = await w.taskRow(task.id);
    console.log('B2 task row after ten ticks', JSON.stringify(afterTen));
    expect(afterTen.state).toBe('ready');
    expect(afterTen.version).toBe(created.version);
    expect(afterTen.current_employee ?? null).toBeNull();
    expect(claimsOf(await w.auditRows(task.id))).toEqual([]);
    expect((await w.auditRows(task.id)).length).toBe(auditAtCreate.length);
    expect(await w.dispatchRows(task.id)).toEqual([]);
    expect(await w.wf.insts()).toEqual([]);
    expect(w.dispatchBlockCalls).toEqual([{ taskId: task.id, phase: 'execute', since }]);

    // The reason changes: the engineering def now exists but is disabled. The same notice row takes the new text and the start stays.
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1, enabled: false });
    const changed = w.newDispatcher();
    const changedReport = await changed.tick();
    expect(changedReport.woke.filter(x => x.task === task.id)).toEqual([]);
    expect(w.verdictOf(changed, task.id)?.reasons.map(r => r.code)).toEqual(['def_disabled']);
    const rowsAfter = await w.noticeRows(`dispatch-blocked:${task.id}:`);
    console.log('B2 notice rows after reason change', JSON.stringify(rowsAfter));
    expect(rowsAfter.map(r => r.key)).toEqual([key]);
    expect(rowsAfter[0]!.resolved_at).toBeFalsy();
    expect(rowsAfter[0]!.text).toContain(BLOCK_TEXT.def_disabled);
    expect(rowsAfter[0]!.text).not.toContain(BLOCK_TEXT.no_candidate);
    expect(rowsAfter[0]!.text).not.toBe(rows[0]!.text);
    expect((await w.taskRow(task.id)).dispatch_blocked_since).toBe(since);
    expect(w.dispatchBlockCalls).toHaveLength(1);
    expect(claimsOf(await w.auditRows(task.id))).toEqual([]);
    expect(await w.dispatchRows(task.id)).toEqual([]);
    expect(await w.wf.insts()).toEqual([]);
    expect((await w.owner.openNotices()).filter(n => n.key.startsWith(`dispatch-blocked:${task.id}:`))).toHaveLength(1);
  } finally {
    await w.close();
  }
}, 120000);

run('B3 (SYS-DISP AC06) (a): a session the tick cannot observe is unknown, never busy and never dispatched; recovery resumes the bound task and clears the notice', async () => {
  const w = await startFork('b3-observe');
  try {
    await w.wf.upsertDef('fixture-eng', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const task = await w.core.createTask(w.gm, { title: 'B3 unobserved session', context: 'Synthetic regression only', executorRole: 'engineering', reviewerRole: 'owner', idempotencyKey: 'b3-observe-create' });
    const key = `dispatch-blocked:${task.id}:execute`;
    // The first pass binds the only engineer seat to the task.
    expect((await w.newDispatcher().tick()).woke.find(x => x.task === task.id)?.spawned).toBe(true);
    const A = (await w.wf.insts())[0]!;
    expect(claimsOf(await w.auditRows(task.id))).toHaveLength(1);
    // A goes idle and its lease lapses, while Paseo gives no usable answer for A: the task returns to ready, still bound to A.
    w.agentRows.get(A.paseoAgentId!)!.status = 'idle';
    await w.db.db.query('UPDATE $t SET lease_expires_at = time::unix(time::now()) - 1;', { t: new RecordId('task', task.id) });
    w.hidden.add(A.paseoAgentId!);
    const dispatcher = w.newDispatcher();
    const second = await dispatcher.tick();
    const verdict = w.verdictOf(dispatcher, task.id);
    console.log('B3(a) revoked', JSON.stringify(second.revoked), 'woke', JSON.stringify(second.woke), 'verdict', JSON.stringify(verdict));
    expect(second.revoked).toEqual([task.id]);
    // The roster reads A as unknown, never busy.
    expect(dispatcher.sessionSnapshot().sessions.get(A.id)).toMatchObject({ status: 'unknown', state: 'unknown' });
    // Not dispatched: no woke, no new employee instance, A is not retired, and the audit stream still holds only the first claim.
    expect(second.woke.filter(x => x.task === task.id)).toEqual([]);
    expect(second.retired).toEqual([]);
    expect((await w.wf.insts()).map(i => i.id)).toEqual([A.id]);
    expect(claimsOf(await w.auditRows(task.id))).toHaveLength(1);
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'ready' });
    expect(verdict).toMatchObject({ dispatchable: false, feasible: true });
    expect(verdict?.reasons.map(r => r.code)).toContain('unknown');
    expect(verdict?.reasons.map(r => r.code)).not.toContain('session_busy');
    // A feasible unknown block becomes an owner notice once the episode ages past the grace; backdate it and re-tick.
    expect(second.notices).not.toContain(key);
    await w.wf.setDispatchBlock(task.id, 'execute', Math.floor(Date.now() / 1000) - 600);
    const third = await w.newDispatcher().tick();
    expect(third.notices).toContain(key);
    const open = await w.noticeRows(`dispatch-blocked:${task.id}:`);
    expect(open.map(r => r.key)).toEqual([key]);
    expect(open[0]!.resolved_at).toBeFalsy();
    expect(open[0]!.text).toContain(BLOCK_TEXT.unknown);
    expect(open[0]!.text).not.toContain(BLOCK_TEXT.session_busy);
    // Recovery: Paseo answers again and A is idle. The same implementer resumes its own task, and the notice clears with an audit row.
    w.hidden.delete(A.paseoAgentId!);
    const recovered = await w.newDispatcher().tick();
    expect(recovered.woke.find(x => x.task === task.id)).toMatchObject({ employee: A.id, spawned: false });
    expect(await w.core.getTask(w.gm, task.id)).toMatchObject({ state: 'doing', currentEmployee: A.id });
    expect((await w.owner.openNotices()).some(n => n.key === key)).toBe(false);
    const unblocked = (await w.auditRows(task.id)).filter(r => r.action === 'dispatch_unblocked');
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]!.evidence).toBe('dispatch-blocked execute episode ended: dispatched');
    expect(claimsOf(await w.auditRows(task.id))).toHaveLength(2);
    expect((await w.wf.insts()).map(i => i.id)).toEqual([A.id]);
  } finally {
    await w.close();
  }
}, 120000);
