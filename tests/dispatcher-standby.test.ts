import { expect, test } from 'bun:test';
import { fixture } from './dispatcher-manager-routing.test.ts';
import type { SidecarBridge } from '../src/dispatcher/dispatcher.ts';

// FV06 P0 ①–⑦：真实 Dispatcher.tick + 内存 doubles（与 dispatcher-manager-routing 同一 fixture）。
// now 在 fixture 里固定为 1_000_000（unix 秒）。
const NOW = 1_000_000;

interface StandbyOpts {
  holder?: string;
  standbyUntil?: number;
  leaseExpiresAt?: number;
  progressAt?: number;
  status?: string;
  worktree?: boolean;
}

/** 把 fixture 里的一条任务行改成 doing+有主持有（可带 standby 标记），并让持有会话处于给定状态。 */
function doingHeld(f: ReturnType<typeof fixture>, taskId: string, opts: StandbyOpts = {}) {
  const row = f.rows.find(r => r.id === taskId)!;
  row.state = 'doing';
  row.currentEmployee = opts.holder ?? 'eng-1';
  row.leaseExpiresAt = opts.leaseExpiresAt ?? NOW + 600;
  row.progressAt = opts.progressAt ?? NOW - 30;
  row.standbyUntil = opts.standbyUntil;
  const raw = row.row as unknown as Record<string, unknown>;
  raw.current_employee = row.currentEmployee;
  raw.lease_expires_at = row.leaseExpiresAt;
  raw.progress_at = row.progressAt;
  raw.standby_until = row.standbyUntil;
  if (opts.worktree !== false) raw.worktree = { id: `wt-${taskId}`, repo: '/fixture/ops', worktreePath: '/fixture/ops-sck-x',
    mode: 'exclusive', branch: `task/${taskId.slice(0, 8)}`, intent: { kind: 'code' }, discipline: '仅在本任务分支 commit/push。' };
  if (opts.status) f.setStatus(`agent-${row.currentEmployee}`, opts.status);
  return row;
}

/** 记录型 workforce 附加层：捕获 revokeLease/standbyTimeout/extendLease 调用。 */
function spies(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const calls = { revokeLease: [] as unknown[][], standbyTimeout: [] as unknown[][], extendLease: [] as unknown[][] };
  const wrapped = {
    revokeLease: async (...args: unknown[]) => { calls.revokeLease.push(args); return true; },
    standbyTimeout: async (...args: unknown[]) => { calls.standbyTimeout.push(args); return true; },
    extendLease: async (...args: unknown[]) => { calls.extendLease.push(args); return true; },
  };
  const wf = { ...(f.wf as unknown as Record<string, unknown>), ...wrapped, ...overrides };
  return { calls, wf };
}

/** 带 adoptLease/dropLease 观察点的完整 sidecar 桥（其余方法与 routing fixture 同形）。 */
function sidecarSpy() {
  const calls = { adoptLease: [] as string[], dropLease: [] as string[] };
  const bridge = {
    env: () => ({ SCK_COMM_DIR: '/tmp/x', SCK_COMM_KEY: 'k' }),
    canReuse: () => true,
    detachAgent: () => {},
    claim: async () => undefined,
    writeScope: async () => [],
    claimDenial: () => undefined,
    bindAgent: () => {},
    commDirFor: () => '/tmp/comm',
    scratchDirFor: (instId: string) => `/tmp/${instId}-scratch`,
    releaseClaim: async () => {},
    releaseWorkspace: async () => {},
    adoptLease: async (inst: { id: string }) => { calls.adoptLease.push(inst.id); },
    dropLease: (instId: string) => { calls.dropLease.push(instId); },
  };
  return { calls, bridge };
}

