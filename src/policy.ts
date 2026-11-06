import { createHash } from 'node:crypto';
import { CompanyError } from './core-errors.ts';
import { ROLES } from './contracts.ts';
import type { AcceptanceLeg, PolicyView, ReviewerRole, Role, TaskKind, WorkIntent } from './contracts.ts';

/**
 * 有效策略层（SYS06 P1）的机器策略：受限类型化 schema + 显式替代关系 + 生效/到期语义。
 *
 * 三条边界是刻意的：
 *  - 机器策略只接受下面三个域的固定字段（多余字段一律拒绝），不做自由文本 eval，也不把
 *    提示词当编译结果：允许/拒绝只由这些字段决定，改提示内容不改变判定。
 *  - 版本只增不改：一版写定后 payload/hash 不再变动，替代写在新一版上（supersedes 指针），
 *    当前有效视图由生效链算出，历史永远可查。
 *  - 同域冲突必须显式替代：同（作用域, 域）已有生效版本时，不带 supersedes 的新版本被拒绝，
 *    不会静默覆盖成"最新一条文本"。
 *
 * 文学/风格/语义敏感词这类判断不在机器策略范围内：本层只强制可执行的授权与关口。
 */
export const POLICY_SCOPES = ['company', 'project', 'goal', 'task'] as const;
export type PolicyScope = typeof POLICY_SCOPES[number];
export type WorkIntentKind = WorkIntent['kind'];
export const POLICY_DOMAINS = ['write_authority', 'tool_scope', 'gate'] as const;
export type PolicyDomain = typeof POLICY_DOMAINS[number];
export const POLICY_STATUSES = ['active', 'superseded', 'revoked'] as const;
export type PolicyStatus = typeof POLICY_STATUSES[number];
/** 授权来源：owner = 老板方向转录（须能对回一条已登记方向）；manager = 运营/系统按岗位授权。 */
export const POLICY_SOURCES = ['owner', 'manager'] as const;
export type PolicySource = typeof POLICY_SOURCES[number];
export const WORK_INTENT_KINDS = ['read', 'code', 'assets'] as const;

export const POLICY_ID_PATTERN = /^[a-z][a-z0-9_-]{2,60}$/;
/** 账号别名的规范形，与 src/ops/accounts.ts 的 canonicalAlias 同一规则（大写、`-`→`_`）；两侧一致性由测试守住。 */
export const ALIAS_SHAPE = /^[A-Z0-9][A-Z0-9_]{0,39}$/;
export const canonicalAliasValue = (raw: string): string => raw.trim().toUpperCase().replaceAll('-', '_');
const MAX_LIST = 64;
const MAX_ITEM_CHARS = 80;

export interface WriteAuthorityPayload {
  kind: 'write_authority';
  /** 允许承接 code 意图任务的岗位；工程岗写入代码的基线规则不变，这里只能再收紧。 */
  codeRoles: Role[];
  /** 本作用域内允许出现的工作意图种类。 */
  intents: WorkIntentKind[];
  /** 给了就只允许这些线名上的 code 写入（lane 分支/线）。 */
  lanes?: string[];
}

export interface ToolScopePayload {
  kind: 'tool_scope';
  allowedTools: string[];
  allowedAliases: string[];
  /** 零新增支出边界：只能是 false，任何 true 都被拒绝。 */
  newSpend: false;
}

export interface GatePayload {
  kind: 'gate';
  /** 为 true 时该作用域的 gate/deploy 交付必须走老板关口（reviewer_role=owner）。 */
  requireOwnerApproval: boolean;
  /** 为 true 时执行岗与验收岗不得同岗（自审自批禁止的强化）。 */
  requireIndependentReviewer: boolean;
  /** 这些腿的交付即使全局验收闸门关闭也必须带基线验收条件。 */
  requiredCriteriaLegs: AcceptanceLeg[];
}

export type PolicyPayload = WriteAuthorityPayload | ToolScopePayload | GatePayload;

