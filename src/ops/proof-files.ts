import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, relative, sep, join } from 'node:path';
import { CompanyError } from '../core-errors.ts';
import { manifestSchema, evidenceSchema, configurationDigest, sha256 } from './proof-contract.ts';
const denied = () => new CompanyError('forbidden', 'approval file unavailable or unsafe');
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
export async function loadProofFiles(home: string, task: string, manifestPath: string, documentPath: string) {
  const [rawManifest, rawDocument] = await Promise.all([readProofFile(home, task, manifestPath), readProofFile(home, task, documentPath)]);
  try {
    const manifest = manifestSchema.parse(JSON.parse(rawManifest.toString('utf8')));
    const evidence = evidenceSchema.parse(JSON.parse(rawDocument.toString('utf8')));
    const { configurationDigest: digest, ...rest } = manifest;
    if (digest !== configurationDigest(rest) || manifest.documentHash !== sha256(rawDocument) || evidence.accountRef !== manifest.service.accountRef || evidence.endpoint !== manifest.service.endpoint || evidence.model !== manifest.service.model || evidence.priceRevision !== manifest.service.priceRevision) throw denied();
    return { manifest, evidence, manifestHash: sha256(rawManifest), documentHash: sha256(rawDocument), manifestPath: resolve(manifestPath), documentPath: resolve(documentPath) };
  } catch { throw new CompanyError('invalid', 'approval manifest/evidence mismatch or unsupported format'); }
}
export type ProofFiles = Awaited<ReturnType<typeof loadProofFiles>>;