test('① idle standby holder is woken in place (adopt + dispatch prompt), throttled to one wake per 60s', async () => {
  const f = fixture([{ id: 'sb-idle', state: 'ready', repoPath: '/fixture/ops' }]);
  doingHeld(f, 'sb-idle', { standbyUntil: NOW + 300, status: 'idle' });
  const sc = sidecarSpy();
  const report = await f.tick({ sidecar: { ...sc.bridge } as unknown as SidecarBridge });
  const wakes = f.sends.filter(s => s.prompt.includes('【派工】任务 sb-idle'));
  expect(wakes).toHaveLength(1);
  expect(sc.calls.adoptLease).toEqual(['eng-1']);
  expect(wakes[0]!.prompt).toContain('已领取给你，本轮执行');
  expect(wakes[0]!.prompt).toContain('登记工作区：/fixture/ops-sck-x');
  expect(report.revoked).not.toContain('sb-idle');
  // 60s 节流：同一秒内再 tick 不再唤醒
  await f.tick({ sidecar: { ...sc.bridge } as unknown as SidecarBridge });
  expect(f.sends.filter(s => s.prompt.includes('【派工】任务 sb-idle'))).toHaveLength(1);
  expect(sc.calls.adoptLease).toEqual(['eng-1']);
});

test('② standby waives the expired/stall reclaim before standby_until; an ordinary idle holder is still reclaimed (对照)', async () => {
  const f = fixture([
    { id: 'sb-waived', state: 'ready', repoPath: '/fixture/ops' },
    { id: 'ctrl-expired', state: 'ready', repoPath: '/fixture/ops' },
  ]);
  // 待命任务：租约已过期 + progress 长期停滞，但 standby_until 未到 → 不收回
  doingHeld(f, 'sb-waived', { standbyUntil: NOW + 300, leaseExpiresAt: NOW - 5, progressAt: NOW - 3600 });
  // 对照任务：同样的租约过期，无 standby 标记 → 收回
  doingHeld(f, 'ctrl-expired', { leaseExpiresAt: NOW - 5 });
  const { calls, wf } = spies(f);
  await f.tick({ workforce: wf as never });
  expect(calls.revokeLease.map(args => args[0])).toEqual(['ctrl-expired']);
  expect(calls.standbyTimeout).toHaveLength(0);
});

test('③ past standby_until the task returns to the gm gate: standbyTimeout (not revokeLease), lease dropped', async () => {
  const f = fixture([{ id: 'sb-timeout', state: 'ready', repoPath: '/fixture/ops' }]);
  doingHeld(f, 'sb-timeout', { standbyUntil: NOW - 10, status: 'idle', worktree: false });
  const sc = sidecarSpy();
  const { calls, wf } = spies(f);
  const report = await f.tick({ workforce: wf as never, sidecar: { ...sc.bridge } as unknown as SidecarBridge });
  expect(calls.standbyTimeout).toHaveLength(1);
  expect(calls.standbyTimeout[0]![0]).toBe('sb-timeout');
  expect(calls.standbyTimeout[0]![1]).toBe('eng-1');
  expect(String(calls.standbyTimeout[0]![2])).toContain('standby_until');
  expect(calls.revokeLease).toHaveLength(0);
  expect(report.revoked).toContain('sb-timeout');
  expect(sc.calls.dropLease).toContain('eng-1');
  // 超时路径不再发派工提示
  expect(f.sends.filter(s => s.prompt.includes('sb-timeout'))).toHaveLength(0);
});

test('④ a closed standby holder goes through the existing resumeClosed path (reload + hold prompt), no standby wake', async () => {
  const f = fixture([{ id: 'sb-closed', state: 'ready', repoPath: '/fixture/ops' }]);
  doingHeld(f, 'sb-closed', { standbyUntil: NOW + 300, status: 'closed', worktree: false });
  const sc = sidecarSpy();
  await f.tick({ sidecar: { ...sc.bridge } as unknown as SidecarBridge });
  // resumeClosed 在会话循环里 reload + 发续作提示；不进 standby 唤醒分支
  expect(f.sends.filter(s => s.prompt.includes('公司服务重启打断了你上一轮的工作'))).toHaveLength(1);
  expect(f.sends.filter(s => s.prompt.includes('【派工】任务 sb-closed'))).toHaveLength(0);
  expect(sc.calls.adoptLease).toHaveLength(0);
});

