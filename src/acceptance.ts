// SYS02: one acceptance model for every gate. Criteria are versioned on the task; evidence is server-verified and bound to
// the submitted head; the evaluator is pure, so submit / review accept / release approval / deploy / owner gate all judge
// the same facts the same way. Self-written text or an arbitrary URL never becomes a machine pass fact: only the source
// adapter can set verified=true.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId, type Surreal } from 'surrealdb';
import type {
  AcceptanceCriterion, AcceptanceCriterionKind, AcceptanceEvidenceRecord, AcceptanceEvidenceType, AcceptanceGateView,
  AcceptanceLayer, AcceptanceLeg, AcceptancePhase, AcceptanceRisk, AcceptanceUnmet, AcceptanceVerdict, TaskKind, WorkIntent,
} from './contracts.ts';
import { CompanyError } from './core-errors.ts';
import { ghCli, type GhRunner } from './pr-gate.ts';

export const ACCEPTANCE_CRITERIA_VERSION = 1;
export const ACCEPTANCE_MAX_CRITERIA = 20;
/** Stable AC ids; the id is what evidence rows and unmet lists name. */
export const ACCEPTANCE_CRITERIA_ID = /^AC-[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
/** A controlled environment name (for example production); undefined is a distinct, generic value, never a wildcard. */
export const ACCEPTANCE_ENVIRONMENT = /^[a-z][a-z0-9._-]{0,49}$/;

const KINDS: readonly AcceptanceCriterionKind[] = ['machine', 'human'];
const LAYERS: readonly AcceptanceLayer[] = ['unit', 'integration', 'fork', 'ci', 'runtime', 'manual'];
const EVIDENCE_TYPES: readonly AcceptanceEvidenceType[] = ['ci-run', 'probe', 'artifact', 'review-signoff'];
const RISKS: readonly AcceptanceRisk[] = ['code', 'data', 'external-timing', 'permission', 'packaging', 'runtime'];
const LEGS: readonly AcceptanceLeg[] = ['implement', 'release', 'deploy', 'goal', 'owner'];

const invalid = (message: string) => new CompanyError('invalid', message);
const environmentValue = (value: string): string => {
  if (!ACCEPTANCE_ENVIRONMENT.test(value)) throw invalid(`environment must match ${ACCEPTANCE_ENVIRONMENT}`);
  return value;
};

/** Validate and normalize a criteria array. Unknown fields are not copied; duplicate ids and machine/human mismatches fail closed. */
export function validateAcceptanceCriteria(input: unknown): AcceptanceCriterion[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length === 0 || input.length > ACCEPTANCE_MAX_CRITERIA) {
    throw invalid(`acceptanceCriteria must be a non-empty array of at most ${ACCEPTANCE_MAX_CRITERIA} criteria`);
  }
  const seen = new Set<string>();
  return input.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid(`acceptanceCriteria[${index}] must be an object`);
    const criterion = raw as Record<string, unknown>;
    const id = criterion.id;
    if (typeof id !== 'string' || !ACCEPTANCE_CRITERIA_ID.test(id)) throw invalid(`acceptance criterion ${index} needs an id like AC-1`);
    if (seen.has(id)) throw invalid(`duplicate acceptance criterion id: ${id}`);
    seen.add(id);
    if (typeof criterion.kind !== 'string' || !KINDS.includes(criterion.kind as AcceptanceCriterionKind)) throw invalid(`${id}: kind must be machine or human`);
    if (typeof criterion.required !== 'boolean') throw invalid(`${id}: required must be true or false`);
    if (typeof criterion.layer !== 'string' || !LAYERS.includes(criterion.layer as AcceptanceLayer)) throw invalid(`${id}: layer must be one of ${LAYERS.join(', ')}`);
    if (typeof criterion.evidence !== 'string' || !EVIDENCE_TYPES.includes(criterion.evidence as AcceptanceEvidenceType)) throw invalid(`${id}: evidence must be one of ${EVIDENCE_TYPES.join(', ')}`);
    if (criterion.kind === 'machine' && criterion.evidence === 'review-signoff') throw invalid(`${id}: machine criteria need a machine evidence type`);
    if (criterion.kind === 'human' && criterion.evidence !== 'review-signoff') throw invalid(`${id}: human criteria need review-signoff evidence`);
    if (typeof criterion.verify !== 'string' || criterion.verify.trim().length === 0 || criterion.verify.length > 120) throw invalid(`${id}: verify must be a non-empty string up to 120 characters`);
    if (criterion.environment !== undefined && (typeof criterion.environment !== 'string' || !ACCEPTANCE_ENVIRONMENT.test(criterion.environment))) {
      throw invalid(`${id}: environment must match ${ACCEPTANCE_ENVIRONMENT}`);
    }
    if (criterion.description !== undefined && (typeof criterion.description !== 'string' || criterion.description.length > 500)) throw invalid(`${id}: description must be up to 500 characters`);
    if (criterion.risk !== undefined && (typeof criterion.risk !== 'string' || !RISKS.includes(criterion.risk as AcceptanceRisk))) throw invalid(`${id}: risk must be one of ${RISKS.join(', ')}`);
    let legs: AcceptanceLeg[] | undefined;
    if (criterion.legs !== undefined) {
      if (!Array.isArray(criterion.legs) || criterion.legs.length === 0 || criterion.legs.length > LEGS.length ||
        !criterion.legs.every(leg => typeof leg === 'string' && LEGS.includes(leg as AcceptanceLeg))) {
        throw invalid(`${id}: legs must be a non-empty list of ${LEGS.join(', ')}`);
      }
      legs = [...new Set(criterion.legs as AcceptanceLeg[])];
    }
    return {
      id, kind: criterion.kind as AcceptanceCriterionKind, required: criterion.required,
      layer: criterion.layer as AcceptanceLayer, evidence: criterion.evidence as AcceptanceEvidenceType,
      verify: criterion.verify.trim(),
      ...(criterion.description !== undefined ? { description: criterion.description } : {}),
      ...(criterion.risk !== undefined ? { risk: criterion.risk as AcceptanceRisk } : {}),
      ...(legs !== undefined ? { legs } : {}),
      ...(criterion.environment !== undefined ? { environment: environmentValue(criterion.environment as string) } : {}),
    } as AcceptanceCriterion;
  });
}

