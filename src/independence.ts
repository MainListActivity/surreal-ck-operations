import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { CONTRIBUTION_ACTIONS, readContributionView, type ContributionFacts, type ContributionView } from './contributors.ts';
import type { EmployeeId, IndependenceMode, IndependencePolicy, IndependenceStage, TaskId } from './contracts.ts';

/**
 * Independence policy (SYS-DISP IR01-IR02): which contributors of other tasks may not take or decide a task. Contributors come from
 * the source tasks' audit stream (contributors.ts), and "same source" means the same registered identity: the same employeeId
 * (across every agent, session and workspace it ever used) or a registered principal link between two employeeIds. A registered
 * definition is NOT an identity (SYS-DISP Q3): it is a capacity template, so two independent employees of one definition are
 * independent people. Nothing is inferred from def, provider, model, name or directory, and an unregistered link is never
 * recognized — nor claimed to be.
 *
 * The rules are pure (validation, the exclusion index), so the core, the dispatcher and the unit tests read one definition.
 * The readers only read; a read that fails or a source that is missing is never reported as "no conflict".
 */

/** Limits of one policy write. Raw list sizes are checked before dedupe. */
export const INDEPENDENCE_LIMITS = { sources: 20, excluded: 100, idChars: 200, reasonBytes: 2048, policyBytes: 8192 } as const;

const STAGES: readonly IndependenceStage[] = ['execute', 'review'];
const MODES: readonly IndependenceMode[] = ['execute_handlers', 'all_handlers'];

/** The writable fields of a policy, validated and normalized. */
export interface IndependenceFields {
  stages: IndependenceStage[];
  sources: TaskId[];
  mode: IndependenceMode;
  excluded: EmployeeId[];
  reason: string;
}

const refuse = (message: string) => new CompanyError('invalid', `Invalid independence policy: ${message}`);
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const idOf = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > INDEPENDENCE_LIMITS.idChars || value.trim() !== value) {
    throw refuse(`${name} must be a plain id of 1-${INDEPENDENCE_LIMITS.idChars} characters`);
  }
  return value;
};

/**
 * Validates one policy write. Raw list sizes are checked before dedupe, so a flood of one repeated id is refused rather than shrunk
 * to something that looks legal. Throws `invalid` for any malformed field. The caller checks that the named tasks and employees exist.
 */
export function normalizeIndependence(input: {
  taskId: TaskId; stages: unknown; sources: unknown; mode: unknown; excluded?: unknown; reason: unknown;
}): IndependenceFields {
  if (!Array.isArray(input.stages)) throw refuse('stages must be a list');
  for (const stage of input.stages) {
    if (!STAGES.includes(stage as IndependenceStage)) throw refuse(`unknown stage ${String(stage)}`);
  }
  if (input.stages.length === 0) throw refuse('name at least one stage (execute or review)');
  if (!MODES.includes(input.mode as IndependenceMode)) throw refuse('mode must be execute_handlers or all_handlers');
  if (!Array.isArray(input.sources) || input.sources.length > INDEPENDENCE_LIMITS.sources) {
    throw refuse(`sources must be a list of at most ${INDEPENDENCE_LIMITS.sources} task ids`);
  }
  const excludedRaw = input.excluded ?? [];
  if (!Array.isArray(excludedRaw) || excludedRaw.length > INDEPENDENCE_LIMITS.excluded) {
    throw refuse(`excluded must be a list of at most ${INDEPENDENCE_LIMITS.excluded} employee ids`);
  }
  if (typeof input.reason !== 'string' || input.reason.trim() === '') throw refuse('reason is required');
  if (Buffer.byteLength(input.reason, 'utf8') > INDEPENDENCE_LIMITS.reasonBytes) {
    throw refuse(`reason exceeds ${INDEPENDENCE_LIMITS.reasonBytes} UTF-8 bytes`);
  }
  const sources = unique(input.sources.map(value => idOf(value, 'source task id')));
  const excluded = unique(excludedRaw.map(value => idOf(value, 'excluded employee id')));
  if (sources.includes(input.taskId)) throw refuse('a task cannot be its own source');
  if (sources.length === 0 && excluded.length === 0) throw refuse('name at least one source task or excluded employee');
  const stageNames: unknown[] = input.stages;
  const fields: IndependenceFields = {
    stages: STAGES.filter(stage => stageNames.includes(stage)),
    sources,
    mode: input.mode as IndependenceMode,
    excluded,
    reason: input.reason,
  };
  if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > INDEPENDENCE_LIMITS.policyBytes) {
    throw refuse(`policy exceeds ${INDEPENDENCE_LIMITS.policyBytes} bytes`);
  }
  return fields;
}