test('⑤ a busy standby holder keeps the ordinary renewal branch: extendLease, no wake, no timeout', async () => {
  const f = fixture([{ id: 'sb-busy', state: 'ready', repoPath: '/fixture/ops' }]);
  doingHeld(f, 'sb-busy', { standbyUntil: NOW + 300, leaseExpiresAt: NOW + 100, status: 'running', worktree: false });
  const sc = sidecarSpy();
  const { calls, wf } = spies(f);
  await f.tick({ workforce: wf as never, sidecar: { ...sc.bridge } as unknown as SidecarBridge });
  expect(calls.extendLease).toHaveLength(1);
  expect(calls.extendLease[0]![0]).toBe('sb-busy');
  expect(calls.standbyTimeout).toHaveLength(0);
  expect(sc.calls.adoptLease).toHaveLength(0);
  expect(f.sends.filter(s => s.prompt.includes('sb-busy'))).toHaveLength(0);
});

test('⑥ regression: a standby-less held task keeps every ordinary branch (idle hold, then expired reclaim)', async () => {
  const f = fixture([{ id: 'plain-idle', state: 'ready', repoPath: '/fixture/ops' }]);
  doingHeld(f, 'plain-idle', { status: 'idle', worktree: false }); // idle + 未停滞 + 租约未过期 → 无动作
  const { calls, wf } = spies(f);
  await f.tick({ workforce: wf as never });
  expect(calls.revokeLease).toHaveLength(0);
  expect(calls.standbyTimeout).toHaveLength(0);
  // 过期即收回（旧行为，原因带「过期」）
  doingHeld(f, 'plain-idle', { leaseExpiresAt: NOW - 5 });
  await f.tick({ workforce: wf as never });
  expect(calls.revokeLease).toHaveLength(1);
  expect(String(calls.revokeLease[0]![2])).toContain('过期');
});

test('⑦ a doing standby task with a holder never re-enters the dispatch pool (原子性：无 ready 无主中间态)', async () => {
  const f = fixture([{ id: 'sb-atomic', state: 'ready', repoPath: '/fixture/ops' }]);
  doingHeld(f, 'sb-atomic', { standbyUntil: NOW + 300, status: 'idle' });
  const result = await f.tick();
  expect(result.woke.filter(w => w.task === 'sb-atomic')).toHaveLength(0);
  expect(f.notices.has('dispatch-blocked:sb-atomic:execute')).toBe(false);
  // 唯一动作是 standby 唤醒
  expect(f.sends.filter(s => s.prompt.includes('sb-atomic'))).toHaveLength(1);
});

test('⑧ state gate: a review-state task with a stale marker gets no wake and no standbyTimeout（复核租约不受旧 deadline 管辖）', async () => {
  const f = fixture([{ id: 'sb-review', state: 'ready', repoPath: '/fixture/ops' }]);
  doingHeld(f, 'sb-review', { standbyUntil: NOW - 10, status: 'idle', worktree: false });
  // submit 之后：state=review，持有人未变（租约未清的间隙）
  const row = f.rows.find(r => r.id === 'sb-review')!;
  row.state = 'review';
  const sc = sidecarSpy();
  const { calls, wf } = spies(f);
  await f.tick({ workforce: wf as never, sidecar: { ...sc.bridge } as unknown as SidecarBridge });
  expect(sc.calls.adoptLease).toHaveLength(0);
  expect(calls.standbyTimeout).toHaveLength(0);
  expect(calls.revokeLease).toHaveLength(0);
  expect(f.sends.filter(s => s.prompt.includes('sb-review'))).toHaveLength(0);
});

test('⑨ state gate: a ready-state task with a residual marker follows the ordinary rules（收回后的残留标记不再触发超时回关口）', async () => {
  const f = fixture([{ id: 'sb-residual', state: 'ready', repoPath: '/fixture/ops' }]);
  doingHeld(f, 'sb-residual', { standbyUntil: NOW - 10, status: 'idle', worktree: false });
  // revokeLease 之后：state=ready 无主——残留标记由普通派工接管
  const row = f.rows.find(r => r.id === 'sb-residual')!;
  row.state = 'ready';
  row.currentEmployee = undefined;
  const raw = row.row as unknown as Record<string, unknown>;
  delete raw.current_employee;
  const { calls, wf } = spies(f);
  const result = await f.tick({ workforce: wf as never });
  expect(calls.standbyTimeout).toHaveLength(0);
  // 无主 ready 任务走普通规则：实现人未定 → 经理接管待办（绝不是 standbyTimeout）
  expect(result.woke.find(w => w.task === 'sb-residual')?.employee.startsWith('gm-')).toBe(true);
});