export interface PolicyAuthorization {
  source: PolicySource;
  employeeId: string;
  /** source=owner 时必须给出，且必须能对回一条已登记的老板方向。 */
  ownerQuote?: string;
  at: number;
}

export interface PolicyRow {
  id: string;
  policyId: string;
  version: number;
  scope: PolicyScope;
  scopeRef?: string;
  domain: PolicyDomain;
  status: PolicyStatus;
  effectiveAt: number;
  expiresAt?: number;
  supersedes?: string;
  supersededBy?: string;
  createdBy: string;
  /** 撤销原因与撤销人（status=revoked 时的人读说明；谁撤的也留在历史里）。 */
  revokeReason?: string;
  revokedBy?: string;
  authorization: PolicyAuthorization;
  payload: PolicyPayload;
  hash: string;
  createdAt: number;
}

/** 一条作用域链上的候选策略，用来算当前有效视图。链上越靠前越具体，命中即覆盖更宽的域。 */
export interface PolicyScopeLink { scope: PolicyScope; scopeRef?: string }

export interface EffectiveDomain {
  domain: PolicyDomain;
  policyId: string;
  policyVersion: number;
  scope: PolicyScope;
  scopeRef?: string;
  docId: string;
  hash: string;
  expiresAt?: number;
  payload: PolicyPayload;
}

/** 服务端生成的有效契约：新动作按它判定；任务/租约登记它的 version 与 hash。 */
export interface EffectiveContract {
  version: number;
  hash: string;
  domains: EffectiveDomain[];
}

export type PolicyVerdict = { ok: true } | { ok: false; code: CompanyError['code']; reason: string };

export const policyError = (code: CompanyError['code'], message: string) =>
  new CompanyError(code, message);

/** 稳定序列化：键排序，数组按给定顺序，让人工可核的 hash 与内容一一对应。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export const policyDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

const text = (value: unknown, name: string, max = MAX_ITEM_CHARS): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw policyError('invalid', `${name} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
};

const textList = (value: unknown, name: string, allowed?: readonly string[]): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) {
    throw policyError('invalid', `${name} must be a non-empty list of at most ${MAX_LIST} entries`);
  }
  const out = value.map(item => text(item, `${name} entry`));
  if (allowed) {
    const bad = out.find(item => !allowed.includes(item));
    if (bad !== undefined) throw policyError('invalid', `${name} has an entry outside the vocabulary: ${bad}`);
  }
  return [...new Set(out)];
};

/** 受限 schema：只认白名单字段，别的字段一律拒绝——自由文本从来不是机器策略的入口。 */
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[], what: string) => {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw policyError('invalid', `${what} carries unknown fields: ${extra.join(',')}`);
};
const asObject = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw policyError('invalid', `${what} must be an object`);
  return value as Record<string, unknown>;
};