export function criteriaForLeg(criteria: readonly AcceptanceCriterion[], leg: AcceptanceLeg): AcceptanceCriterion[] {
  return criteria.filter(criterion => !criterion.legs || criterion.legs.includes(leg));
}

/**
 * The controlled environment declaration for one task/leg: the explicit task value, or the single environment named by
 * its criteria. Conflicting declarations are refused, so an executor cannot relabel a generic CI run as production.
 */
export function effectiveEnvironment(criteria: readonly AcceptanceCriterion[], declared?: string): string | undefined {
  const taskEnvironment = declared !== undefined && declared !== '' ? environmentValue(declared) : undefined;
  const names = [...new Set(criteria.map(criterion => criterion.environment).filter((value): value is string => value !== undefined))];
  if (names.length > 1) throw invalid(`acceptance criteria declare conflicting environments: ${names.join(', ')}`);
  const criterionEnvironment = names[0];
  if (taskEnvironment !== undefined && criterionEnvironment !== undefined && taskEnvironment !== criterionEnvironment) {
    throw invalid(`acceptance environment ${taskEnvironment} conflicts with criterion environment ${criterionEnvironment}`);
  }
  return taskEnvironment ?? criterionEnvironment;
}

export const criteriaDigest = (criteria: readonly AcceptanceCriterion[]): string =>
  createHash('sha256').update(JSON.stringify(criteria)).digest('hex');

/**
 * Default criteria per delivery leg. They are a baseline, not a claim that the system can prove every risk: callers add the
 * specific runtime/timing/permission checks their change needs. The gate is enforced only once enabled (AC06).
 */
export function defaultAcceptanceCriteria(leg: AcceptanceLeg): AcceptanceCriterion[] {
  if (leg === 'implement') return [
    { id: 'AC-1', kind: 'machine', required: true, layer: 'ci', evidence: 'ci-run', verify: 'ci', risk: 'code', description: 'PR head 的 CI 成功' },
    { id: 'AC-2', kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'independent-review', risk: 'code', description: '另一位工程师独立复核' },
  ];
  if (leg === 'release') return [
    { id: 'AC-1', kind: 'machine', required: true, layer: 'ci', evidence: 'ci-run', verify: 'ci', risk: 'code', description: '上线申请 PR head 的 CI 成功' },
  ];
  if (leg === 'deploy') return [
    { id: 'AC-1', kind: 'machine', required: true, layer: 'ci', evidence: 'ci-run', verify: 'deploy-run', risk: 'code', description: '合入/发布 CI 成功' },
    { id: 'AC-2', kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'qa-production', risk: 'runtime', description: 'QA 生产实测签署' },
  ];
  return [
    { id: 'AC-1', kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'owner-acceptance', risk: 'runtime', description: '老板/授权人签署' },
  ];
}

/**
 * The server-owned minimum for a new code delivery and each of its legs: one required machine CI check and one required
 * real independent sign-off. Callers may only add criteria; a supplied set that omits, downgrades or leg-filters the
 * minimum gets the missing baseline entries merged in (a baseline id with changed fields is refused). The baseline is
 * derived from the trusted task kind/work intent, never from the caller's criteria, so an all-optional or human-only set
 * cannot reclassify a code delivery.
 */
export const ACCEPTANCE_BASELINE_VERSION = 1;
export const BASELINE_IDS: Record<AcceptanceLeg, { machine: string; human: string }> = {
  implement: { machine: 'AC-BASE-IMPL-1', human: 'AC-BASE-IMPL-2' },
  release: { machine: 'AC-BASE-RELEASE-1', human: 'AC-BASE-RELEASE-2' },
  deploy: { machine: 'AC-BASE-DEPLOY-1', human: 'AC-BASE-DEPLOY-2' },
  goal: { machine: 'AC-BASE-GOAL-1', human: 'AC-BASE-GOAL-2' },
  owner: { machine: 'AC-BASE-OWNER-1', human: 'AC-BASE-OWNER-2' },
};
export function acceptanceLegForSubject(subject: { kind?: TaskKind; workIntent?: WorkIntent }): AcceptanceLeg {
  if (subject.kind === 'release') return 'release';
  if (subject.kind === 'deploy') return 'deploy';
  return 'implement';
}
/** Trusted classification: kind and work intent only. Criteria cannot make a code delivery look like a non-code task. */
export function isTrustedCodeDeliverable(subject: { kind?: TaskKind; workIntent?: WorkIntent }): boolean {
  if (subject.kind === 'release' || subject.kind === 'deploy') return true;
  return subject.kind === 'task' && subject.workIntent?.kind === 'code';
}
function baselineField(leg: AcceptanceLeg): { machineVerify: string; humanVerify: string; humanRisk: AcceptanceRisk } {
  if (leg === 'deploy') return { machineVerify: 'deploy-run', humanVerify: 'qa-production', humanRisk: 'runtime' };
  if (leg === 'release') return { machineVerify: 'ci', humanVerify: 'independent-release', humanRisk: 'code' };
  if (leg === 'implement') return { machineVerify: 'ci', humanVerify: 'independent-review', humanRisk: 'code' };
  return { machineVerify: 'ci', humanVerify: 'owner-acceptance', humanRisk: 'runtime' };
}
export function baselineAcceptanceCriteria(leg: AcceptanceLeg): AcceptanceCriterion[] {
  const ids = BASELINE_IDS[leg];
  const field = baselineField(leg);
  return [
    { id: ids.machine, kind: 'machine', required: true, layer: 'ci', evidence: 'ci-run', verify: field.machineVerify, risk: 'code',
      description: `${leg} baseline: required machine CI evidence (server-owned)` },
    { id: ids.human, kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: field.humanVerify, risk: field.humanRisk,
      description: `${leg} baseline: required real independent sign-off (server-owned)` },
  ];
}
const baselineCovered = (criterion: AcceptanceCriterion, baseline: AcceptanceCriterion, leg: AcceptanceLeg): boolean =>
  criterion.required && criterion.kind === baseline.kind && criterion.layer === baseline.layer &&
  criterion.evidence === baseline.evidence && criterion.verify === baseline.verify &&
  (!criterion.legs || criterion.legs.includes(leg));
