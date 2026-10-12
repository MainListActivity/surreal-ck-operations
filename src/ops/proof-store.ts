import { RecordId, type Surreal } from 'surrealdb';
import type { OpsScope, Role } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { PROOF_GOAL, APPROVAL_MARKER } from './proof-contract.ts';
import type { ProofFiles } from './proof-files.ts';
export type LeaseStamp = { taskId: string; employee: string; delivery: string; fence: number; goal: string; project: string; role: Role };
export type ApprovalReceipt = { taskId: string; version: number; action: 'accept' | 'owner_approve'; auditId: string; reviewer: string; digest: string };
export type Candidate = { task: RecordId; digest: string; manifest_hash: string; document_hash: string; manifest_path: string; document_path: string; author: string; env: string };
export type ProofRow = { id: RecordId; task: RecordId; delivery: string; fence: number; request_key: string; request_digest: string; lease: LeaseStamp; approval: ApprovalReceipt | null; files: ProofFiles; identities_digest: string; status_hash: string; expires_at: number; revoked: boolean; version: number; sealed: { ciphertext: string; iv: string; tag: string }; kid: string };
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
  async diagnoseApproval(taskId: string, env: string, files: ProofFiles, scope: { goal: string; project: string }): Promise<Record<string, unknown>> {
    if (scope.goal !== PROOF_GOAL || scope.project !== 'surreal_ck') throw denied();
    const candidate = await this.candidate(taskId);
    const [tasks, audits] = await this.db.query<[Array<{ state: string; kind: string; version: number; submitted_by: string; accepted_by: string; reviewer_role: string; goal: RecordId; project: RecordId }>, Array<{ id: RecordId; actor: RecordId | string; action: 'accept' | 'owner_approve'; evidence: string; version: number }>]>(
      `SELECT state, kind, version, submitted_by, accepted_by, reviewer_role, goal, goal.project AS project FROM $task;
       SELECT id, actor, action, evidence, version, at FROM audit WHERE task = $task AND action IN ['accept', 'owner_approve'] ORDER BY at DESC LIMIT 1;`, { task: new RecordId('task', taskId) });
    const task = tasks[0], audit = audits[0];
    const result = {
      lease: true, fileRead: true, schema: true,
      candidate: { found: !!candidate, env: candidate?.env === env, digest: candidate?.digest === files.manifest.configurationDigest, manifestHash: candidate?.manifest_hash === files.manifestHash, documentHash: candidate?.document_hash === files.documentHash, manifestPath: candidate?.manifest_path === files.manifestPath, documentPath: candidate?.document_path === files.documentPath, author: candidate?.author === task?.submitted_by },
      task: { found: !!task, state: task?.state === 'done', kind: !!task && ['task', 'gate'].includes(task.kind), goal: String(task?.goal?.id) === PROOF_GOAL, project: String(task?.project?.id) === 'surreal_ck', version: task?.version ?? null, submittedBy: !!task && candidate?.author === task.submitted_by },
      audit: { found: !!audit, action: audit?.action ?? null, version: audit?.version ?? null, versionMatches: !!audit && !!task && audit.version === task.version, marker: !!audit && audit.evidence.split(/\\r?\\n/).some(line => line.trim() === APPROVAL_MARKER + files.manifest.configurationDigest) },
      reviewer: { distinctSubmitter: !!task && task.accepted_by !== task.submitted_by, recordId: audit?.actor instanceof RecordId, active: null as boolean | null },
      expired: Date.parse(files.evidence.expiresAt) <= this.now(),
    };
    if (audit?.action === 'accept' && audit.actor instanceof RecordId) {
      const reviewer = await this.db.select<{ revoked: boolean; retired?: boolean }>(audit.actor);
      result.reviewer.active = !!reviewer && !reviewer.revoked && !reviewer.retired;
    } else if (audit?.action === 'owner_approve') {
      result.reviewer.active = task?.accepted_by === 'owner' && task.reviewer_role === 'owner';
    }
    return result;
  }

  async approval(taskId: string, env: string, files: ProofFiles): Promise<ApprovalReceipt> {
    const candidate = await this.candidate(taskId);
    if (!candidate || candidate.env !== env || candidate.digest !== files.manifest.configurationDigest || candidate.manifest_hash !== files.manifestHash || candidate.document_hash !== files.documentHash || candidate.manifest_path !== files.manifestPath || candidate.document_path !== files.documentPath) throw denied();
    const [tasks, audits] = await this.db.query<[Array<{ state: string; kind: string; version: number; submitted_by: string; accepted_by: string; reviewer_role: string; goal: RecordId; project: RecordId }>, Array<{ id: RecordId; actor: RecordId | string; action: 'accept' | 'owner_approve'; evidence: string; version: number }>]>(
      `SELECT state, kind, version, submitted_by, accepted_by, reviewer_role, goal, goal.project AS project FROM $task;
       SELECT id, actor, action, evidence, version, at FROM audit WHERE task = $task AND action IN ['accept', 'owner_approve'] ORDER BY at DESC LIMIT 1;`, { task: new RecordId('task', taskId) });
    const task = tasks[0], audit = audits[0];
    if (!task || !audit || task.state !== 'done' || !['task', 'gate'].includes(task.kind) || String(task.goal?.id) !== PROOF_GOAL || String(task.project?.id) !== 'surreal_ck' || audit.version !== task.version || candidate.author !== task.submitted_by || !audit.evidence.split(/\r?\n/).some(line => line.trim() === APPROVAL_MARKER + candidate.digest)) throw denied();
    if (audit.action === 'accept') {
      if (!(audit.actor instanceof RecordId) || String(audit.actor.id) !== task.accepted_by || task.accepted_by === task.submitted_by) throw denied();
      const reviewer = await this.db.select<{ revoked: boolean; retired?: boolean }>(audit.actor);
      if (!reviewer || reviewer.revoked || reviewer.retired) throw denied();
    } else if (task.accepted_by !== 'owner' || task.reviewer_role !== 'owner') throw denied();
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