export function normalizePayload(value: unknown): PolicyPayload {
  const raw = asObject(value, 'policy payload');
  const kind = raw.kind;
  if (kind === 'write_authority') {
    onlyKeys(raw, ['kind', 'codeRoles', 'intents', 'lanes'], 'write_authority payload');
    // 岗位清单直接引用 contracts 的 ROLES，策略 schema 不会随岗位表漂移。
    const codeRoles = raw.codeRoles === undefined || (Array.isArray(raw.codeRoles) && raw.codeRoles.length === 0)
      ? [] : textList(raw.codeRoles, 'codeRoles', ROLES) as Role[];
    const intents = textList(raw.intents, 'intents', WORK_INTENT_KINDS) as WorkIntentKind[];
    const lanes = raw.lanes === undefined ? undefined : textList(raw.lanes, 'lanes');
    return { kind, codeRoles, intents, ...(lanes ? { lanes } : {}) };
  }
  if (kind === 'tool_scope') {
    onlyKeys(raw, ['kind', 'allowedTools', 'allowedAliases', 'newSpend'], 'tool_scope payload');
    const allowedTools = textList(raw.allowedTools, 'allowedTools').map(tool => {
      if (!/^[a-z][a-z0-9_]{1,60}$/.test(tool)) throw policyError('invalid', `allowedTools entry is not a tool name: ${tool}`);
      return tool;
    });
    const allowedAliases = textList(raw.allowedAliases, 'allowedAliases').map(alias => {
      const canonical = canonicalAliasValue(alias);
      if (!ALIAS_SHAPE.test(canonical)) throw policyError('invalid', `allowedAliases entry is not an account alias: ${alias}`);
      return canonical;
    });
    if (raw.newSpend !== false) throw policyError('invalid', 'tool_scope.newSpend must be false: this layer never grants new spend');
    return { kind, allowedTools, allowedAliases, newSpend: false };
  }
  if (kind === 'gate') {
    onlyKeys(raw, ['kind', 'requireOwnerApproval', 'requireIndependentReviewer', 'requiredCriteriaLegs'], 'gate payload');
    if (typeof raw.requireOwnerApproval !== 'boolean' || typeof raw.requireIndependentReviewer !== 'boolean') {
      throw policyError('invalid', 'gate payload flags must be booleans');
    }
    const legs = textList(raw.requiredCriteriaLegs, 'requiredCriteriaLegs', ['implement', 'release', 'deploy'] as readonly string[]) as AcceptanceLeg[];
    return { kind, requireOwnerApproval: raw.requireOwnerApproval, requireIndependentReviewer: raw.requireIndependentReviewer, requiredCriteriaLegs: legs };
  }
  throw policyError('invalid', `unknown policy domain: ${String(kind)}`);
}

export const domainOfPayload = (payload: PolicyPayload): PolicyDomain =>
  payload.kind === 'write_authority' ? 'write_authority' : payload.kind === 'tool_scope' ? 'tool_scope' : 'gate';

/** 内容 hash：payload + 判定元数据一起入 hash，同 payload 换作用域/授权来源就不是同一条策略。 */
export function policyHash(doc: {
  policyId: string; version: number; scope: PolicyScope; scopeRef?: string; domain: PolicyDomain;
  effectiveAt: number; expiresAt?: number; payload: PolicyPayload;
}): string {
  return policyDigest({ policyId: doc.policyId, version: doc.version, scope: doc.scope, scopeRef: doc.scopeRef ?? null,
    domain: doc.domain, effectiveAt: doc.effectiveAt, expiresAt: doc.expiresAt ?? null, payload: doc.payload });
}

/** 一条策略此刻是否生效：状态 active、已到生效时间、未到期。被替代或被撤销的不算。 */
export const policyActiveAt = (row: Pick<PolicyRow, 'status' | 'effectiveAt' | 'expiresAt' | 'supersededBy'>, now: number) =>
  row.status === 'active' && row.effectiveAt <= now && (row.expiresAt === undefined || row.expiresAt > now) &&
  row.supersededBy === undefined;

/**
 * 当前有效视图：沿作用域链（任务 → 目标 → 项目 → 公司）为每个域取第一条生效版本，命中即覆盖更宽的域。
 * 同（作用域, 域）内的重复生效版本属于写入时已被拒绝的坏数据，这里按失败关闭处理——宁可无契约也不猜。
 */
export function resolveEffective(rows: readonly PolicyRow[], chain: readonly PolicyScopeLink[], epoch: number, now: number): EffectiveContract {
  const domains: EffectiveDomain[] = [];
  for (const domain of POLICY_DOMAINS) {
    let winner: PolicyRow | undefined;
    for (const link of chain) {
      const matches = rows.filter(row => row.domain === domain && row.scope === link.scope &&
        (link.scopeRef === undefined ? row.scopeRef === undefined : row.scopeRef === link.scopeRef) && policyActiveAt(row, now));
      if (matches.length > 1) {
        throw policyError('conflict',
          `${matches.length} active ${domain} policies govern ${link.scope}${link.scopeRef ? `:${link.scopeRef}` : ''}; the effective view is ambiguous until the conflict is resolved`);
      }
      if (matches.length === 1) { winner = matches[0]; break; }
    }
    if (winner) {
      domains.push({ domain, policyId: winner.policyId, policyVersion: winner.version, scope: winner.scope,
        scopeRef: winner.scopeRef, docId: winner.id, hash: winner.hash, expiresAt: winner.expiresAt, payload: winner.payload });
    }
  }
  // 契约摘要覆盖"哪一版规则在生效"（epoch + 每个域的条目），但刻意不含各策略行的记录号：记录号是存储细节，
  // 试算（dry-run）时还没写库、也就还没有记录号。摘要里带上它，试算给出的 hash 就永远对不上落地后的 hash，
  // "先试算再落地、两边逐位一致"就成了空话。条目里的 policyId/version/hash 已经足够指认是哪一版。
  const hash = policyDigest({ version: epoch, domains: domains.map(({ docId: _docId, ...entry }) => entry) });
  return { version: epoch, hash, domains };
}

