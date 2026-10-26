// SYS02: one acceptance model for every gate. Criteria are versioned on the task; evidence is server-verified and bound to
// the submitted head; the evaluator is pure, so submit / review accept / release approval / deploy / owner gate all judge
// the same facts the same way. Self-written text or an arbitrary URL never becomes a machine pass fact: only the source
// adapter can set verified=true.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId, type Surreal } from 'surrealdb';
import type {
  AcceptanceCriterion, AcceptanceCriterionKind, AcceptanceEvidenceRecord, AcceptanceEvidenceType, AcceptanceGateView,
  AcceptanceLayer, AcceptanceLeg, AcceptancePhase, AcceptanceRisk, AcceptanceUnmet, AcceptanceVerdict, TaskKind, WorkIntent,
} from './contracts.ts';
import { CompanyError } from './core-errors.ts';
import {
  associateDeploymentSource, type DeploymentRecord, type DeploymentStatusRecord,
} from './deployment-source.ts';
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
  provider: 'github-actions' | 'managed-local-test';
  runUrl?: string;
  artifactId?: string;
  sha: string;
  environment?: string;
  probe?: ProbeRecord;
  /** The criterion's own verify/risk, so the adapter binds the probe kind/target to the AC it satisfies. */
  verify?: string;
  risk?: string;
  /** Allowlisted suite recorded by scripts/managed-local-test.sh. */
  suite?: string;
  /** Real owner_reply audit id that authorizes the managed-local-test exception. */
  ownerReplyAuditId?: string;
  /** Task that received the owner_reply. */
  ownerReplyTaskId?: string;
  /** The task asking to record evidence (used to enforce the authorization scope). */
  requestingTaskId?: string;
}
export type AcceptanceVerifyResult =
  | { ok: true; sha: string; at: string; environment?: string; source: Record<string, unknown> }
  | { ok: false; reason: string };
export interface AcceptanceSourceAdapter { verify(input: AcceptanceSourceInput): Promise<AcceptanceVerifyResult> }

/**
 * Owner-authorized managed local test exception (SYS02).
 *
 * The host script `scripts/managed-local-test.sh` writes a gate record under the service home. This adapter
 * verifies that record (sha, exitCode, logHash, dirty=false, allowlisted suite) and a real `owner_reply`
 * audit whose evidence matches the authorized wording. An employee-uploaded JSON is never the proof: the
 * record must already exist on the host at the path the host script writes.
 */
export const MANAGED_LOCAL_TEST_GATE = 'managed-local-test';
export const MANAGED_LOCAL_TEST_SUITES = ['sys04-runtime-diagnostics', 'sys02-local-evidence'] as const;
export type ManagedLocalTestSuite = (typeof MANAGED_LOCAL_TEST_SUITES)[number];

/**
 * Tasks that may consume a managed-local-test record under the owner_reply of 2026-10-26
 * ("无法取得就在本地运行单元测试，通过就可以"): the authorizing deploy task, this repair chain, and nothing else.
 * Expanding the set is a code change, never a free-form argument.
 */
export const MANAGED_LOCAL_TEST_AUTHORIZED_TASKS: readonly string[] = [
  '25ec8d1a-6bbf-4bee-abaf-74998adeb5af', // SYS04 deploy (owner_reply target)
  '612f1946-ccab-42b6-b426-c3b032eb6a11', // this repair · implement
  '690ea881-7663-41a5-a984-bfed0c189cde', // this repair · release
  '231e786b-dc11-4649-82ad-1d5e6b99790d', // this repair · deploy
];

/** Exact owner wording that authorizes the exception; a paraphrase is not accepted. */
export const MANAGED_LOCAL_TEST_OWNER_PHRASE = '无法取得就在本地运行单元测试，通过就可以';

/** Fixed owner_reply that authorizes PR-gate CI substitution for the tasks above (code-bound, not free-form). */
export const MANAGED_LOCAL_TEST_OWNER_REPLY_AUDIT_ID = 'wuj9vmp3vg9pqyu33p2v';
export const MANAGED_LOCAL_TEST_OWNER_REPLY_TASK_ID = '25ec8d1a-6bbf-4bee-abaf-74998adeb5af';

/**
 * Suite required when substituting a red GitHub check-run at submit time.
 * Distinct from sys04-runtime-diagnostics (content-bound SYS04 suite).
 */
