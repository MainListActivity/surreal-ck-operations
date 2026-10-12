import { RecordId, type Surreal } from 'surrealdb';
import type { OpsScope, Role } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { PROOF_GOAL, APPROVAL_MARKER } from './proof-contract.ts';
import { emptyChecks, mark, type DiagnosticCheck, type CheckResult } from './approval-diagnosis.ts';
import type { ProofFiles } from './proof-files.ts';
export type LeaseStamp = { taskId: string; employee: string; delivery: string; fence: number; goal: string; project: string; role: Role };
export type ApprovalReceipt = { taskId: string; version: number; action: 'accept' | 'owner_approve'; auditId: string; reviewer: string; digest: string };
export type Candidate = { task: RecordId; digest: string; manifest_hash: string; document_hash: string; manifest_path: string; document_path: string; author: string; env: string };
export type ProofRow = { id: RecordId; task: RecordId; delivery: string; fence: number; request_key: string; request_digest: string; lease: LeaseStamp; approval: ApprovalReceipt | null; files: ProofFiles; identities_digest: string; status_hash: string; expires_at: number; revoked: boolean; version: number; sealed: { ciphertext: string; iv: string; tag: string }; kid: string };
type ApprovalTaskRow = { state: string; kind: string; version: number; submitted_by: string; accepted_by: string; reviewer_role: string; goal: RecordId; project: RecordId };
type ApprovalAuditRow = { id: RecordId; actor: RecordId | string; action: 'accept' | 'owner_approve'; evidence: string; version: number; at: unknown };
type ApprovalSnapshot = { candidate?: Candidate; task?: ApprovalTaskRow; audit?: ApprovalAuditRow; reviewer?: { revoked: boolean; retired?: boolean }; ambiguous: boolean };
const denied = () => new CompanyError('forbidden', 'company approval or live lease unavailable');
export class CompanyProofStore {
  constructor(private readonly db: Surreal, private readonly now: () => number = Date.now) {}
  async lease(scope: OpsScope): Promise<LeaseStamp> {
    const [rows] = await this.db.query<[Array<{ current_employee: string; delivery_id: string; fence: number; lease_expires_at: number; state: string; goal: RecordId; project: RecordId; revoked: boolean; retired: boolean; role: string }>]>(
      'SELECT current_employee, delivery_id, fence, lease_expires_at, state, goal, goal.project AS project, type::record("employee", current_employee).revoked AS revoked, type::record("employee", current_employee).retired AS retired, type::record("employee", current_employee).role AS role FROM $task;', { task: new RecordId('task', scope.taskId) });
    const r = rows[0];
    if (!r || r.current_employee !== scope.actor.employeeId || !['doing', 'review'].includes(r.state) || r.lease_expires_at <= this.now() / 1000 || r.revoked || r.retired || !['engineering', 'product', 'qa'].includes(r.role) || String(r.goal?.id) !== PROOF_GOAL || String(r.project?.id) !== scope.project || scope.project !== 'surreal_ck') throw denied();
    return { taskId: scope.taskId, employee: r.current_employee, delivery: r.delivery_id, fence: r.fence, goal: PROOF_GOAL, project: scope.project, role: r.role as Role };
  }
  async leaseValid(stamp: LeaseStamp): Promise<boolean> {
    try {
      const current = await this.lease({ taskId: stamp.taskId, project: stamp.project, actor: { employeeId: stamp.employee, role: stamp.role, capabilities: [] } });
      return current.delivery === stamp.delivery && current.fence === stamp.fence && current.role === stamp.role;
    } catch { return false; }
  }
  async prepare(lease: LeaseStamp, env: string, files: ProofFiles): Promise<void> {
    const row: Candidate = { task: new RecordId('task', lease.taskId), digest: files.manifest.configurationDigest, manifest_hash: files.manifestHash, document_hash: files.documentHash, manifest_path: files.manifestPath, document_path: files.documentPath, author: lease.employee, env };
    await this.db.query('INSERT INTO internal_ai_candidate $row ON DUPLICATE KEY UPDATE digest = $input.digest;', { row });
    const found = await this.candidate(lease.taskId);
    if (!found || found.manifest_hash !== row.manifest_hash || found.document_hash !== row.document_hash || found.author !== row.author || found.env !== env || found.manifest_path !== row.manifest_path || found.document_path !== row.document_path) throw new CompanyError('conflict', 'immutable approval candidate differs');
  }
  async candidate(taskId: string): Promise<Candidate | undefined> {
    const [rows] = await this.db.query<[Candidate[]]>('SELECT * FROM internal_ai_candidate WHERE task = $task LIMIT 1;', { task: new RecordId('task', taskId) }); return rows[0];
  }
  /** Authorization runs before file/candidate/audit reads. Only self or a direct server-stored dependency. */
  async authorizeDiagnosis(lease: LeaseStamp, taskId: string): Promise<boolean> {
    if (!['engineering', 'qa'].includes(lease.role) || !await this.leaseValid(lease)) return false;
    const [callers, targets] = await this.db.query<[Array<{ dependencies: RecordId[] }>, Array<{ goal: RecordId; project: RecordId }>]>(
      'SELECT dependencies FROM $caller; SELECT goal, goal.project AS project FROM $target;',
      { caller: new RecordId('task', lease.taskId), target: new RecordId('task', taskId) });
    return !!targets[0] && String(targets[0].goal?.id) === lease.goal && String(targets[0].project?.id) === lease.project &&
      (lease.taskId === taskId || !!callers[0]?.dependencies?.some(dep => dep instanceof RecordId && String(dep.table) === 'task' && String(dep.id) === taskId));
  }
  private async approvalSnapshot(taskId: string, diagnostic = false): Promise<ApprovalSnapshot> {
    const [candidates, tasks, audits] = await this.db.query<[Candidate[], ApprovalTaskRow[], ApprovalAuditRow[]]>(
      `SELECT task, digest, manifest_hash, document_hash, manifest_path, document_path, author, env FROM internal_ai_candidate WHERE task = $task LIMIT 1;
       SELECT state, kind, version, submitted_by, accepted_by, reviewer_role, goal, goal.project AS project FROM $task;
       SELECT id, actor, action, evidence, version, at FROM audit WHERE task = $task AND action IN ['accept', 'owner_approve'] ORDER BY at DESC LIMIT 2;`,
      { task: new RecordId('task', taskId) });
    const audit = audits[0];
    // A diagnostic never dereferences caller-controlled records or non-employee tables.
    if (diagnostic && audit?.action === 'accept' && audit.actor instanceof RecordId && String(audit.actor.table) !== 'employee') throw denied();
    let reviewer: ApprovalSnapshot['reviewer'];
    if (audit?.action === 'accept' && audit.actor instanceof RecordId) {
      const [rows] = await this.db.query<[Array<NonNullable<ApprovalSnapshot['reviewer']>>]>('SELECT revoked, retired FROM $reviewer;', { reviewer: audit.actor });
      reviewer = rows[0];
    }
    return { candidate: candidates[0], task: tasks[0], audit, reviewer,
      ambiguous: !!audits[1] && JSON.stringify(audits[1].at) === JSON.stringify(audit?.at) };
  }
  private approvalChecks(snapshot: ApprovalSnapshot, env: string, files?: ProofFiles) {
    const checks = emptyChecks();
    const set = (key: DiagnosticCheck, value: boolean) => mark(checks, key, value);
    const { candidate: c, task: t, audit: a, reviewer: r } = snapshot;
    set('candidateExists', !!c);
    if (files) {
      set('candidateEnvMatches', !!c && c.env === env);
      set('candidateDigestMatches', !!c && c.digest === files.manifest.configurationDigest);
      set('candidateManifestHashMatches', !!c && c.manifest_hash === files.manifestHash);
      set('candidateDocumentHashMatches', !!c && c.document_hash === files.documentHash);
      set('candidateManifestResolvedPathMatches', !!c && c.manifest_path === files.manifestPath);
      set('candidateDocumentResolvedPathMatches', !!c && c.document_path === files.documentPath);
    }
    set('approvalTaskExists', !!t);
    set('approvalTaskDone', !!t && t.state === 'done');
    set('approvalTaskKindEligible', !!t && ['task', 'gate'].includes(t.kind));
    set('approvalTaskGoalMatches', String(t?.goal?.id) === PROOF_GOAL);
    set('approvalTaskProjectMatches', String(t?.project?.id) === 'surreal_ck');
    set('candidateAuthorMatchesSubmitter', !!c && !!t && c.author === t.submitted_by);
    set('approvalAuditExists', !!a);
    set('auditVersionMatchesTask', !!a && !!t && a.version === t.version);
    if (files) set('auditMarkerExactLine', !!a && !!c && a.evidence.split(/\r?\n/).some(line => line.trim() === APPROVAL_MARKER + c.digest));
    if (a?.action === 'accept') {
      set('auditActorIsRecordId', a.actor instanceof RecordId);
      set('auditActorMatchesAcceptedBy', a.actor instanceof RecordId && !!t && String(a.actor.id) === t.accepted_by);
      set('reviewerIndependent', !!t && t.accepted_by !== t.submitted_by);
      set('reviewerExists', !!r);
      set('reviewerNotRevoked', !!r && !r.revoked);
      set('reviewerNotRetired', !!r && !r.retired);
    } else if (a?.action === 'owner_approve') {
      set('ownerAcceptedByMatches', !!t && t.accepted_by === 'owner');
      set('ownerReviewerRoleMatches', !!t && t.reviewer_role === 'owner');
    }
    return checks;
  }
  async diagnoseApproval(taskId: string, env: string, files: ProofFiles | undefined, lease: LeaseStamp): Promise<{ checks: Record<DiagnosticCheck, CheckResult>; snapshotStable: boolean }> {
    if (!await this.authorizeDiagnosis(lease, taskId)) throw denied();
    const snapshot = await this.approvalSnapshot(taskId, true);
    const checks = this.approvalChecks(snapshot, env, files);
    const next = await this.approvalSnapshot(taskId, true);
    return { checks, snapshotStable: !snapshot.ambiguous && !next.ambiguous && JSON.stringify(snapshot) === JSON.stringify(next) };
  }
  async approval(taskId: string, env: string, files: ProofFiles): Promise<ApprovalReceipt> {
    const snapshot = await this.approvalSnapshot(taskId);
    const checks = this.approvalChecks(snapshot, env, files);
    if (Object.values(checks).some(check => check.evaluated && !check.matched)) throw denied();
    const task = snapshot.task!, audit = snapshot.audit!, candidate = snapshot.candidate!;
    return { taskId, version: task.version, action: audit.action, auditId: String(audit.id), reviewer: task.accepted_by, digest: candidate.digest };
  }
  async rotationApproval(taskId: string, kid: string): Promise<void> {
    const [tasks, audits] = await this.db.query<[Array<{ state: string; kind: string; version: number; submitted_by: string; accepted_by: string; reviewer_role: string; goal: RecordId; project: RecordId }>, Array<{ actor: RecordId | string; action: string; evidence: string; version: number }>]>(
      `SELECT state, kind, version, submitted_by, accepted_by, reviewer_role, goal, goal.project AS project FROM $task;
       SELECT actor, action, evidence, version, at FROM audit WHERE task = $task AND action IN ['accept', 'owner_approve'] ORDER BY at DESC LIMIT 1;`, { task: new RecordId('task', taskId) });
    const t = tasks[0], a = audits[0];
    const marker = 'company-internal-ai-key-rotation:v1:surreal_ck:production:' + kid;
    if (!t || !a || t.state !== 'done' || !['task','gate'].includes(t.kind) || String(t.goal?.id) !== PROOF_GOAL || String(t.project?.id) !== 'surreal_ck' || a.version !== t.version || !a.evidence.split(/\r?\n/).some(l => l.trim() === marker)) throw denied();
    if (a.action === 'accept') {
      if (!(a.actor instanceof RecordId) || String(a.actor.id) !== t.accepted_by || t.accepted_by === t.submitted_by) throw denied();
      const who = await this.db.select<{revoked:boolean;retired?:boolean}>(a.actor);
      if (!who || who.revoked || who.retired) throw denied();
    } else if (t.accepted_by !== 'owner' || t.reviewer_role !== 'owner') throw denied();
  }

  async put(row: ProofRow): Promise<ProofRow> {
    await this.db.query('INSERT INTO internal_ai_proof $row ON DUPLICATE KEY UPDATE request_digest = request_digest;', { row });
    const stored = await this.db.select<ProofRow>(row.id);
    if (!stored || stored.request_digest !== row.request_digest) throw new CompanyError('conflict', 'proof idempotency key changed');
    return stored;
  }
  async get(handleHash: string): Promise<ProofRow | undefined> { return this.db.select<ProofRow>(new RecordId('internal_ai_proof', handleHash)); }
  async status(statusHash: string): Promise<ProofRow | undefined> { const [rows] = await this.db.query<[ProofRow[]]>('SELECT * FROM internal_ai_proof WHERE status_hash = $hash LIMIT 1;', { hash: statusHash }); return rows[0]; }
  async revoke(row: ProofRow): Promise<void> { await this.db.query('UPDATE ONLY $id SET revoked = true, version += 1 WHERE revoked = false;', { id: row.id }); }
}
