import { expect, test } from 'bun:test';
import { executeGateFor, managedRecencyOrder, PRIOR_HAND_WEIGHT_FACTOR, quotaBlockedProviders, staffingPool, type StaffingInput } from '../src/dispatcher/dispatcher.ts';
import { BLOCK_TEXT } from '../src/dispatcher/dispatch-blocked.ts';
import { buildIndependenceIndex } from '../src/independence.ts';
import { deriveContributors } from '../src/contributors.ts';
import type { CompanyConfig, EmployeeDef, EmployeeInst, SupervisedTask } from '../src/workforce.ts';
import type { ProviderQuota } from '../src/contracts.ts';

const OPS = '/ops/repo';
const PRODUCT = '/product/repo';

const def = (id: string, over: Partial<EmployeeDef> = {}): EmployeeDef =>
  ({ id, role: 'engineering', provider: 'codex', model: 'm1', enabled: true, maxInstances: 2,
    priority: 100, weight: 10, scored: 0, errorStreak: 0, ...over });

const inst = (id: string, over: Partial<EmployeeInst> = {}): EmployeeInst =>
  ({ id, role: 'engineering', def: 'd1', provider: 'codex', model: 'm1', paseoAgentId: `ag-${id}`, workspaceScope: 'maintenance', ...over });

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
  expect(by.get('i1')!.reason).toBe(BLOCK_TEXT.session_busy);
  expect(by.get('i1')!.code).toBe('session_busy');
  expect(by.get('i2')!.reason).toBe(BLOCK_TEXT.held);
  expect(by.get('i3')!.reason).toBe(BLOCK_TEXT.credential_file);
});

test('pool: a session nobody observed is unknown, never reported as busy', () => {
  const d = def('d1');
  const pool = staffingPool(base({ defs: [d], insts: [inst('i1')], states: new Map([['i1', 'unknown']]) }));
  const reuse = pool.find(e => e.kind === 'reuse')!;
  expect(reuse.eligible).toBe(false);
  expect(reuse.code).toBe('unknown');
  expect(reuse.reason).toBe(BLOCK_TEXT.unknown);
  // No state entry at all is the same observation gap, not a busy session.
  const absent = staffingPool(base({ defs: [d], insts: [inst('i1')], states: new Map() })).find(e => e.kind === 'reuse')!;
  expect(absent.code).toBe('unknown');
});

test('pool: legacy instance does not consume a maxInstances seat in sidecar mode', () => {
  const d = def('d1', { maxInstances: 1 });
  const legacy = inst('i1', { credentialFile: '/cred/i1.json' });
  const pool = staffingPool(base({ defs: [d], insts: [legacy], states: new Map([['i1', 'idle']]) }));
  const spawn = pool.find(e => e.kind === 'spawn')!;
  expect(spawn.eligible).toBe(true);   // seat free despite the live legacy inst
  // Non-sidecar mode: the same inst would consume the seat.
  const pool2 = staffingPool(base({ defs: [d], insts: [legacy], states: new Map([['i1', 'idle']]), sidecar: false }));
  expect(pool2.find(e => e.kind === 'spawn')!.reason).toBe('编制席位已满（1/1 个实例，仓库 repo）');
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
  expect(pool.find(e => e.kind === 'reuse')!.reason).toBe(BLOCK_TEXT.model_slot);
  expect(pool.find(e => e.kind === 'spawn')!.model).toBe('devin-new');
  // Slot missing → spawn entry ineligible.
  const noSlot = staffingPool(base({ defs: [auto], insts: [], providerMax: { devin: 2 } }));
  expect(noSlot.find(e => e.kind === 'spawn')!.reason).toBe(BLOCK_TEXT.model_slot);
  expect(noSlot.find(e => e.kind === 'spawn')!.code).toBe('model_slot');
});

test('pool: provider capacity and quota block both reuse and spawn', () => {
  const d = def('d1');
  const i = inst('i1');
  const full = staffingPool(base({ defs: [d], insts: [i],
    states: new Map([['i1', 'idle']]), providerMax: { codex: 1 }, busyBy: new Map([['codex', 1]]) }));
  expect(full.every(e => e.reason === BLOCK_TEXT.provider_capacity)).toBe(true);
  expect(full.every(e => e.code === 'provider_capacity')).toBe(true);
  // Quota circuit-break reports the quota reason itself, not the generic capacity one.
  const quota = staffingPool(base({ defs: [d], insts: [i],
    states: new Map([['i1', 'idle']]), quotaBlocked: new Map([['codex', '额度不足（周/月额度 0%<2%）']]) }));
  expect(quota.every(e => e.reason === '额度不足（周/月额度 0%<2%）')).toBe(true);
  expect(quota.every(e => e.code === 'quota')).toBe(true);
});

