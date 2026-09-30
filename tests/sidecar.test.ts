import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { commDir, reqDir, resDir, reportPath, blockerPath, readJsonFile } from '../src/comm.ts';
import type { ClaimResult, LeaseProof, TaskView } from '../src/contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../src/workforce.ts';

const taskView = (id: string, version = 1): TaskView => ({
  id, title: `t-${id}`, context: '', state: 'doing', executorRole: 'engineering', reviewerRole: 'qa',
  kind: 'task', dependencies: [], version, fence: 1, deliveryId: `d-${id}`,
});

const claimResult = (taskId: string): ClaimResult => ({
  task: taskView(taskId), deliveryId: `d-${taskId}`, fence: 7, leaseExpiresAt: new Date().toISOString(), history: [],
});

interface Call { tool: string; proof?: LeaseProof; text?: string; to?: string }
const calls: Call[] = [];

let employeeForGetTask = 'eng-x';
const snap = (proof: LeaseProof): LeaseProof => ({ ...proof }); // record a copy; the pool mutates its proof between calls

const core = {
  claim: async (_cred: string, taskId: string) => claimResult(taskId),
  heartbeat: async (_c: string, proof: LeaseProof) => { calls.push({ tool: 'heartbeat', proof: snap(proof) }); return claimResult(proof.taskId); },
  checkpoint: async (_c: string, proof: LeaseProof, ev: { text: string }) => { calls.push({ tool: 'checkpoint', proof: snap(proof), text: ev.text }); return { ...taskView(proof.taskId), version: proof.expectedVersion + 1 }; },
  submit: async (_c: string, proof: LeaseProof, ev: { text: string }) => { calls.push({ tool: 'submit', proof: snap(proof), text: ev.text }); return taskView(proof.taskId); },
  block: async (_c: string, proof: LeaseProof, to: string, ev: { text: string }) => { calls.push({ tool: 'block', proof: snap(proof), to, text: ev.text }); return taskView(proof.taskId); },
  accept: async (_c: string, proof: LeaseProof, ev: { text: string }) => { calls.push({ tool: 'accept', proof: snap(proof), text: ev.text }); return taskView(proof.taskId); },
  returnTask: async (_c: string, proof: LeaseProof, ev: { text: string }) => { calls.push({ tool: 'return', proof: snap(proof), text: ev.text }); return taskView(proof.taskId); },
  authenticate: async () => ({ employeeId: 'eng-x', role: 'engineering', capabilities: ['execute'] as const }),
  companyBrief: async () => ({ ok: true }),
  listTasks: async () => [],
  getTask: async (_c: string, taskId: string) => ({ ...taskView(taskId), currentEmployee: employeeForGetTask }),
  history: async () => [],
  createTask: async () => taskView('new'),
  relayGoal: async () => ({}), triageGoal: async () => ({}), createDelivery: async () => [],
  getSecret: async () => 'v', putSecret: async () => ({ stored: 'x' }),
  relayOwnerDecision: async () => taskView('x'), relayDirection: async () => {},
  resume: async () => taskView('x'), recordScore: async () => ({ recorded: 1, participants: [] }),
  listOutbox: async () => [],
};

const workforce = { rotate: async () => 'tok-rotated' };
const inst = (id: string, extra: Partial<EmployeeInst> = {}): EmployeeInst =>
  ({ id, role: 'engineering', credential: `tok-${id}`, ...extra }) as EmployeeInst;
const task = (id: string): SupervisedTask => ({ id, title: `t-${id}`, state: 'ready', executorRole: 'engineering', row: {} }) as unknown as SupervisedTask;

const until = async (fn: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return; await Bun.sleep(20); }
  throw new Error('condition not met');
};

let runDir: string;
let pool: SidecarPool;
beforeEach(() => {
  calls.length = 0;
  employeeForGetTask = 'eng-x';
  runDir = mkdtempSync(join(tmpdir(), 'sck-sidecar-'));
  pool = new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 10_000, sweepMs: 20 });
});
afterEach(() => { rmSync(runDir, { recursive: true, force: true }); });