/** Merge the server baseline into a caller's set. A baseline id with different fields is a downgrade and is refused. */
export function mergeAcceptanceCriteria(leg: AcceptanceLeg, custom: readonly AcceptanceCriterion[]): AcceptanceCriterion[] {
  if (leg !== 'implement' && leg !== 'release' && leg !== 'deploy') return [...custom];
  const baseline = baselineAcceptanceCriteria(leg);
  const ids = new Set(baseline.map(item => item.id));
  for (const criterion of custom) {
    if (criterion.id.startsWith('AC-BASE-') && !ids.has(criterion.id)) {
      throw invalid(`${criterion.id}: baseline ids are leg-scoped; use a normal AC id for a supplementary criterion`);
    }
    if (ids.has(criterion.id) && !baseline.some(item => item.id === criterion.id && baselineCovered(criterion, item, leg))) {
      throw invalid(`${criterion.id}: the server-owned ${leg} baseline criterion cannot be replaced or downgraded`);
    }
  }
  const missing = baseline.filter(item => !custom.some(criterion => baselineCovered(criterion, item, leg)));
  return [...custom, ...missing];
}

/** The facts the evaluator reads. core builds this from a TaskRow; it is not a database object. */
export interface AcceptanceSubject {
  id: string;
  kind?: TaskKind;
  workIntent?: WorkIntent;
  acceptanceCriteria?: AcceptanceCriterion[];
  acceptanceLegacy?: boolean;
  acceptanceHead?: string;
  acceptanceEnvironment?: string;
  acceptanceAttempt?: number;
  taskVersion?: number;
  submittedBy?: string;
  reviewerRole?: string;
  createdAt?: string;
}

/** Who is acting at the gate. `human:false` is the machine actor (Jev); it can never sign a human criterion. */
export interface AcceptanceActor { employeeId: string; role: string; human: boolean; owner?: boolean }

export interface AcceptanceInput {
  subject: AcceptanceSubject;
  evidence: readonly AcceptanceEvidenceRecord[];
  phase: AcceptancePhase;
  actor: AcceptanceActor;
  gate: AcceptanceGateView;
  leg?: AcceptanceLeg;
}

/** The task-row shape needed to build a subject; core, owner and workforce all read the same optional columns. */
export interface AcceptanceTaskRow {
  id: unknown;
  kind?: TaskKind;
  work_intent?: WorkIntent;
  acceptance_criteria?: AcceptanceCriterion[];
  acceptance_legacy?: boolean;
  acceptance_head?: string;
  acceptance_environment?: string;
  acceptance_attempt?: number;
  version?: number;
  submitted_by?: string;
  reviewer_role?: string;
  created_at?: unknown;
}
const rowId = (value: unknown): string =>
  typeof value === 'string' ? value : String((value as { id?: unknown } | null)?.id ?? value);
/** Build the evaluator subject from a task row, optionally overriding the head (submit binds the new head). */
export function acceptanceSubject(row: AcceptanceTaskRow, head?: string,
  overrides: { environment?: string; attempt?: number } = {}): AcceptanceSubject {
  let environment = row.acceptance_environment;
  try { environment = effectiveEnvironment(row.acceptance_criteria ?? [], row.acceptance_environment); }
  catch { /* a legacy/conflicting row keeps its stored value; the evaluator refuses it when a requirement exists */ }
  return {
    id: rowId(row.id), kind: row.kind, workIntent: row.work_intent, acceptanceCriteria: row.acceptance_criteria,
    acceptanceLegacy: row.acceptance_legacy, acceptanceHead: head ?? row.acceptance_head,
    acceptanceEnvironment: overrides.environment ?? environment,
    acceptanceAttempt: overrides.attempt ?? row.acceptance_attempt ?? 0,
    taskVersion: row.version, submittedBy: row.submitted_by, reviewerRole: row.reviewer_role,
    createdAt: row.created_at ? String(row.created_at) : undefined,
  };
}

/**
 * The attempt a piece of machine evidence or a status read belongs to: while the work is still in progress it is the
 * next submission attempt, and once a submission exists it is the attempt that was submitted. One rule for the evidence
 * writer, the evaluator and the status read, so a row is never judged against a different attempt than it was written for.
 */
