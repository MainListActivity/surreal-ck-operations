// SYS06 P1 有效策略层的纯单元测试：受限 schema、版本/替代/生效语义、当前有效视图、三个域的判定与派工结论。
// 不碰数据库：判定只由 policy.ts 的字段决定，所以这里改提示词/改文本都改不动任何一条结论。
import { describe, expect, test } from 'bun:test';
import { CompanyError } from '../src/core-errors.ts';
import { canonicalAlias } from '../src/ops/accounts.ts';
import {
  canonicalAliasValue, checkGateCreation, checkToolScope, checkWriteAuthority, contractDiff, dispatchVerdict,
  domainOfPayload, domainPayload, impliedIntent, normalizePayload, policyActiveAt, policyDigest, policyHash, renderContract,
  resolveEffective, type EffectiveContract, type PolicyRow, type PolicyScopeLink,
} from '../src/policy.ts';
import { scanInFlightTasks } from '../src/policy-store.ts';
import { answerBytes, fitCount, RESPONSE_BUDGET_BYTES } from '../src/response-budget.ts';

const chain = (over: Partial<Record<'task' | 'goal' | 'project', string>> = {}): PolicyScopeLink[] => [
  ...(over.task ? [{ scope: 'task' as const, scopeRef: over.task }] : []),
  ...(over.goal ? [{ scope: 'goal' as const, scopeRef: over.goal }] : []),
  ...(over.project ? [{ scope: 'project' as const, scopeRef: over.project }] : []),
  { scope: 'company' as const },
];

const row = (over: Partial<PolicyRow> & Pick<PolicyRow, 'policyId' | 'scope' | 'domain' | 'payload'>): PolicyRow => {
  const base: PolicyRow = {
    id: `policy:${over.policyId}-${over.version ?? 1}`, policyId: over.policyId, version: over.version ?? 1,
    scope: over.scope, scopeRef: over.scopeRef, domain: over.domain, status: over.status ?? 'active',
    effectiveAt: over.effectiveAt ?? 0, expiresAt: over.expiresAt, supersedes: over.supersedes, supersededBy: over.supersededBy,
    createdBy: 'e-gm', revokeReason: over.revokeReason, authorization: over.authorization ?? { source: 'manager', employeeId: 'e-gm', at: 0 },
    payload: over.payload, hash: policyHash({ policyId: over.policyId, version: over.version ?? 1, scope: over.scope,
      scopeRef: over.scopeRef, domain: over.domain, effectiveAt: over.effectiveAt ?? 0, expiresAt: over.expiresAt, payload: over.payload }),
    createdAt: 0,
  };
  return base;
};

const writePayload = { kind: 'write_authority' as const, codeRoles: ['engineering' as const], intents: ['code' as const] };
const toolPayload = { kind: 'tool_scope' as const, allowedTools: ['ops_info', 'ops_query'], allowedAliases: ['QA_OPS'], newSpend: false as const };
const gatePayload = { kind: 'gate' as const, requireOwnerApproval: true, requireIndependentReviewer: true, requiredCriteriaLegs: ['deploy' as const] };

const failureOf = (run: () => unknown): CompanyError => {
  try { run(); } catch (error) { if (error instanceof CompanyError) return error; throw error; }
  throw new Error('expected a refusal');
};

