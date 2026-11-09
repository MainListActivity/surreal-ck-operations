// 发行清单与发行包校验：CI 打包（scripts/plugin-package.ts）与节点更新器共用同一份格式，不做宽松兼容。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod';

export const PRODUCT_ID = 'sck-company';
export const MANIFEST_FORMAT = 1;
export const MANIFEST_ASSET = 'manifest.json';
export const UPDATER_ASSET = 'node-updater.js';
export const packageAssetName = (version: string): string => `sck-company-${version}.tgz`;

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

const releaseAssetSchema = z.object({
  name: z.string().min(1),
  sha256: z.string().regex(SHA256),
  bytes: z.number().int().positive(),
}).strict();

export const releaseManifestSchema = z.object({
  format: z.literal(MANIFEST_FORMAT),
  product: z.literal(PRODUCT_ID),
  version: z.string().regex(SEMVER),
  sha: z.string().regex(SHA40),
  requiredSchema: z.number().int().positive(),
  createdAt: z.string().min(1),
  package: releaseAssetSchema,
  updater: releaseAssetSchema,
}).strict();

export type ReleaseAsset = z.infer<typeof releaseAssetSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** 解析并校验清单：缺字段、多余字段或格式不对一律拒绝。 */
export function parseReleaseManifest(text: string): ReleaseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('发行清单不是合法 JSON');
  }
  const parsed = releaseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`发行清单无效：${issue?.path.join('.') ?? '(root)'} ${issue?.message ?? ''}`.trim());
  }
  return parsed.data;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 流式计算文件的 sha256 与字节数，大发行包不整体读入内存。 */
export function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(path);
    stream.on('data', chunk => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

/** 下载内容的 sha256 与字节数必须与清单完全一致，否则拒绝使用。 */
export function assertAssetIntegrity(actual: { sha256: string; bytes: number }, expected: ReleaseAsset): void {
  if (actual.sha256 !== expected.sha256) {
    throw new Error(`${expected.name} sha256 不符：清单 ${expected.sha256}，实际 ${actual.sha256}`);
  }
  if (actual.bytes !== expected.bytes) {
    throw new Error(`${expected.name} 大小不符：清单 ${expected.bytes}，实际 ${actual.bytes}`);
  }
}

/** 只接受 x.y.z 的数字版本比较：负数、0、正数分别表示 a 小于、等于、大于 b。 */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => {
    if (!SEMVER.test(version)) throw new Error(`版本号格式无效：${version}`);
    return version.split('.').map(Number);
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}
