// SYS-QUOTA 端到端：员工的额度阻塞必须真的立起门禁。本用例跑真实层——隔离 SurrealDB、真实 core、
// 真实 Workforce/Dispatcher、真实 SidecarPool，员工侧用真实 `sck` 通道（client-cli 进程写 req/ 读 res/），
// 不 mock 调度器、不直接调 core.block。缺陷原文见 comm 目录的 gm-bc728b-defect-quota-resets-dropped.md：
// sidecar 只转发 text，第 5 参 quotaResetsAt 缺省 ⇒ 任务 quota_resets_at 不写、provider 不标 exhausted、
// 经理在恢复点前被反复唤醒。本用例断言的是这三件事的反面。
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce } from '../src/workforce.ts';
import type { EmployeeInst } from '../src/workforce.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import { blockerPath } from '../src/comm.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
const CLIENT_CLI = join(import.meta.dir, '..', 'src', 'mcp', 'client-cli.ts');

/** The real `sck call` path: a separate client-cli process writes req/ and reads res/. */
async function relay(comm: Record<string, string>, tool: string, args: Record<string, unknown> = {}) {
  // Spawn asynchronously: the sidecar sweeper lives in this same Bun process, so a blocking
  // spawnSync would prevent it from answering the child client.
  const child = Bun.spawn([process.execPath, CLIENT_CLI, 'call', tool, JSON.stringify(args)], {
    env: { ...process.env, SCK_COMM_DIR: comm.SCK_COMM_DIR!, SCK_COMM_KEY: comm.SCK_COMM_KEY! },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  let answer: { data?: unknown; error?: string } | undefined;
  try { answer = stdout.trim() ? JSON.parse(stdout.trim()) : undefined; } catch { answer = undefined; }
  if (code === 0) return { ok: true, data: answer };
  return { ok: false, error: (typeof answer?.error === 'string' && answer.error) || stderr.trim() || 'real sck client failed' };
}

run('SYS-QUOTA fork: a real sck quota block writes the task row and the provider health, and the provider takes no work until the reset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-fork-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const rootPassword = 'isolated-quota-test-only';
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', rootPassword, '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword, namespace: 'isolated_quota_gate', database: 'control_plane' });
  let pool: SidecarPool | undefined;
  const agentRows = new Map<string, { id: string; status: string }>();
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true); await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db), enrollment = new LocalEnrollmentAdmin(db), owner = new OwnerDesk(db);
    const gm = await enrollment.enroll('fixture-manager', 'gm', ['execute', 'review', 'manage']);
    // 额度下限熔断关掉（quota_floor_pct 0）：本用例证明的是 provider_health 这一条门禁，不是 magpie 的剩余额度熔断。
    // provider_max 每个订阅一个席位：一席在手时新任务只能去另一个订阅，本用例的派工落点是确定的。
    await db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false,
      quota_floor_pct: 0, quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0,
      minFreeMemMb: 0, minFreeDiskMb: 0, artifactReclaimEnabled: false, blockLoopLimit: 0, redispatch_minutes: 15,
      max_running: 4, provider_max: { codex: 1, anthropic: 1 } });
    const wf = new Workforce(db, join(dir, 'unused-credential-files'));
    await wf.upsertDef('fixture-eng-codex', { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 1 });
    // 复核席位与工程同 provider：服务恢复前「所有订阅都不可用」，公司才该压住队列。
    await wf.upsertDef('fixture-qa-codex', { role: 'qa', provider: 'codex', model: 'fixture', maxInstances: 1 });
    const envs = new Map<string, Record<string, string>>();
    const paseo: PaseoGateway = {
      list: async () => agentRows,
      status: async id => agentRows.get(id) ? { status: agentRows.get(id)!.status, pendingPermissions: 0 } : undefined,
      lastError: async () => '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
      spawn: async b => { const id = `agent-${b.labels.employee_id}`; agentRows.set(id, { id, status: 'running' }); envs.set(id, b.env); return id; },
      send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; },
      reload: async id => { agentRows.get(id)!.status = 'idle'; },
      archive: async id => { agentRows.get(id)!.status = 'archived'; pool!.detachAgent(id); },
      listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
    };
    pool = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], runDir: join(dir, 'comm'), sweepMs: 5 });
    // 一个长驻调度器实例（生产里也是一个进程常驻）：pass 之间保留会话状态（lastStatus），
    // 恢复点之后空闲会话才会被认作「从 running 转为 idle」并把 provider 健康改回 healthy。
    const dispatcher = new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool!, rand: () => 0,
      env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
    const taskRow = async (id: string) => (await db.db.query<[{
      state: string; blocked_to?: string; quota_resets_at?: number | null; current_employee?: unknown;
    }]>('SELECT state, blocked_to, quota_resets_at, current_employee FROM ONLY $t;', { t: new RecordId('task', id) }))[0]!;
    const healthRow = async (provider: string) => (await db.db.query<[{ state: string; until?: number; last_error?: string }]>(
      'SELECT state, until, last_error FROM ONLY $p;', { p: new RecordId('provider_health', provider) }))[0];
    /** A task that never declared a reset carries no field at all; `?? null` reads that and an explicit NONE alike. */
    const quotaOf = async (id: string) => (await taskRow(id)).quota_resets_at ?? null;
    /** The fork renders an employee id as a bare uuid, as `employee:⟨uuid⟩`, or as a RecordId; all three must compare with instance ids. */
    const bareId = (value: unknown) => {
      const raw = value instanceof RecordId ? String(value.id) : String(value);
      const id = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
      return id.startsWith('⟨') && id.endsWith('⟩') ? id.slice(1, -1) : id;
    };
    /** Whoever the dispatcher put on this task: their instance and their private comm channel (never a guessed one). */
    const holderOf = async (taskId: string) => {
      const holder = bareId((await taskRow(taskId)).current_employee);
      const inst = (await wf.insts()).find(i => i.id === holder)!;
      expect(inst).toBeDefined();
      return { inst, channel: envs.get(inst.paseoAgentId!)! };
    };
    /** The agent's turn ended: Paseo reports the session idle and the dispatcher may reuse its seat. */
    const idle = (inst: EmployeeInst) => { agentRows.get(inst.paseoAgentId!)!.status = 'idle'; };
    const create = (title: string, key: string) => core.createTask(gm, { title, context: `SYS-QUOTA 隔离用例：${title}`,
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key });

    // ---- 一个真实派工：工程实例被唤醒、sidecar 代领任务
    const task1 = await create('额度阻塞：真实 sck 通道', 'quota-task-1');
    await dispatcher.tick();
    expect(await taskRow(task1.id)).toMatchObject({ state: 'doing' });
    const { inst: codex, channel: codexChannel } = await holderOf(task1.id);
    expect(codex.provider).toBe('codex');
    const resetAt = new Date(Date.now() + 3600_000).toISOString();
    const resetSec = Math.floor(Date.parse(resetAt) / 1000);

    // ---- AC03③：非法值由 core 拒绝、原样回给员工，任务状态不变、一个 provider 行都不写，且租约没被吃掉
    const bad = await relay(codexChannel, 'report_blocker',
      { to: 'gm', text: '订阅额度用尽，但恢复时间写错了，需要按格式重报一次。', idempotencyKey: 'quota-block-bad', quotaResetsAt: '2026-10-24T04:40:00' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toStartWith('invalid:');
    expect(bad.error).toContain('explicit timezone offset');
    expect(await taskRow(task1.id)).toMatchObject({ state: 'doing' });
    expect(await quotaOf(task1.id)).toBeNull();
    expect(await healthRow('codex')).toBeUndefined();

    // ---- AC01/AC03①/AC04：同一租约上改好格式重报，任务行与 provider 健康都要落到员工声明的时刻
    const blocked = await relay(codexChannel, 'report_blocker',
      { to: 'gm', text: '订阅额度用尽：平台说本窗口到点才恢复，先阻塞等恢复。', idempotencyKey: 'quota-block-1', quotaResetsAt: resetAt });
    expect(blocked.ok).toBe(true);
    expect(await taskRow(task1.id)).toMatchObject({ state: 'blocked', blocked_to: 'gm', quota_resets_at: resetSec });
    expect(await healthRow('codex')).toMatchObject({ state: 'exhausted', until: resetSec, last_error: 'quota reset reported by employee' });

    // ---- AC04：恢复点前该 provider 不派工。此时唯一的订阅都耗尽，公司压住队列而不是把活派下去。
    const task2 = await create('额度恢复前的第二个任务', 'quota-task-2');
    const held = await dispatcher.tick();
    expect(held.skipped).toBe('budget');
    expect(await taskRow(task2.id)).toMatchObject({ state: 'ready' });
    expect(await quotaOf(task2.id)).toBeNull();
    expect((await wf.insts()).length).toBe(1);
    // 门禁还在：到点前 provider 行没被动过（不是冷却，是明确的恢复时刻）。
    expect(await healthRow('codex')).toMatchObject({ state: 'exhausted', until: resetSec });

    // ---- AC04：恢复点到了（等价于时间走过去），会话空闲，同一个 provider 重新接活，队列解压
    idle(codex);
    await db.db.query('UPDATE provider_health:codex SET until = 0;');
    const resumed = await dispatcher.tick();
    expect(resumed.skipped).toBeUndefined();
    expect(await taskRow(task2.id)).toMatchObject({ state: 'doing' });
    expect(await healthRow('codex')).toMatchObject({ state: 'healthy' });

    // ---- AC03②：不带 quotaResetsAt 的阻塞不写任何 health，任务列也为空（另一个 provider，保证是「没写」而不是「写回同值」）
    await wf.upsertDef('fixture-eng-other', { role: 'engineering', provider: 'anthropic', model: 'fixture', maxInstances: 1 });
    const task3 = await create('普通阻塞：没有额度恢复时间', 'quota-task-3');
    await dispatcher.tick();
    const { inst: other, channel: otherChannel } = await holderOf(task3.id);
    expect(other.provider).toBe('anthropic');
    const plain = await relay(otherChannel, 'report_blocker',
      { to: 'gm', text: '范围不确定，需要经理定夺，与订阅额度无关，请给个方向。', idempotencyKey: 'quota-block-2' });
    expect(plain.ok).toBe(true);
    expect(await taskRow(task3.id)).toMatchObject({ state: 'blocked', blocked_to: 'gm' });
    expect(await quotaOf(task3.id)).toBeNull();
    expect(await healthRow('anthropic')).toBeUndefined();

    // ---- AC02/AC03④：blocker.md 文件入口与 report_blocker 等价——首行声明恢复时间，落地同一条门禁
    const task5 = await create('文件入口：blocker.md 首行声明恢复时间', 'quota-task-5');
    idle(other);
    await dispatcher.tick();
    const { inst: fileInst, channel: fileChannel } = await holderOf(task5.id);
    const fileReset = new Date(Date.now() + 2 * 3600_000).toISOString();
    writeFileSync(blockerPath(fileChannel.SCK_COMM_DIR!), `quotaResetsAt: ${fileReset}\n\n订阅额度用尽，等这个点之后再继续。`);
    await pool.settle(fileInst.paseoAgentId!);
    expect(await taskRow(task5.id)).toMatchObject({ state: 'blocked', blocked_to: 'gm', quota_resets_at: Math.floor(Date.parse(fileReset) / 1000) });
    expect(await healthRow('anthropic')).toMatchObject({ state: 'exhausted', until: Math.floor(Date.parse(fileReset) / 1000) });

    // ---- AC02：文件入口的非法值同样走拒绝路径（不是静默丢字段）：阻塞不落库、额度列空、该 provider 一个 health 行都没写
    // 另一个订阅（grok）上做这一步：拒绝路径不能把 provider 标脏，这样才能看出「拒绝」与「登记」的差别。
    await wf.upsertDef('fixture-eng-grok', { role: 'engineering', provider: 'grok', model: 'fixture', maxInstances: 1 });
    await db.db.query('UPDATE company_meta:config SET provider_max = { codex: 1, anthropic: 1, grok: 1 };');
    const task6 = await create('文件入口：非法恢复时间被拒绝', 'quota-task-6');
    await dispatcher.tick();
    const { inst: refusedInst, channel: refusedChannel } = await holderOf(task6.id);
    expect(refusedInst.provider).toBe('grok');
    writeFileSync(blockerPath(refusedChannel.SCK_COMM_DIR!), 'quotaResetsAt: 2026-10-24T04:40:00\n\n时间没带时区偏移。');
    await pool.settle(refusedInst.paseoAgentId!);
    expect(await taskRow(task6.id)).toMatchObject({ state: 'doing' });
    expect(await quotaOf(task6.id)).toBeNull();
    expect(await healthRow('grok')).toBeUndefined();
  } finally {
    for (const id of agentRows.keys()) pool?.detachAgent(id);
    pool?.close(); await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
  }
}, 120000);