export function acceptanceTargetAttempt(row: { state?: string; acceptance_attempt?: number }): number {
  const attempt = row.acceptance_attempt ?? 0;
  return ['ready', 'doing', 'blocked'].includes(row.state ?? '') ? attempt + 1 : attempt;
}

/** The AC06 legacy decision, shared by the evaluator and the submit environment check. */
export function isLegacyAcceptance(subject: AcceptanceSubject, gate: AcceptanceGateView): boolean {
  if (!gate.enabled) return true;
  if (subject.acceptanceLegacy === true) return true;
  const created = subject.createdAt ? Date.parse(subject.createdAt) : Number.NaN;
  const enabled = gate.enabledAt ? Date.parse(gate.enabledAt) : Number.NaN;
  return Number.isFinite(created) && Number.isFinite(enabled) && created < enabled;
}

/**
 * The single evaluator (SYS02 AC03). Rules:
 * - gate off: allow (legacy), so a rollback to a release without SYS02 never blocks old work;
 * - no criteria: legacy rows are allowed and marked; non-code tasks are not applicable; a current code deliverable is refused;
 * - machine: verified evidence for this AC, bound to the submitted head, with the criterion's evidence type and environment;
 * - human: at submit it is pending (the reviewer signs at review); elsewhere the current actor must be the authorized human
 *   signer, never the submitter. Jev (human:false) cannot satisfy a human criterion.
 */
export function evaluateAcceptance(input: AcceptanceInput): AcceptanceVerdict {
  const all = validateAcceptanceCriteria(input.subject.acceptanceCriteria);
  const trusted = isTrustedCodeDeliverable(input.subject);
  const leg = input.leg ?? acceptanceLegForSubject(input.subject);
  let criteria = input.leg !== undefined || trusted ? criteriaForLeg(all, leg) : all;
  const baseOf = (final: AcceptanceCriterion[]): Omit<AcceptanceVerdict, 'ok'> => ({
    phase: input.phase, gateEnabled: input.gate.enabled, legacy: false, notApplicable: false,
    criteriaVersion: input.gate.criteriaVersion, head: input.subject.acceptanceHead,
    environment: input.subject.acceptanceEnvironment, attempt: input.subject.acceptanceAttempt ?? 0,
    criteria: final, evidence: [...input.evidence], unmet: [],
  });
  if (!input.gate.enabled) return { ...baseOf(criteria), ok: true, legacy: true };
  // AC06/R1: a row created while the gate was off (or before enabledAt) keeps the old path even when it carries the
  // default criteria persisted by createDelivery. Enabling the gate must never retroactively require evidence from it.
  if (isLegacyAcceptance(input.subject, input.gate)) return { ...baseOf(criteria), ok: true, legacy: true };
  const scope = trusted || all.some(criterion => criterion.kind === 'machine');
  if (criteria.length === 0) {
    if (!scope) return { ...baseOf(criteria), ok: true, notApplicable: true };
    if (!trusted) return { ...baseOf(criteria), ok: false, unmet: [{ acId: '*', reason: 'structured-acceptance-criteria-required' }] };
  }
  // The trusted minimum is merged at evaluation too, so a row written before this fix (for example a caller-supplied
  // all-optional set) cannot reach review or done without the required machine evidence and independent sign-off.
  if (trusted) criteria = mergeAcceptanceCriteria(leg, criteria);
  const base = baseOf(criteria);
  const head = input.subject.acceptanceHead;
  const targetEnvironment = input.subject.acceptanceEnvironment;
  const targetAttempt = input.subject.acceptanceAttempt ?? 0;
  const criteriaVersion = input.gate.criteriaVersion;
  const unmet: AcceptanceUnmet[] = [];
  for (const criterion of criteria) {
    if (!criterion.required) continue;
    if (criterion.kind === 'machine') {
      if (criterion.environment !== undefined && criterion.environment !== targetEnvironment) {
        unmet.push({ acId: criterion.id, reason: 'environment-mismatch' });
        continue;
      }
      const candidates = head === undefined ? [] : input.evidence.filter(row =>
        row.acId === criterion.id && row.kind === 'machine' && row.verified === true &&
        row.evidenceType === criterion.evidence && row.sha === head);
      const verified = candidates.some(row => row.environment === targetEnvironment &&
        (row.attempt ?? 0) === targetAttempt && row.criteriaVersion === criteriaVersion);
      if (!verified) {
        const reason = head === undefined ? 'submission-head-missing'
          : candidates.some(row => (row.attempt ?? 0) !== targetAttempt) ? 'machine-evidence-wrong-attempt'
          : candidates.some(row => row.environment !== targetEnvironment) ? 'machine-evidence-wrong-environment'
          : candidates.some(row => row.criteriaVersion !== criteriaVersion) ? 'machine-evidence-stale-criteria-version'
          : 'machine-evidence-missing-or-untrusted';
        unmet.push({ acId: criterion.id, reason });
      }
      continue;
    }
    // A human sign-off already written at this task version is reused (the status read, or a later goal gate);
    // a new attempt has a higher version, so an older sign-off never satisfies it.
    const signed = input.evidence.some(row =>
      row.acId === criterion.id && row.kind === 'human' && row.verified === true &&
      (row.attempt ?? 0) === targetAttempt && row.criteriaVersion === criteriaVersion &&
      (head === undefined ? row.sha === input.subject.id : row.sha === head));
    if (signed) continue;
    if (input.phase === 'submit') continue;
    if (!input.actor.human) { unmet.push({ acId: criterion.id, reason: 'human-signoff-required' }); continue; }
    if (input.subject.submittedBy !== undefined && input.actor.employeeId === input.subject.submittedBy) {
      unmet.push({ acId: criterion.id, reason: 'self-review' }); continue;
    }
    if (input.phase === 'accept' && input.actor.role !== input.subject.reviewerRole) {
      unmet.push({ acId: criterion.id, reason: 'reviewer-role-mismatch' }); continue;
    }
    if (input.phase === 'owner' && input.actor.owner !== true) {
      unmet.push({ acId: criterion.id, reason: 'owner-signoff-required' }); continue;
    }
    if (input.phase === 'deploy' && input.actor.role !== 'qa' && input.actor.owner !== true) {
      unmet.push({ acId: criterion.id, reason: 'qa-signoff-required' }); continue;
    }
    if (input.phase === 'release' && !['product', 'gm'].includes(input.actor.role) && input.actor.owner !== true) {
      unmet.push({ acId: criterion.id, reason: 'release-signoff-role-mismatch' }); continue;
    }
  }
  return { ...base, ok: unmet.length === 0, unmet };
}

