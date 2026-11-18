import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AUTO_FOLLOWUP_LIMIT, ExecutionJournal, advancedWorktreeHead, stewardWorkResult, workResult, finalAnswer } from '../src/runner/lifecycle.ts';

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

test('判读器回退：没有首行口令时给出结构化结论，执行轮不能越权 accept，连续自动跟进 3 轮熔断', async () => {
  const base = { task: 'task', employee: 'worker', deliveryId: 'delivery', autoFollowups: 0 };
  // 执行轮答复没写口令：判读器判 submit，自动跟进计 1 轮。
  const submit = await stewardWorkResult('功能已实现并通过本地测试，产物在 src/x.ts。', 'doing', undefined,
    { ...base, resolver: () => ({ action: 'submit', summary: '实现完成并自验' }) });
  expect(submit.via).toBe('steward');
  expect(submit.autoFollowups).toBe(1);
  expect(submit.result.action).toBe('submit');
  expect(submit.result.evidence.text).toContain('实现完成并自验');
  // 判读器不能越过独立复核把执行轮判为 accept。
  await expect(stewardWorkResult('看起来都对了。', 'doing', undefined,
    { ...base, resolver: () => ({ action: 'accept', summary: '直接通过' }) })).rejects.toThrow('越过独立复核');
  // 复核轮没有手写复核结论：判读器可以判 accept。
  const review = await stewardWorkResult('逐条复验均符合验收标准。', 'review', undefined,
    { ...base, resolver: () => ({ action: 'accept', summary: '复验通过' }) });
  expect(review.result.action).toBe('accept');
  // 已经连续自动跟进 3 轮：第 4 轮强制转受阻，不再自动继续。
  const capped = await stewardWorkResult('继续做完了。', 'doing', undefined,
    { ...base, autoFollowups: AUTO_FOLLOWUP_LIMIT, resolver: () => ({ action: 'submit', summary: '又完成一轮' }) });
  expect(capped.result.action).toBe('block');
  expect(capped.result.evidence.text).toContain(`连续自动跟进 ${AUTO_FOLLOWUP_LIMIT} 轮`);
  const cappedWithoutResolverCall = await stewardWorkResult('继续做完了。', 'doing', undefined,
    { ...base, autoFollowups: AUTO_FOLLOWUP_LIMIT, resolver: () => { throw new Error('熔断后不得再调用判读器'); } });
  expect(cappedWithoutResolverCall.result.action).toBe('block');
  const blockedReview = await stewardWorkResult('工作结果：受阻\n缺少验收环境', 'review', undefined,
    { ...base, resolver: () => { throw new Error('明确受阻不需要判读器'); } });
  expect(blockedReview.result.action).toBe('block');
  // 员工手写口令时不计自动跟进，链条清零。
  const written = await stewardWorkResult(`完成。\n提交：${'a'.repeat(40)}`, 'doing', undefined,
    { ...base, autoFollowups: 2, resolver: () => ({ action: 'submit' }) });
  expect(written.via).toBe('written');
  expect(written.autoFollowups).toBe(0);
  expect(written.result.evidence.sha).toBe('a'.repeat(40));
  // 没有判读器：未写口令的复核答复仍按原规则拒绝，不推断结论。
  await expect(stewardWorkResult('看起来不错', 'review', undefined, base)).rejects.toThrow('明确');
});

test('代码回合自动采集任务分支相对基线前进的 HEAD；未前进或分支不符不冒充交付提交', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sck-advance-head-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const probe = async (cmd: string, args: string[], cwd: string) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: String(r.stdout ?? '') };
  };
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'fixture');
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root });
    const base = git('rev-parse', 'HEAD');
    // 远端默认分支指向基线（合成 ref），任务分支从基线出发。
    git('update-ref', 'refs/remotes/origin/main', base);
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git('checkout', '-q', '-b', 'task/abc12345');
    expect(await advancedWorktreeHead(probe, root, 'task/abc12345')).toBeUndefined();
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'advance'], { cwd: root });
    const advanced = git('rev-parse', 'HEAD');
    expect(advanced).not.toBe(base);
    expect(await advancedWorktreeHead(probe, root, 'task/abc12345')).toBe(advanced);
    // 分支不符：不拿别的分支 HEAD 冒充本任务交付。
    expect(await advancedWorktreeHead(probe, root, 'task/other')).toBeUndefined();
    // 基线完全不可判定时不得把任意 HEAD 作为“相对基线前进”的证据。
    git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(await advancedWorktreeHead(probe, root, 'task/abc12345')).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
import { SidecarPool } from '../src/runner/sidecar.ts';
import { settleCompanyTurn, TurnInterruptions } from '../src/runner/turn-closeout.ts';
import { writeFileSync, existsSync } from 'node:fs';
import type { LeaseProof, ClaimResult } from '../src/contracts.ts';
import type { ResultFacts, StewardVerdictResolver } from '../src/runner/lifecycle.ts';