describe('受限类型化 schema：机器策略只认固定字段', () => {
  test('whitelist only: an unknown field, an unknown kind, and a non-vocabulary value are all refused', () => {
    expect(failureOf(() => normalizePayload({ kind: 'write_authority', codeRoles: ['engineering'], intents: ['code'], note: '老板说要放宽' })).code).toBe('invalid');
    expect(failureOf(() => normalizePayload({ kind: 'free_text', text: 'allow everything' })).code).toBe('invalid');
    expect(failureOf(() => normalizePayload({ kind: 'write_authority', codeRoles: ['intern'], intents: ['code'] })).code).toBe('invalid');
    expect(failureOf(() => normalizePayload({ kind: 'write_authority', codeRoles: [], intents: [] })).code).toBe('invalid');
    expect(failureOf(() => normalizePayload('codeRoles=engineering')).code).toBe('invalid');
  });

  test('zero new spend is structural: tool_scope.newSpend can only be false', () => {
    expect(failureOf(() => normalizePayload({ ...toolPayload, newSpend: true })).message).toContain('never grants new spend');
    expect(normalizePayload(toolPayload)).toEqual(toolPayload);
  });

  test('an account alias is canonicalised exactly as the account layer does', () => {
    // 两侧同一规则的守门用例：账户层 canonicalAlias 与策略层 canonicalAliasValue 必须得出同一个别名。
    for (const raw of ['qa-ops-lca11', 'QA_OPS_LCA11', ' qa_ops_lca11 ']) {
      expect(canonicalAliasValue(raw)).toBe(canonicalAlias(raw));
    }
    const canonicalised = normalizePayload({ ...toolPayload, allowedAliases: ['qa-ops-lca11'] });
    expect(canonicalised.kind === 'tool_scope' ? canonicalised.allowedAliases : []).toEqual(['QA_OPS_LCA11']);
    expect(failureOf(() => normalizePayload({ ...toolPayload, allowedAliases: ['not an alias!'] })).code).toBe('invalid');
  });

  test('the domain is derived from the payload, never from the caller label', () => {
    expect(domainOfPayload(normalizePayload(writePayload))).toBe('write_authority');
    expect(domainOfPayload(normalizePayload(toolPayload))).toBe('tool_scope');
    expect(domainOfPayload(normalizePayload(gatePayload))).toBe('gate');
  });
});

describe('版本与生效语义', () => {
  test('policyActiveAt excludes superseded, revoked, future and expired versions', () => {
    const now = 1_000;
    expect(policyActiveAt({ status: 'active', effectiveAt: 900, supersededBy: undefined }, now)).toBe(true);
    expect(policyActiveAt({ status: 'superseded', effectiveAt: 900, supersededBy: 'policy:x', }, now)).toBe(false);
    expect(policyActiveAt({ status: 'revoked', effectiveAt: 900 }, now)).toBe(false);
    expect(policyActiveAt({ status: 'active', effectiveAt: 1_100 }, now)).toBe(false);
    expect(policyActiveAt({ status: 'active', effectiveAt: 900, expiresAt: 1_000 }, now)).toBe(false);
    expect(policyActiveAt({ status: 'active', effectiveAt: 900, supersededBy: 'policy:x' }, now)).toBe(false);
  });

  test('the hash covers payload and governing metadata, so the same payload elsewhere is a different version', () => {
    const a = policyHash({ policyId: 'p-a', version: 1, scope: 'company', domain: 'write_authority', effectiveAt: 10, payload: writePayload });
    expect(policyHash({ policyId: 'p-a', version: 1, scope: 'company', domain: 'write_authority', effectiveAt: 10, payload: writePayload })).toBe(a);
    expect(a).not.toBe(policyHash({ policyId: 'p-a', version: 2, scope: 'company', domain: 'write_authority', effectiveAt: 10, payload: writePayload }));
    expect(a).not.toBe(policyHash({ policyId: 'p-a', version: 1, scope: 'project', scopeRef: 'p1', domain: 'write_authority', effectiveAt: 10, payload: writePayload }));
    expect(policyDigest({ b: 1, a: 2 })).toBe(policyDigest({ a: 2, b: 1 }));
  });
});