export const MANAGED_LOCAL_TEST_SUBMIT_SUITE: ManagedLocalTestSuite = 'sys02-local-evidence';

/** Protocol / schema version embedded in every signed attestation payload. */
export const MANAGED_LOCAL_TEST_PROTOCOL = 'managed-local-test/1';

export interface ManagedLocalTestRecord {
  gate: string;
  suite: string;
  sha: string;
  bun: string;
  bunPath: string;
  platform: string;
  arch?: string;
  result: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  command: string;
  target: string;
  repoIdentity: string;
  dirty: boolean;
  log: string;
  logHash: string;
  why?: string;
  protocolVersion?: string;
  /** Process identity that ran the suite (hostname + uid), never a secret. */
  runnerIdentity?: string;
  /** Authorization scope bound into the signed payload (host agent supplies these). */
  requestingTaskId?: string;
  ownerReplyAuditId?: string;
  ownerReplyTaskId?: string;
  /**
   * `managed` = a trusted signing agent attested the record.
   * `dry-run` = engineer/sandbox self-run without the agent — never substitutes CI.
   */
  hostMode?: 'managed' | 'dry-run';
  /** HMAC-SHA256 (hex) over the canonical attestation payload; required when hostMode=managed. */
  hostAttestation?: string;
}

export type ManagedLocalTestRecordReader = (input: { sha: string; suite: string }) => Promise<ManagedLocalTestRecord | null>;
export type OwnerReplyReader = (input: { taskId: string; auditId: string }) => Promise<{ action: string; actor: string; evidence: string; at: string } | null>;

/**
 * Trusted signing/verification agent seam (SYS02 v11).
 *
 * The key material lives ONLY inside the agent implementation the host wires in.
 * Core never reads private/service.env (or any employee-reachable env) to derive a secret.
 * Production default is fail-closed until an agent is injected.
 */
export interface ManagedLocalTestAttestationAgent {
  /** Sign a canonical payload; returns 64-char lowercase hex HMAC (or equivalent). */
  sign(payload: string): string;
  /** Verify attestation against the same canonical payload. */
  verify(payload: string, attestation: string): boolean;
  /** Stable non-secret name for audits (e.g. "test-hmac", "host-agent/1"). */
  readonly name: string;
}

/** Fields that participate in the signed canonical record (order is protocol-stable). */
export type ManagedLocalTestSignedFields = Readonly<{
  protocolVersion: string;
  gate: string;
  sha: string;
  suite: string;
  result: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  command: string;
  target: string;
  repoIdentity: string;
  dirty: boolean;
  logHash: string;
  runnerIdentity: string;
  requestingTaskId: string;
  ownerReplyAuditId: string;
  ownerReplyTaskId: string;
}>;

/** Default service-home resolution (same as the host script). */
export function managedLocalTestServiceHome(): string {
  return process.env.SCK_SERVICE_HOME ?? join(process.env.HOME ?? '', 'Library/Application Support/SurrealCKCompany');
}

/**
 * Canonical attestation payload. Both the host signing agent and the verifier MUST use this
 * exact field set and order; any security-relevant mutation changes the MAC.
 */
export function managedLocalTestAttestationPayload(fields: ManagedLocalTestSignedFields): string {
  return [
    `protocolVersion=${fields.protocolVersion}`,
    `gate=${fields.gate}`,
    `sha=${fields.sha}`,
    `suite=${fields.suite}`,
    `result=${fields.result}`,
    `exitCode=${fields.exitCode}`,
    `startedAt=${fields.startedAt}`,
    `finishedAt=${fields.finishedAt}`,
    `command=${fields.command}`,
    `target=${fields.target}`,
    `repoIdentity=${fields.repoIdentity}`,
    `dirty=${fields.dirty ? 'true' : 'false'}`,
    `logHash=${fields.logHash}`,
    `runnerIdentity=${fields.runnerIdentity}`,
    `requestingTaskId=${fields.requestingTaskId}`,
    `ownerReplyAuditId=${fields.ownerReplyAuditId}`,
    `ownerReplyTaskId=${fields.ownerReplyTaskId}`,
  ].join('\n');
}

