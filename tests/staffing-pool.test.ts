import { expect, test } from 'bun:test';
import { quotaBlockedProviders, staffingPool, type StaffingInput } from '../src/dispatcher/dispatcher.ts';
import type { CompanyConfig, EmployeeDef, EmployeeInst } from '../src/workforce.ts';
import type { ProviderQuota } from '../src/contracts.ts';

const OPS = '/ops/repo';
const PRODUCT = '/product/repo';

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
  now: 1_000_000, ...over,
});

test('pool: reuse instance gets def effective weight and normalized share', () => {
  const d = def('d1', { weight: 10, avgScore: 4.5 });   // factor 1.5 → effective 15
  const i = inst('i1');
  const entries = staffingPool(base({ defs: [d], insts: [i], states: new Map([['i1', 'idle']]) }));
  const reuse = entries.find(e => e.kind === 'reuse')!;
  const spawn = entries.find(e => e.kind === 'spawn')!;
  expect(reuse.weight).toBeCloseTo(15);
  expect(reuse.eligible).toBe(true);
  expect(spawn.eligible).toBe(true);
  // 15 / (15 + 15) = 0.5 each
  expect(reuse.share).toBeCloseTo(0.5);
  expect(spawn.share).toBeCloseTo(0.5);
});

test('pool: busy / holding / legacy instances are ineligible with reasons', () => {
  const d = def('d1');
  const busy = inst('i1');
  const held = inst('i2');
  const legacy = inst('i3', { credentialFile: '/cred/i3.json' });
  const entries = staffingPool(base({
    defs: [d], insts: [busy, held, legacy],
    states: new Map([['i1', 'busy'], ['i2', 'idle'], ['i3', 'idle']]),
    holding: new Set(['i2']),
  }));
  const by = new Map(entries.filter(e => e.kind === 'reuse').map(e => [e.ref, e]));
  expect(by.get('i1')!.reason).toBe('会话占用中/异常');
  expect(by.get('i2')!.reason).toBe('持有在办任务');
  expect(by.get('i3')!.reason).toBe('凭证文件实例不可接新任务');
});

test('pool: legacy instance does not consume a maxInstances seat in sidecar mode', () => {
  const d = def('d1', { maxInstances: 1 });
  const legacy = inst('i1', { credentialFile: '/cred/i1.json' });
  const pool = staffingPool(base({ defs: [d], insts: [legacy], states: new Map([['i1', 'idle']]) }));
  const spawn = pool.find(e => e.kind === 'spawn')!;
  expect(spawn.eligible).toBe(true);   // seat free despite the live legacy inst
  // Non-sidecar mode: the same inst would consume the seat.
  const pool2 = staffingPool(base({ defs: [d], insts: [legacy], states: new Map([['i1', 'idle']]), sidecar: false }));
  expect(pool2.find(e => e.kind === 'spawn')!.reason).toBe('实例数 1/1 已满');
});

test('pool: model drift and unresolved slots are ineligible', () => {
  const auto = def('dAuto', { provider: 'devin', model: 'auto:fast' });
  const drifted = inst('i2', { def: 'dAuto', provider: 'devin', model: 'old-model' });
  const pool = staffingPool(base({
    defs: [auto], insts: [drifted],
    states: new Map([['i2', 'idle']]),
    providerMax: { codex: 3, devin: 2 },
    slots: new Map([['devin:fast', 'devin-new']]),
  }));
  expect(pool.find(e => e.kind === 'reuse')!.reason).toBe('模型槽位已漂移');
  expect(pool.find(e => e.kind === 'spawn')!.model).toBe('devin-new');
  // Slot missing → spawn entry ineligible.
  const noSlot = staffingPool(base({ defs: [auto], insts: [], providerMax: { devin: 2 } }));
  expect(noSlot.find(e => e.kind === 'spawn')!.reason).toBe('模型槽位未解析');
});

test('pool: provider capacity and quota block both reuse and spawn', () => {
  const d = def('d1');
  const i = inst('i1');
  const full = staffingPool(base({ defs: [d], insts: [i],
    states: new Map([['i1', 'idle']]), providerMax: { codex: 1 }, busyBy: new Map([['codex', 1]]) }));
  expect(full.every(e => e.reason === 'provider 无可用容量')).toBe(true);
  // Quota circuit-break reports the quota reason itself, not the generic capacity one.
  const quota = staffingPool(base({ defs: [d], insts: [i],
    states: new Map([['i1', 'idle']]), quotaBlocked: new Map([['codex', '额度不足（周/月额度 0%<2%）']]) }));
  expect(quota.every(e => e.reason === '额度不足（周/月额度 0%<2%）')).toBe(true);
});

test('pool: exhausted inst is reusable only while the provider is in probe window', () => {
  const d = def('d1');
  const i = inst('i1');
  const exhausted = new Map([['codex', { provider: 'codex', state: 'exhausted' as const, until: 2_000_000, failures: 1 }]]);
  const cooling = staffingPool(base({ defs: [d], insts: [i], states: new Map([['i1', 'exhausted']]), health: exhausted }));
  expect(cooling.find(e => e.kind === 'reuse')!.eligible).toBe(false);
  const probing = staffingPool(base({ defs: [d], insts: [i], states: new Map([['i1', 'exhausted']]),
    health: new Map([['codex', { provider: 'codex', state: 'exhausted' as const, until: 999_999, failures: 1 }]]) }));
  expect(probing.find(e => e.kind === 'reuse')!.eligible).toBe(true);
});