/** 契约里某个域的 payload；没有该域的生效版本时是 undefined（= 该域不设机器约束）。 */
export const domainPayload = <T extends PolicyPayload['kind']>(contract: EffectiveContract, kind: T) =>
  contract.domains.find(entry => entry.domain === (kind as PolicyDomain))?.payload as
    Extract<PolicyPayload, { kind: T }> | undefined;

/**
 * 未声明意图的任务按 claim 建树的同一规则解析：工程岗的非发布任务按代码写，其余按读。
 * 这条规则只有一处（worktree-registry.ts 的 claimShape 也用它），否则"判定放行的任务"与"实际拿到写树的任务"
 * 会各说各话——AC02① 的绕过正是从这个缝里来的：payload 带 lanes 白名单，而判定只看出生字段，不看它实际会怎么写。
 */
export const impliedIntent = (role: Role, kind: TaskKind): WorkIntent =>
  ({ kind: role === 'engineering' && kind !== 'release' ? 'code' : 'read' });

/** code 意图任务的写权判定：岗位必须在 codeRoles 内，意图与线名也必须被授权。 */
export function checkWriteAuthority(contract: EffectiveContract,
  input: { role: Role; kind: TaskKind; goalId?: string; intent?: WorkIntent }): PolicyVerdict {
  const payload = domainPayload(contract, 'write_authority');
  if (!payload) return { ok: true };
  // 未声明意图时按"它会被怎么跑"判定，而不是当作没有可判的东西放过去（缺数据是拒绝，不是通过）。
  const intent = input.intent ?? impliedIntent(input.role, input.kind);
  const role = input.role;
  if (!payload.intents.includes(intent.kind)) {
    return { ok: false, code: 'forbidden', reason: `policy ${payload.kind} forbids work intent ${intent.kind} here` };
  }
  if (intent.kind === 'code' && !payload.codeRoles.includes(role)) {
    return { ok: false, code: 'forbidden', reason: `policy forbids role ${role} from taking code work here` };
  }
  if (intent.kind === 'code' && payload.lanes) {
    // 白名单生效时必须判定"这条 code 任务会落到哪条轨上"：线名未声明、或任务不在任何目标下（没有 goalId 就
    // 只能建 task/<id8> 的临时分支，不是任何一条轨）都不在白名单内 → 失败关闭，绝不因为字段缺失而放行。
    if (intent.lane === undefined) {
      return { ok: false, code: 'forbidden',
        reason: `policy requires code work on this scope to declare a lane (allowed: ${payload.lanes.join(', ') || 'none'})` };
    }
    if (!input.goalId) {
      return { ok: false, code: 'forbidden',
        reason: `policy forbids code work on lane ${intent.lane} outside a goal (a lane needs a goal to have a lane branch)` };
    }
    if (!payload.lanes.includes(intent.lane)) {
      return { ok: false, code: 'forbidden', reason: `policy forbids code work on lane ${intent.lane}` };
    }
  }
  return { ok: true };
}

