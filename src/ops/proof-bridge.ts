import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { RecordId } from 'surrealdb';
import type { OpsScope } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { openSecret, sealSecret } from '../projects.ts';
import { canonical, sha256, APPROVAL_MARKER, TOKEN_PLAN_PLAN_TYPE_FREE, type ProofIdentity, type ProofTool, proofToolSchemas } from './proof-contract.ts';
import { loadProofFiles, readProofFile, parseProofFiles, evidenceChecks, type ProofFiles } from './proof-files.ts';
import { CompanyProofStore, type ProofRow } from './proof-store.ts';
import { emptyChecks, mark, diagnosis, type DiagnosticCheck } from './approval-diagnosis.ts';
import { ProofSigner } from './proof-signer.ts';
export type IdentityResolver = (scope: OpsScope, env: string, files: ProofFiles) => Promise<ProofIdentity[]>;
export interface BridgeDeps {
  store: CompanyProofStore; home: string; key: () => Buffer;
  signer: (project: string, env: string) => Promise<ProofSigner>;
  identities: IdentityResolver;
  rotate: (project: string, env: string, kid: string) => Promise<ProofSigner>;
  deliver: (jwt: string, scope: OpsScope, env: string, session: string) => Promise<{ status: number; ok: boolean; errorCode?: string }>;
  now?: () => number;
}
export class InternalAiProofBridge {
  private readonly now: () => number;
  constructor(private readonly deps: BridgeDeps) { this.now = deps.now ?? Date.now; }
  private assertFiles(files: ProofFiles, mode: 'register-disabled' | 'enable'): void {
    if (mode !== 'enable') return;
    if (Object.values(evidenceChecks(files.evidence, files.manifest, this.now())).some(matched => !matched)) throw new CompanyError('forbidden', 'reviewed service evidence unavailable');
  }
  private async diagnose(scope: OpsScope, env: string, raw: Record<string, unknown>) {
    const args = proofToolSchemas.ops_internal_ai_approval_diagnose.parse(raw);
    let lease;
    try {
      lease = await this.deps.store.lease(scope);
      if (!await this.deps.store.authorizeDiagnosis(lease, args.approvalTask)) return { outcome: 'denied', failure: 'scope-denied' } as const;
    } catch (error) {
      if (error instanceof CompanyError && error.code === 'forbidden') return { outcome: 'denied', failure: 'scope-denied' } as const;
      return { outcome: 'unavailable', failure: 'dependency-unavailable' } as const;
    }
    const checks = emptyChecks();
    const set = (key: DiagnosticCheck, value: boolean) => mark(checks, key, value);
    for (const key of ['leaseCallerMatches', 'leaseStateEligible', 'leaseUnexpired', 'leaseEmployeeActive', 'leaseRoleEligible', 'leaseGoalProjectMatch', 'leaseFenceDeliveryCurrent'] as const) set(key, true);
    const roots = ['evidence', 'deliverables'].map(kind => resolve(this.deps.home, kind, args.approvalTask) + sep);
    set('manifestRootMatches', roots.some(root => resolve(args.manifestPath).startsWith(root)));
    set('documentRootMatches', roots.some(root => resolve(args.documentPath).startsWith(root)));
    let files: ProofFiles | undefined;
    if (checks.manifestRootMatches.matched && checks.documentRootMatches.matched) {
      try {
        const [rm, rd] = await Promise.all([readProofFile(this.deps.home, args.approvalTask, args.manifestPath), readProofFile(this.deps.home, args.approvalTask, args.documentPath)]);
        set('fileSafetyValid', true);
        const parsed = parseProofFiles(rm, rd);
        set('manifestSchemaValid', parsed.manifest.success);
        set('documentSchemaValid', parsed.evidence.success);
        if (parsed.manifest.success && parsed.evidence.success) {
          set('configurationDigestValid', !!parsed.digestValid);
          set('documentHashValid', !!parsed.documentHashValid);
          set('serviceFieldsMatch', !!parsed.serviceFieldsMatch);
          files = { manifest: parsed.manifest.data, evidence: parsed.evidence.data, manifestHash: sha256(rm), documentHash: sha256(rd), manifestPath: resolve(args.manifestPath), documentPath: resolve(args.documentPath) };
          set('activityIdMatches', args.activityId === files.manifest.activityId);
          const time = evidenceChecks(files.evidence, files.manifest, this.now());
          for (const key of Object.keys(time) as (keyof typeof time)[]) set(key, time[key]);
        }
      } catch { set('fileSafetyValid', false); }
    }
    try {
      const stored = await this.deps.store.diagnoseApproval(args.approvalTask, env, files, lease);
      for (const key of Object.keys(stored.checks) as DiagnosticCheck[]) if (stored.checks[key].evaluated) checks[key] = stored.checks[key];
      set('approvalSnapshotStable', stored.snapshotStable);
      set('leaseStillCurrent', await this.deps.store.leaseValid(lease));
      // Re-read exactly the bounded files; never combine a changed file with an earlier approval snapshot.
      let fileStable = true;
      if (files) {
        try {
          const [rm, rd] = await Promise.all([readProofFile(this.deps.home, args.approvalTask, args.manifestPath), readProofFile(this.deps.home, args.approvalTask, args.documentPath)]);
          fileStable = sha256(rm) === files.manifestHash && sha256(rd) === files.documentHash;
        } catch { fileStable = false; }
      }
      const stable = stored.snapshotStable && checks.leaseStillCurrent.matched && fileStable;
      return { ...diagnosis(checks, stable), codeVersion: await diagnosticCodeVersion() };
    } catch (error) {
      if (error instanceof CompanyError && error.code === 'forbidden') return { outcome: 'denied', failure: 'scope-denied' } as const;
      return diagnosis(checks, false, true);
    }
  }