/** The role a source contributor played on that source. */
export type ContributorRole = 'author' | 'implementer' | 'reviewer';

/**
 * Why an employee is excluded: a contributor of a source, a named employee, or the same registered identity as either.
 * `via: same_principal` carries the matched employee and the principal linking them (schema 029); `source` is set when
 * the match came from a contributor.
 */
export interface IndependenceHit {
  via: 'contributor' | 'explicit' | 'same_principal';
  source?: TaskId;
  matched?: EmployeeId;
  role?: ContributorRole;
  principal?: string;
}

/** Exclusions by employee id and by registered principal (an identity link, never a definition). */
export interface IndependenceIndex {
  byEmployee: Map<EmployeeId, IndependenceHit>;
  byPrincipal: Map<string, IndependenceHit>;
}

/**
 * What one stage of one task reads: the exclusion, or unverifiable when a source could not be read. Unverifiable never means clear.
 * `source` names the source task whose history is unreadable or missing, when the failure can be pinned to one source.
 */
export type IndependenceScope = { kind: 'index'; index: IndependenceIndex } | { kind: 'unverifiable'; reason: string; source?: TaskId };

/**
 * Contributors of a source for the policy mode (SYS-DISP IR01). `execute_handlers` is every execute-phase handler of the source —
 * authors, implementer and claim-only holders (`hands`) — which is the strict set a source excludes; `all_handlers` adds the
 * source's reviewers.
 */
function contributorsOf(facts: ContributionFacts, mode: IndependenceMode): Array<[EmployeeId, ContributorRole]> {
  const roles = new Map<EmployeeId, ContributorRole>();
  for (const employee of facts.excluded) roles.set(employee, facts.authors.includes(employee) ? 'author' : 'implementer');
  for (const employee of facts.strictExcluded) {
    if (!roles.has(employee)) roles.set(employee, facts.authors.includes(employee) ? 'author' : 'implementer');
  }
  if (mode === 'all_handlers') for (const employee of facts.reviewers) roles.set(employee, 'reviewer');
  return [...roles];
}

/**
 * The exclusion index for a policy: each source contributor (per mode) and each named employee, by employee id and by the
 * registered principal linking employees into one identity. A definition is never an index key: two employees of one
 * definition are independent unless a registered principal link says otherwise (SYS-DISP Q3).
 */
export function buildIndependenceIndex(input: {
  policy: Pick<IndependenceFields, 'mode' | 'excluded'>;
  sources: ReadonlyArray<{ taskId: TaskId; facts: ContributionFacts }>;
  principalOf: (employee: EmployeeId) => string | undefined;
}): IndependenceIndex {
  const byEmployee = new Map<EmployeeId, IndependenceHit>();
  const byPrincipal = new Map<string, IndependenceHit>();
  const add = (employee: EmployeeId, hit: IndependenceHit) => {
    if (!byEmployee.has(employee)) byEmployee.set(employee, hit);
    const principal = input.principalOf(employee);
    if (principal !== undefined && !byPrincipal.has(principal)) {
      byPrincipal.set(principal, { ...hit, via: 'same_principal', matched: employee, principal });
    }
  };
  for (const source of input.sources) {
    for (const [employee, role] of contributorsOf(source.facts, input.policy.mode)) {
      add(employee, { via: 'contributor', source: source.taskId, matched: employee, role });
    }
  }
  for (const employee of input.policy.excluded) add(employee, { via: 'explicit', matched: employee });
  return { byEmployee, byPrincipal };
}

/**
 * The hit that excludes an employee (registered as `principal`, when a principal link is registered), or undefined when nothing
 * excludes them. An employee with no registered principal is judged by its own id alone.
 */
export function independenceHit(index: IndependenceIndex, employee: EmployeeId | undefined, principal?: string): IndependenceHit | undefined {
  return (employee === undefined ? undefined : index.byEmployee.get(employee)) ?? (principal === undefined ? undefined : index.byPrincipal.get(principal));
}