/** A refusal a caller can act on: the unmet AC ids and reasons travel in the message and in details. */
export function acceptanceError(verdict: AcceptanceVerdict): CompanyError {
  const list = verdict.unmet.map(item => `${item.acId}:${item.reason}`).join(', ');
  return new CompanyError('invalid',
    `acceptance gate blocked: ${list}; record verified evidence with record_acceptance_evidence, or sign at the independent review`,
    false, { unmet: verdict.unmet, phase: verdict.phase, criteriaVersion: verdict.criteriaVersion });
}

/** The human sign-offs the gate writes at accept/owner approval. The digest is unique per task, AC, signer and attempt. */
export interface HumanSignoff { acId: string; sha: string; criteriaVersion: number; attempt: number; digest: string }
export function humanSignoffs(verdict: AcceptanceVerdict, taskId: string, actor: string, attempt: number): HumanSignoff[] {
  // The old path (gate off or a legacy row) must not write SYS02 evidence at all.
  if (!verdict.gateEnabled || verdict.legacy) return [];
  return verdict.criteria.filter(criterion => criterion.required && criterion.kind === 'human').map(criterion => ({
    acId: criterion.id, sha: verdict.head ?? taskId, criteriaVersion: verdict.criteriaVersion, attempt,
    digest: createHash('sha256').update(JSON.stringify({
      taskId, acId: criterion.id, actor, sha: verdict.head ?? '', attempt,
    })).digest('hex'),
  }));
}

// ---- The evidence store. Rows are append-only; only the source adapter (or an authorized gate sign-off) writes verified=true. ----

interface GateRow { version?: number; enabled?: boolean; enabled_at?: unknown; scope?: string; criteria_version?: number }
export async function loadAcceptanceGate(db: Surreal): Promise<AcceptanceGateView> {
  const row = await db.select<GateRow>(new RecordId('company_meta', 'acceptance_gate'));
  return {
    version: row?.version ?? 1,
    enabled: row?.enabled === true,
    ...(row?.enabled_at ? { enabledAt: String(row.enabled_at) } : {}),
    scope: row?.scope ?? 'code-deliveries',
    criteriaVersion: row?.criteria_version ?? ACCEPTANCE_CRITERIA_VERSION,
  };
}

interface EvidenceRow {
  id: RecordId; task: RecordId; ac_id: string; kind: AcceptanceCriterionKind; sha: string; environment?: string;
  evidence_type: AcceptanceEvidenceType; source: Record<string, unknown>; verified: boolean; verifier: string;
  actor: string; at: unknown; criteria_version: number; task_version: number; attempt?: number; digest: string;
}
const evidenceView = (row: EvidenceRow): AcceptanceEvidenceRecord => ({
  id: String(row.id.id), taskId: String(row.task.id), acId: row.ac_id, kind: row.kind, sha: row.sha,
  ...(row.environment ? { environment: row.environment } : {}), evidenceType: row.evidence_type,
  source: row.source, verified: row.verified, verifier: row.verifier, actor: row.actor,
  at: String(row.at), criteriaVersion: row.criteria_version, taskVersion: row.task_version,
  ...(row.attempt !== undefined ? { attempt: row.attempt } : {}), digest: row.digest,
});

export async function loadAcceptanceEvidence(db: Surreal, taskId: string): Promise<AcceptanceEvidenceRecord[]> {
  const [rows] = await db.query<[EvidenceRow[]]>(
    'SELECT * FROM acceptance_evidence WHERE task = $task ORDER BY at, id;', { task: new RecordId('task', taskId) });
  return (rows ?? []).map(evidenceView);
}