test('pool: exhausted inst is reusable only while the provider is in probe window', () => {
  const d = def('d1');
  const i = inst('i1');
  const exhausted = new Map([['codex', { provider: 'codex', state: 'exhausted' as const, until: 2_000_000, failures: 1 }]]);
  const cooling = staffingPool(base({ defs: [d], insts: [i], states: new Map([['i1', 'exhausted']]), health: exhausted }));
  expect(cooling.find(e => e.kind === 'reuse')!.eligible).toBe(false);
  // A cooling quota-exhausted session is quota, not busy: the owner tops up or waits for recovery, not for a free seat.
  expect(cooling.find(e => e.kind === 'reuse')!.code).toBe('quota');
  const probing = staffingPool(base({ defs: [d], insts: [i], states: new Map([['i1', 'exhausted']]),
    health: new Map([['codex', { provider: 'codex', state: 'exhausted' as const, until: 999_999, failures: 1 }]]) }));
  expect(probing.find(e => e.kind === 'reuse')!.eligible).toBe(true);
});

test('pool: an unreadable execute history blocks every candidate as unknown, never as busy or free', () => {
  const d = def('d1');
  const pool = staffingPool(base({
    defs: [d], insts: [inst('eng-a')], states: new Map([['eng-a', 'idle']]),
    task: {} as StaffingInput['task'], implementer: { unresolved: true, unknown: true },
  }));
  expect(pool.length).toBe(2);
  expect(pool.every(e => !e.eligible && e.code === 'unknown' && e.reason === BLOCK_TEXT.unknown)).toBe(true);
});

test('pool: the execute gate reaches only the task executor role, never a review pool or a manager anchor', () => {
  const gates = new Map([['t1', { implementer: 'eng-impl', unresolved: false }]]);
  const task = { id: 't1', executorRole: 'engineering' } as SupervisedTask;
  expect(executeGateFor(gates, 'engineering', task)).toEqual({ implementer: 'eng-impl', unresolved: false });
  // A reviewer, or a gm pool anchored on the same engineering task, is not an execute pool.
  expect(executeGateFor(gates, 'qa', task)).toBeUndefined();
  expect(executeGateFor(gates, 'gm', task)).toBeUndefined();
  // Review of the task never carries the gate, even for the executor role, and no task means no gate.
  expect(executeGateFor(gates, 'engineering', task, true)).toBeUndefined();
  expect(executeGateFor(gates, 'engineering')).toBeUndefined();
});

test('pool: submitter excluded only for review work', () => {
  const d = def('d1');
  const i = inst('i1');
  const task = { submittedBy: 'i1' } as StaffingInput['task'];
  const review = staffingPool(base({ defs: [d], insts: [i], states: new Map([['i1', 'idle']]), task, excludeSubmitter: true }));
  expect(review.find(e => e.kind === 'reuse')!.reason).toBe(BLOCK_TEXT.author_recusal);
  expect(review.find(e => e.kind === 'reuse')!.code).toBe('author_recusal');
  const impl = staffingPool(base({ defs: [d], insts: [i], states: new Map([['i1', 'idle']]), task }));
  expect(impl.find(e => e.kind === 'reuse')!.eligible).toBe(true);
});

test('pool: review hard-excludes every author; other candidates keep their full weight', () => {
  const d = def('d1', { weight: 10 });
  const author = inst('eng-author');     // submitted this task: hard recusal
  const reviewer = inst('eng-reviewer'); // reviewed before, never wrote code: not an author
  const fresh = inst('eng-fresh');
  const task = { submittedBy: 'eng-rework' } as StaffingInput['task'];
  const pool = staffingPool(base({
    defs: [d], insts: [author, reviewer, fresh],
    states: new Map([['eng-author', 'idle'], ['eng-reviewer', 'idle'], ['eng-fresh', 'idle']]),
    task, excludeSubmitter: true,
    recusal: { authors: new Set(['eng-author', 'eng-rework']), hands: new Set() },
  }));
  const by = new Map(pool.filter(e => e.kind === 'reuse').map(e => [e.ref, e]));
  expect(by.get('eng-author')!.eligible).toBe(false);
  expect(by.get('eng-author')!.code).toBe('author_recusal');
  expect(by.get('eng-author')!.reason).toBe(BLOCK_TEXT.author_recusal);
  expect(by.get('eng-reviewer')!.eligible).toBe(true);
  expect(by.get('eng-reviewer')!.weight).toBeCloseTo(by.get('eng-fresh')!.weight);
  expect(by.get('eng-fresh')!.eligible).toBe(true);
});

