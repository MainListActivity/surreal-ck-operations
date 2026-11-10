import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionJournal, workResult, finalAnswer } from '../src/runner/lifecycle.ts';

test('工作结论不等于任务完成，复核只接受显式业务结论', () => {
  expect(workResult('完成了功能并通过了本地测试', 'doing').action).toBe('submit');
  expect(workResult('复核结论：通过\n逐项复验全部符合要求', 'review').action).toBe('accept');
  expect(workResult('复核结论：退回\n第一条验收未满足', 'review').action).toBe('return');
  expect(workResult('工作结果：受阻\n缺少已授权的测试账号', 'doing').action).toBe('block');
  expect(() => workResult('用户希望通过审核，尚未测试', 'review')).toThrow('明确');
  expect(() => workResult('', 'doing')).toThrow('没有工作结果');
});
test('结构化结果只接收业务字段，不能伪造身份、租约或幂等键', () => {
  const result = workResult('', 'doing', { summary: '合成测试工作成果', task: 'other', proof: {}, idempotencyKey: 'forged', sha: 'a'.repeat(40) });
  expect(result.evidence).toEqual({ text: '执行端自动收集的工作结果：\n合成测试工作成果', sha: 'a'.repeat(40) });
});
test('只采集最后一条助手结果，不把工具输出或推理当成产物', () => {
  expect(finalAnswer({ timeline: [{ type: 'assistant_message', text: '进度' }, { type: 'tool_result', text: '通过' },
    { type: 'assistant_message', text: '最终结果' }, { type: 'reasoning', text: '内部推理' }] } as never)).toBe('最终结果');
});
test('执行批次与结果重启后保持，重放使用同一幂等键', () => {
  const root = mkdtempSync(join(tmpdir(), 'sck-lifecycle-'));
  try {
    const journal = new ExecutionJournal(root);
    const row = journal.reserve('employee', 'doing', { taskId: 'task', deliveryId: 'delivery', fence: 2, expectedVersion: 4 });
    row.state = 'pending'; row.result = workResult('完整的工作成果，等待程序自动送审', 'doing'); journal.save(row);
    const restarted = new ExecutionJournal(root), restored = restarted.reserve('employee', 'doing', row.proof);
    expect(restored.state).toBe('pending'); expect(restarted.evidence(restored)).toEqual(journal.evidence(row));
    expect(restarted.rows()).toHaveLength(1);
    expect(restarted.reserve('employee', 'review', { ...row.proof, deliveryId: 'new' }).result).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { SidecarPool } from '../src/runner/sidecar.ts';
import { writeFileSync, existsSync } from 'node:fs';
import type { LeaseProof, ClaimResult } from '../src/contracts.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sck-runner-flow-'));
  const calls: Array<{ action: string; proof: LeaseProof; key: string }> = [];
  let delivery = 'delivery-a', version = 2, phase: 'doing' | 'review' = 'doing', submitted = false;
  let fail = false, loseReply = false, failRead = false;
  const inst = { id: 'worker', role: 'engineering' as const, credential: 'synthetic', paseoAgentId: undefined as string | undefined };
  const task = () => ({ id: 'task', state: phase, version, fence: 1, deliveryId: delivery, currentEmployee: 'worker',
    leaseExpiresAt: new Date(Date.now() + 600000).toISOString() });
  const result = () => ({ task: task(), fence: 1, deliveryId: delivery, leaseExpiresAt: task().leaseExpiresAt, history: [] }) as unknown as ClaimResult;
  const committed = new Set<string>();
  const transition = (action: string) => async (_cred: string, proof: LeaseProof, evidence: { idempotencyKey: string }) => {
    calls.push({ action, proof: { ...proof }, key: evidence.idempotencyKey });
    if (committed.has(evidence.idempotencyKey)) return task();
    if (fail) throw new Error('synthetic network failure');
    if (proof.deliveryId !== delivery || proof.expectedVersion !== version) throw Object.assign(new Error('stale version'), { code: 'conflict' });
    committed.add(evidence.idempotencyKey); submitted = true;
    if (loseReply) { loseReply = false; throw new Error('synthetic response lost after commit'); }
    return task();
  };
  const core = { claim: async () => result(), heartbeat: async () => { if (failRead) throw new Error('network'); return result(); },
    getTask: async () => { if (failRead) throw new Error('network'); return task(); },
    activeLeases: async () => submitted ? [] : [{ ...task(), taskId: 'task' }],
    submit: transition('submit'), accept: transition('accept'), returnTask: transition('return'), block: transition('block') };
  const workforce = { rotate: async () => 'synthetic', insts: async () => [inst] };
  const options = { core: core as never, workforce: workforce as never, runDir: join(root, 'comm'), managedLifecycle: true, heartbeatMs: 15 };
  let pool = new SidecarPool(options);
  const event = (turn = 'turn-a', text = '工作已完成，全部只读检查通过，证据已生成。', kind = 'completed') =>
    ({ agent: { id: 'agent' }, turnId: turn, outcome: { kind }, timeline: [{ type: 'assistant_message', text }] });
  const journal = () => new ExecutionJournal(join(root, 'private', 'executions', createHash('sha256').update(options.runDir).digest('hex')));
  return { root, calls, inst, event, journal, get pool() { return pool; },
    fail(value: boolean) { fail = value; }, loseReply() { loseReply = true; }, failRead(value: boolean) { failRead = value; },
    async claim(review = false) { phase = review ? 'review' : 'doing'; pool.env(inst); inst.paseoAgentId = 'agent'; pool.bindAgent(inst.id, 'agent'); await pool.claim(inst, { id: 'task' } as never); },
    async restart() { pool.close(); pool = new SidecarPool(options); await pool.adopt([inst]); },
    async retry() { for (const row of journal().rows()) { row.nextRetry = 0; journal().save(row); } await pool.retryExecutions(); },
    nextVersion() { version++; }, nextDelivery() { delivery = 'delivery-b'; submitted = false; },
    close() { pool.close(); rmSync(root, { recursive: true, force: true }); } };
}
import { createHash } from 'node:crypto';

