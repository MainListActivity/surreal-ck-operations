import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, relative, sep, join } from 'node:path';
import { CompanyError } from '../core-errors.ts';
import { manifestSchema, evidenceSchema, configurationDigest, sha256, tokenPlanV3Eligible, magpieEvidenceEligible, TOKEN_PLAN_PLAN_TYPE_FREE, type ServiceEvidence, type ProofManifest } from './proof-contract.ts';
const denied = () => new CompanyError('forbidden', 'approval file unavailable or unsafe');
/** v1 binds account/endpoint/model/price; v2 binds the Magpie account/endpoint/route digest/price. */
function serviceFieldsMatch(evidence: ServiceEvidence, manifest: ProofManifest): boolean {
  const service = manifest.service;
  if ('kind' in service) {
    return evidence.type === 'magpie-controlled-route'
      && evidence.accountRef === service.accountRef
      && evidence.endpoint === service.endpoint
      && evidence.route.group === service.routeId
      && evidence.route.digest === service.routeDigest
      && evidence.priceRevision === service.priceRevision;
  }
  return evidence.type !== 'magpie-controlled-route'
    && evidence.accountRef === service.accountRef
    && evidence.endpoint === service.endpoint
    && evidence.model === service.model
    && evidence.priceRevision === service.priceRevision;
}
/** No symlink components; hash the same bounded fd that was opened and recheck metadata after reading. */
export async function readProofFile(home: string, task: string, path: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(task)) throw denied();
  const abs = resolve(path);
  const roots = ['evidence', 'deliverables'].map(kind => resolve(home, kind, task));
  const root = roots.find(r => abs.startsWith(r + sep));
  if (!root) throw denied();
  const rel = relative(root, abs);
  if (!rel.endsWith('.json') || rel.split(sep).some(p => !/^[A-Za-z0-9_-]+(?:\.json)?$/.test(p) || /secret|credential|customer|token|password|env/i.test(p))) throw denied();
  const check = async () => {
    if (await realpath(root) !== root || await realpath(abs) !== abs) throw denied();
    let p = root;
    for (const part of rel.split(sep)) { p = join(p, part); if ((await lstat(p)).isSymbolicLink()) throw denied(); }
  };
  try {
    await check();
    const fd = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await fd.stat();
      if (!before.isFile() || before.size < 1 || before.size > 256 * 1024) throw denied();
      const bytes = Buffer.alloc(before.size + 1);
      const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
      const after = await fd.stat(); const current = await lstat(abs);
      await check();
      if (bytesRead !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw denied();
      return bytes.subarray(0, bytesRead);
    } finally { await fd.close(); }
  } catch { throw denied(); }
}
export function parseProofFiles(rawManifest: Buffer, rawDocument: Buffer) {
  const manifest = manifestSchema.safeParse(parseJson(rawManifest));
  const evidence = evidenceSchema.safeParse(parseJson(rawDocument));
  if (!manifest.success || !evidence.success) return { manifest, evidence };
  const { configurationDigest: digest, ...rest } = manifest.data;
  return { manifest, evidence, digestValid: digest === configurationDigest(rest),
    documentHashValid: manifest.data.documentHash === sha256(rawDocument),
    serviceFieldsMatch: serviceFieldsMatch(evidence.data, manifest.data) };
}
function parseJson(bytes: Buffer): unknown { try { return JSON.parse(bytes.toString('utf8')); } catch { return null; } }
export function evidenceChecks(e: ServiceEvidence, manifest: ProofManifest, now: number) {
  return { sampleNotFuture: Date.parse(e.sampledAt) <= now, evidenceUnexpired: Date.parse(e.expiresAt) > now,
    serviceEvidenceEligible: e.type === 'reviewed-service'
      ? e.serviceApproved && e.balanceNanoUsd >= manifest.budget.totalNanoUsd
      : e.type === 'magpie-controlled-route'
        ? magpieEvidenceEligible(e, now)
        : e.type === 'reviewed-token-plan'
          ? e.schemaVersion === 3
            ? tokenPlanV3Eligible(e, now)
            : e.serviceApproved && e.quotaAmount > 0 && (e.quotaRemaining == null || e.quotaRemaining > 0) && e.accountPlanType === TOKEN_PLAN_PLAN_TYPE_FREE && now - Date.parse(e.sampledAt) <= 86_400_000
          : false };
}
export async function loadProofFiles(home: string, task: string, manifestPath: string, documentPath: string) {
  const [rawManifest, rawDocument] = await Promise.all([readProofFile(home, task, manifestPath), readProofFile(home, task, documentPath)]);
  const parsed = parseProofFiles(rawManifest, rawDocument);
  if (!parsed.manifest.success || !parsed.evidence.success || !parsed.digestValid || !parsed.documentHashValid || !parsed.serviceFieldsMatch) throw new CompanyError('invalid', 'approval manifest/evidence mismatch or unsupported format');
  return { manifest: parsed.manifest.data, evidence: parsed.evidence.data, manifestHash: sha256(rawManifest), documentHash: sha256(rawDocument), manifestPath: resolve(manifestPath), documentPath: resolve(documentPath) };
}
export type ProofFiles = Awaited<ReturnType<typeof loadProofFiles>>;