function fixture(readTurnResult?: (agent: string, turn: string) => Promise<string>, verdictResolver?: StewardVerdictResolver) {
  const root = mkdtempSync(join(tmpdir(), 'sck-runner-flow-'));
  const calls: Array<{ action: string; proof: LeaseProof; key: string; text?: string }> = [];
  let delivery = 'delivery-a', version = 2, phase: 'doing' | 'review' = 'doing', submitted = false;
  let fail = false, loseReply = false, failRead = false;
  let refusal: { code: string; message: string; times: number } | undefined;
  let accepted = 0;
  let factsFn: ((taskId: string, employee: string, delivery?: { idempotencyKey: string }) => Promise<ResultFacts>) | undefined;
  let authRefusals = 0;
  let rotateError: Error | undefined;
  // Identity dies after the next committed write: models a worker retired while its reply was in flight.
  let goneAfterCommit = false, gone = false;
  const mirror: Array<{ state: string; error?: string; attempts: number }> = [];
  const inst = { id: 'worker', role: 'engineering' as const, credential: 'synthetic', paseoAgentId: undefined as string | undefined };
  const task = () => ({ id: 'task', state: phase, version, fence: 1, deliveryId: delivery, currentEmployee: 'worker',
    leaseExpiresAt: new Date(Date.now() + 600000).toISOString() });
  const result = () => ({ task: task(), fence: 1, deliveryId: delivery, leaseExpiresAt: task().leaseExpiresAt, history: [] }) as unknown as ClaimResult;
  const committed = new Set<string>();
  const transition = (action: string) => async (_cred: string, proof: LeaseProof, evidence: { idempotencyKey: string; text?: string }) => {
    calls.push({ action, proof: { ...proof }, key: evidence.idempotencyKey, text: evidence.text });
    // The real core authenticates before its idempotent replay, so a retired identity is refused either way.
    if (gone || authRefusals > 0) { if (!gone) authRefusals--; throw Object.assign(new Error('invalid credential'), { code: 'unauthorized' }); }
    if (committed.has(evidence.idempotencyKey)) return task();
    if (action === 'submit' && refusal && refusal.times > 0) { refusal.times--; throw Object.assign(new Error(refusal.message), { code: refusal.code }); }
    if (fail) throw new Error('synthetic network failure');
    if (proof.deliveryId !== delivery || proof.expectedVersion !== version) throw Object.assign(new Error('stale version'), { code: 'conflict' });
    committed.add(evidence.idempotencyKey); submitted = true;
    if (goneAfterCommit) { goneAfterCommit = false; gone = true; }
    if (action === 'submit') accepted++;
    if (loseReply) { loseReply = false; throw new Error('synthetic response lost after commit'); }
    return task();
  };
  const core = { claim: async () => result(), heartbeat: async () => { if (failRead) throw new Error('network'); return result(); },
    getTask: async () => { if (failRead) throw new Error('network'); return task(); },
    activeLeases: async () => submitted ? [] : [{ ...task(), taskId: 'task' }],
    submit: transition('submit'), accept: transition('accept'), returnTask: transition('return'),
    block: (cred: string, proof: LeaseProof, _to: 'owner', evidence: { idempotencyKey: string; text?: string }) => transition('block')(cred, proof, evidence) };
  const workforce = { rotate: async () => { if (gone) { const e = rotateError ?? Object.assign(new Error('Employee retired or revoked'), { code: 'unauthorized' }); throw e; } if (rotateError) throw rotateError; return 'synthetic'; }, insts: async () => [inst] };
  const options = { core: core as never, workforce: workforce as never, runDir: join(root, 'comm'), managedLifecycle: true, readTurnResult, verdictResolver, heartbeatMs: 15,
    resultFacts: async (taskId: string, employee: string, delivery?: { idempotencyKey: string }) => {
      const base = factsFn ? await factsFn(taskId, employee, delivery) : undefined;
      // Like the real store: the idempotency record exists exactly when the write committed.
      return base ? { landed: committed.has(delivery?.idempotencyKey ?? ''), ...base } : undefined;
    },
    executionChanged: async (row: { state: string; error?: string; tries: number }) => { mirror.push({ state: row.state, error: row.error, attempts: row.tries }); } };
  let pool = new SidecarPool(options);
  const event = (turn = 'turn-a', text = '工作已完成，全部只读检查通过，证据已生成。', kind = 'completed') =>
    ({ agent: { id: 'agent' }, turnId: turn, outcome: { kind }, timeline: [{ type: 'assistant_message', text }] });
  const journal = () => new ExecutionJournal(join(root, 'private', 'executions', createHash('sha256').update(options.runDir).digest('hex')));
  return { core, workforce, root, calls, inst, event, journal,
    settle: (value = event(), interruptions?: TurnInterruptions) => settleCompanyTurn({sidecar: pool, workforce} as never, {} as never, value as never, interruptions),
    get pool() { return pool; },
    fail(value: boolean) { fail = value; }, loseReply() { loseReply = true; }, failRead(value: boolean) { failRead = value; },
    refuse(code: string, times: number, message: string) { refusal = { code, message, times }; },
    facts(fn: (taskId: string, employee: string, delivery?: { idempotencyKey: string }) => Promise<ResultFacts>) { factsFn = fn; },
    authFailures(times: number) { authRefusals = times; },
    rotateFails(error: Error) { rotateError = error; },
    /** The next committed write retires this identity: lands the result, then every call is unauthorized. */
    retireAfterCommit() { goneAfterCommit = true; },
    accepted: () => accepted, committed: () => committed, mirror: () => mirror,
    async claim(review = false) { phase = review ? 'review' : 'doing'; pool.env(inst); inst.paseoAgentId = 'agent'; pool.bindAgent(inst.id, 'agent'); await pool.claim(inst, { id: 'task' } as never); },
    async restart() { pool.close(); pool = new SidecarPool(options); await pool.adopt([inst]); },
    async retry() { for (const row of journal().rows()) { row.nextRetry = 0; journal().save(row); } await pool.retryExecutions(); },
    nextVersion() { version++; }, nextDelivery(id = 'delivery-b') { delivery = id; submitted = false; },
    close() { pool.close(); rmSync(root, { recursive: true, force: true }); } };
}
import { createHash } from 'node:crypto';