/** Owner-facing text for a hit, for the dispatcher's candidate reasons. */
export function independenceText(hit: IndependenceHit): string {
  if (hit.via === 'explicit') return '经理指定回避的员工，不能接手或复核本任务';
  if (hit.via === 'same_principal') {
    return hit.source === undefined
      ? `与经理指定回避的员工 ${hit.matched} 同一登记身份（principal ${hit.principal}），不能接手或复核本任务`
      : `与来源任务 ${hit.source} 的经手人 ${hit.matched} 同一登记身份（principal ${hit.principal}），不能接手或复核本任务`;
  }
  return `来源任务 ${hit.source} 的经手人 ${hit.matched}，不能接手或复核本任务`;
}

const employeeKey = (value: unknown): string | undefined =>
  value instanceof RecordId && value.table.name === 'employee' ? String(value.id) : undefined;
const principalKey = (value: unknown): string | undefined =>
  value instanceof RecordId && value.table.name === 'principal' ? String(value.id) : undefined;

/**
 * The registered principal of each named employee (schema 029): the explicit, manage-controlled identity link that makes two
 * employeeIds one person. Rows survive retirement, so a retired contributor's registered identity still links whoever shares it.
 * An employee with no link returns nothing here and is judged by its own id alone. A definition is never read as an identity.
 */
export async function readEmployeePrincipals(db: Surreal, employees: readonly EmployeeId[]): Promise<Map<EmployeeId, string>> {
  const principals = new Map<EmployeeId, string>();
  if (employees.length === 0) return principals;
  const [rows] = await db.query<[Array<{ id?: unknown; principal?: unknown }>]>('SELECT id, principal FROM employee WHERE id IN $ids;',
    { ids: employees.map(employee => new RecordId('employee', employee)) });
  for (const row of rows ?? []) {
    const employee = employeeKey(row.id);
    const principal = principalKey(row.principal);
    if (employee !== undefined && principal !== undefined) principals.set(employee, principal);
  }
  return principals;
}

/** Everything a policy reads at one moment: each source's contribution view with the version it was read at, and the index. */
export interface IndependenceSnapshot {
  sources: Array<{ taskId: TaskId; version: number; facts: ContributionFacts }>;
  index: IndependenceIndex;
}

async function readSource(db: Surreal, taskId: TaskId, hook?: (taskId: TaskId) => Promise<void>): Promise<ContributionView> {
  try {
    await hook?.(taskId);
    return await readContributionView(db, taskId);
  } catch {
    throw new CompanyError('temporarily_unavailable', `Independence source history unreadable: ${taskId}; retry`, true, { source: taskId });
  }
}

const isIdList = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');

/**
 * Why a stored policy cannot be enforced by this build, or undefined when it can. An unknown version refuses, and so does a record
 * missing or mistyping a field the write path always sets: an incomplete policy never reads as no policy.
 */
export function policyFault(policy: IndependencePolicy): string | undefined {
  if (policy.schema !== 1) return `Independence policy version ${String(policy.schema)} is not understood; refusing`;
  if (!Array.isArray(policy.stages) || policy.stages.length === 0 || !policy.stages.every(stage => STAGES.includes(stage))) {
    return 'Independence policy is incomplete (stages); refusing';
  }
  if (!MODES.includes(policy.mode)) return 'Independence policy is incomplete (mode); refusing';
  if (!isIdList(policy.sources) || !isIdList(policy.excluded)) return 'Independence policy is incomplete (sources or excluded); refusing';
  if (policy.sources.length + policy.excluded.length === 0) return 'Independence policy is incomplete (no source or excluded employee); refusing';
  return undefined;
}

/**
 * The exclusion a policy reads now. A policy this build cannot enforce refuses (fail closed, see policyFault). A source that cannot be
 * read refuses as temporarily unavailable, and a source that does not exist refuses as not found: the caller never gets a partial index.
 */