test('pool: submitter excluded only for review work', () => {
  const d = def('d1');
  const i = inst('i1');
  const task = { submittedBy: 'i1' } as StaffingInput['task'];
  const review = staffingPool(base({ defs: [d], insts: [i], states: new Map([['i1', 'idle']]), task, excludeSubmitter: true }));
  expect(review.find(e => e.kind === 'reuse')!.reason).toBe('提交者回避');
  const impl = staffingPool(base({ defs: [d], insts: [i], states: new Map([['i1', 'idle']]), task }));
  expect(impl.find(e => e.kind === 'reuse')!.eligible).toBe(true);
});

test('pool: review recuses every task contributor, including an author who is not the submitter', () => {
  const d = def('d1');
  const author = inst('eng-author');   // 写过实现（audit 有 claim），但提交字段在换人续办后指向别人
  const fresh = inst('eng-fresh');
  const task = { submittedBy: 'eng-rework' } as StaffingInput['task'];
  const pool = staffingPool(base({
    defs: [d], insts: [author, fresh],
    states: new Map([['eng-author', 'idle'], ['eng-fresh', 'idle']]),
    task, excludeSubmitter: true,
    contributors: new Set(['eng-author', 'eng-rework']),
  }));
  const by = new Map(pool.filter(e => e.kind === 'reuse').map(e => [e.ref, e]));
  expect(by.get('eng-author')!.eligible).toBe(false);
  expect(by.get('eng-author')!.reason).toBe('任务贡献者回避');
  expect(by.get('eng-fresh')!.eligible).toBe(true);
});

test('pool: without a contributor set (execute path or read failure) recusal is unchanged', () => {
  const d = def('d1');
  const author = inst('eng-author');
  const task = { submittedBy: 'eng-author' } as StaffingInput['task'];
  // 执行派工：不带 contributors，贡献者不回避（previousEmployee 连续性保留）。
  const impl = staffingPool(base({ defs: [d], insts: [author], states: new Map([['eng-author', 'idle']]), task }));
  expect(impl.find(e => e.kind === 'reuse')!.eligible).toBe(true);
  // review 且贡献者读取失败（空集）：提交者仍由 excludeSubmitter 兜底拦住。
  const review = staffingPool(base({
    defs: [d], insts: [author], states: new Map([['eng-author', 'idle']]),
    task, excludeSubmitter: true, contributors: new Set<string>(),
  }));
  expect(review.find(e => e.kind === 'reuse')!.reason).toBe('提交者回避');
});

test('pool: scope is per role+home; other homes/roles do not appear', () => {
  const dOps = def('d1');
  const iOps = inst('i1');                                     // cwd undefined → opsRepo
  const iProd = inst('i2', { cwd: PRODUCT });
  const pool = staffingPool(base({ defs: [dOps], insts: [iOps, iProd], states: new Map([['i1', 'idle'], ['i2', 'idle']]) }));
  expect(pool.filter(e => e.kind === 'reuse').map(e => e.ref)).toEqual(['i1']);
  const gm = staffingPool(base({ role: 'gm', defs: [dOps], insts: [iOps], states: new Map([['i1', 'idle']]) }));
  expect(gm).toEqual([]);
});

test('pool: zero-weight candidates are eligible but get share 0', () => {
  const heavy = def('d1', { weight: 10 });
  const zero = def('d2', { weight: 0 });
  const entries = staffingPool(base({ defs: [heavy, zero] }));
  const z = entries.find(e => e.ref === 'd2')!;
  expect(z.eligible).toBe(true);
  expect(z.share).toBe(0);
  expect(entries.find(e => e.ref === 'd1')!.share).toBe(1);
});

test('quotaBlockedProviders: split-window floors and stale fail-open', () => {
  const cfg: Pick<CompanyConfig, 'quotaFloorPct' | 'quotaWeeklyFloorPct'> = { quotaFloorPct: 8, quotaWeeklyFloorPct: 2 };
  const fresh = new Date().toISOString();
  const quota = (over: Partial<ProviderQuota>): ProviderQuota => ({ provider: 'x', summary: '', fetchedAt: fresh, ...over });
  const blocked = quotaBlockedProviders([
    quota({ provider: 'low-session', sessionPct: 3, weeklyPct: 50 }),
    quota({ provider: 'low-week', sessionPct: 50, weeklyPct: 1 }),
    quota({ provider: 'fine', sessionPct: 50, weeklyPct: 50 }),
    quota({ provider: 'stale', sessionPct: 0, weeklyPct: 0, fetchedAt: new Date(Date.now() - 20 * 60_000).toISOString() }),
    quota({ provider: 'legacy-row', lowestPct: 1 }),   // pre-split row: judged by session floor only
  ], cfg, Date.now());
  expect(blocked.get('low-session')).toContain('短窗口');
  expect(blocked.get('low-week')).toContain('周/月');
  expect(blocked.has('fine')).toBe(false);
  expect(blocked.has('stale')).toBe(false);
  expect(blocked.get('legacy-row')).toContain('短窗口');
});