export async function recordAcceptanceEvidenceRow(db: Surreal, input: {
  taskId: string; acId: string; kind: AcceptanceCriterionKind; sha: string; environment?: string;
  evidenceType: AcceptanceEvidenceType; source: Record<string, unknown>; verifier: string; actor: string;
  at: string; criteriaVersion: number; taskVersion: number; attempt?: number;
}): Promise<AcceptanceEvidenceRecord> {
  const digest = createHash('sha256').update(JSON.stringify({
    taskId: input.taskId, acId: input.acId, sha: input.sha, evidenceType: input.evidenceType, source: input.source,
    attempt: input.attempt, environment: input.environment, criteriaVersion: input.criteriaVersion,
  })).digest('hex');
  const record = new RecordId('acceptance_evidence', digest.slice(0, 32));
  try {
    // Optional fields are omitted when absent: a NULL is not NONE in a schemaless option field.
    const environment = input.environment !== undefined ? 'environment: $environment,' : '';
    const attempt = input.attempt !== undefined ? 'attempt: $attempt,' : '';
    const vars: Record<string, unknown> = {
      id: record, task: new RecordId('task', input.taskId), ac: input.acId, kind: input.kind, sha: input.sha,
      type: input.evidenceType, source: input.source, verifier: input.verifier, actor: input.actor, at: input.at,
      criteria: input.criteriaVersion, version: input.taskVersion, digest,
    };
    if (input.environment !== undefined) vars.environment = input.environment;
    if (input.attempt !== undefined) vars.attempt = input.attempt;
    const [rows] = await db.query<[EvidenceRow[]]>(`CREATE $id CONTENT {
      task: $task, ac_id: $ac, kind: $kind, sha: $sha, ${environment} ${attempt} evidence_type: $type,
      source: $source, verified: true, verifier: $verifier, actor: $actor, at: <datetime>$at,
      criteria_version: $criteria, task_version: $version, digest: $digest
    };`, vars);
    return evidenceView(rows[0]!);
  } catch (error) {
    // An identical source (same run/artifact/probe) is idempotent, not a conflict.
    const [rows] = await db.query<[EvidenceRow[]]>('SELECT * FROM acceptance_evidence WHERE digest = $digest LIMIT 1;', { digest });
    if (rows?.[0]) return evidenceView(rows[0]);
    throw error;
  }
}

// ---- The source adapter. The default reads GitHub Actions read-only through gh; tests inject a deterministic run registry. ----

export const ACCEPTANCE_PROBE_VERSION = 'acceptance-probe/2';
export interface ProbeRecord {
  runId: string; jobId?: string; readAt: string; inProgress: boolean; observationHash: string;
  /** Trusted producer version; the real adapter refuses a record without it. */
  probeVersion?: string;
  /** The producer run and the target run/job it read while the target was in progress. */
  producerRunId?: string; targetRunId?: string; targetJobId?: string; targetWorkflow?: string; targetStatus?: string;
  kind?: string; nodeVersion?: string; bundleHash?: string; annotationHash?: string; channel?: string; statusCreatedAt?: string;
  /** The environment the trusted probe read from its CI context; the adapter corroborates it with the deployment record. */
  environment?: string;
}
export interface AcceptanceSourceInput {
  provider: 'github-actions';
  runUrl: string;
  artifactId?: string;
  sha: string;
  environment?: string;
  probe?: ProbeRecord;
  /** The criterion's own verify/risk, so the adapter binds the probe kind/target to the AC it satisfies. */
  verify?: string;
  risk?: string;
}
export type AcceptanceVerifyResult =
  | { ok: true; sha: string; at: string; environment?: string; source: Record<string, unknown> }
  | { ok: false; reason: string };
export interface AcceptanceSourceAdapter { verify(input: AcceptanceSourceInput): Promise<AcceptanceVerifyResult> }

const RUN_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)\/?$/;

/** One artifact's record as downloaded from a run; tests inject a deterministic reader. */
export interface ArtifactRecord { name: string; content: string }
export type ArtifactReader = (input: { owner: string; repo: string; runId: string; artifactId: string; name: string }) => Promise<ArtifactRecord>;