// SYS-DISP IR01 (Q1): an ordinary task's plain review rule is unchanged by an independence policy elsewhere. A prior hand —
// claimed execute, never wrote code — is demoted, not excluded, so a task never starves behind them.
test('pool: a prior hand (claimed, never wrote code) is demoted but eligible, and a strict source excludes it outright', () => {
  const d = def('d1');
  const hand = inst('eng-hand');
  const fresh = inst('eng-fresh');
  const task = {} as StaffingInput['task'];
  const base0: Partial<StaffingInput> = { defs: [d], insts: [hand, fresh],
    states: new Map([['eng-hand', 'idle'], ['eng-fresh', 'idle']]), task, excludeSubmitter: true };
  // No policy: the claim-only holder is eligible at the demoted weight (the pre-SYS-DISP rule).
  const demoted = staffingPool(base({ ...base0, recusal: { authors: new Set(['eng-author']), hands: new Set(['eng-hand']) } }));
  const byDemoted = new Map(demoted.filter(e => e.kind === 'reuse').map(e => [e.ref, e]));
  expect(byDemoted.get('eng-hand')!.eligible).toBe(true);
  expect(byDemoted.get('eng-hand')!.weight).toBeCloseTo(byDemoted.get('eng-fresh')!.weight * PRIOR_HAND_WEIGHT_FACTOR);
  expect(byDemoted.get('eng-hand')!.note).toContain('降权兜底');
  // A strict independence source that names this task: the same holder is excluded outright, demotion never applies.
  const index = buildIndependenceIndex({ policy: { mode: 'execute_handlers', excluded: [] },
    sources: [{ taskId: 'P', facts: deriveContributors([{ action: 'claim', actor: 'eng-hand', phase: 'execute' }]) }],
    principalOf: () => undefined });
  const strict = staffingPool(base({ ...base0, recusal: { authors: new Set(['eng-author']), hands: new Set(['eng-hand']) },
    independence: { kind: 'index', index } }));
  const byStrict = new Map(strict.filter(e => e.kind === 'reuse').map(e => [e.ref, e]));
  expect(byStrict.get('eng-hand')!.eligible).toBe(false);
  expect(byStrict.get('eng-hand')!.code).toBe('independence_conflict');
  expect(byStrict.get('eng-fresh')!.eligible).toBe(true);
});

test('pool: without a recusal set (execute path or read failure) recusal is unchanged', () => {
  const d = def('d1');
  const author = inst('eng-author');
  const task = { submittedBy: 'eng-author' } as StaffingInput['task'];
  // 执行派工：不带 recusal，贡献者不回避（previousEmployee 连续性保留）。
  const impl = staffingPool(base({ defs: [d], insts: [author], states: new Map([['eng-author', 'idle']]), task }));
  expect(impl.find(e => e.kind === 'reuse')!.eligible).toBe(true);
  // review 且贡献者读取失败（空集）：提交者仍由 excludeSubmitter 兜底拦住。
  const review = staffingPool(base({
    defs: [d], insts: [author], states: new Map([['eng-author', 'idle']]),
    task, excludeSubmitter: true, recusal: { authors: new Set<string>(), hands: new Set() },
  }));
  expect(review.find(e => e.kind === 'reuse')!.reason).toBe(BLOCK_TEXT.author_recusal);
});

test('pool: execute gate admits only the bound implementer; spawns and other employees are implementer_mismatch', () => {
  const d = def('d1');
  const implementer = inst('eng-impl');
  const other = inst('eng-other');
  const pool = staffingPool(base({
    defs: [d], insts: [implementer, other],
    states: new Map([['eng-impl', 'idle'], ['eng-other', 'idle']]),
    task: {} as StaffingInput['task'],
    implementer: { implementer: 'eng-impl', unresolved: false },
  }));
  const by = new Map(pool.map(e => [e.key, e]));
  expect(by.get('eng-impl')!.eligible).toBe(true);
  expect(by.get('eng-other')!.eligible).toBe(false);
  expect(by.get('eng-other')!.code).toBe('implementer_mismatch');
  expect(by.get('spawn:d1')!.code).toBe('implementer_mismatch');
});