describe('当前有效视图', () => {
  const company = row({ policyId: 'company-write', scope: 'company', domain: 'write_authority', payload: writePayload });
  const project = row({ policyId: 'project-write', scope: 'project', scopeRef: 'proj-1', domain: 'write_authority',
    payload: { kind: 'write_authority', codeRoles: ['engineering', 'qa'], intents: ['code'] } });

  test('the nearest active version of a domain wins, and an absent domain simply constrains nothing', () => {
    const onlyCompany = resolveEffective([company], chain({ project: 'proj-1' }), 1, 100);
    expect(domainPayload(onlyCompany, 'write_authority')?.codeRoles).toEqual(['engineering']);
    expect(domainPayload(onlyCompany, 'tool_scope')).toBeUndefined();
    expect(domainPayload(onlyCompany, 'gate')).toBeUndefined();

    const both = resolveEffective([company, project], chain({ project: 'proj-1' }), 2, 100);
    expect(domainPayload(both, 'write_authority')?.codeRoles).toEqual(['engineering', 'qa']);
    // 另一个项目的链不该被这条项目策略命中。
    expect(domainPayload(resolveEffective([company, project], chain({ project: 'proj-2' }), 2, 100), 'write_authority')?.codeRoles).toEqual(['engineering']);
  });

  test('keys are ordered, so two contract reads of the same facts hash the same', () => {
    const one = resolveEffective([project, company], chain({ project: 'proj-1' }), 3, 100);
    const two = resolveEffective([company, project], chain({ project: 'proj-1' }), 3, 100);
    expect(one.hash).toBe(two.hash);
    expect(resolveEffective([company], chain(), 4, 100).hash).not.toBe(one.hash);
  });

  test('two active versions in the same scope and domain are a conflict, never a silent "latest text wins"', () => {
    const twin = row({ policyId: 'company-write-2', scope: 'company', domain: 'write_authority', payload: writePayload });
    expect(failureOf(() => resolveEffective([company, twin], chain(), 5, 100)).code).toBe('conflict');
  });

  test('a superseded version leaves the effective view but stays readable as history', () => {
    const superseded = row({ policyId: 'company-write', scope: 'company', domain: 'write_authority', payload: writePayload,
      status: 'superseded', supersededBy: 'policy:company-write-2' });
    const next = row({ policyId: 'company-write-2', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: ['engineering', 'qa'], intents: ['code'] } });
    const contract = resolveEffective([superseded, next], chain(), 6, 100);
    expect(domainPayload(contract, 'write_authority')?.codeRoles).toEqual(['engineering', 'qa']);
    expect(contract.domains.find(d => d.domain === 'write_authority')?.policyVersion).toBe(1);
  });
});