export async function readIndependenceSnapshot(db: Surreal, policy: IndependencePolicy,
  hook?: (taskId: TaskId) => Promise<void>): Promise<IndependenceSnapshot> {
  const fault = policyFault(policy);
  if (fault !== undefined) throw new CompanyError('forbidden', fault);
  const sources: IndependenceSnapshot['sources'] = [];
  for (const taskId of policy.sources) {
    const view = await readSource(db, taskId, hook);
    if (view.version === undefined) throw new CompanyError('not_found', `Independence source not found: ${taskId}`, false, { source: taskId });
    sources.push({ taskId, version: view.version, facts: view.facts });
  }
  const employees = unique([...policy.excluded, ...sources.flatMap(source => [...source.facts.excluded, ...source.facts.reviewers, ...source.facts.strictExcluded])]);
  let principals: Map<EmployeeId, string>;
  try {
    principals = await readEmployeePrincipals(db, employees);
  } catch {
    // Identity records unreadable is never "no conflict": the whole scope is unverifiable and fails closed.
    throw new CompanyError('temporarily_unavailable', 'Independence identity links unreadable; retry', true);
  }
  const index = buildIndependenceIndex({ policy, sources, principalOf: employee => principals.get(employee) });
  return { sources, index };
}

/**
 * The scope a dispatch pass reads for one task at one stage. Undefined when a readable policy does not apply at that stage (legacy
 * tasks and other stages are unchanged). A policy this build cannot enforce is unverifiable at every stage, because its stages cannot
 * be trusted, and so is a snapshot that cannot be read: the pool blocks both instead of reading them as clear.
 */
export async function readIndependenceScope(db: Surreal, policy: IndependencePolicy | undefined,
  stage: IndependenceStage): Promise<IndependenceScope | undefined> {
  if (!policy) return undefined;
  const fault = policyFault(policy);
  if (fault !== undefined) return { kind: 'unverifiable', reason: fault };
  if (!policy.stages.includes(stage)) return undefined;
  try {
    return { kind: 'index', index: (await readIndependenceSnapshot(db, policy)).index };
  } catch (error) {
    const source = error instanceof CompanyError && typeof error.details === 'object' && error.details !== null
      ? (error.details as { source?: unknown }).source : undefined;
    return { kind: 'unverifiable', reason: error instanceof Error ? error.message : String(error), ...(typeof source === 'string' ? { source } : {}) };
  }
}

/** The first contribution row of `employee` on `source`: the audit reference a conflict cites. */
export async function auditRefOf(db: Surreal, source: TaskId, employee: EmployeeId): Promise<string | undefined> {
  const [rows] = await db.query<[Array<{ id?: unknown }>]>(
    'SELECT id, at FROM audit WHERE task = $task AND actor = $actor AND action IN $actions ORDER BY at ASC LIMIT 1;',
    { task: new RecordId('task', source), actor: new RecordId('employee', employee), actions: [...CONTRIBUTION_ACTIONS] });
  const row = rows?.[0];
  return row?.id === undefined ? undefined : String(row.id);
}

/** A refusal's structured reason: the task, the employee refused, and the source and audit row that prove the match. */
export interface IndependenceConflict {
  task: TaskId;
  employee: EmployeeId;
  via: IndependenceHit['via'];
  source?: TaskId;
  matched?: EmployeeId;
  role?: ContributorRole;
  principal?: string;
  auditRef?: string;
}

async function conflictOf(db: Surreal, task: TaskId, employee: EmployeeId, hit: IndependenceHit): Promise<IndependenceConflict> {
  const auditRef = hit.source !== undefined && hit.matched !== undefined ? await auditRefOf(db, hit.source, hit.matched) : undefined;
  return {
    task, employee, via: hit.via,
    ...(hit.source !== undefined ? { source: hit.source } : {}),
    ...(hit.matched !== undefined ? { matched: hit.matched } : {}),
    ...(hit.role !== undefined ? { role: hit.role } : {}),
    ...(hit.principal !== undefined ? { principal: hit.principal } : {}),
    ...(auditRef !== undefined ? { auditRef } : {}),
  };
}

/**
 * Refuses `employee` (registered as `principal`, when a link is registered) for `task` when the index excludes them. The refusal
 * is `forbidden` with the structured conflict in `details`. Used by the claim and submit gates, which read the index from the same
 * snapshot their write is guarded by.
 */
export async function refuseIfExcluded(db: Surreal, task: TaskId, index: IndependenceIndex, employee: EmployeeId, principal?: string): Promise<void> {
  const hit = independenceHit(index, employee, principal);
  if (!hit) return;
  const conflict = await conflictOf(db, task, employee, hit);
  const via = conflict.source === undefined ? conflict.via : `${conflict.via} of source ${conflict.source}`;
  throw new CompanyError('forbidden', `independence conflict: ${employee} may not take or decide ${task} (${via})`, false, { conflicts: [conflict] });
}