  async call(scope: OpsScope, env: string, tool: ProofTool, raw: Record<string, unknown>): Promise<unknown> {
    const schema = proofToolSchemas[tool]; const parsed = schema.safeParse(raw);
    if (!parsed.success || env !== 'production') throw new CompanyError('invalid', 'invalid internal AI proof request');
    if (tool === 'ops_internal_ai_approval_diagnose') return this.diagnose(scope, env, raw);
    const lease = await this.deps.store.lease(scope);
    const signer = await this.deps.signer(scope.project, env);
    if (tool === 'ops_internal_ai_trust') return signer.trust();
    if (tool === 'ops_internal_ai_rotate_key') {
      const args = proofToolSchemas.ops_internal_ai_rotate_key.parse(raw);
      if (args.expectedKid !== signer.kid) throw new CompanyError('conflict', 'issuer key changed');
      await this.deps.store.rotationApproval(args.approvalTask, signer.kid);
      if (!await this.deps.store.leaseValid(lease)) throw new CompanyError('forbidden', 'live lease unavailable');
      return (await this.deps.rotate(scope.project, env, signer.kid)).trust();
    }
    if (tool === 'ops_internal_ai_prepare') {
      const args = proofToolSchemas.ops_internal_ai_prepare.parse(raw);
      const files = await loadProofFiles(this.deps.home, scope.taskId, args.manifestPath, args.documentPath);
      await this.deps.store.prepare(lease, env, files);
      return { digest: files.manifest.configurationDigest, documentHash: files.documentHash, approvalMarker: APPROVAL_MARKER + files.manifest.configurationDigest, paidCallsAllowed: 0 };
    }
    if (tool === 'ops_internal_ai_prove') {
      const args = proofToolSchemas.ops_internal_ai_prove.parse(raw);
      const approvalTask = args.mode === 'enable' ? args.approvalTask : undefined;
      if (args.mode === 'enable' && !approvalTask) throw new CompanyError('forbidden', 'independent approved task required');
      const files = await loadProofFiles(this.deps.home, approvalTask ?? scope.taskId, args.manifestPath, args.documentPath);
      if (args.activityId !== files.manifest.activityId) throw new CompanyError('forbidden', 'activity scope mismatch');
      this.assertFiles(files, args.mode);
      const approval = approvalTask ? await this.deps.store.approval(approvalTask, env, files) : null;
      const identities = await this.deps.identities(scope, env, files);
      const identitiesDigest = sha256(canonical(identities));
      const handle = 'p_' + createHmac('sha256', this.deps.key()).update(canonical({ lease, env, key: args.idempotencyKey })).digest('hex');
      const handleHash = sha256(handle);
      const requestDigest = sha256(canonical({ args, digest: files.manifestHash, identitiesDigest, approval }));
      const prior = await this.deps.store.get(handleHash);
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new CompanyError('conflict', 'proof idempotency key changed');
        await this.valid(prior, signer, identitiesDigest);
        return this.summary(handle, prior);
      }
      const seconds = Math.floor(this.now() / 1000), exp = seconds + 300;
      const statusSecret = randomBytes(32).toString('base64url'), jti = randomUUID();
      const jwt = signer.sign('proof', { contractVersion: 1, type: args.mode === 'enable' ? 'approved-service' : 'development-disabled', paidCallsAllowed: args.mode === 'enable' ? 1 : 0, scope: args.mode,
        project: scope.project, env, goal: lease.goal, requestTask: lease.taskId, lease, approval,
        documentHash: files.documentHash, manifest: files.manifest, configurationDigest: files.manifest.configurationDigest,
        identities, identitiesDigest, jti, nonce: args.nonce, iat: seconds, exp, status: { path: '/internal-ai/status', bearer: statusSecret } });
      const row = await this.deps.store.put({ id: new RecordId('internal_ai_proof', handleHash), task: new RecordId('task', lease.taskId), delivery: lease.delivery, fence: lease.fence, request_key: args.idempotencyKey, request_digest: requestDigest, lease, approval, files,
        identities_digest: identitiesDigest, status_hash: sha256(statusSecret), expires_at: exp * 1000, revoked: false, version: 1,
        sealed: sealSecret(this.deps.key(), JSON.stringify({ jwt, jti, mode: args.mode }), handleHash), kid: signer.kid });
      await this.valid(row, signer, identitiesDigest);
      return this.summary(handle, row);
    }
    const args = tool === 'ops_internal_ai_revoke' ? proofToolSchemas.ops_internal_ai_revoke.parse(raw) : proofToolSchemas.ops_internal_ai_deliver.parse(raw);
    const row = await this.deps.store.get(sha256(args.proofHandle));
    if (!row || row.lease.employee !== lease.employee || row.lease.taskId !== lease.taskId || row.lease.delivery !== lease.delivery || row.lease.fence !== lease.fence || row.files.manifest.env !== env) throw new CompanyError('not_found', 'unknown task-bound proof handle');
    if (tool === 'ops_internal_ai_revoke') { await this.deps.store.revoke(row); return { revoked: true, version: row.revoked ? row.version : row.version + 1 }; }
    await this.valid(row, signer, await this.liveIdentitiesDigest(row));
    const content = this.content(row);
    const response = await this.deps.deliver(content.jwt, scope, env, proofToolSchemas.ops_internal_ai_deliver.parse(raw).session);
    return { status: response.status, ok: response.ok, ...(response.errorCode ? { errorCode: response.errorCode } : {}), configurationDigest: row.files.manifest.configurationDigest, paidCallsAllowed: content.mode === 'enable' ? 1 : 0 };
  }
  private summary(handle: string, row: ProofRow) {
    const mode = this.content(row).mode;
    return { proofHandle: handle, keyId: row.kid, type: mode === 'enable' ? 'approved-service' : 'development-disabled', scope: mode, configurationDigest: row.files.manifest.configurationDigest, documentHash: row.files.documentHash, expiresAt: new Date(row.expires_at).toISOString(), aliases: row.files.manifest.identities.map(i => ({ alias: i.alias, workspaceRole: i.workspaceRole, billingRole: i.billingRole })), paidCallsAllowed: mode === 'enable' ? 1 : 0 };
  }
  private content(row: ProofRow): { jwt: string; jti: string; mode: 'enable' | 'register-disabled' } {
    return JSON.parse(openSecret(this.deps.key(), row.sealed, String(row.id.id))) as { jwt: string; jti: string; mode: 'enable' | 'register-disabled' };
  }
  /** Live per-alias IdP resolution for deliver; a full pass can outlast the freshness window, so it
   * runs before it starts. The digest it yields is still compared inside valid(). */
  private async liveIdentitiesDigest(row: ProofRow): Promise<string> {
    const files = await loadProofFiles(this.deps.home, row.approval?.taskId ?? row.lease.taskId, row.files.manifestPath, row.files.documentPath);
    const scope: OpsScope = { taskId: row.lease.taskId, project: row.lease.project, actor: { employeeId: row.lease.employee, role: row.lease.role, capabilities: [] } };
    return sha256(canonical(await this.deps.identities(scope, files.manifest.env, files)));
  }
  private async valid(row: ProofRow, signer: ProofSigner, identitiesDigest: string): Promise<void> {
    const validationStarted = this.now();
    if (row.revoked || row.expires_at <= this.now() || row.kid !== signer.kid || !await this.deps.store.leaseValid(row.lease)) throw new CompanyError('forbidden', 'proof expired or revoked');
    const files = await loadProofFiles(this.deps.home, row.approval?.taskId ?? row.lease.taskId, row.files.manifestPath, row.files.documentPath);
    if (files.manifestHash !== row.files.manifestHash || files.documentHash !== row.files.documentHash) throw new CompanyError('forbidden', 'proof evidence changed');
    this.assertFiles(files, this.content(row).mode);
    if (row.approval && canonical(await this.deps.store.approval(row.approval.taskId, files.manifest.env, files)) !== canonical(row.approval)) throw new CompanyError('forbidden', 'proof approval changed');
    // The digest is always supplied by the caller and always compared: prove and deliver pass this
    // request's live resolution (their identity-drift check, kept outside the freshness window);
    // status passes the digest stored on the row so the 5-second status path never resolves at all.
    if (identitiesDigest !== row.identities_digest) throw new CompanyError('forbidden', 'proof identity changed');
    // Recheck after potentially slow file/DB reads; no stale lease window.
    if (!await this.deps.store.leaseValid(row.lease) || row.expires_at <= this.now()) throw new CompanyError('forbidden', 'proof expired or revoked');
    const fresh = await this.deps.store.get(String(row.id.id));
    if (!fresh || fresh.revoked || fresh.version !== row.version) throw new CompanyError('forbidden', 'proof revoked during validation');
    if (row.approval && canonical(await this.deps.store.approval(row.approval.taskId, files.manifest.env, files)) !== canonical(row.approval)) throw new CompanyError('forbidden', 'proof approval changed');
    if (this.now() - validationStarted >= 60_000) throw new CompanyError('temporarily_unavailable', 'proof validation exceeded freshness bound');
  }
  /** Authenticated scoped capability: no task/history/identity/file data is returned. Request nonce defeats reply replay. */
  async status(request: Request): Promise<Response> {
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const nonce = request.headers.get('x-sck-nonce') ?? '';
    const format = request.method !== 'GET' ? 'bad-method' : !bearer ? 'bad-bearer' : !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) ? 'bad-nonce' : 'ok';
    const audit: Record<string, unknown> = { at: new Date(this.now()).toISOString(), method: request.method, format, rowFound: false, valid: null, failReason: null, httpStatus: 401, statusHashPrefix: bearer ? sha256(bearer).slice(0, 8) : null };
    try {
      if (format !== 'ok') return new Response('unauthorized', {status: 401});
      const row = await this.deps.store.status(sha256(bearer!));
      audit.rowFound = !!row;
      if (!row) return new Response('unauthorized', {status: 401});
      const signer = await this.deps.signer(row.lease.project, row.files.manifest.env);
      // 状态 JWT 的时间声明带固定安全边距：签约宿主时钟可能快于校验方（本公司宿主曾快 ~5.5s，
      // 产品对 checkedAt/iat 零正向容差），显式签旧 30 秒保证任何宿主漂移 ≤+30s 时都不显未来；
      // 状态票据是请求级 nonce 绑定短票据，产品侧 60 秒新鲜窗仅等效缩为 ~30 秒，无语义损失。
      const STATUS_CLOCK_MARGIN_MS = 30_000;
      const issuedAt = this.now() - STATUS_CLOCK_MARGIN_MS;
      const checkedAt = Math.floor(issuedAt / 1000);
      let valid = true;
      try { await this.valid(row, signer, row.identities_digest); } catch (e) { valid = false; audit.failReason = statusFailReason(e); }
      audit.valid = valid;
      const at = Math.floor(this.now() / 1000);
      audit.httpStatus = 200;
      audit.payloadSummary = { valid, version: row.version, approvalVersion: row.approval?.version ?? null };
      return Response.json({ status: signer.sign('status', { jti: this.content(row).jti, valid, version: row.version, approvalVersion: row.approval?.version ?? null, checkedAt, iat: checkedAt, exp: Math.min(at + 60, checkedAt + 60), nonce }) }, { headers: { 'cache-control': 'no-store' } });
    } catch { audit.httpStatus = 503; return new Response('status unavailable', {status: 503}); }
    finally { await this.statusAudit(audit); }
  }
  /** One sanitized JSONL line per status request under <home>/logs; audit failures never change the response. */
  private async statusAudit(line: Record<string, unknown>): Promise<void> {
    try {
      let text = JSON.stringify(line);
      if (text.length > 2048) text = JSON.stringify({ at: line.at, method: line.method, format: line.format, httpStatus: line.httpStatus });
      const file = join(this.deps.home, 'logs', 'internal-ai-status.jsonl');
      await mkdir(join(this.deps.home, 'logs'), { recursive: true, mode: 0o700 });
      await appendFile(file, text + '\n', { mode: 0o600 });
      await chmod(file, 0o600).catch(() => undefined);
    } catch { /* observability must not affect the status response */ }
  }
}
/** failReason admits only short machine-word reasons (CompanyError messages are already fixed non-sensitive strings). */
const STATUS_REASON = /^[a-z0-9 _:-]{1,80}$/i;
const statusFailReason = (e: unknown): string => {
  const reason = e instanceof CompanyError ? e.message : e instanceof Error ? e.name : 'unknown';
  return STATUS_REASON.test(reason) ? reason : 'redacted';
};

/** Content-address the actual running implementation, including vendored plugin copies. */
let diagnosticVersion: Promise<string> | undefined;
function diagnosticCodeVersion(): Promise<string> {
  return diagnosticVersion ??= Promise.all(['proof-bridge.ts', 'proof-store.ts', 'proof-files.ts', 'proof-contract.ts', 'approval-diagnosis.ts'].map(file => readFile(new URL(file, import.meta.url)))).then(bytes => sha256(Buffer.concat(bytes)));
}
