import { expect, test } from 'bun:test';
import { staffingPool, type StaffingInput } from '../src/dispatcher/dispatcher.ts';
import { BLOCK_TEXT, evaluateDispatch, holderLabel, type EvaluatedEntry } from '../src/dispatcher/dispatch-blocked.ts';
import type { EmployeeDef, EmployeeInst, ProviderHealth } from '../src/workforce.ts';
import type { WriteScopeHolder } from '../src/contracts.ts';

// SYS-DISP f2f16a69 R1/R2/R3: write-scope verdicts, provider cooldown recovery times, probe wording, repo names in seat text.
const OPS = '/ops/repo';
const NOW = 1_000; // server seconds: the clock the tick and the provider cooldowns share
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const def = (id: string, over: Partial<EmployeeDef> = {}): EmployeeDef =>
  ({ id, role: 'engineering', provider: 'codex', model: 'm1', enabled: true, maxInstances: 2,
    priority: 100, weight: 10, scored: 0, errorStreak: 0, ...over });
const inst = (id: string, over: Partial<EmployeeInst> = {}): EmployeeInst =>
  ({ id, role: 'engineering', def: 'd1', provider: 'codex', model: 'm1', paseoAgentId: `ag-${id}`, ...over });
const base = (over: Partial<StaffingInput> = {}): StaffingInput => ({
  role: 'engineering', home: OPS,
  defs: [], insts: [], states: new Map(), holding: new Set(),
  health: new Map(), quotaBlocked: new Map(), busyBy: new Map(),
  providerMax: { codex: 3 }, slots: new Map(), opsRepo: OPS, sidecar: true,
  now: NOW, ...over,
});
const cooldown = (until: number, provider = 'codex'): ProviderHealth => ({ provider, state: 'exhausted', until, failures: 1 });
/** The same pool entries feed the verdict, so the roster preview and the tick cannot disagree. */
const verdictOf = (entries: ReturnType<typeof staffingPool>) => evaluateDispatch({
  taskId: 't1', title: 'Task', phase: 'execute', role: 'engineering', home: OPS,
  entries: entries.map((e): EvaluatedEntry => ({ key: e.key, eligible: e.eligible, code: e.code, until: e.until })),
  checkedAt: NOW * 1000,
});
const holder: WriteScopeHolder = { taskId: '0f9c1e2a-7b3d-4e5f-8a9b-1c2d3e4f5a6b', employee: 'employee-7', intent: 'code' };

test('write scope: a same-lane writer is a gm reason that names its holder and waits, never wake_failed', () => {
  const verdict = evaluateDispatch({ taskId: 't1', title: 'Task', phase: 'execute', role: 'engineering', home: OPS,
    globalBlocks: [{ code: 'write_scope', text: BLOCK_TEXT.write_scope, candidates: [holderLabel(holder)] }], checkedAt: NOW * 1000 });
  expect(verdict.dispatchable).toBe(false);
  expect(verdict.feasible).toBe(true);
  expect(verdict.reasons).toEqual([expect.objectContaining({ code: 'write_scope', owner: 'gm', basis: 'tick:worktree-scope', candidates: ['任务 0f9c1e2a · employee-7'] })]);
  const [reason] = verdict.reasons;
  expect(reason!.text).toContain('同线或重叠目录');
  expect(reason!.recovery).toBe('等待同线或重叠目录的在办写者结束，或经理拆线');
  expect(reason!.nextTrigger).toBe('同线或重叠目录的在办写者结束，或经理拆线');
  expect(reason!.actions).toEqual([expect.objectContaining({ authority: 'gm', executable: false })]);
  expect(reason!.text).not.toBe(BLOCK_TEXT.wake_failed);
});

test('holder label: a read session has no task, and a writer names its task by the first eight characters', () => {
  expect(holderLabel(holder)).toBe('任务 0f9c1e2a · employee-7');
  expect(holderLabel({ employee: 'employee-2', intent: 'read' })).toBe('读取会话 · employee-2');
});