/** Read-only artifact download through gh; the file is read from a private temporary directory and removed. */
const ghArtifactReader = (run: GhRunner): ArtifactReader => async ({ owner, repo, runId, name }) => {
  const dir = mkdtempSync(join(tmpdir(), 'sck-acceptance-artifact-'));
  try {
    await run(['run', 'download', runId, '--repo', `${owner}/${repo}`, '--name', name, '--dir', dir]);
    const files = readdirSync(dir, { recursive: true }) as string[];
    const file = files.find(entry => entry.endsWith('acceptance-probe.json')) ?? files.find(entry => entry.endsWith('.json'));
    if (!file) throw new Error('the artifact has no acceptance probe JSON record');
    return { name: file, content: readFileSync(join(dir, file), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

interface ProbeArtifactRecord extends ProbeRecord { probe?: string; target?: string; kind?: string; result?: string }

/**
 * Read-only GitHub Actions adapter (SYS02 AC02/AC04). It reads the run through gh and requires the run's head to equal the
 * submitted sha and the conclusion to be success. A probe is the artifact's record, not a caller claim: the artifact must
 * come from the same run and head, and its JSON record must match the caller's attested fields. An artifact-only criterion
 * still requires an unexpired artifact of the same head. The adapter never reads product credentials.
 */
export function createGithubActionsAdapter(run: GhRunner = ghCli, readArtifact: ArtifactReader = ghArtifactReader(run)): AcceptanceSourceAdapter {
  return {
    async verify(input) {
      const match = RUN_URL.exec(input.runUrl);
      if (!match) return { ok: false, reason: 'runUrl must be https://github.com/<owner>/<repo>/actions/runs/<id>' };
      const [, owner, repo, runId] = match as unknown as [string, string, string, string];
      let info: { headSha?: string; status?: string; conclusion?: string; workflowName?: string; createdAt?: string; updatedAt?: string };
      try {
        info = JSON.parse(await run(['run', 'view', runId, '--repo', `${owner}/${repo}`,
          '--json', 'headSha,status,conclusion,workflowName,createdAt,updatedAt']));
      } catch (error) {
        return { ok: false, reason: `the CI run could not be read: ${(error as Error).message.slice(0, 160)}` };
      }
      if (info.headSha !== input.sha) return { ok: false, reason: `the CI run head ${info.headSha ?? '?'} is not the submitted sha ${input.sha}` };
      if (info.conclusion !== 'success') return { ok: false, reason: `the CI run is not successful (conclusion ${info.conclusion ?? 'unknown'})` };
      let at = info.updatedAt ?? new Date().toISOString();
      let verifiedProbe: Record<string, unknown> | undefined;
      let probeEnvironment: string | undefined;
      if (input.probe) {
        // A probe record must be the CI artifact's content: the artifact has to belong to this run and head, and the
        // caller's attested fields must match what the artifact actually holds. A window-shaped caller record alone is refused.
        if (input.artifactId === undefined) return { ok: false, reason: 'a probe requires the CI artifact that carries its record' };
        let artifact: { name?: string; expired?: boolean; workflow_run?: { id?: number | string; head_sha?: string } };
        try {
          artifact = JSON.parse(await run(['api', `repos/${owner}/${repo}/actions/artifacts/${input.artifactId}`]));
        } catch (error) {
          return { ok: false, reason: `the probe artifact could not be read: ${(error as Error).message.slice(0, 160)}` };
        }
        if (artifact.expired === true) return { ok: false, reason: 'the probe artifact has expired' };
        if (String(artifact.workflow_run?.id ?? '') !== runId) return { ok: false, reason: 'the probe artifact belongs to another run' };
        if (artifact.workflow_run?.head_sha !== input.sha) return { ok: false, reason: 'the probe artifact belongs to another head' };
        let pulled: ArtifactRecord;
        try {
          pulled = await readArtifact({ owner, repo, runId, artifactId: input.artifactId, name: artifact.name ?? 'acceptance-probe' });
        } catch (error) {
          return { ok: false, reason: `the probe record could not be read from its artifact: ${(error as Error).message.slice(0, 160)}` };
        }
        let record: ProbeArtifactRecord;
        try {
          record = JSON.parse(pulled.content) as ProbeArtifactRecord;
        } catch {
          return { ok: false, reason: 'the probe artifact does not hold a JSON record' };
        }
        probeEnvironment = typeof record.environment === 'string' ? record.environment : undefined;
        if (record.probe !== 'acceptance' || String(record.runId) !== runId || record.inProgress !== true || record.result !== 'ok') {
          return { ok: false, reason: 'the probe artifact record is not an in-progress acceptance probe from this run' };
        }
        if (typeof record.observationHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.observationHash)) {
          return { ok: false, reason: 'the probe artifact observation hash is not a sha256' };
        }
        const started = Date.parse(info.createdAt ?? '');
        const read = Date.parse(record.readAt);
        const ended = Date.parse(info.updatedAt ?? '');
        if (!Number.isFinite(started) || !Number.isFinite(read) || !Number.isFinite(ended) || read < started || read > ended) {
          return { ok: false, reason: 'the probe artifact read time is outside the CI run window' };
        }
        if (input.probe.runId !== String(record.runId) || input.probe.inProgress !== record.inProgress ||
            input.probe.observationHash !== record.observationHash || Date.parse(input.probe.readAt) !== read ||
            (input.probe.environment !== undefined && input.probe.environment !== record.environment)) {
          return { ok: false, reason: 'the probe record does not match the CI artifact record' };
        }
        // A trusted probe is bound to its producer version, its criterion kind/risk, and (for a running channel) the actual
        // target run/job whose in-progress window contains readAt. A local server, a fake adapter or a self-passed RUN_ID has
        // no target run/job and is refused here.
        if (record.probeVersion !== ACCEPTANCE_PROBE_VERSION) return { ok: false, reason: 'the probe record is not from the trusted probe version' };
        const expectedKind = input.verify?.startsWith('probe:') ? input.verify.slice('probe:'.length) : undefined;
        if (expectedKind !== undefined && record.kind !== expectedKind) {
          return { ok: false, reason: `the probe kind ${record.kind ?? '?'} does not match the criterion verify ${input.verify}` };
        }
        if (input.risk === 'packaging' && record.kind !== 'node-packed') return { ok: false, reason: 'a packaging criterion needs the node-packed probe' };
        if (record.kind === 'node-packed') {
          if (typeof record.nodeVersion !== 'string' || !/^v\d+\./.test(record.nodeVersion)) return { ok: false, reason: 'the node-packed probe does not name the Node version' };
          if (typeof record.bundleHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.bundleHash)) return { ok: false, reason: 'the node-packed probe has no bundle hash' };
        } else if (record.kind === 'running-channel') {
          if (!record.targetRunId || !record.targetJobId || record.producerRunId !== runId) {
            return { ok: false, reason: 'the running-channel probe is not bound to a producer and target run' };
          }
          if (record.targetStatus !== 'in_progress') return { ok: false, reason: 'the target was not in progress when read' };
          let targetRun: { head_sha?: string; run_started_at?: string; updated_at?: string; name?: string; path?: string };
          try {
            targetRun = JSON.parse(await run(['api', `repos/${owner}/${repo}/actions/runs/${record.targetRunId}`]));
          } catch (error) {
            return { ok: false, reason: `the target run could not be read: ${(error as Error).message.slice(0, 160)}` };
          }
          if (targetRun.head_sha !== input.sha) return { ok: false, reason: 'the target run head is not the submitted sha' };
          if (record.targetWorkflow && targetRun.name !== record.targetWorkflow && targetRun.path !== record.targetWorkflow) {
            return { ok: false, reason: 'the target run is not the named target workflow' };
          }
          const targetStart = Date.parse(targetRun.run_started_at ?? '');
          const targetEnd = Date.parse(targetRun.updated_at ?? '');
          if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd) || read < targetStart || read > targetEnd) {
            return { ok: false, reason: 'the probe read time is outside the target run window' };
          }
          let targetJob: { run_id?: number; head_sha?: string; started_at?: string; completed_at?: string | null; check_run_url?: string };
          try {
            targetJob = JSON.parse(await run(['api', `repos/${owner}/${repo}/actions/jobs/${record.targetJobId}`]));
          } catch (error) {
            return { ok: false, reason: `the target job could not be read: ${(error as Error).message.slice(0, 160)}` };
          }
          if (String(targetJob.run_id ?? '') !== record.targetRunId || targetJob.head_sha !== input.sha) {
            return { ok: false, reason: 'the target job is not from the target run and head' };
          }
          const jobStart = Date.parse(targetJob.started_at ?? '');
          const jobEnd = targetJob.completed_at ? Date.parse(targetJob.completed_at) : Number.POSITIVE_INFINITY;
          if (!Number.isFinite(jobStart) || !(jobStart <= read && read <= jobEnd)) {
            return { ok: false, reason: 'the probe read time is outside the target job in-progress window' };
          }
          // The check-run annotation API does not expose a running job's notice (the real run showed it only after
          // completion), so the trusted in-progress channel is a commit status the target job creates at start.
          if (record.channel !== 'commit-status') return { ok: false, reason: 'the running-channel probe did not read the commit-status channel' };
          let statuses: Array<{ context?: string; description?: string; state?: string; created_at?: string }>;
          try {
            statuses = JSON.parse(await run(['api', `repos/${owner}/${repo}/commits/${input.sha}/statuses`]));
          } catch (error) {
            return { ok: false, reason: `the target status channel could not be read: ${(error as Error).message.slice(0, 160)}` };
          }
          const marker = (Array.isArray(statuses) ? statuses : []).find(item => item.context === 'acceptance-barrier' && item.description === 'target-ready');
          if (!marker) return { ok: false, reason: 'the target commit-status channel has no barrier marker' };
          const statusAt = Date.parse(marker.created_at ?? '');
          if (!Number.isFinite(statusAt) || statusAt < jobStart || statusAt > read) {
            return { ok: false, reason: 'the barrier status was not created inside the target in-progress window' };
          }
          const statusHash = createHash('sha256').update(JSON.stringify({ context: marker.context ?? '', description: marker.description ?? '' })).digest('hex');
          if (statusHash !== record.annotationHash) return { ok: false, reason: 'the target status hash does not match the record' };
          if (record.statusCreatedAt !== undefined && Date.parse(record.statusCreatedAt) !== statusAt) {
            return { ok: false, reason: 'the record status time does not match the target status' };
          }
        } else {
          return { ok: false, reason: 'the probe kind is unknown' };
        }
        at = record.readAt;
        verifiedProbe = record as unknown as Record<string, unknown>;
      } else if (input.artifactId) {
        let artifact: { expired?: boolean; workflow_run?: { head_sha?: string } };
        try {
          artifact = JSON.parse(await run(['api', `repos/${owner}/${repo}/actions/artifacts/${input.artifactId}`]));
        } catch (error) {
          return { ok: false, reason: `the artifact could not be read: ${(error as Error).message.slice(0, 160)}` };
        }
        if (artifact.expired === true) return { ok: false, reason: 'the artifact has expired' };
        if (artifact.workflow_run?.head_sha !== input.sha) return { ok: false, reason: 'the artifact belongs to another head' };
      }
      // N1: an environment is never taken from the caller's label. When the criterion/task declares one, the GitHub
      // deployment record for this run/head must corroborate it; an environment-labeled probe cannot satisfy a generic
      // criterion. Undefined here means "generic CI", not "any environment".
      if (input.environment === undefined && probeEnvironment !== undefined) {
        return { ok: false, reason: `the probe record names environment ${probeEnvironment} but the criterion did not require one` };
      }
      if (input.environment !== undefined && probeEnvironment !== undefined && probeEnvironment !== input.environment) {
        return { ok: false, reason: `the probe record environment ${probeEnvironment} is not the declared environment ${input.environment}` };
      }
      let verifiedEnvironment: string | undefined;
      if (input.environment !== undefined) {
        let deployments: Array<{ environment?: string; sha?: string; created_at?: string }>;
        try {
          const raw = JSON.parse(await run(['api',
            `repos/${owner}/${repo}/deployments?sha=${encodeURIComponent(input.sha)}&environment=${encodeURIComponent(input.environment)}&per_page=100`]));
          deployments = Array.isArray(raw) ? raw : [];
        } catch (error) {
          return { ok: false, reason: `the environment could not be verified: ${(error as Error).message.slice(0, 160)}` };
        }
        const windowStart = Date.parse(info.createdAt ?? '');
        const windowEnd = Date.parse(info.updatedAt ?? '');
        const deployment = deployments.find(item => item?.environment === input.environment &&
          (item.sha === undefined || item.sha === input.sha) &&
          Number.isFinite(Date.parse(item.created_at ?? '')) &&
          Date.parse(item.created_at ?? '') >= windowStart && Date.parse(item.created_at ?? '') <= windowEnd);
        if (!deployment) return { ok: false, reason: `the CI run has no deployment for environment ${input.environment}` };
        verifiedEnvironment = input.environment;
      }
      return {
        ok: true, sha: input.sha, at,
        ...(verifiedEnvironment !== undefined ? { environment: verifiedEnvironment } : {}),
        source: {
          provider: 'github-actions', runUrl: input.runUrl, runId, workflowName: info.workflowName ?? null,
          conclusion: info.conclusion, ...(verifiedProbe ? { probe: verifiedProbe } : {}),
          ...(verifiedEnvironment !== undefined ? { environment: verifiedEnvironment } : {}),
          ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        },
      };
    },
  };
}