describe('三个域的判定', () => {
  const contract = (rows: PolicyRow[], links = chain()): EffectiveContract => resolveEffective(rows, links, 1, 100);

  test('write_authority: role, intent and lane are all checked; nothing else is', () => {
    const policies = [row({ policyId: 'w', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: ['engineering'], intents: ['code'], lanes: ['lane/allowed'] } })];
    const c = contract(policies);
    const goal = { kind: 'task' as const, goalId: 'goal-1' };
    expect(checkWriteAuthority(c, { role: 'engineering', ...goal, intent: { kind: 'code', lane: 'lane/allowed' } })).toEqual({ ok: true });
    expect(checkWriteAuthority(c, { role: 'qa', ...goal, intent: { kind: 'code', lane: 'lane/allowed' } }).ok).toBe(false);
    expect(checkWriteAuthority(c, { role: 'engineering', ...goal, intent: { kind: 'assets' } }).ok).toBe(false);
    expect(checkWriteAuthority(c, { role: 'engineering', ...goal, intent: { kind: 'code', lane: 'lane/other' } }).ok).toBe(false);
    // intents 是"本作用域允许承接的意图清单"：只列 code 时连 read 任务都不放行，这是纯粹收紧。
    expect(checkWriteAuthority(c, { role: 'qa', ...goal, intent: { kind: 'read' } }).ok).toBe(false);
    const widened = contract([row({ policyId: 'w', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: ['engineering'], intents: ['code', 'read'] } })]);
    expect(checkWriteAuthority(widened, { role: 'qa', ...goal, intent: { kind: 'read' } })).toEqual({ ok: true });
    expect(checkWriteAuthority(contract([]), { role: 'qa', kind: 'task', intent: { kind: 'code' } })).toEqual({ ok: true });
  });

  // AC02① 的绕过口：lanes 白名单只对"自报 lane"的任务生效。判定的输入必须是这条任务**实际会被怎么跑**，
  // 缺字段不是"没有可判的"，而是拒绝——否则不声明 lane 就成了白名单的旁路。
  test('write_authority under a lanes whitelist fails closed when the lane is missing', () => {
    const c = contract([row({ policyId: 'w', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: ['engineering'], intents: ['code'], lanes: ['lane-a'] } })]);
    // 负例：声明了意图但没声明 lane → 拒。
    const noLane = checkWriteAuthority(c, { role: 'engineering', kind: 'task', goalId: 'goal-1', intent: { kind: 'code' } });
    expect(noLane.ok).toBe(false);
    expect(noLane.ok === false && noLane.reason).toContain('declare a lane');
    // 负例：声明了合法 lane 但任务不在任何目标下 → 没有轨分支可言，拒。
    const noGoal = checkWriteAuthority(c, { role: 'engineering', kind: 'task', intent: { kind: 'code', lane: 'lane-a' } });
    expect(noGoal.ok).toBe(false);
    expect(noGoal.ok === false && noGoal.reason).toContain('outside a goal');
    // 负例：完全不声明意图的工程岗任务，按 claim 的建树规则就是 code 写 → 同样受白名单约束，拒。
    const noIntent = checkWriteAuthority(c, { role: 'engineering', kind: 'task', goalId: 'goal-1' });
    expect(noIntent.ok).toBe(false);
    expect(noIntent.ok === false && noIntent.reason).toContain('declare a lane');
    // 放行面：lane 在白名单内、任务有目标。
    expect(checkWriteAuthority(c, { role: 'engineering', kind: 'task', goalId: 'goal-1', intent: { kind: 'code', lane: 'lane-a' } }))
      .toEqual({ ok: true });
    // 未声明意图的 qa 任务解析成 read：intents 只列 code 时被意图清单拦下（不是被 lane 规则误伤）。
    const qaNoIntent = checkWriteAuthority(c, { role: 'qa', kind: 'task', goalId: 'goal-1' });
    expect(qaNoIntent.ok).toBe(false);
    expect(qaNoIntent.ok === false && qaNoIntent.reason).toContain('work intent read');
    // 未声明意图的发布任务解析成 read，不是 code：工程岗的非发布任务才是 code，release 不是。
    const release = contract([row({ policyId: 'w', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: ['engineering'], intents: ['code', 'read'] } })]);
    expect(checkWriteAuthority(release, { role: 'engineering', kind: 'release' })).toEqual({ ok: true });
    // 未声明意图时按岗位+kind 解析：工程岗 task → code（走 codeRoles，放行）；qa task → read（codeRoles 管不到，放行）。
    expect(checkWriteAuthority(release, { role: 'engineering', kind: 'task' })).toEqual({ ok: true });
    expect(checkWriteAuthority(release, { role: 'qa', kind: 'task' })).toEqual({ ok: true });
    // 同一份契约下 qa 显式声明 code 意图 → 被 codeRoles 拦下：区别在意图，不在岗位本身。
    expect(checkWriteAuthority(release, { role: 'qa', kind: 'task', intent: { kind: 'code' } }).ok).toBe(false);
    // 冻结只冻代码写权：同一份契约把 codeRoles 清空后，工程岗 task（=code）被拒，工程岗 release（=read）照旧放行。
    const frozen = contract([row({ policyId: 'w2', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: [], intents: ['code', 'read'] } })]);
    expect(checkWriteAuthority(frozen, { role: 'engineering', kind: 'task' }).ok).toBe(false);
    expect(checkWriteAuthority(frozen, { role: 'engineering', kind: 'release' })).toEqual({ ok: true });
  });

  test('the lane rule resolves the same intent the claim will build the worktree from', () => {
    expect(impliedIntent('engineering', 'task')).toEqual({ kind: 'code' });
    expect(impliedIntent('engineering', 'gate')).toEqual({ kind: 'code' });
    expect(impliedIntent('engineering', 'release')).toEqual({ kind: 'read' });
    expect(impliedIntent('qa', 'task')).toEqual({ kind: 'read' });
    expect(impliedIntent('gm', 'task')).toEqual({ kind: 'read' });
  });

  test('tool_scope: tools outside this layer are untouched, and aliases compare in their canonical form', () => {
    const c = contract([row({ policyId: 't', scope: 'company', domain: 'tool_scope', payload: toolPayload })]);
    expect(checkToolScope(c, { tool: 'ops_info', alias: 'qa-ops', toolNames: ['ops_info', 'ops_query'] })).toEqual({ ok: true });
    expect(checkToolScope(c, { tool: 'ops_member_add', toolNames: ['ops_info', 'ops_member_add'] }).ok).toBe(false);
    expect(checkToolScope(c, { tool: 'checkpoint', toolNames: ['ops_info'] })).toEqual({ ok: true });
    expect(checkToolScope(c, { tool: 'ops_query', alias: 'OTHER_ALIAS', toolNames: ['ops_query'] }).ok).toBe(false);
    expect(checkToolScope(contract([]), { tool: 'ops_member_add', toolNames: ['ops_member_add'] })).toEqual({ ok: true });
  });

  test('gate: the owner gate and the independent reviewer can only be strengthened', () => {
    const c = contract([row({ policyId: 'g', scope: 'company', domain: 'gate', payload: gatePayload })]);
    expect(checkGateCreation(c, { leg: 'deploy', kind: 'deploy', executorRole: 'qa', reviewerRole: 'owner' })).toEqual({ ok: true });
    expect(checkGateCreation(c, { leg: 'deploy', kind: 'gate', executorRole: 'engineering', reviewerRole: 'qa' }).ok).toBe(false);
    expect(checkGateCreation(c, { leg: 'implement', kind: 'task', executorRole: 'qa', reviewerRole: 'qa' }).ok).toBe(false);
    expect(checkGateCreation(c, { leg: 'implement', kind: 'task', executorRole: 'qa', reviewerRole: 'gm' })).toEqual({ ok: true });
    // 没有 gate 策略时创建照旧。
    expect(checkGateCreation(contract([]), { leg: 'deploy', kind: 'deploy', executorRole: 'qa', reviewerRole: 'qa' })).toEqual({ ok: true });
  });

  test('a task that lost authorization is blocked for dispatch, and an unauthorized one is never stale-clear', () => {
    const c = contract([row({ policyId: 'w', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: ['engineering'], intents: ['code'] } })]);
    expect(dispatchVerdict({ state: 'ready', executorRole: 'engineering', kind: 'task', workIntent: { kind: 'code' } }, c).verdict).toBe('clear');
    expect(dispatchVerdict({ state: 'ready', executorRole: 'qa', kind: 'task', workIntent: { kind: 'code' } }, c).verdict).toBe('blocked');
    expect(dispatchVerdict({ state: 'doing', executorRole: 'qa', kind: 'task', workIntent: { kind: 'code' } }, c).reason).toContain('code work');
    // 已隔离的任务无论契约怎么说都保持 blocked。
    expect(dispatchVerdict({ state: 'ready', executorRole: 'engineering', kind: 'task', workIntent: { kind: 'code' }, policyBlockReason: '收权隔离' }, c).verdict).toBe('blocked');
    // 契约换了但仍然授权 = stale：派工可继续，claim 会重新登记。
    expect(dispatchVerdict({ state: 'ready', executorRole: 'engineering', kind: 'task', workIntent: { kind: 'code' }, policyHash: 'old-hash' }, c).verdict).toBe('stale');
    expect(dispatchVerdict({ state: 'done', executorRole: 'qa', kind: 'task', workIntent: { kind: 'code' } }, c).verdict).toBe('clear');
    // 未声明意图不是"没有可判的"：工程岗的非发布任务按 claim 的建树规则就是 code 写，冻结后必须被拦下（缺数据 = 拒绝）。
    expect(dispatchVerdict({ state: 'ready', executorRole: 'engineering', kind: 'task' }, c).verdict).toBe('clear');
    const frozen = contract([row({ policyId: 'w2', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: [], intents: ['code'] } })]);
    const noIntentFrozen = dispatchVerdict({ state: 'ready', executorRole: 'engineering', kind: 'task' }, frozen);
    expect(noIntentFrozen.verdict).toBe('blocked');
    expect(noIntentFrozen.reason).toContain('code work');
    // 发布任务未声明意图时解析成 read，不占写权：空 codeRoles 冻结的是代码写，不是发布（read 在意图清单里）。
    const frozenAll = contract([row({ policyId: 'w3', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: [], intents: ['code', 'read'] } })]);
    expect(dispatchVerdict({ state: 'ready', executorRole: 'engineering', kind: 'release' }, frozenAll).verdict).toBe('clear');
    // 同一份契约下工程岗的普通任务仍是 code → 被冻结拦下。
    expect(dispatchVerdict({ state: 'ready', executorRole: 'engineering', kind: 'task' }, frozenAll).verdict).toBe('blocked');
  });
});