test('执行端在无手写 SHA 的代码答复中采集真实任务分支 HEAD 并冻结到提交证据', async () => {
  const f = fixture();
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'fixture');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('checkout', '-q', '-b', 'task/abc12345');
    git('commit', '-q', '--allow-empty', '-m', 'implementation');
    const sha = git('rev-parse', 'HEAD');
    const getTask = f.core.getTask;
    f.core.getTask = async () => ({ ...await getTask(), workIntent: { kind: 'code' },
      worktree: { worktreePath: f.root, branch: 'task/abc12345' } });
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    await f.settle(f.event('turn-a', '实现完成并逐条自验，未手写提交行。'));
    expect(f.journal().rows()[0]?.result?.evidence.sha).toBe(sha);
    expect(f.calls.map(call => call.action)).toEqual(['submit']);
  } finally { f.close(); }
});

test('判读器计数跨投递与重启持久化，重复收尾不累加，第四轮不再调用判读器并转交老板', async () => {
  const seen: number[] = [];
  const f = fixture(undefined, input => { seen.push(input.autoFollowups); return { action: 'submit' }; });
  try {
    for (let round = 1; round <= 4; round++) {
      if (round > 1) { f.nextVersion(); f.nextDelivery(`delivery-${round}`); }
      await f.claim(); await f.pool.turnStarted('agent', `turn-${round}`);
      await f.settle(f.event(`turn-${round}`, `完成第 ${round} 轮工作。`));
      await f.settle(f.event(`turn-${round}`, `完成第 ${round} 轮工作。`));
      const row = f.journal().rows().find(row => row.turn === `turn-${round}`)!;
      expect(row.autoFollowups).toBe(round);
      expect(row.result?.action).toBe(round <= 3 ? 'submit' : 'block');
      await f.restart();
    }
    expect(seen).toEqual([0, 1, 2]);
    expect(f.calls.map(call => call.action)).toEqual(['submit', 'submit', 'submit', 'block']);
  } finally { f.close(); }
});

test('执行 agent 不调用命令，最终答复自动送审；重复结束只提交一次', async () => {
  const f = fixture(); try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    expect(f.journal().rows()[0]?.state).toBe('running');
    await f.settle(f.event()); await f.settle(f.event());
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.pool.holdsLease('worker', 'task')).toBe(false);
  } finally { f.close(); }
});
test('复核结果由执行端记录，失败回合即使留下报告也不提交', async () => {
  const f = fixture(); try {
    await f.claim(true); await f.pool.turnStarted('agent', 'turn-a');
    await f.settle(f.event('turn-a', '复核结论：通过\n逐条核对了证据，全部满足标准。'));
    expect(f.calls.map(c => c.action)).toEqual(['accept']);
  } finally { f.close(); }
  const g = fixture(); try {
    await g.claim(); writeFileSync(join(g.pool.commDirFor('worker'), 'report.md'), '尚未完成的草稿，不应提交');
    await g.pool.settleExecution(g.event('turn-a', '暂时完成了部分工作', 'failed'));
    expect(g.calls).toHaveLength(0);
    expect(g.journal().rows()[0]?.state).toBe('interrupted');
  } finally { g.close(); }
});
/**
 * devin-cloud（以及任何云端通道）超时仍受理的受阻回合，在 main.ts 事件映射与 native.ts 的真实
 * parseNativeResult 之后是 outcome.kind:'completed'（tests/cloud-lane.test.ts 的"近真实 main→native
 * 链路验证"已经单独证实这一段，并且明确写了它到此为止、不替 sidecar.ts 的结论背书）。这里接着那段没走到的
 * 下一环：同一个 completed TurnEnded 事件，经真实（未打桩）的 settleExecution → collectExecution →
 * workResult 之后，必须是业务 block（不是静默回合，不是供应商额度或协议故障的记录），且会话地址不丢在评审
 * 证据之外。对照组证明两条路没有被改成同一条：outcome.kind 不是 completed 时仍然按既有行为走静默分支。
 */
