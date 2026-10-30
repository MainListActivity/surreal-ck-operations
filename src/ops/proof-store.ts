import { windowExpired, type ExecutionWindow } from '../task-recovery.ts';
import { RecordId, type Surreal } from 'surrealdb';
import type { OpsScope, Role } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { PROOF_GOAL, APPROVAL_MARKER, isRemoteCandidateGoal } from './proof-contract.ts';
import { emptyChecks, mark, normalRetirement, type DiagnosticCheck, type CheckResult, type ReviewerLifecycle } from './approval-diagnosis.ts';
import type { ProofFiles } from './proof-files.ts';
export type LeaseStamp = { taskId: string; employee: string; delivery: string; fence: number; goal: string; project: string; role: Role };
export type ApprovalReceipt = { taskId: string; version: number; action: 'accept' | 'owner_approve'; auditId: string; reviewer: string; digest: string };
export type Candidate = { evidence_expires_at?: string; task: RecordId; digest: string; manifest_hash: string; document_hash: string; manifest_path: string; document_path: string; author: string; env: string; type?: string; source_path?: string; /** G1 (FV06 P1): the sampler's employee id, recorded by prepare() when the caller passed it. */ sampler?: string };
/** A broker-verified remote candidate registered as the approval candidate for one task. */
export type RemoteCandidateInput = { taskId: string; digest: string; evidenceExpiresAt: string; author: string; env: string; sourcePath: string; candidateHash: string };
export type ProofRow = { id: RecordId; task: RecordId; delivery: string; fence: number; request_key: string; request_digest: string; lease: LeaseStamp; approval: ApprovalReceipt | null; files: ProofFiles; identities_digest: string; status_hash: string; expires_at: number; revoked: boolean; version: number; sealed: { ciphertext: string; iv: string; tag: string }; kid: string };
type ApprovalTaskRow = { state: string; kind: string; version: number; submitted_by: string; accepted_by: string; reviewer_role: string; goal: RecordId; project: RecordId };
type ApprovalAuditRow = { id: RecordId; actor: RecordId | string; action: 'accept' | 'owner_approve'; evidence: string; version: number; at: unknown };
type ApprovalSnapshot = { candidate?: Candidate; task?: ApprovalTaskRow; audit?: ApprovalAuditRow; reviewer?: ReviewerLifecycle; ambiguous: boolean };
const denied = () => new CompanyError('forbidden', 'company approval or live lease unavailable');
export class CompanyProofStore {
  constructor(private readonly db: Surreal, private readonly now: () => number = Date.now) {}
  async lease(scope: OpsScope): Promise<LeaseStamp> {
    return this.leaseFor(scope, goal => goal === PROOF_GOAL);
  }
  /**
   * 远端候选窗口绑定登记的租约：沿用 lease() 的全部检查（当前持有人、doing/review、租约未过期、员工未撤销、
   * 角色 engineering/product/qa、项目 surreal_ck 且与 scope 同），目标改为允许名单（PROOF_GOAL 与第二阶段目标）。
   * 内部 AI proof 链（prepare/prove/deliver、v2 manifest）仍只走 lease()，目标唯一为 PROOF_GOAL。
   */
  async remoteLease(scope: OpsScope): Promise<LeaseStamp> {
    return this.leaseFor(scope, isRemoteCandidateGoal);
  }
  private async leaseFor(scope: OpsScope, goalAllowed: (goalId: string | undefined) => boolean): Promise<LeaseStamp> {
    const [rows] = await this.db.query<[Array<{ current_employee: string; delivery_id: string; fence: number; lease_expires_at: number; state: string; goal: RecordId; project: RecordId; revoked: boolean; retired: boolean; role: string }>]>(
      'SELECT current_employee, delivery_id, fence, lease_expires_at, state, goal, goal.project AS project, type::record("employee", current_employee).revoked AS revoked, type::record("employee", current_employee).retired AS retired, type::record("employee", current_employee).role AS role FROM $task;', { task: new RecordId('task', scope.taskId) });
    const r = rows[0];
    const goalId = r && r.goal ? String(r.goal.id) : undefined;
    if (!r || r.current_employee !== scope.actor.employeeId || !['doing', 'review'].includes(r.state) || r.lease_expires_at <= this.now() / 1000 || r.revoked || r.retired || !['engineering', 'product', 'qa'].includes(r.role) || !goalAllowed(goalId) || String(r.project?.id) !== scope.project || scope.project !== 'surreal_ck') throw denied();
    return { taskId: scope.taskId, employee: r.current_employee, delivery: r.delivery_id, fence: r.fence, goal: goalId!, project: scope.project, role: r.role as Role };
  }
  async assertExecutionWindow(taskId: string, approvalTask?: string, files?: ProofFiles): Promise<void> {
    const [row] = await this.db.query<[{ execution_window?: ExecutionWindow } | undefined]>(
      'SELECT execution_window FROM ONLY $task;', { task: new RecordId('task', taskId) });
    const window = row?.execution_window;
    if (!window) return; // Legacy tasks retain the existing proof and evidence checks.
    if (windowExpired(window, this.now())) throw new CompanyError('forbidden', 'execution window expired');
    if (files && (window.approvalTask !== approvalTask || window.configurationDigest !== files.manifest.configurationDigest ||
        window.evidenceExpiresAt !== files.evidence.expiresAt)) throw new CompanyError('forbidden', 'execution window candidate mismatch');
  }
  async leaseValid(stamp: LeaseStamp): Promise<boolean> {
    try {
      const current = await this.lease({ taskId: stamp.taskId, project: stamp.project, actor: { employeeId: stamp.employee, role: stamp.role, capabilities: [] } });
      return current.delivery === stamp.delivery && current.fence === stamp.fence && current.role === stamp.role;
    } catch { return false; }
  }
  /**
   * 与 leaseValid 相同的重核，但走远端候选允许名单：登记行之后仍要确认持有人、围栏与角色未变，
   * 且任务目标仍在允许名单内。v2 链的 leaseValid 不受影响。
   */
  async remoteLeaseValid(stamp: LeaseStamp): Promise<boolean> {
    try {
      const current = await this.remoteLease({ taskId: stamp.taskId, project: stamp.project, actor: { employeeId: stamp.employee, role: stamp.role, capabilities: [] } });
      return current.delivery === stamp.delivery && current.fence === stamp.fence && current.role === stamp.role;
    } catch { return false; }
  }
  /**
   * 写 internal_ai_candidate（G1/FV06 P1：可选携带采样者身份）。samplerEmployee 与登记持有人同一人时
   * 直接拒绝——采样 QA 与批准任务登记人必须是两台机器上的两个员工。同文件重放幂等（digest 只刷新、
   * 其余字段回读比对，含 sampler），换文件冲突。
   */
  async prepare(lease: LeaseStamp, env: string, files: ProofFiles, samplerEmployee?: string): Promise<void> {
    if (samplerEmployee !== undefined && samplerEmployee === lease.employee)
      throw new CompanyError('invalid', 'sampler must differ from the registering holder (G1: sampler identity is machine-checked)');
    const row: Candidate = { evidence_expires_at: files.evidence.expiresAt, task: new RecordId('task', lease.taskId), digest: files.manifest.configurationDigest, manifest_hash: files.manifestHash, document_hash: files.documentHash, manifest_path: files.manifestPath, document_path: files.documentPath, author: lease.employee, env, ...(samplerEmployee !== undefined ? { sampler: samplerEmployee } : {}) };
    await this.db.query('INSERT INTO internal_ai_candidate $row ON DUPLICATE KEY UPDATE digest = $input.digest;', { row });
    const found = await this.candidate(lease.taskId);
    if (!found || found.manifest_hash !== row.manifest_hash || found.document_hash !== row.document_hash || found.author !== row.author || found.env !== env || found.manifest_path !== row.manifest_path || found.document_path !== row.document_path || found.sampler !== row.sampler) throw new CompanyError('conflict', 'immutable approval candidate differs');
  }
  /**
   * Registers a broker-verified remote-magpie-evidence/1 candidate as the approval candidate for one task.
   * It writes the same row shape the v2 prepare chain writes, so the existing resume checks apply unchanged.
   * One row per task (the schema index is unique on task): a fresh observation replaces the previous row in
   * place and never extends its expiry; the caller audits the replaced digest. Nothing here decides a window.
   */
  async registerRemoteCandidate(lease: LeaseStamp, input: RemoteCandidateInput): Promise<{ created: boolean; replacedDigest?: string }> {
    if (!await this.remoteLeaseValid(lease)) throw denied();
    const task = new RecordId('task', input.taskId);
    if (!await this.db.select(task)) throw new CompanyError('not_found', 'approval task not found');
    const row: Candidate = {
      task, digest: input.digest, evidence_expires_at: input.evidenceExpiresAt, author: input.author, env: input.env,
      type: 'remote-magpie-evidence/1', source_path: input.sourcePath,
      manifest_hash: input.candidateHash, document_hash: input.candidateHash,
      manifest_path: input.sourcePath, document_path: input.sourcePath,
    };
    const before = await this.candidate(input.taskId);
    // digest and evidence_expires_at are READONLY, so a replacement deletes and re-inserts in one transaction
    // rather than updating them in place. The unique index keeps one row per task throughout.
    await this.db.query('BEGIN; DELETE internal_ai_candidate WHERE task = $task; INSERT INTO internal_ai_candidate $row; COMMIT;', { task, row });
    const found = await this.candidate(input.taskId);
    if (!found || found.digest !== row.digest || found.evidence_expires_at !== row.evidence_expires_at || found.author !== row.author || found.env !== row.env || found.type !== row.type || found.source_path !== row.source_path) throw new CompanyError('conflict', 'remote candidate registration did not persist');
    return { created: before === undefined, ...(before && before.digest !== row.digest ? { replacedDigest: before.digest } : {}) };
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
      `SELECT task, digest, manifest_hash, document_hash, manifest_path, document_path, author, env, sampler FROM internal_ai_candidate WHERE task = $task LIMIT 1;
       SELECT state, kind, version, submitted_by, accepted_by, reviewer_role, goal, goal.project AS project FROM $task;
       SELECT id, actor, action, evidence, version, at FROM audit WHERE task = $task AND action IN ['accept', 'owner_approve'] ORDER BY at DESC LIMIT 2;`,
      { task: new RecordId('task', taskId) });
    const audit = audits[0];
    // A diagnostic never dereferences caller-controlled records or non-employee tables.
    if (diagnostic && audit?.action === 'accept' && audit.actor instanceof RecordId && String(audit.actor.table) !== 'employee') throw denied();
    let reviewer: ApprovalSnapshot['reviewer'];
    if (audit?.action === 'accept' && audit.actor instanceof RecordId) {
      const [rows] = await this.db.query<[Array<NonNullable<ApprovalSnapshot['reviewer']>>]>('SELECT revoked, retired, retired_kind, security_revoked FROM $reviewer;', { reviewer: audit.actor });
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
    // G1 (FV06 P1): once a candidate carries a sampler identity, 采样 QA ≠ 批准者 is a machine check.
    // Candidates registered before G1 (no sampler) stay unevaluated here — the legacy approval
    // contract keeps working, and new registrations should always pass samplerEmployee.
    if (c && c.sampler !== undefined && a && t)
      set('samplerApproverIndependent', a.action === 'owner_approve' ? c.sampler !== 'owner' : a.action === 'accept' && c.sampler !== t.accepted_by);
    set('approvalAuditExists', !!a);
    set('auditVersionMatchesTask', !!a && !!t && a.version === t.version);
    if (files) set('auditMarkerExactLine', !!a && !!c && a.evidence.split(/\r?\n/).some(line => line.trim() === APPROVAL_MARKER + c.digest));
    if (a?.action === 'accept') {
      set('auditActorIsRecordId', a.actor instanceof RecordId);
      set('auditActorMatchesAcceptedBy', a.actor instanceof RecordId && !!t && String(a.actor.id) === t.accepted_by);
      set('reviewerIndependent', !!t && t.accepted_by !== t.submitted_by);
      set('reviewerExists', !!r);
      set('reviewerNotRevoked', !!r && (!r.revoked || normalRetirement(r)));
      set('reviewerNotRetired', !!r && (!r.retired || normalRetirement(r)));
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
      const who = await this.db.select<ReviewerLifecycle>(a.actor);
      if (!who || ((who.revoked || who.retired) && !normalRetirement(who))) throw denied();
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