describe('渲染与差异', () => {
  test('the rendered contract names the versions, not free text, and the diff lists only changed domains', () => {
    const before = resolveEffective([row({ policyId: 'w', scope: 'company', domain: 'write_authority', payload: writePayload })], chain(), 1, 100);
    const after = resolveEffective([
      row({ policyId: 'w', scope: 'company', domain: 'write_authority', status: 'superseded', supersededBy: 'policy:w-2', payload: writePayload }),
      row({ policyId: 'w', scope: 'company', domain: 'write_authority', version: 2,
        payload: { kind: 'write_authority', codeRoles: ['engineering', 'qa'], intents: ['code'] } }),
    ], chain(), 2, 100);
    const rendered = renderContract(after);
    expect(rendered).toContain('有效策略契约 v2');
    expect(rendered).toContain('w v2');
    expect(rendered).toContain('codeRoles=engineering,qa');
    const diff = contractDiff(before, after);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.domain).toBe('write_authority');
    expect(diff[0]?.before).toContain('w v1');
    expect(diff[0]?.after).toContain('w v2');
    expect(contractDiff(after, after)).toEqual([]);
    expect(renderContract(resolveEffective([], chain(), 3, 100))).toContain('无机器策略生效');
  });
});
describe('R1 候选集扫描：与判定同源、分页读到底、截断显式', () => {
  /**
   * 假 DB：按 SQL 里的 keyset 条件（created_at, id）真做分页，这样"翻页"是被执行出来的、不是被断言的。
   * 数据按 (created_at DESC, id DESC) 排序，与真实扫描的 ORDER BY 同一个全序。
   */
  const pagingDb = (rows: Array<{ id: string; created_at: number }>) => {
    const queries: string[] = [];
    const ordered = [...rows].sort((left, right) => right.created_at - left.created_at || (left.id < right.id ? 1 : -1));
    return {
      queries,
      db: {
        async query<T>(sql: string, vars?: Record<string, unknown>): Promise<T> {
          queries.push(sql);
          const size = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 0);
          if (!size) throw new Error(`scan did not page: ${sql}`);
          const at = vars?.after_at as number | undefined;
          const id = vars?.after_id as string | undefined;
          const rest = at === undefined ? ordered
            : ordered.filter(row => row.created_at < at || (row.created_at === at && row.id < (id ?? '')));
          return [rest.slice(0, size)] as T;
        },
      },
    };
  };

  test('读到底：跨页取回全部在办任务，一条都不丢', async () => {
    const all = Array.from({ length: 5 }, (_, index) => ({ id: `task-${index}`, created_at: 100 - index }));
    const { db, queries } = pagingDb(all);
    const scan = await scanInFlightTasks<{ id: string; created_at: number }>(db, 2, 10);
    expect(scan.rows.map(row => row.id)).toEqual(all.map(row => row.id));
    expect(scan.scanned).toBe(5);
    expect(scan.truncated).toBe(false);
    expect(scan.scanLimit).toBe(20);
    // 三页：2 + 2 + 1，最后一页不满 → 停止；没有"读满一页就当读完"。
    expect(queries).toHaveLength(3);
  });

  test('keyset 翻页在并发写入下不重不漏（偏移量翻页会整页错位）', async () => {
    // 第一页读完后，库的最前面插进一条新任务：偏移量翻页会把第二页整体往后挤（漏掉一条或重复一条），
    // keyset 翻页不会——它按 (created_at, id) 接着上一条往下读。
    const all = Array.from({ length: 6 }, (_, index) => ({ id: `task-${index}`, created_at: 100 - index }));
    const { db } = pagingDb(all);
    let calls = 0;
    const racing = {
      query: async <T>(sql: string, vars?: Record<string, unknown>): Promise<T> => {
        calls += 1;
        if (calls === 2) all.unshift({ id: 'task-newest', created_at: 999 }); // 并发新建：偏移量翻页会漏一条
        return await db.query<T>(sql, vars);
      },
    };
    const scan = await scanInFlightTasks<{ id: string; created_at: number }>(racing, 2, 10);
    const ids = scan.rows.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);                                  // 不重
    expect(ids).toEqual(['task-0', 'task-1', 'task-2', 'task-3', 'task-4', 'task-5']); // 不漏（新建的那条不挤掉别人）
  });

  test('读满上限：显式报告 truncated，绝不静默截断', async () => {
    const all = Array.from({ length: 9 }, (_, index) => ({ id: `task-${index}`, created_at: 100 - index }));
    const { db, queries } = pagingDb(all);
    const scan = await scanInFlightTasks<{ id: string; created_at: number }>(db, 2, 2);
    expect(scan.scanned).toBe(4);
    expect(scan.scanLimit).toBe(4);
    expect(scan.truncated).toBe(true);
    expect(queries).toHaveLength(2);
  });

  test('候选集没有 policy_hash 预筛：SQL 里既没有该条件，也没有隐式上限', async () => {
    const { db, queries } = pagingDb([]);
    await scanInFlightTasks(db, 200, 50);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain('policy_hash');
    expect(queries[0]).toContain("state NOT IN ['done', 'void']");
    expect(queries[0]).toContain('LIMIT 200');
    // 第一页不带 keyset 条件；后续页才有（见上一条）。
    expect(queries[0]).not.toContain('after_at');
  });
});