test('pool: an unresolved execute gate blocks every candidate; a gate without a block leaves routing unchanged', () => {
  const d = def('d1');
  const a = inst('eng-a');
  const unresolved = staffingPool(base({
    defs: [d], insts: [a], states: new Map([['eng-a', 'idle']]),
    implementer: { unresolved: true },
  }));
  expect(unresolved.every(e => !e.eligible)).toBe(true);
  expect(unresolved.every(e => e.code === 'implementer_unresolved')).toBe(true);
  const fresh = staffingPool(base({
    defs: [d], insts: [a], states: new Map([['eng-a', 'idle']]), implementer: { unresolved: false },
  }));
  expect(fresh.find(e => e.kind === 'reuse')!.eligible).toBe(true);
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


test('pool: screenwriter requires 编剧 on task and covering def for reuse and spawn', () => {
  for (const tracks of [undefined, [], ['角色设计'], ['编剧']]) {
    for (const discipline of [undefined, '角色设计', '编剧']) {
      const d = def('d1', { role: 'screenwriter', tracks });
      const i = inst('i1', { role: 'screenwriter' });
      const pool = staffingPool(base({ role: 'screenwriter', defs: [d], insts: [i],
        states: new Map([['i1', 'idle']]), task: { discipline } as StaffingInput['task'] }));
      expect(pool).toHaveLength(2);
      expect(pool.every(e => e.eligible === (discipline === '编剧' && !!tracks?.includes('编剧')))).toBe(true);
    }
  }
  const pool = staffingPool(base({ defs: [def('d1', { tracks: ['编剧'] })], insts: [inst('i1')],
    states: new Map([['i1', 'idle']]), task: {} as StaffingInput['task'] }));
  expect(pool.every(e => e.eligible)).toBe(true);
});

test('pool: a def exempt from quota gating stays eligible at 0% and in provider cooldown', () => {
  const exempt = def('d1', { quotaLimited: false });
  const limited = def('d2');
  const entries = staffingPool(base({
    defs: [exempt, limited],
    insts: [inst('i1', { def: 'd1' }), inst('i2', { def: 'd2' })],
    states: new Map([['i1', 'idle'], ['i2', 'idle']]),
    quotaBlocked: new Map([['codex', '额度不足（周/月额度 0%<2%）']]),
    health: new Map([['codex', { provider: 'codex', state: 'exhausted', until: 2_000_000, failures: 1, lastError: 'model_usage_exhausted' }]]),
  }));
  const by = new Map(entries.map(e => [e.ref, e]));
  expect(by.get('i1')!.eligible).toBe(true);
  expect(by.get('d1')!.eligible).toBe(true);
  expect(by.get('i2')!.eligible).toBe(false);
  expect(by.get('d2')!.eligible).toBe(false);
  expect(by.get('d2')!.code).toBe('quota');
});

test('pool: the seat cap still bounds an exempt def', () => {
  const exempt = def('d1', { quotaLimited: false });
  const entries = staffingPool(base({
    defs: [exempt],
    insts: [inst('i1', { def: 'd1' })],
    states: new Map([['i1', 'idle']]),
    health: new Map([['codex', { provider: 'codex', state: 'exhausted', until: 2_000_000, failures: 1 }]]),
    busyBy: new Map([['codex', 3]]),
  }));
  expect(entries.every(e => !e.eligible && e.code === 'provider_capacity')).toBe(true);
});

test('pool: aggregate magpie group backoff applies even to a native-quota-exempt harness',()=>{
 const d=def('d1',{quotaLimited:false});const i=inst('i1');const task={row:{model_route_until:1_000_060}} as SupervisedTask;
 const input=base({defs:[d],insts:[i],states:new Map([['i1','idle']]),task});
 expect(staffingPool(input).filter(e=>e.eligible)).toHaveLength(0);
 expect(staffingPool(input).find(e=>e.kind==='reuse')?.code).toBe('quota');
 expect(staffingPool({...input,now:1_000_061}).some(e=>e.eligible)).toBe(true);
});


test('managed Claude pool ignores subscription model quotas and provider capacity but preserves lease and recusal gates',()=>{
  const d=def('d1',{provider:'claude',model:'group/sck-haiku',quotaLimited:false,avgScore:1});
  const i=inst('i1',{provider:'claude',model:'actual-model'});
  const p=base({defs:[d],insts:[i],states:new Map([['i1','idle']]),providerMax:{claude:0},busyBy:new Map([['claude',20]]),quotaBlocked:new Map([['claude','spent']]),health:new Map([['claude',{provider:'claude',state:'exhausted',failures:4,until:2000000}]])});
  expect(staffingPool(p).every(e=>e.eligible)).toBe(true);
  expect(staffingPool(p).every(e=>e.weight===1)).toBe(true);
  expect(staffingPool({...p,holding:new Set(['i1'])}).find(e=>e.key==='i1')?.code).toBe('held');
  expect(staffingPool({...p,defs:[{...d,enabled:false}]}).find(e=>e.key==='i1')?.code).toBe('def_disabled');
  expect(staffingPool({...p,defs:[]}).find(e=>e.key==='i1')?.code).toBe('def_disabled');
});

// 7cf393f8 B2 merge: main's all-managed pick orders by last wake, this lane's pool demotes a prior hand. Both rules hold: a
// managed base weight is still cut by the prior-hand factor, and the deterministic pick still takes the hand only after fresh sessions.
test('managed pool: the managed base weight composes with the prior-hand demotion instead of replacing it', () => {
  const d = def('d1', { provider: 'claude', model: 'group/sck-haiku', quotaLimited: false });
  const hand = inst('eng-hand', { provider: 'claude' });
  const fresh = inst('eng-fresh', { provider: 'claude' });
  const pool = staffingPool(base({ defs: [d], insts: [hand, fresh], states: new Map([['eng-hand', 'idle'], ['eng-fresh', 'idle']]),
    recusal: { authors: new Set<string>(), hands: new Set(['eng-hand']) } }));
  const by = new Map(pool.filter(e => e.kind === 'reuse').map(e => [e.ref, e]));
  expect(by.get('eng-fresh')!.weight).toBe(1);
  expect(by.get('eng-hand')!.weight).toBeCloseTo(PRIOR_HAND_WEIGHT_FACTOR);
  expect(by.get('eng-hand')!.note).toContain('降权兜底');
});

test('managed recency order: least recently woken first, a prior hand last, and an unknown wake time after any recorded one', () => {
  const at = (id: string, lastWakeAt?: number) => ({ id, lastWakeAt });
  expect(managedRecencyOrder([at('a', 30), at('b', 10), at('c', 20)]).map(i => i.id)).toEqual(['b', 'c', 'a']);
  // The hand is not dropped: with every fresh session unavailable it is still the pick. It just never outranks one.
  expect(managedRecencyOrder([at('hand', 1), at('fresh', 99)], new Set(['hand'])).map(i => i.id)).toEqual(['fresh', 'hand']);
  expect(managedRecencyOrder([at('hand', 1)], new Set(['hand'])).map(i => i.id)).toEqual(['hand']);
  // No recorded wake is never a claim to be the stalest session.
  expect(managedRecencyOrder([at('never'), at('woken', 50)]).map(i => i.id)).toEqual(['woken', 'never']);
});

test('Factory queue admission preserves recusal and allows overflow and exhausted-quota fallback',()=>{
 const factory=def('factory',{provider:'factory-droid',maxInstances:1});
 const claude=def('claude',{provider:'claude',model:'group/sck-haiku',quotaLimited:false});
 const f=inst('f',{def:'factory',provider:'factory-droid'}),c=inst('c',{def:'claude',provider:'claude',model:'group/sck-haiku'});
 const t={id:'queued',state:'review',executorRole:'engineering',reviewerRole:'engineering',row:{}} as unknown as SupervisedTask;
 const input=base({defs:[factory,claude],insts:[f,c],task:t,excludeSubmitter:true,states:new Map([['f','busy'],['c','idle']]),providerMax:{'factory-droid':1,claude:4},factoryQueue:new Map([['queued:engineering:review',3]])});
 expect(staffingPool(input).find(e=>e.key==='c')).toMatchObject({eligible:false,code:'factory_wait',share:0});
 expect(staffingPool({...input,factoryQueue:new Map([['queued:engineering:review',4]])}).find(e=>e.key==='c')?.eligible).toBe(true);
 expect(staffingPool({...input,quotaBlocked:new Map([['factory-droid','exhausted']])}).find(e=>e.key==='c')?.eligible).toBe(true);
 expect(staffingPool({...input,recusal:{authors:new Set(['c']),hands:new Set()}}).find(e=>e.key==='c')?.code).toBe('author_recusal');
});

test('an unresolved Factory definition cannot reserve a task over qualified Claude',()=>{
 const factory=def('factory',{provider:'factory-droid',model:'auto:missing',maxInstances:1});
 const claude=def('claude',{provider:'claude',model:'group/sck-haiku',quotaLimited:false});
 const f=inst('f',{def:'factory',provider:'factory-droid'}),c=inst('c',{def:'claude',provider:'claude',model:'group/sck-haiku'});
 const entries=staffingPool(base({defs:[factory,claude],insts:[c],states:new Map([['c','idle']]),providerMax:{'factory-droid':1,claude:4}}));
 expect(entries.find(e=>e.key==='c')?.eligible).toBe(true);
});