export function signedFieldsFromRecord(
  record: ManagedLocalTestRecord,
  scope: { requestingTaskId: string; ownerReplyAuditId: string; ownerReplyTaskId: string },
): ManagedLocalTestSignedFields | { error: string } {
  if (record.protocolVersion !== MANAGED_LOCAL_TEST_PROTOCOL) {
    return { error: `protocolVersion must be ${MANAGED_LOCAL_TEST_PROTOCOL}` };
  }
  if (typeof record.runnerIdentity !== 'string' || record.runnerIdentity.length < 1) {
    return { error: 'gate record is missing runnerIdentity' };
  }
  if (typeof record.target !== 'string' || !record.target.startsWith('/')) {
    return { error: 'gate record target must be an absolute path' };
  }
  if (typeof record.repoIdentity !== 'string' || record.repoIdentity.length < 1) {
    return { error: 'gate record is missing repoIdentity' };
  }
  // A release snapshot must prove content↔commit binding via a real ops repo identity, never "release:<sha>" alone.
  if (record.repoIdentity === `release:${record.sha}` || record.repoIdentity.startsWith('release:')) {
    return { error: 'gate record repoIdentity is an unbound release label; content must match an ops checkout' };
  }
  if (record.requestingTaskId !== undefined && record.requestingTaskId !== scope.requestingTaskId) {
    return { error: `gate record requestingTaskId ${record.requestingTaskId} does not match the requesting task` };
  }
  if (record.ownerReplyAuditId !== undefined && record.ownerReplyAuditId !== scope.ownerReplyAuditId) {
    return { error: 'gate record ownerReplyAuditId does not match the authorizing audit' };
  }
  if (record.ownerReplyTaskId !== undefined && record.ownerReplyTaskId !== scope.ownerReplyTaskId) {
    return { error: 'gate record ownerReplyTaskId does not match the authorizing task' };
  }
  return {
    protocolVersion: MANAGED_LOCAL_TEST_PROTOCOL,
    gate: MANAGED_LOCAL_TEST_GATE,
    sha: record.sha,
    suite: record.suite,
    result: record.result,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    command: record.command,
    target: record.target,
    repoIdentity: record.repoIdentity,
    dirty: record.dirty === true,
    logHash: record.logHash,
    runnerIdentity: record.runnerIdentity,
    requestingTaskId: scope.requestingTaskId,
    ownerReplyAuditId: scope.ownerReplyAuditId,
    ownerReplyTaskId: scope.ownerReplyTaskId,
  };
}

/**
 * Test-only / host-agent helper: HMAC-SHA256 over the canonical payload with an injected secret.
 * Production core never constructs this from private/service.env or employee env.
 */