describe('sidecar', () => {
  test('env exposes comm channel, never credentials', () => {
    const env = pool.env(inst('e1'));
    expect(env.SCK_COMM_DIR).toBe(join(runDir, 'e1'));
    expect(env.SCK_COMM_KEY?.length).toBe(32);
    expect(Object.keys(env)).not.toContain('SCK_EMPLOYEE_CREDENTIAL');
    expect(existsSync(reqDir(env.SCK_COMM_DIR))).toBe(true);
  });

  test('claim stages claim.json and records the lease proof', async () => {
    const i = inst('e2');
    pool.env(i);
    const result = await pool.claim(i, task('task-1'));
    expect(result?.deliveryId).toBe('d-task-1');
    const staged = JSON.parse(readFileSync(join(runDir, 'e2', 'claim.json'), 'utf8')) as ClaimResult;
    expect(staged.fence).toBe(7);
  });

  test('legacy credential-file instances are never claimed by the sidecar', async () => {
    const i = inst('legacy-1', { credentialFile: '/tmp/x.token', credential: undefined });
    const result = await pool.claim(i, task('task-2'));
    expect(result).toBeUndefined();
    expect(calls.filter(c => c.tool === 'claim')).toHaveLength(0);
  });

  test('relay injects the held lease proof into checkpoint', async () => {
    const i = inst('e3');
    const env = pool.env(i);
    await pool.claim(i, task('task-3'));
    const key = 'req1';
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), `${key}.json`),
      JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'checkpoint', args: { text: 'half done' } }));
    await until(() => existsSync(join(resDir(env.SCK_COMM_DIR), `${key}.json`)));
    const res = readJsonFile<{ ok: boolean; data?: { version: number }; error?: string }>(join(resDir(env.SCK_COMM_DIR), `${key}.json`))!;
    expect(res.ok).toBe(true);
    const call = calls.find(c => c.tool === 'checkpoint')!;
    expect(call.proof).toEqual({ taskId: 'task-3', deliveryId: 'd-task-3', fence: 7, expectedVersion: 1 });
    expect(call.text).toBe('half done');
  });

  test('relay rejects a wrong comm key and claim_next', async () => {
    const i = inst('e4');
    const env = pool.env(i);
    await pool.claim(i, task('task-4'));
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), 'bad.json'),
      JSON.stringify({ key: 'forged', tool: 'checkpoint', args: { text: 'x' } }));
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), 'cn.json'),
      JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'claim_next', args: { taskId: 'task-4' } }));
    await until(() => existsSync(join(resDir(env.SCK_COMM_DIR), 'bad.json')) && existsSync(join(resDir(env.SCK_COMM_DIR), 'cn.json')));
    expect(readJsonFile<{ ok: boolean }>(join(resDir(env.SCK_COMM_DIR), 'bad.json'))!.ok).toBe(false);
    const cn = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR), 'cn.json'))!;
    expect(cn.ok).toBe(false);
    expect(cn.error).toContain('forbidden');
    expect(calls.filter(c => c.tool === 'checkpoint')).toHaveLength(0);
  });

  test('writes without a live lease are refused', async () => {
    const i = inst('e5');
    const env = pool.env(i);
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), 's.json'),
      JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'submit', args: { text: 'done' } }));
    await until(() => existsSync(join(resDir(env.SCK_COMM_DIR), 's.json')));
    const res = readJsonFile<{ ok: boolean; error?: string }>(join(resDir(env.SCK_COMM_DIR), 's.json'))!;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no_lease');
  });

  test('settle submits report.md exactly once', async () => {
    const i = inst('e6');
    const env = pool.env(i);
    await pool.claim(i, task('task-6'));
    pool.bindAgent('e6', 'agent-6');
    writeFileSync(reportPath(env.SCK_COMM_DIR), '交付完成：已验证 a/b/c');
    await pool.settle('agent-6');
    const submits = calls.filter(c => c.tool === 'submit');
    expect(submits).toHaveLength(1);
    expect(submits[0]!.text).toContain('交付完成');
    expect(submits[0]!.proof?.deliveryId).toBe('d-task-6');
    // File was renamed; a second settle cannot resubmit.
    await pool.settle('agent-6');
    expect(calls.filter(c => c.tool === 'submit')).toHaveLength(1);
    expect(readdirSync(env.SCK_COMM_DIR).some(f => f.startsWith('report.md.done-'))).toBe(true);
  });

  test('settle routes blocker.md to gm and consumes the lease', async () => {
    const i = inst('e7');
    const env = pool.env(i);
    await pool.claim(i, task('task-7'));
    pool.bindAgent('e7', 'agent-7');
    writeFileSync(blockerPath(env.SCK_COMM_DIR), '需要经理定夺范围');
    await pool.settle('agent-7');
    const blocks = calls.filter(c => c.tool === 'block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.to).toBe('gm');
    // A later write attempt finds no lease.
    writeFileSync(join(reqDir(env.SCK_COMM_DIR), 'late.json'),
      JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'checkpoint', args: { text: 'x' } }));
    await until(() => existsSync(join(resDir(env.SCK_COMM_DIR), 'late.json')));
    expect(readJsonFile<{ ok: boolean }>(join(resDir(env.SCK_COMM_DIR), 'late.json'))!.ok).toBe(false);
  });

  test('a stale report file present before claim is never submitted', async () => {
    const i = inst('e8');
    const env = pool.env(i);
    writeFileSync(reportPath(env.SCK_COMM_DIR), '上一轮残留的假交付');
    await pool.claim(i, task('task-8'));
    pool.bindAgent('e8', 'agent-8');
    await pool.settle('agent-8');
    expect(calls.filter(c => c.tool === 'submit')).toHaveLength(0);
  });

  test('adopt rebuilds the lease proof for a live comm instance', async () => {
    const fresh = new SidecarPool({ core: core as never, workforce: workforce as never, runDir, heartbeatMs: 10_000, sweepMs: 20 });
    const legacy = inst('old', { credentialFile: '/tmp/x', paseoAgentId: 'a-old', activeTask: 't-x', credential: undefined });
    const live = inst('e9', { paseoAgentId: 'a-9', activeTask: 'task-9', credential: undefined });
    employeeForGetTask = 'e9';
    await fresh.adopt([legacy, live]);
    const envDir = join(runDir, 'e9');
    writeFileSync(reportPath(envDir), '重启后补交');
    await fresh.settle('a-9');
    const submits = calls.filter(c => c.tool === 'submit');
    expect(submits).toHaveLength(1);
    // Proof rebuilt from getTask: deliveryId/fence/version from the task row.
    expect(submits[0]!.proof).toEqual({ taskId: 'task-9', deliveryId: 'd-task-9', fence: 1, expectedVersion: 1 });
  });
});