test('云端受阻回合（如 devin-cloud 已受理超时）经真实 settleExecution 收尾为 block，不是静默回合也不记供应商故障；对照 outcome 非 completed 仍走静默分支（需求 3：main→native 之后接到真实 sidecar.ts 收尾）', async () => {
  const SESSION = 'https://app.devin.ai/sessions/abcd1234abcd1234abcd1234abcd1234';
  const BLOCKED_TEXT = `工作结果：受阻\nDevin Cloud 会话 ${SESSION} 超过配置时限仍未给出终稿（标记 SCK-abc1234567），会话可能仍在运行；恢复本任务将回到原会话继续等待，不会重发`;
  const f = fixture();
  try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-devin-1');
    const settled = await f.pool.settleExecution(f.event('turn-devin-1', BLOCKED_TEXT, 'completed'));
    // 不是静默回合：有真实的业务结论产出，不是「本回合没有可用产物」。
    expect(settled?.status).not.toBe('silent');
    expect(f.calls.map(c => c.action)).toEqual(['block']);
    expect(f.calls[0]?.text).toContain('超过配置时限仍未给出终稿');
    expect(f.calls[0]?.text).toContain(SESSION);
    const row = f.journal().rows()[0];
    expect(row?.state).toBe('settled');
    expect(row?.result?.action).toBe('block');
    // 不靠供应商额度/协议故障通道记这次受阻：那条通道只由 releaseClaim({ providerFailure }) 显式写入，
    // 这里全程没有调用过它。
    expect(row?.providerFailure).toBeUndefined();
  } finally { f.close(); }

  const g = fixture();
  try {
    await g.claim(); await g.pool.turnStarted('agent', 'turn-devin-2');
    const settled = await g.pool.settleExecution(g.event('turn-devin-2', '页面协议错误：wrong_session，未能确认是否受理', 'failed'));
    expect(settled).toMatchObject({ status: 'silent', silent: { instId: 'worker', taskId: 'task', phase: 'doing' } });
    expect(g.calls).toHaveLength(0);
    const row = g.journal().rows()[0];
    expect(row?.state).toBe('interrupted');
    expect(row?.providerFailure).toBeUndefined();
  } finally { g.close(); }
});
test('网络失败不丢结果不清租约，重启后自动重试，agent 无需补交', async () => {
  const f = fixture(); try {
    await f.claim(); f.fail(true);
    await f.settle(f.event());
    expect(f.pool.holdsLease('worker', 'task')).toBe(true);
    expect(f.journal().rows()[0]?.state).toBe('pending');
    expect(f.pool.hasPendingResult('worker', 'task', 'delivery-a')).toBe(true);
    expect(f.pool.hasPendingResult('worker', 'task', 'other-delivery')).toBe(false);
    expect(f.pool.hasPendingResult('worker', 'other-task', 'delivery-a')).toBe(false);
    await f.restart();
    expect(f.pool.hasPendingResult('worker', 'task', 'delivery-a')).toBe(true);
    f.fail(false); await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.pool.hasPendingResult('worker', 'task', 'delivery-a')).toBe(false);
    expect(f.calls[0]?.key).toBe(f.calls[1]?.key);
  } finally { f.close(); }
});
test('提交已成功但回复丢失：重启后重放原请求，不重复变更任务', async () => {
  const f = fixture(); try {
    await f.claim(); f.loseReply(); await f.settle(f.event());
    await f.restart(); await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.calls).toHaveLength(2); expect(f.calls[0]).toEqual(f.calls[1]);
  } finally { f.close(); }
});
test('明确的版本冲突由执行端刷新 proof 后补交', async () => {
  const f = fixture(); try {
    await f.claim(); f.nextVersion(); await f.settle(f.event()); await f.retry();
    expect(f.calls.map(c => c.proof.expectedVersion)).toEqual([2, 3]);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});
test('旧回合重复结束不会提交新批次，新的回合必须匹配', async () => {
  const f = fixture(); try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a'); await f.settle(f.event());
    f.nextDelivery(); await f.claim(); await f.pool.turnStarted('agent', 'turn-b');
    await f.settle(f.event()); await f.settle(f.event('late-unknown'));
    expect(f.calls).toHaveLength(1); expect(f.pool.holdsLease('worker', 'task')).toBe(true);
    await f.settle(f.event('turn-b')); expect(f.calls).toHaveLength(2);
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
    await f.settle(f.event());
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});


test('恢复旧批次 collecting 不消费新任务产物，也不提交新租约', async () => {
  const f = fixture(); try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    const old = f.journal().rows()[0]!;
    old.state = 'collecting'; old.finalText = '旧任务只读核对结果已完成，等待执行端收尾。'; old.turns.push('turn-a'); f.journal().save(old);
    f.nextDelivery(); await f.claim(); await f.pool.turnStarted('agent', 'turn-b');
    writeFileSync(join(f.pool.commDirFor('worker'), 'result.json'), JSON.stringify({summary:'新任务仍在执行的草稿',outcome:'blocked'}));
    await f.retry();
    expect(f.calls.map(c => [c.action, c.proof.deliveryId])).toEqual([['submit', 'delivery-a']]);
    expect(f.journal().read('worker','delivery-a')?.state).toBe('superseded');
    expect(f.journal().read('worker','delivery-b')?.state).toBe('running');
    expect(f.pool.holdsLease('worker','task')).toBe(true);
  } finally { f.close(); }
});
test('重复结束恢复同一 collecting 快照，不重新读取被覆盖的文件', async () => {
  const f = fixture(); try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    const row = f.journal().rows()[0]!;
    row.state = 'collecting'; row.turns.push('turn-a');
    row.artifacts = {raw: JSON.stringify({summary:'已完成真实工作检查，成果已经持久保存。'})}; f.journal().save(row);
    writeFileSync(join(f.pool.commDirFor('worker'), 'result.json'), 'invalid');
    await f.settle(f.event()); await f.retry();
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});