/** 受控工具/账号别名的判定：不在允许清单里的工具或别名一律拒绝；支出能力本层从不放开。 */
export function checkToolScope(contract: EffectiveContract, input: { tool: string; alias?: string; toolNames: readonly string[] }): PolicyVerdict {
  const payload = domainPayload(contract, 'tool_scope');
  if (!payload) return { ok: true };
  // toolNames 是"这个调用点认得的所有工具名"：不在里面的名字不受本域约束（例如任务自身的 checkpoint）。
  if (!input.toolNames.includes(input.tool)) return { ok: true };
  if (!payload.allowedTools.includes(input.tool)) {
    return { ok: false, code: 'forbidden', reason: `policy does not allow ops tool ${input.tool} here (allowed: ${payload.allowedTools.join(',')})` };
  }
  const alias = input.alias === undefined ? undefined : canonicalAliasValue(input.alias);
  if (alias !== undefined && !payload.allowedAliases.includes(alias)) {
    return { ok: false, code: 'forbidden', reason: `policy does not allow account alias ${alias} here (allowed: ${payload.allowedAliases.join(',')})` };
  }
  return { ok: true };
}

/** 必需验收/老板关口的判定：老板关口、独立验收岗都只能被加强，不能被策略放宽。 */
export function checkGateCreation(contract: EffectiveContract, input: { leg: AcceptanceLeg; kind: string; executorRole: Role; reviewerRole: ReviewerRole }): PolicyVerdict {
  const payload = domainPayload(contract, 'gate');
  if (!payload) return { ok: true };
  if (payload.requireOwnerApproval && (input.kind === 'gate' || input.kind === 'deploy') && input.reviewerRole !== 'owner') {
    return { ok: false, code: 'forbidden', reason: `policy requires the owner gate for ${input.kind} deliverables in this scope` };
  }
  if (payload.requireIndependentReviewer && input.reviewerRole === input.executorRole) {
    return { ok: false, code: 'forbidden', reason: 'policy requires the reviewer to be a different role than the executor' };
  }
  return { ok: true };
}

/** 单行人类/代理可读的契约渲染：提示里只出现当前有效契约，历史文本留在 policy 表里。 */
export function renderContract(contract: EffectiveContract): string {
  if (!contract.domains.length) return `有效策略契约 v${contract.version} hash=${contract.hash.slice(0, 16)}：无机器策略生效（仅人工关口）`;
  const lines = contract.domains.map(entry => {
    const at = `${entry.scope}${entry.scopeRef ? `:${entry.scopeRef}` : ''}`;
    const payload = entry.payload;
    const detail = payload.kind === 'write_authority'
      ? `codeRoles=${payload.codeRoles.join(',')} intents=${payload.intents.join(',')}${payload.lanes ? ` lanes=${payload.lanes.join(',')}` : ''}`
      : payload.kind === 'tool_scope'
        ? `allowedTools=${payload.allowedTools.join(',')} allowedAliases=${payload.allowedAliases.join(',')} newSpend=false`
        : `requireOwnerApproval=${payload.requireOwnerApproval} requireIndependentReviewer=${payload.requireIndependentReviewer} requiredCriteriaLegs=${payload.requiredCriteriaLegs.join(',')}`;
    return `[${entry.domain} @${at}] ${entry.policyId} v${entry.policyVersion}: ${detail}`;
  });
  return [`有效策略契约 v${contract.version} hash=${contract.hash.slice(0, 16)}`, ...lines].join('\n');
}