test('cooldown: a provider in health cooldown is quota with its recovery time, never concurrency-full', () => {
  const until = NOW + 600;
  const entries = staffingPool(base({ defs: [def('d1')], insts: [inst('i1')], states: new Map([['i1', 'idle']]),
    health: new Map([['codex', cooldown(until)]]) }));
  const verdict = verdictOf(entries);
  expect(verdict.reasons.map(r => r.code)).toEqual(['quota']);
  expect(verdict.reasons[0]!.until).toBe(iso(until));
  expect(verdict.reasons[0]!.text).toContain(`恢复时间 ${iso(until)}`);
  expect(verdict.reasons[0]!.text).not.toContain('并发已满');
  expect(entries.every(e => e.code === 'quota' && e.until === iso(until))).toBe(true);
});

test('cooldown: an exhausted session under the same cooldown is quota with the same recovery time', () => {
  const until = NOW + 300;
  const entries = staffingPool(base({ defs: [def('d1')], insts: [inst('i1')], states: new Map([['i1', 'exhausted']]),
    health: new Map([['codex', cooldown(until)]]) }));
  const reuse = entries.find(e => e.kind === 'reuse')!;
  expect(reuse.code).toBe('quota');
  expect(reuse.until).toBe(iso(until));
});

test('quota: a percent-only floor has no recovery time, so the owner reads 恢复时间未知 and no time is invented', () => {
  const entries = staffingPool(base({ defs: [def('d1')], insts: [inst('i1')], states: new Map([['i1', 'idle']]),
    quotaBlocked: new Map([['codex', '额度不足（短窗口/余额 3%<5%）']]) }));
  const verdict = verdictOf(entries);
  expect(verdict.reasons.map(r => r.code)).toEqual(['quota']);
  expect(verdict.reasons[0]!.until).toBeUndefined();
  expect(verdict.reasons[0]!.text).toContain('恢复时间未知');
  expect(verdict.reasons[0]!.text).not.toContain('并发已满');
});

test('quota: one candidate without a recovery time makes the whole reason unknown, never the earliest known time', () => {
  const entries = staffingPool(base({ defs: [def('d1'), def('d2', { provider: 'devin', model: 'm2' })], insts: [inst('i1')],
    states: new Map([['i1', 'idle']]), health: new Map([['codex', cooldown(NOW + 600)]]),
    quotaBlocked: new Map([['devin', '额度不足（周/月额度 1%<2%）']]), providerMax: { codex: 3, devin: 3 } }));
  const verdict = verdictOf(entries);
  expect(verdict.reasons.map(r => r.code)).toEqual(['quota']);
  expect(verdict.reasons[0]!.until).toBeUndefined();
  expect(verdict.reasons[0]!.text).toContain('恢复时间未知');
});

test('probe: a trial session still running after the cooldown is probe_busy, never concurrency-full or a recovery time', () => {
  const entries = staffingPool(base({ defs: [def('d1')], insts: [inst('i1')], states: new Map([['i1', 'idle']]),
    health: new Map([['codex', cooldown(NOW - 60)]]), busyBy: new Map([['codex', 1]]) }));
  const verdict = verdictOf(entries);
  expect(verdict.reasons.map(r => r.code)).toEqual(['probe_busy']);
  expect(verdict.reasons[0]!.text).toContain('单次探测会话占用中');
  expect(verdict.reasons[0]!.text).not.toContain('恢复时间');
  expect(verdict.reasons[0]!.text).not.toContain('并发已满');
  expect(verdict.reasons[0]!.until).toBeUndefined();
});

test('concurrency: a full subscription keeps the plain concurrency text', () => {
  const entries = staffingPool(base({ defs: [def('d1')], insts: [inst('i1')], states: new Map([['i1', 'idle']]),
    busyBy: new Map([['codex', 3]]) }));
  const verdict = verdictOf(entries);
  expect(verdict.reasons.map(r => r.code)).toEqual(['provider_capacity']);
  expect(verdict.reasons[0]!.text).toBe(BLOCK_TEXT.provider_capacity);
});

test('seat: a full seat names the repo it counts, in the pool entry and in the verdict', () => {
  const entries = staffingPool(base({ defs: [def('d1', { maxInstances: 1 })], insts: [inst('i1')], states: new Map([['i1', 'busy']]) }));
  const spawn = entries.find(e => e.kind === 'spawn')!;
  expect(spawn.code).toBe('seat_full');
  expect(spawn.reason).toBe('编制席位已满（1/1 个实例，仓库 repo）');
  expect(verdictOf(entries).reasons.find(r => r.code === 'seat_full')!.text).toContain('仓库 repo');
});