describe('R1(b) 试算分页的字节边界', () => {
  test('页大小的选择让每一页都在 48 KiB 预算内（按真实序列化大小裁，不按条数猜）', () => {
    // policy_plan 的 pagePolicyPlan 用 answerBytes 做 fitCount；这里用同一度量核对"一页装不下就少装几条"的边界。
    const entry = (index: number) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      title: `受影响任务 ${index} —— 一个足够长的标题，用来逼近响应预算`, state: 'ready' as const,
      fromHash: 'd'.repeat(64), toHash: 'e'.repeat(64), losesAuthorization: true,
      reason: 'policy forbids role engineering from taking code work here' });
    const page = (count: number) => ({ scopeChain: [{ scope: 'company' as const }],
      before: { hash: 'a'.repeat(64), version: 1, domains: [] }, after: { hash: 'b'.repeat(64), version: 2, domains: [] }, diff: [],
      scanned: 500, scanLimit: 10_000, truncated: false, planHash: 'c'.repeat(64),
      page: { pageSize: 200, returned: count, total: 500, hasMore: true, nextCursor: 'v1.x.y', budgetBytes: RESPONSE_BUDGET_BYTES },
      affectedTasks: Array.from({ length: count }, (_, index) => entry(index)) });
    // 条目本身很小，200 条会超预算：fitCount 会往下裁到一个能装下的条数，而不是整份拒绝。
    expect(answerBytes(page(200))).toBeGreaterThan(RESPONSE_BUDGET_BYTES);
    const fit = fitCount(Array.from({ length: 200 }, (_, index) => entry(index)),
      subset => answerBytes(page(subset.length)), RESPONSE_BUDGET_BYTES);
    expect(fit).toBeGreaterThan(0);
    expect(fit).toBeLessThan(200);
    expect(answerBytes(page(fit))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    // 每多一条就一定更贵（fitCount 的前提）：边界上的下一条确实装不下。
    expect(answerBytes(page(fit + 1))).toBeGreaterThan(RESPONSE_BUDGET_BYTES);
  });
});