/** 契约差异（dry-run 用）：按域列出前后版本，没有生效版本的一侧记 local:none。 */
export function contractDiff(before: EffectiveContract, after: EffectiveContract) {
  return POLICY_DOMAINS.flatMap(domain => {
    const b = before.domains.find(entry => entry.domain === domain);
    const a = after.domains.find(entry => entry.domain === domain);
    const key = (entry?: EffectiveDomain) => entry ? `${entry.policyId} v${entry.policyVersion} (${entry.hash.slice(0, 12)})` : 'none';
    return key(b) === key(a) ? [] : [{ domain, before: key(b), after: key(a), scope: a?.scope ?? b?.scope, scopeRef: a?.scopeRef ?? b?.scopeRef }];
  });
}
/** 对外形状（MCP/sck）：时间是 ISO 8601 字符串；内部判定一律用 unix 秒。 */
export function policyView(row: PolicyRow): PolicyView {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  return { id: row.id, policyId: row.policyId, version: row.version, scope: row.scope, scopeRef: row.scopeRef,
    domain: row.domain, status: row.status, effectiveAt: iso(row.effectiveAt),
    ...(row.expiresAt !== undefined ? { expiresAt: iso(row.expiresAt) } : {}),
    ...(row.supersedes !== undefined ? { supersedes: row.supersedes } : {}),
    ...(row.supersededBy !== undefined ? { supersededBy: row.supersededBy } : {}),
    ...(row.revokeReason !== undefined ? { revokeReason: row.revokeReason } : {}),
    ...(row.revokedBy !== undefined ? { revokedBy: row.revokedBy } : {}),
    authorization: { ...row.authorization, at: iso(row.authorization.at) as unknown as number },
    payload: row.payload, hash: row.hash, createdBy: row.createdBy, createdAt: iso(row.createdAt) };
}

/**
 * 派工前的判定（SYS06 AC02）：core（任务/租约/关口）与 workforce（调度器）共用这一段，所以调度器拦住的任务
 * 与 claim 拒绝的任务永远是同一个结论。
 * blocked 只在契约不再授权、原授权版本已失效、或任务已带隔离原因时出现；stale 表示契约已换但仍授权（新的 claim 会重新登记版本）。
 */
export interface PolicyTaskFacts {
  state: string;
  executorRole: Role;
  /** 任务的 kind：未声明意图时按它解析出"这条任务会被怎么跑"（见 impliedIntent）。 */
  kind?: TaskKind;
  /** 任务所属目标：lanes 白名单下，没有目标就没有轨分支可言。 */
  goalId?: string;
  workIntent?: { kind: string; lane?: string };
  policyHash?: string;
  policyBlockReason?: string;
  /** 任务/租约登记时那份契约里生效的域（AC01 的版本历史事实）。 */
  registeredDomains?: readonly string[];
}

export function dispatchVerdict(facts: PolicyTaskFacts, contract: EffectiveContract): { verdict: 'clear' | 'stale' | 'blocked'; reason?: string; hash: string } {
  if (facts.state === 'done' || facts.state === 'void') return { verdict: 'clear', hash: contract.hash };
  // 失效关闭（AC01/AC03/AC05）：本任务当初是按一份带 write_authority 的契约被授权创建的，如果当前有效契约里
  // 这个域整个消失了（临时授权到期、被撤销），"没有策略"绝不能被读成"没有限制"——那等于到期/撤销反而放权。
  // 只有这一种情形会拦：原契约有、现在没有。原契约有、现在是另一版 → 按新版重新判定（下面 stale/blocked）。
  const lostDomain = POLICY_DOMAINS.some(domain => (facts.registeredDomains ?? []).includes(domain) &&
    !contract.domains.some(entry => entry.domain === domain));
  if (lostDomain) {
    return { verdict: 'blocked', hash: contract.hash,
      reason: '原授权版本已到期或被撤销：当前有效契约里没有生效的写权/工具/关口版本，需老板按新契约重新授权或隔离本任务' };
  }
  const intent = facts.workIntent ? { kind: facts.workIntent.kind, ...(facts.workIntent.lane !== undefined ? { lane: facts.workIntent.lane } : {}) } as WorkIntent : undefined;
  const verdict = checkWriteAuthority(contract, { role: facts.executorRole, kind: facts.kind ?? 'task',
    ...(facts.goalId ? { goalId: facts.goalId } : {}), ...(intent ? { intent } : {}) });
  if (!verdict.ok || facts.policyBlockReason) {
    return { verdict: 'blocked', reason: verdict.ok ? facts.policyBlockReason : verdict.reason, hash: contract.hash };
  }
  if (facts.policyHash && facts.policyHash !== contract.hash) return { verdict: 'stale', hash: contract.hash };
  return { verdict: 'clear', hash: contract.hash };
}