test('宿主结束事件没有正文时按回合读取，短暂读取失败后仍自动提交', async () => {
  let available = false;
  const f = fixture(async (agent, turn) => { expect([agent,turn]).toEqual(['agent','turn-a']); if (!available) throw new Error('history unavailable'); return '真实会话最终成果已读取，计算与验证均已完成。'; });
  try {
    await f.claim(); await f.pool.turnStarted('agent','turn-a');
    await f.pool.settleExecution({...f.event(),timeline:[]});
    expect(f.calls).toHaveLength(0);expect(f.journal().rows()[0]?.state).toBe('collecting');
    expect(f.pool.hasPendingResult('worker', 'task', 'delivery-a')).toBe(true);
    await f.restart();
    expect(f.pool.hasPendingResult('worker', 'task', 'delivery-a')).toBe(true);
    available = true;await f.retry();
    expect(f.calls.map(c=>c.action)).toEqual(['submit']);expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});
test('取不到最终答复时有限次读取，窗口耗尽后以可恢复受阻提交，不推断成功', async () => {
  let reads = 0;
  const f = fixture(async () => { reads++; throw new RuntimeResultError('not_yet_available', 'runtime final result not yet available'); });
  try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    await f.pool.settleExecution({ ...f.event(), timeline: [] });
    const firstDelay = (f.journal().rows()[0]?.nextRetry ?? 0) - Date.now();
    expect(firstDelay).toBeGreaterThan(9000);
    expect(firstDelay).toBeLessThanOrEqual(10000);
    for (let i = 0; i < 5; i++) await f.pool.settleExecution({ ...f.event(), timeline: [] });
    expect(reads).toBe(1);
    for (let i = 0; i < 10; i++) await f.retry();
    await f.restart();
    for (let i = 0; i < 8; i++) await f.retry();
    expect(reads).toBe(19);
    expect(f.journal().rows()[0]?.state).toBe('collecting');
    expect(f.calls).toHaveLength(0);
    await f.retry();
    expect(reads).toBe(20);
    expect(f.calls.map(c => c.action)).toEqual(['block']);
    expect(f.calls[0]?.text).toContain('连续 20 次');
    expect(f.calls[0]?.text).toContain('runtime_result_unavailable:not_yet_available');
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.pool.holdsLease('worker', 'task')).toBe(false);
    await f.retry();
    expect(reads).toBe(20);
    expect(f.calls.map(c => c.action)).toEqual(['block']);
  } finally { f.close(); }
});
test('最终答复迟到几轮后仍按正常结果自动提交，不因前几次读取失败而阻塞', async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    if (reads < 6) throw new RuntimeResultError('not_yet_available', 'runtime final result not yet available');
    return '迟到的最终成果已可读取，验证全部通过。';
  });
  try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    await f.pool.settleExecution({ ...f.event(), timeline: [] });
    for (let i = 0; i < 5; i++) await f.retry();
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.calls[0]?.text).toContain('迟到的最终成果');
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});
test('受阻结果提交失败时保留同一幂等键，恢复后重放，不重复变更任务', async () => {
  const f = fixture(async () => { throw new RuntimeResultError('timeline_unavailable', 'runtime timeline unavailable'); });
  try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    f.fail(true);
    await f.pool.settleExecution({ ...f.event(), timeline: [] });
    for (let i = 0; i < 19; i++) await f.retry();
    // The failed write is replayed once in the same attempt before judging: two calls, one frozen key, zero commits.
    expect(f.calls.map(c => c.action)).toEqual(['block', 'block']);
    expect(f.committed().size).toBe(0);
    expect(f.journal().rows()[0]?.state).toBe('pending');
    f.fail(false); await f.retry();
    expect(f.calls.map(c => c.action)).toEqual(['block', 'block', 'block']);
    expect(f.calls[1]?.key).toBe(f.calls[0]?.key);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});
import { readTurnResult, RuntimeResultError } from '../src/runner/turn-result.ts';
test('宿主读取只接受目标回合的最终答复，不串新回合也不把进度当成果', async () => {
  const host = (entries: unknown[]) => ({agents:{ref:()=>({timeline:{refetch:async()=>({epoch:'e',hasOlder:false,entries})}})}}) as never;
  expect(await readTurnResult(host([
    {turnId:'a',seqEnd:2,item:{type:'assistant_message',text:'正确成果'}},
    {turnId:'b',seqEnd:3,item:{type:'assistant_message',text:'另一个任务'}}
  ]),'agent','a')).toBe('正确成果');
  await expect(readTurnResult(host([{turnId:'b',seqEnd:1,item:{type:'assistant_message',text:'旧结果'}}]),'agent','a')).rejects.toThrow('unavailable');
  await expect(readTurnResult(host([{turnId:'a',seqEnd:1,item:{type:'assistant_message',text:'正在检查'}},{turnId:'a',seqEnd:2,item:{type:'tool_call'}}]),'agent','a')).rejects.toThrow('not yet');
});
test('投影中工具条目晚于最终答复结束时，仍按首次出现的位置读取答复；答复之后新开的工具仍视为未完成', async () => {
  const host = (entries: unknown[]) => ({agents:{ref:()=>({timeline:{refetch:async()=>({epoch:'e',hasOlder:false,entries})}})}}) as never;
  // Paseo keeps a tool call at its first position (seqStart); a later completion only moves seqEnd past the answer.
  expect(await readTurnResult(host([
    {turnId:'a',seqStart:1,seqEnd:5,item:{type:'tool_call'}},
    {turnId:'a',seqStart:3,seqEnd:4,item:{type:'assistant_message',text:'全部检查已通过'}},
  ]),'agent','a')).toBe('全部检查已通过');
  await expect(readTurnResult(host([
    {turnId:'a',seqStart:3,seqEnd:4,item:{type:'assistant_message',text:'正在检查'}},
    {turnId:'a',seqStart:5,seqEnd:6,item:{type:'tool_call'}},
  ]),'agent','a')).rejects.toMatchObject({ reason: 'not_yet_available' });
});


test('Paseo 重开会话复用回合编号，新派工仍记录启动并自动收尾', async () => {
  const f = fixture();try {
    await f.claim();await f.pool.turnStarted('agent','turn-a');await f.settle(f.event());
    f.nextDelivery();await f.claim();
    await f.settle(f.event()); // duplicate from old delivery before any new start
    expect(f.calls).toHaveLength(1);
    await f.pool.turnStarted('agent','turn-a');
    expect(f.journal().read('worker','delivery-b')?.state).toBe('running');
    await f.settle(f.event());
    expect(f.calls.map(c=>c.proof.deliveryId)).toEqual(['delivery-a','delivery-b']);
  } finally {f.close();}
});
test('相同宿主回合号使用启动时间隔离，运行中事件不能提前送审', async () => {
  const base={epoch:'e',hasOlder:false,entries:[{timestamp:'2026-11-10T08:00:00Z',turnId:'turn-1',seqEnd:1,item:{type:'assistant_message',text:'旧轮成果'}}]};
  const host=(page:unknown)=>({agents:{ref:()=>({timeline:{refetch:async()=>page}})}}) as never;
  await expect(readTurnResult(host(base),'agent','turn-1',Date.parse('2026-11-10T09:00:00Z'))).rejects.toThrow('unavailable');
  await expect(readTurnResult(host({...base,agent:{status:'running'}}),'agent','turn-1')).rejects.toThrow('still active');
});