export function createHmacManagedLocalTestAgent(secret: string, name = 'hmac-agent/1'): ManagedLocalTestAttestationAgent {
  if (!secret || secret.length < 16) throw new Error('managed-local-test agent secret is too short');
  return {
    name,
    sign(payload: string) {
      return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    },
    verify(payload: string, attestation: string) {
      if (!/^[0-9a-f]{64}$/.test(attestation)) return false;
      const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(attestation, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}

/** @deprecated Use createHmacManagedLocalTestAgent + managedLocalTestAttestationPayload(signedFields). */
export function signManagedLocalTestAttestation(
  record: Pick<ManagedLocalTestRecord, 'sha' | 'suite' | 'exitCode' | 'logHash' | 'finishedAt' | 'command'> & Partial<ManagedLocalTestRecord>,
  secret: string,
  scope?: { requestingTaskId: string; ownerReplyAuditId: string; ownerReplyTaskId: string },
): string {
  const agent = createHmacManagedLocalTestAgent(secret, 'legacy-test-hmac');
  const full: ManagedLocalTestRecord = {
    gate: MANAGED_LOCAL_TEST_GATE,
    bun: record.bun ?? '0',
    bunPath: record.bunPath ?? '/bun',
    platform: record.platform ?? 'darwin',
    result: record.result ?? 'pass',
    startedAt: record.startedAt ?? record.finishedAt,
    target: record.target ?? '/target',
    repoIdentity: record.repoIdentity ?? '/ops/.git',
    dirty: record.dirty ?? false,
    log: record.log ?? '/log',
    protocolVersion: record.protocolVersion ?? MANAGED_LOCAL_TEST_PROTOCOL,
    runnerIdentity: record.runnerIdentity ?? 'test-runner',
    sha: record.sha,
    suite: record.suite,
    exitCode: record.exitCode,
    finishedAt: record.finishedAt,
    command: record.command,
    logHash: record.logHash,
  };
  const fields = signedFieldsFromRecord(full, scope ?? {
    requestingTaskId: record.requestingTaskId ?? '612f1946-ccab-42b6-b426-c3b032eb6a11',
    ownerReplyAuditId: record.ownerReplyAuditId ?? MANAGED_LOCAL_TEST_OWNER_REPLY_AUDIT_ID,
    ownerReplyTaskId: record.ownerReplyTaskId ?? MANAGED_LOCAL_TEST_OWNER_REPLY_TASK_ID,
  });
  if ('error' in fields) throw new Error(fields.error);
  return agent.sign(managedLocalTestAttestationPayload(fields));
}

export function verifyManagedLocalTestAttestation(
  record: ManagedLocalTestRecord,
  agent: ManagedLocalTestAttestationAgent | null | undefined,
  scope: { requestingTaskId: string; ownerReplyAuditId: string; ownerReplyTaskId: string },
): { ok: true; payload: string } | { ok: false; reason: string } {
  if (record.hostMode !== 'managed') {
    return { ok: false, reason: 'gate record hostMode is not managed (engineer dry-run cannot substitute CI)' };
  }
  if (typeof record.hostAttestation !== 'string' || !/^[0-9a-f]{64}$/.test(record.hostAttestation)) {
    return { ok: false, reason: 'gate record is missing a hostAttestation HMAC' };
  }
  if (!agent) {
    return {
      ok: false,
      reason: 'managed-local-test signing agent is not wired (production fail-closed; host must inject ManagedLocalTestAttestationAgent)',
    };
  }
  const fields = signedFieldsFromRecord(record, scope);
  if ('error' in fields) return { ok: false, reason: fields.error };
  const payload = managedLocalTestAttestationPayload(fields);
  if (!agent.verify(payload, record.hostAttestation)) {
    return { ok: false, reason: `gate record hostAttestation does not verify under agent ${agent.name}` };
  }
  return { ok: true, payload };
}

/** Default reader: the host-written gate record under SCK_SERVICE_HOME/gates/managed-local-test/<sha>.json. */
export const defaultManagedLocalTestReader: ManagedLocalTestRecordReader = async ({ sha }) => {
  const path = join(managedLocalTestServiceHome(), 'gates', MANAGED_LOCAL_TEST_GATE, `${sha}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ManagedLocalTestRecord;
  } catch {
    return null;
  }
};

/**
 * Verify a host-written managed-local-test record against the submitted sha and an owner_reply authorization.
 * Pure enough for unit tests when `readRecord`, `readOwnerReply`, and `attestationAgent` are injected.
 * Production has no default agent: requireHostAttestation fails closed until the host wires one.
 */
export async function verifyManagedLocalTest(input: {
  sha: string;
  suite: string;
  ownerReplyAuditId: string;
  ownerReplyTaskId: string;
  requestingTaskId: string;
  readRecord?: ManagedLocalTestRecordReader;
  readOwnerReply?: OwnerReplyReader;
  readLogHash?: (logPath: string) => string;
  /** Trusted attestation agent; production default is unset (fail-closed). */
  attestationAgent?: ManagedLocalTestAttestationAgent | null;
  /** @deprecated Ignored — secrets are never read from private/service.env. */
  readHostSecret?: () => string | null;
  /** When true (default), hostMode must be managed and attestation must verify. */
  requireHostAttestation?: boolean;
}): Promise<AcceptanceVerifyResult> {
  if (!MANAGED_LOCAL_TEST_SUITES.includes(input.suite as ManagedLocalTestSuite)) {
    return { ok: false, reason: `suite must be one of ${MANAGED_LOCAL_TEST_SUITES.join(', ')}` };
  }
  if (!MANAGED_LOCAL_TEST_AUTHORIZED_TASKS.includes(input.requestingTaskId)) {
    return { ok: false, reason: `task ${input.requestingTaskId} is not in the owner-authorized managed-local-test scope` };
  }
  if (!MANAGED_LOCAL_TEST_AUTHORIZED_TASKS.includes(input.ownerReplyTaskId)) {
    return { ok: false, reason: `owner_reply task ${input.ownerReplyTaskId} is not in the authorized scope` };
  }
  if (!input.readOwnerReply) {
    return { ok: false, reason: 'owner_reply reader is not configured' };
  }
  const reply = await input.readOwnerReply({ taskId: input.ownerReplyTaskId, auditId: input.ownerReplyAuditId });
  if (!reply) return { ok: false, reason: 'owner_reply audit not found' };
  if (reply.action !== 'owner_reply') return { ok: false, reason: `audit action is ${reply.action}, not owner_reply` };
  if (!reply.actor.startsWith('owner:')) return { ok: false, reason: 'owner_reply actor is not an owner source' };
  const bodyOk = reply.evidence.includes(MANAGED_LOCAL_TEST_OWNER_PHRASE)
    && /决定：\s*reply/.test(reply.evidence);
  if (!bodyOk) {
    return { ok: false, reason: 'owner_reply evidence does not carry the authorized local-test wording' };
  }

  const readRecord = input.readRecord ?? defaultManagedLocalTestReader;
  const record = await readRecord({ sha: input.sha, suite: input.suite });
  if (!record) return { ok: false, reason: `no managed-local-test gate record for sha ${input.sha}` };
  if (record.gate !== MANAGED_LOCAL_TEST_GATE) return { ok: false, reason: `gate record is for ${record.gate}, not ${MANAGED_LOCAL_TEST_GATE}` };
  if (record.suite !== input.suite) return { ok: false, reason: `gate record suite ${record.suite} is not ${input.suite}` };
  if (record.sha !== input.sha) return { ok: false, reason: `gate record sha ${record.sha} is not the submitted sha ${input.sha}` };
  if (record.dirty === true) return { ok: false, reason: 'gate record was taken on a dirty worktree' };
  if (record.result !== 'pass' || record.exitCode !== 0) {
    return { ok: false, reason: `managed local test did not pass (result=${record.result}, exitCode=${record.exitCode})` };
  }
  if (typeof record.log !== 'string' || typeof record.logHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.logHash)) {
    return { ok: false, reason: 'gate record is missing a sha256 logHash' };
  }
  const hashOf = input.readLogHash ?? ((path: string) => createHash('sha256').update(readFileSync(path)).digest('hex'));
  let actualHash: string;
  try {
    actualHash = hashOf(record.log);
  } catch {
    return { ok: false, reason: 'gate log could not be read to verify logHash' };
  }
  if (actualHash !== record.logHash) return { ok: false, reason: 'gate logHash does not match the log on disk' };
  if (typeof record.startedAt !== 'string' || typeof record.finishedAt !== 'string') {
    return { ok: false, reason: 'gate record is missing startedAt/finishedAt' };
  }
  if (typeof record.command !== 'string' || !record.command.includes('bun test')) {
    return { ok: false, reason: 'gate record command is not an allowlisted bun test invocation' };
  }

  const scope = {
    requestingTaskId: input.requestingTaskId,
    ownerReplyAuditId: input.ownerReplyAuditId,
    ownerReplyTaskId: input.ownerReplyTaskId,
  };
  const needAttestation = input.requireHostAttestation !== false;
  if (needAttestation) {
    const attested = verifyManagedLocalTestAttestation(record, input.attestationAgent ?? null, scope);
    if (!attested.ok) return attested;
  }

  return {
    ok: true,
    sha: input.sha,
    at: record.finishedAt,
    source: {
      provider: 'managed-local-test',
      protocolVersion: record.protocolVersion ?? null,
      suite: record.suite,
      sha: record.sha,
      exitCode: record.exitCode,
      result: record.result,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      command: record.command,
      target: record.target,
      logHash: record.logHash,
      repoIdentity: record.repoIdentity,
      dirty: false,
      bun: record.bun,
      runnerIdentity: record.runnerIdentity ?? null,
      hostMode: record.hostMode ?? 'unknown',
      hostAttestation: record.hostAttestation ?? null,
      attestationAgent: input.attestationAgent?.name ?? null,
      ownerReplyAuditId: input.ownerReplyAuditId,
      ownerReplyTaskId: input.ownerReplyTaskId,
      ownerReplyAt: reply.at,
      ownerReplyActor: reply.actor,
      requestingTaskId: input.requestingTaskId,
    },
  };
}

/**
 * Decide whether a soft PR-gate CI failure may be substituted by a host-attested managed-local-test record.
 * Closed/conflicting PRs never reach here (pr-gate marks them hard). Ordinary tasks are refused.
 */
export async function evaluateManagedLocalPrGateSubstitute(input: {
  taskId: string;
  head: string;
  ciFailed: string[];
  reason: string;
  prUrl?: string;
  readOwnerReply?: OwnerReplyReader;
  readRecord?: ManagedLocalTestRecordReader;
  readLogHash?: (logPath: string) => string;
  attestationAgent?: ManagedLocalTestAttestationAgent | null;
  /** @deprecated Ignored. */
  readHostSecret?: () => string | null;
}): Promise<
  | { ok: true; head: string; source: Record<string, unknown> }
  | { ok: false; reason: string }
> {
  if (!MANAGED_LOCAL_TEST_AUTHORIZED_TASKS.includes(input.taskId)) {
    return { ok: false, reason: input.reason };
  }
  if (!input.ciFailed.length || !/^[0-9a-f]{7,40}$/i.test(input.head)) {
    return { ok: false, reason: input.reason };
  }
  const result = await verifyManagedLocalTest({
    sha: input.head,
    suite: MANAGED_LOCAL_TEST_SUBMIT_SUITE,
    ownerReplyAuditId: MANAGED_LOCAL_TEST_OWNER_REPLY_AUDIT_ID,
    ownerReplyTaskId: MANAGED_LOCAL_TEST_OWNER_REPLY_TASK_ID,
    requestingTaskId: input.taskId,
    requireHostAttestation: true,
    readOwnerReply: input.readOwnerReply,
    readRecord: input.readRecord,
    readLogHash: input.readLogHash,
    attestationAgent: input.attestationAgent ?? null,
  });
  if (!result.ok) {
    return { ok: false, reason: `${input.reason}；受管本地替代未通过：${result.reason}` };
  }
  return { ok: true, head: input.head, source: result.source };
}

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
      if (input.provider !== 'github-actions') {
        return { ok: false, reason: `github-actions adapter cannot verify provider ${input.provider}` };
      }
      if (typeof input.runUrl !== 'string' || input.runUrl.length === 0) {
        return { ok: false, reason: 'runUrl is required for github-actions evidence' };
      }
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
      // The traceable record of the deployment that certified the environment. It is written into the evidence source
      // so a later reader can see which deployment, which status and which run the fact came from.
      let deploymentSource: { deploymentId: string; status: string; deploymentRunId: string; deploymentJobId?: string; jobVerified?: true; workflowName: string; sha: string } | undefined;
      if (input.environment !== undefined) {
        // N1-R: the deployment must be causally linked to THIS run and its success terminal state must be read.
        // Same head, same environment name and a close timestamp are not proof: an unrelated failed deployment of the
        // same commit shares all three. The association is decided by src/deployment-source.ts.
        let deployments: DeploymentRecord[];
        try {
          const raw = JSON.parse(await run(['api',
            `repos/${owner}/${repo}/deployments?sha=${encodeURIComponent(input.sha)}&environment=${encodeURIComponent(input.environment)}&per_page=100`]));
          deployments = Array.isArray(raw) ? raw as DeploymentRecord[] : [];
        } catch (error) {
          return { ok: false, reason: `the environment could not be verified: ${(error as Error).message.slice(0, 160)}` };
        }
        const statusesOf = async (deployment: DeploymentRecord): Promise<DeploymentStatusRecord[]> => {
          // Only the status list of the deployment being judged may be read: a status of another deployment can never
          // be substituted for it.
          const statusUrl = typeof deployment.statuses_url === 'string' ? deployment.statuses_url : '';
          // The status list must belong to this repository. A record pointing elsewhere is not this deployment's status
          // and must never be read as if it were.
          if (statusUrl !== '' && !statusUrl.startsWith(`https://api.github.com/repos/${owner}/${repo}/`)) {
            throw new Error('the deployment statuses url belongs to another repository');
          }
          const path = statusUrl
            ? statusUrl.replace(/^https?:\/\/api\.github\.com\//, '')
            : `repos/${owner}/${repo}/deployments/${deployment.id}/statuses`;
          const raw = JSON.parse(await run(['api', path]));
          return Array.isArray(raw) ? raw as DeploymentStatusRecord[] : [];
        };
        // N1-R job axis: a job named by the record or by the success status link is read back from this repository.
        // A job that resolves to another run or another head, and a job that cannot be read at all, both fail the
        // association — an unverifiable job id is never trusted on its face.
        const jobOf = async (jobId: string) => {
          const raw = JSON.parse(await run(['api', `repos/${owner}/${repo}/actions/jobs/${jobId}`]));
          const job = raw as { run_id?: number | string | null; head_sha?: string | null; name?: string | null };
          return { runId: job.run_id === undefined || job.run_id === null ? null : String(job.run_id), headSha: job.head_sha ?? null, name: job.name ?? null };
        };
        const verdict = await associateDeploymentSource({
          run: {
            runId, headSha: info.headSha, workflowName: info.workflowName ?? null,
            conclusion: info.conclusion ?? null, status: info.status ?? null,
            createdAt: info.createdAt ?? null, updatedAt: info.updatedAt ?? null,
          },
          environment: input.environment,
          deployments,
          statusesOf,
          jobOf,
        });
        if (!verdict.ok) return { ok: false, reason: verdict.reason };
        verifiedEnvironment = verdict.environment;
        deploymentSource = {
          deploymentId: verdict.deploymentId, status: verdict.status, deploymentRunId: verdict.deploymentRunId,
          ...(verdict.deploymentJobId ? { deploymentJobId: verdict.deploymentJobId } : {}),
          ...(verdict.jobVerified ? { jobVerified: true as const } : {}),
          workflowName: verdict.workflowName, sha: verdict.sha,
        };
        at = verdict.at;
      }
      return {
        ok: true, sha: input.sha, at,
        ...(verifiedEnvironment !== undefined ? { environment: verifiedEnvironment } : {}),
        source: {
          provider: 'github-actions', runUrl: input.runUrl, runId, workflowName: info.workflowName ?? null,
          conclusion: info.conclusion, ...(verifiedProbe ? { probe: verifiedProbe } : {}),
          ...(verifiedEnvironment !== undefined ? { environment: verifiedEnvironment } : {}),
          ...(deploymentSource ? { deployment: deploymentSource } : {}),
          ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        },
      };
    },
  };
}