test('执行 agent 不调用命令，最终答复自动送审；重复结束只提交一次', async () => {
  const f = fixture(); try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    expect(f.journal().rows()[0]?.state).toBe('running');
    await f.pool.settleExecution(f.event()); await f.pool.settleExecution(f.event());
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.pool.holdsLease('worker', 'task')).toBe(false);
  } finally { f.close(); }
});
test('复核结果由执行端记录，失败回合即使留下报告也不提交', async () => {
  const f = fixture(); try {
    await f.claim(true); await f.pool.turnStarted('agent', 'turn-a');
    await f.pool.settleExecution(f.event('turn-a', '复核结论：通过\n逐条核对了证据，全部满足标准。'));
    expect(f.calls.map(c => c.action)).toEqual(['accept']);
  } finally { f.close(); }
  const g = fixture(); try {
    await g.claim(); writeFileSync(join(g.pool.commDirFor('worker'), 'report.md'), '尚未完成的草稿，不应提交');
    await g.pool.settleExecution(g.event('turn-a', '暂时完成了部分工作', 'failed'));
    expect(g.calls).toHaveLength(0);
    expect(g.journal().rows()[0]?.state).toBe('interrupted');
  } finally { g.close(); }
});
test('网络失败不丢结果不清租约，重启后自动重试，agent 无需补交', async () => {
  const f = fixture(); try {
    await f.claim(); f.fail(true);
    await f.pool.settleExecution(f.event());
    expect(f.pool.holdsLease('worker', 'task')).toBe(true);
    expect(f.journal().rows()[0]?.state).toBe('pending');
    await f.restart(); f.fail(false); await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.calls[0]?.key).toBe(f.calls[1]?.key);
  } finally { f.close(); }
});
test('提交已成功但回复丢失：重启后重放原请求，不重复变更任务', async () => {
  const f = fixture(); try {
    await f.claim(); f.loseReply(); await f.pool.settleExecution(f.event());
    await f.restart(); await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.calls).toHaveLength(2); expect(f.calls[0]).toEqual(f.calls[1]);
  } finally { f.close(); }
});
test('明确的版本冲突由执行端刷新 proof 后补交', async () => {
  const f = fixture(); try {
    await f.claim(); f.nextVersion(); await f.pool.settleExecution(f.event()); await f.retry();
    expect(f.calls.map(c => c.proof.expectedVersion)).toEqual([2, 3]);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});
test('旧回合重复结束不会提交新批次，新的回合必须匹配', async () => {
  const f = fixture(); try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a'); await f.pool.settleExecution(f.event());
    f.nextDelivery(); await f.claim(); await f.pool.turnStarted('agent', 'turn-b');
    await f.pool.settleExecution(f.event()); await f.pool.settleExecution(f.event('late-unknown'));
    expect(f.calls).toHaveLength(1); expect(f.pool.holdsLease('worker', 'task')).toBe(true);
    await f.pool.settleExecution(f.event('turn-b')); expect(f.calls).toHaveLength(2);
  } finally { f.close(); }
});
test('心跳与复查同时暂时不可用，不把本地 claim 当作失效删除', async () => {
  const f = fixture(); try {
    await f.claim(); f.failRead(true); await Bun.sleep(55);
    expect(f.pool.holdsLease('worker', 'task')).toBe(true);
    expect(existsSync(join(f.pool.commDirFor('worker'), 'claim.json'))).toBe(true);
  } finally { f.close(); }
});

test('新一轮无结果时不能拿历史答复送审', () => {
  expect(finalAnswer({ timeline: [{ type: 'assistant_message', text: '上一轮完成' }, { type: 'user_message', text: '新的要求' }] } as never)).toBe('');
});

test('本地 claim 丢失仍保存并提交结束结果，不要求 agent 补交', async () => {
  const f = fixture(); try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    f.pool.dropLease('worker', 'task');
    await f.pool.settleExecution(f.event());
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});