test('取消后同批次重开复用回合号，新的启动可以正常完成', async () => {
  const f=fixture(), interruptions = new TurnInterruptions();try {
    await f.claim();await f.pool.turnStarted('agent','turn-a');await f.settle(f.event('turn-a','部分进度','canceled'), interruptions);
    await f.pool.turnStarted('agent','turn-a');expect(f.journal().rows()[0]?.state).toBe('running');
    await f.settle(f.event());expect(f.calls.map(c=>c.action)).toEqual(['submit']);
  }finally{interruptions.stop();f.close();}
});


test('同毫秒重开同号回合与重复启动事件：只为每个实际启动收尾一次', async () => {
  const f = fixture(), interruptions = new TurnInterruptions();
  const now = Date.now;
  try {
    Date.now = () => 1800000000000;
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    await f.settle(f.event('turn-a', '部分进度', 'canceled'), interruptions);
    await f.pool.turnStarted('agent', 'turn-a');
    const key = f.pool.turnCloseoutKey('agent', 'turn-a');
    await f.pool.turnStarted('agent', 'turn-a');
    expect(f.pool.turnCloseoutKey('agent', 'turn-a')).toBe(key);
    await Promise.all([f.settle(), f.settle()]);
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { Date.now = now; interruptions.stop(); f.close(); }
});

test('明确供应商失败先保存预算；保存失败保留租约，同回合重试可继续收尾且不调用模型', async () => {
  const f = fixture();
  const actions: string[] = [];
  let failBudget = true;
  Object.assign(f.inst, { provider:'codex' });
  Object.assign(f.workforce, {
    markExhausted: async()=>{}, refundQuotaWake:async()=>{},
    recordProviderFailure: async(_employee:string,proof:LeaseProof)=>{
      expect(proof.deliveryId).toBe('delivery-a'); actions.push('budget');
      if(failBudget)throw new Error('synthetic budget write failure');
    },
  });
  Object.assign(f.core,{release:async()=>{actions.push('release');}});
  try {
    await f.claim(); await f.pool.turnStarted('agent','turn-a');
    const event={...f.event(),outcome:{kind:'failed',error:{message:'503 service unavailable'}},timeline:[]};
    await expect(f.settle(event as never)).rejects.toThrow('budget write failure');
    expect(actions).toEqual(['budget']);
    expect(f.journal().rows()[0]?.state).toBe('interrupted');
    expect(f.pool.hasPendingResult('worker','task','delivery-a')).toBe(true);
    await f.restart();
    expect(f.pool.hasPendingResult('worker','task','delivery-a')).toBe(true);
    failBudget=false;
    await f.retry();
    expect(actions).toEqual(['budget','budget','release']);
    expect(f.pool.hasPendingResult('worker','task','delivery-a')).toBe(false);
    await f.settle(event as never);
    expect(actions).toEqual(['budget','budget','release']);
  } finally { f.close(); }
});

const CI_WAIT = 'submit sha 0123456789012345678901234567890123456789: CI 尚未成功，GitHub Actions run 完成后自动接续送审';
test('CI 排队或运行中：成果保持待收尾，不计失败次数、不 block；CI 成功后同一成果恰好送审一次', async () => {
  const f = fixture(); try {
    await f.claim(); f.refuse('ci_pending', 13, CI_WAIT);
    await f.settle(f.event());
    for (let i = 0; i < 12; i++) await f.retry();
    const row = f.journal().rows()[0]!;
    expect(row.state).toBe('pending'); expect(row.tries).toBe(0); expect(row.error).toBe('ci_pending');
    expect(f.pool.holdsLease('worker', 'task')).toBe(true);
    expect(f.mirror().at(-1)).toEqual({ state: 'pending', error: 'ci_pending', attempts: 0 });
    expect(f.calls.map(c => c.action)).toEqual(Array(13).fill('submit'));
    expect(f.accepted()).toBe(0);
    await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.accepted()).toBe(1);
    expect(f.calls.map(c => c.action)).toEqual(Array(14).fill('submit'));
    expect(new Set(f.calls.map(c => c.key)).size).toBe(1);
    expect(f.pool.holdsLease('worker', 'task')).toBe(false);
    expect(f.mirror().at(-1)?.error).toBeUndefined();
  } finally { f.close(); }
});
test('最终答复迟到后再等待 CI：重启不重读结果、不额外消耗重试、同一成果只送审一次', async () => {
  let reads = 0;
  const f = fixture(async () => {
    if (++reads < 3) throw new Error('result not yet visible');
    return '工作已完成，延迟取回的完整成果与验证证据保持不变。';
  });
  try {
    await f.claim(); await f.pool.turnStarted('agent', 'turn-a');
    f.refuse('ci_pending', 3, CI_WAIT);
    await f.settle(f.event('turn-a', ''));
    await f.retry(); await f.retry();
    const row = f.journal().rows()[0]!;
    expect(row.state).toBe('pending'); expect(row.error).toBe('ci_pending'); expect(row.tries).toBe(2);
    await f.restart(); await f.retry(); await f.retry(); await f.retry();
    expect(reads).toBe(3);
    expect(f.accepted()).toBe(1);
    expect(f.calls.map(call => call.action)).toEqual(Array(4).fill('submit'));
    expect(new Set(f.calls.map(call => call.key)).size).toBe(1);
    expect(new Set(f.calls.map(call => call.text)).size).toBe(1);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});

test('CI 等待期间执行端重启：从执行批次恢复等待，CI 成功后仍只送审一次', async () => {
  const f = fixture(); try {
    await f.claim(); f.refuse('ci_pending', 1, CI_WAIT);
    await f.settle(f.event());
    await f.restart();
    expect(f.pool.hasPendingResult('worker', 'task', 'delivery-a')).toBe(true);
    await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.accepted()).toBe(1);
    expect(f.calls.map(c => c.action)).toEqual(['submit', 'submit']);
  } finally { f.close(); }
});
test('CI 等待期间任务版本被推进：刷新 proof 后同一成果补交一次，不重新唤醒', async () => {
  const f = fixture(); try {
    await f.claim(); f.refuse('ci_pending', 1, CI_WAIT);
    await f.settle(f.event()); f.nextVersion();
    await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('pending');
    await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.accepted()).toBe(1);
    expect(f.calls.map(c => c.proof.expectedVersion)).toEqual([2, 2, 3]);
  } finally { f.close(); }
});
test('CI 等待期间租约已转给别人：不再等待也不提交，成果标记为已被接手', async () => {
  const f = fixture(); try {
    await f.claim(); f.refuse('ci_pending', 1000, CI_WAIT);
    await f.settle(f.event());
    f.nextDelivery();
    await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('superseded');
    // One more attempt reaches core before the ownership read; core's lease check refuses it, so nothing is committed.
    expect(f.calls.map(c => c.action)).toEqual(['submit', 'submit']);
    expect(f.accepted()).toBe(0);
    await f.retry();
    expect(f.calls).toHaveLength(2);
  } finally { f.close(); }
});
test('CI 等待超过上限仍无成功运行：明确 block 并写明等待超时，不再无限重试', async () => {
  const f = fixture(); try {
    await f.claim(); f.refuse('ci_pending', 1000, CI_WAIT);
    await f.settle(f.event());
    const row = f.journal().rows()[0]!;
    row.ciWaitSince = Date.now() - 7 * 3_600_000; f.journal().save(row);
    await f.retry();
    const waiting = f.journal().rows()[0]!;
    expect(waiting.result?.action).toBe('block');
    expect(waiting.result?.evidence.text).toContain('CI 等待超时');
    expect(waiting.originalResult?.action).toBe('submit');
    await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.calls.map(c => c.action)).toEqual(['submit', 'submit', 'block']);
    expect(f.accepted()).toBe(0);
  } finally { f.close(); }
});
test('CI 真正失败：不等待、不无限重试，立即 block 并写明 CI 失败原因', async () => {
  const f = fixture(); try {
    await f.claim(); f.refuse('ci_failed', 1000, 'submit sha 0123456789012345678901234567890123456789: CI 失败，没有成功的 GitHub Actions run');
    await f.settle(f.event());
    expect(f.journal().rows()[0]?.result?.action).toBe('block');
    expect(f.journal().rows()[0]?.error).toBe('ci_failed');
    await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.calls.map(c => c.action)).toEqual(['submit', 'block']);
    expect(f.accepted()).toBe(0);
  } finally { f.close(); }
});
test('确定性非法成果仍有界重试，阻塞说明写入真实拒绝原因', async () => {
  const f = fixture(); try {
    await f.claim(); f.refuse('invalid', 1000, 'submit sha 0123456789012345678901234567890123456789: 环境不符');
    await f.settle(f.event());
    let attempts = 1;
    while (f.journal().rows()[0]?.result?.action !== 'block' && attempts < 20) { await f.retry(); attempts++; }
    expect(attempts).toBe(10);
    expect(f.journal().rows()[0]?.result?.evidence.text).toContain('环境不符');
    await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.accepted()).toBe(0);
  } finally { f.close(); }
});
const CURRENT_FACTS: ResultFacts = { task: { state: 'doing', currentEmployee: 'worker', deliveryId: 'delivery-a', fence: 1 }, employee: { retired: false, revoked: false } };
test('旧员工已退休且任务已完成：旧结果终态 superseded，保留原成果与拒收信息，不再重放', async () => {
  const f = fixture(); try {
    f.facts(async () => ({ task: { state: 'done' }, employee: { retired: true, revoked: true } }));
    f.authFailures(1000);
    f.rotateFails(Object.assign(new Error('Employee retired or revoked'), { code: 'unauthorized' }));
    await f.claim(); await f.settle(f.event());
    const row = f.journal().rows()[0]!;
    expect(row.state).toBe('superseded');
    expect(row.supersededCause).toBe('task_finished');
    expect(row.error).toBe('superseded:task_finished');
    expect(row.result?.action).toBe('submit');
    expect(row.result?.evidence.text).toContain('工作已完成');
    expect(row.lastRefusal).toBe('Employee retired or revoked');
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.pool.holdsLease('worker', 'task')).toBe(false);
    await f.retry(); await f.retry();
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    await f.restart(); await f.retry();
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.journal().rows()[0]?.state).toBe('superseded');
  } finally { f.close(); }
});
test('活租约的暂时 unauthorized 可恢复：轮换凭证后同一成果只送审一次', async () => {
  const f = fixture(); try {
    f.facts(async () => CURRENT_FACTS);
    f.authFailures(1);
    await f.claim(); await f.settle(f.event());
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.accepted()).toBe(1);
    expect(f.calls.map(c => c.action)).toEqual(['submit', 'submit']);
    expect(new Set(f.calls.map(c => c.key)).size).toBe(1);
    expect(f.journal().rows()[0]?.supersededCause).toBeUndefined();
  } finally { f.close(); }
});
test('事实暂时读不到或网络失败不误判成果无效：结果保留并继续重试到成功', async () => {
  const f = fixture(); try {
    f.facts(async () => { throw new Error('database unavailable'); });
    f.fail(true);
    await f.claim(); await f.settle(f.event());
    expect(f.journal().rows()[0]?.state).toBe('pending');
    expect(f.journal().rows()[0]?.result?.action).toBe('submit');
    expect(f.mirror().at(-1)).toEqual({ state: 'pending', error: 'unavailable', attempts: 1 });
    f.fail(false); await f.retry();
    expect(f.journal().rows()[0]?.state).toBe('settled');
    expect(f.accepted()).toBe(1);
  } finally { f.close(); }
});
test('新租约或新 fence 取代旧投递：旧结果标记 superseded，不再重复 submit 或 block', async () => {
  const f = fixture(); try {
    f.facts(async () => ({ task: { state: 'doing', currentEmployee: 'other', deliveryId: 'delivery-b', fence: 2 }, employee: { retired: false } }));
    f.refuse('conflict', 1000, 'stale lease or version');
    await f.claim(); await f.settle(f.event());
    const row = f.journal().rows()[0]!;
    expect(row.state).toBe('superseded');
    expect(row.supersededCause).toBe('lease_replaced');
    expect(row.result?.action).toBe('submit');
    expect(row.lastRefusal).toBe('stale lease or version');
    await f.retry(); await f.retry();
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
    expect(f.accepted()).toBe(0);
  } finally { f.close(); }
});
test('员工身份已退休或撤销：终态 superseded(employee_gone)，记录死因后停止重试', async () => {
  const f = fixture(); try {
    f.facts(async () => ({ task: { state: 'doing', currentEmployee: 'worker', deliveryId: 'delivery-a', fence: 1 }, employee: { retired: true } }));
    f.authFailures(1000);
    f.rotateFails(Object.assign(new Error('Employee retired or revoked'), { code: 'unauthorized' }));
    await f.claim(); await f.settle(f.event());
    const row = f.journal().rows()[0]!;
    expect(row.state).toBe('superseded');
    expect(row.supersededCause).toBe('employee_gone');
    expect(row.lastRefusal).toBe('Employee retired or revoked');
    expect(row.supersededAt).toBeGreaterThan(0);
    await f.retry();
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
  } finally { f.close(); }
});
test('提交已落库但回复丢失：同键重放确认交付后结算，核心只记一次提交，不判 superseded', async () => {
  const f = fixture(); try {
    // Facts describe the post-submit world: the task moved to review and cleared the lease fields.
    f.facts(async () => ({ task: { state: 'review' }, employee: { retired: false, revoked: false } }));
    await f.claim(); f.loseReply(); await f.settle(f.event());
    const row = f.journal().rows()[0]!;
    expect(row.state).toBe('settled');
    expect(row.supersededCause).toBeUndefined();
    expect(row.error).toBeUndefined();
    expect(f.calls.map(c => c.action)).toEqual(['submit', 'submit']);
    expect(new Set(f.calls.map(c => c.key)).size).toBe(1);
    expect(f.committed().size).toBe(1);
    await f.retry(); await f.restart(); await f.retry();
    expect(f.calls).toHaveLength(2);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});
test('复核通过已落库但回复丢失：accept 同键重放结算，不判 task_finished', async () => {
  const f = fixture(); try {
    f.facts(async () => ({ task: { state: 'done' }, employee: { retired: false, revoked: false } }));
    await f.claim(true); f.loseReply();
    await f.settle(f.event('turn-a', '复核结论：通过\n已独立核对全部验收要求，成果与证据一致。'));
    const row = f.journal().rows()[0]!;
    expect(row.state).toBe('settled');
    expect(row.supersededCause).toBeUndefined();
    expect(f.calls.map(c => c.action)).toEqual(['accept', 'accept']);
    expect(new Set(f.calls.map(c => c.key)).size).toBe(1);
    expect(f.committed().size).toBe(1);
    await f.retry();
    expect(f.calls).toHaveLength(2);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});
test('成果落库后员工才退休且回复丢失：权威幂等记录确认已交付，结算而不判 employee_gone', async () => {
  const f = fixture(); try {
    f.facts(async () => ({ task: { state: 'done' }, employee: { retired: true, revoked: true } }));
    await f.claim(); f.loseReply(); f.retireAfterCommit();
    await f.settle(f.event());
    const row = f.journal().rows()[0]!;
    expect(row.state).toBe('settled');
    expect(row.supersededCause).toBeUndefined();
    expect(row.error).toBeUndefined();
    expect(row.lastRefusal).toBe('Employee retired or revoked');
    expect(f.calls.map(c => c.action)).toEqual(['submit', 'submit']);
    expect(f.committed().size).toBe(1);
    await f.retry(); await f.restart(); await f.retry();
    expect(f.calls).toHaveLength(2);
    expect(f.journal().rows()[0]?.state).toBe('settled');
  } finally { f.close(); }
});
test('重启后通道被隔离的旧结果仍按权威事实终态记录，不会永远停在 pending', async () => {
  const f = fixture(); try {
    f.authFailures(1000);
    f.rotateFails(Object.assign(new Error('Employee retired or revoked'), { code: 'unauthorized' }));
    await f.claim(); await f.settle(f.event());
    expect(f.journal().rows()[0]?.state).toBe('pending');
    f.facts(async () => ({ task: { state: 'void' }, employee: { retired: true } }));
    await f.restart();
    await f.retry();
    const row = f.journal().rows()[0]!;
    expect(row.state).toBe('superseded');
    expect(row.supersededCause).toBe('task_finished');
    expect(row.result?.action).toBe('submit');
    expect(f.calls.map(c => c.action)).toEqual(['submit']);
  } finally { f.close(); }
});
