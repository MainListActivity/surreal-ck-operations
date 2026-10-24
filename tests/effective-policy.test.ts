// SYS06 P1 有效策略层的纯单元测试：受限 schema、版本/替代/生效语义、当前有效视图、三个域的判定与派工结论。
// 不碰数据库：判定只由 policy.ts 的字段决定，所以这里改提示词/改文本都改不动任何一条结论。
import { describe, expect, test } from 'bun:test';
import { CompanyError } from '../src/core-errors.ts';
import { canonicalAlias } from '../src/ops/accounts.ts';
import {
  canonicalAliasValue, checkGateCreation, checkToolScope, checkWriteAuthority, contractDiff, dispatchVerdict,
  domainOfPayload, domainPayload, normalizePayload, policyActiveAt, policyDigest, policyHash, renderContract,
  resolveEffective, type EffectiveContract, type PolicyRow, type PolicyScopeLink,
} from '../src/policy.ts';

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
    expect(checkWriteAuthority(c, { role: 'engineering', intent: { kind: 'code', lane: 'lane/allowed' } })).toEqual({ ok: true });
    expect(checkWriteAuthority(c, { role: 'qa', intent: { kind: 'code', lane: 'lane/allowed' } }).ok).toBe(false);
    expect(checkWriteAuthority(c, { role: 'engineering', intent: { kind: 'assets' } }).ok).toBe(false);
    expect(checkWriteAuthority(c, { role: 'engineering', intent: { kind: 'code', lane: 'lane/other' } }).ok).toBe(false);
    // intents 是"本作用域允许承接的意图清单"：只列 code 时连 read 任务都不放行，这是纯粹收紧。
    expect(checkWriteAuthority(c, { role: 'qa', intent: { kind: 'read' } }).ok).toBe(false);
    const widened = contract([row({ policyId: 'w', scope: 'company', domain: 'write_authority',
      payload: { kind: 'write_authority', codeRoles: ['engineering'], intents: ['code', 'read'] } })]);
    expect(checkWriteAuthority(widened, { role: 'qa', intent: { kind: 'read' } })).toEqual({ ok: true });
    expect(checkWriteAuthority(contract([]), { role: 'qa', intent: { kind: 'code' } })).toEqual({ ok: true });
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
    expect(dispatchVerdict({ state: 'ready', executorRole: 'engineering', workIntent: { kind: 'code' } }, c).verdict).toBe('clear');
    expect(dispatchVerdict({ state: 'ready', executorRole: 'qa', workIntent: { kind: 'code' } }, c).verdict).toBe('blocked');
    expect(dispatchVerdict({ state: 'doing', executorRole: 'qa', workIntent: { kind: 'code' } }, c).reason).toContain('code work');
    // 已隔离的任务无论契约怎么说都保持 blocked。
    expect(dispatchVerdict({ state: 'ready', executorRole: 'engineering', workIntent: { kind: 'code' }, policyBlockReason: '收权隔离' }, c).verdict).toBe('blocked');
    // 契约换了但仍然授权 = stale：派工可继续，claim 会重新登记。
    expect(dispatchVerdict({ state: 'ready', executorRole: 'engineering', workIntent: { kind: 'code' }, policyHash: 'old-hash' }, c).verdict).toBe('stale');
    expect(dispatchVerdict({ state: 'done', executorRole: 'qa', workIntent: { kind: 'code' } }, c).verdict).toBe('clear');
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