/**
 * Composite acceptance adapter: github-actions (default) plus the owner-authorized managed-local-test path.
 * `readOwnerReply` must be supplied by the core (it alone can read audit rows); without it the local-test
 * path refuses closed rather than skipping the authorization check.
 */
export function createAcceptanceSourceAdapter(options?: {
  github?: AcceptanceSourceAdapter;
  readRecord?: ManagedLocalTestRecordReader;
  readOwnerReply?: OwnerReplyReader;
  readLogHash?: (logPath: string) => string;
  /** Host-wired signing agent; unset ⇒ managed-local-test verifies fail closed. */
  attestationAgent?: ManagedLocalTestAttestationAgent | null;
}): AcceptanceSourceAdapter {
  const github = options?.github ?? createGithubActionsAdapter();
  return {
    async verify(input) {
      if (input.provider === 'managed-local-test') {
        if (typeof input.suite !== 'string' || typeof input.ownerReplyAuditId !== 'string' || typeof input.ownerReplyTaskId !== 'string') {
          return { ok: false, reason: 'managed-local-test requires suite, ownerReplyAuditId and ownerReplyTaskId' };
        }
        if (typeof input.requestingTaskId !== 'string') {
          return { ok: false, reason: 'managed-local-test requires the requesting task id' };
        }
        return verifyManagedLocalTest({
          sha: input.sha,
          suite: input.suite,
          ownerReplyAuditId: input.ownerReplyAuditId,
          ownerReplyTaskId: input.ownerReplyTaskId,
          requestingTaskId: input.requestingTaskId,
          readRecord: options?.readRecord,
          attestationAgent: options?.attestationAgent ?? null,
          requireHostAttestation: true,
          readOwnerReply: options?.readOwnerReply,
          readLogHash: options?.readLogHash,
        });
      }
      return github.verify(input);
    },
  };
}
