// 插件发行包打包：bun scripts/plugin-package.ts --out <dir> [--sha <40位小写 hex>] [--verify-install]
//
// 产物写入 --out：sck-company-<version>.tgz（release.json + plugin/，不含 node_modules）、node-updater.js、manifest.json。
// 节点更新器会对 plugin/ 执行 pnpm install --prod --frozen-lockfile --ignore-scripts，所以锁文件必须与 package.json 一致。
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
  MANIFEST_ASSET,
  PRODUCT_ID,
  UPDATER_ASSET,
  packageAssetName,
  releaseManifestSchema,
  sha256File,
  MANIFEST_FORMAT,
  type ReleaseManifest,
} from '../src/release-manifest.ts';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dir, '..');
const PLUGIN_DIR = join(ROOT, 'plugin');
const UPDATER_ENTRY = join(ROOT, 'scripts', 'node-updater.ts');
const SHA40 = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

/** 发行包白名单：只复制插件运行所需的顶层条目。 */
export const PLUGIN_ENTRIES = [
  'paseo-plugin.json',
  'package.json',
  'pnpm-lock.yaml',
  'index.client.tsx',
  'index.server.ts',
  'client',
  'server',
  'shared',
] as const;

/** 排除规则：node_modules、*.tmp、.ignored_*、AppleDouble（._*）、*.test.*、tsconfig.json。 */
export function excluded(name: string): boolean {
  return (
    name === 'node_modules' ||
    name.endsWith('.tmp') ||
    name.startsWith('.ignored_') ||
    name.startsWith('._') ||
    /\.test\./.test(name) ||
    name === 'tsconfig.json'
  );
}

async function copyTree(src: string, dst: string): Promise<void> {
  const info = await stat(src);
  if (info.isDirectory()) {
    await mkdir(dst, { recursive: true });
    for (const name of await readdir(src)) {
      if (excluded(name)) continue;
      await copyTree(join(src, name), join(dst, name));
    }
  } else if (info.isFile()) {
    await copyFile(src, dst);
  } else {
    throw new Error(`不支持的文件类型：${src}`);
  }
}

/** 把插件源码按白名单暂存到 stagePluginDir（即发行包内的 plugin/ 目录）。 */
export async function stagePlugin(pluginDir: string, stagePluginDir: string): Promise<void> {
  await rm(stagePluginDir, { recursive: true, force: true });
  await mkdir(stagePluginDir, { recursive: true });
  for (const entry of PLUGIN_ENTRIES) {
    const src = join(pluginDir, entry);
    await stat(src).catch(() => {
      throw new Error(`插件源缺少白名单条目：${entry}`);
    });
    await copyTree(src, join(stagePluginDir, entry));
  }
  for (const rel of ['server/vendor/src', 'server/vendor/schema']) {
    const info = await stat(join(stagePluginDir, rel)).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`发行包缺少 ${rel}：先运行 sh plugin/scripts/vendor.sh`);
  }
}

/** 覆写发行副本中的版本戳（源码检出里保持 dev 占位）。 */
export async function writeReleaseStamp(
  stagePluginDir: string,
  stamp: { version: string; sha: string },
): Promise<void> {
  assertVersionAndSha(stamp.version, stamp.sha);
  const body = `export const RELEASE = { version: "${stamp.version}", sha: "${stamp.sha}" } as const;\n`;
  await writeFile(join(stagePluginDir, 'server', 'release-stamp.ts'), body);
}

/** 写 <stageDir>/release.json：节点安装前用于核对产品、版本与 schema 要求。 */
export async function writeReleaseJson(
  stageDir: string,
  info: { version: string; sha: string; requiredSchema: number },
): Promise<void> {
  assertVersionAndSha(info.version, info.sha);
  const body = { product: PRODUCT_ID, version: info.version, sha: info.sha, requiredSchema: info.requiredSchema };
  await writeFile(join(stageDir, 'release.json'), `${JSON.stringify(body, null, 2)}\n`);
}

/** 打包 release.json 与 plugin/，COPYFILE_DISABLE 禁止生成 AppleDouble 文件。 */
export async function packTarball(stageDir: string, tgzPath: string): Promise<void> {
  await execFileAsync('tar', ['-czf', resolve(tgzPath), '-C', stageDir, 'release.json', 'plugin'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
}

/** 生成并校验发行清单；资产名与格式来自 src/release-manifest.ts。 */
export async function buildManifest(input: {
  version: string;
  sha: string;
  requiredSchema: number;
  createdAt: string;
  packageFile: string;
  updaterFile: string;
}): Promise<ReleaseManifest> {
  const pkg = await sha256File(input.packageFile);
  const updater = await sha256File(input.updaterFile);
  return releaseManifestSchema.parse({
    format: MANIFEST_FORMAT,
    product: PRODUCT_ID,
    version: input.version,
    sha: input.sha,
    requiredSchema: input.requiredSchema,
    createdAt: input.createdAt,
    package: { name: packageAssetName(input.version), sha256: pkg.sha256, bytes: pkg.bytes },
    updater: { name: UPDATER_ASSET, sha256: updater.sha256, bytes: updater.bytes },
  });
}

/** 打包节点更新器单文件。源文件缺失时失败，不生成空产物。 */
export async function buildUpdater(entry: string, outFile: string): Promise<void> {
  await stat(entry).catch(() => {
    throw new Error(`节点更新器源文件不存在：${entry}`);
  });
  await run(process.execPath, ['build', entry, '--target', 'node', '--outfile', outFile], ROOT);
}

/** 在临时目录按 --prod 锁定安装，并确认服务端入口可以打包。 */
export async function verifyInstall(stagePluginDir: string): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'sck-plugin-verify-'));
  try {
    const dir = join(tmp, 'plugin');
    await copyTree(stagePluginDir, dir);
    await run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], dir);
    await run(process.execPath, ['build', join(dir, 'index.server.ts'), '--target=bun', '--outdir', join(tmp, 'out')], dir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function assertVersionAndSha(version: string, sha: string): void {
  if (!SEMVER.test(version)) throw new Error(`版本号格式无效：${version}`);
  if (!SHA40.test(sha)) throw new Error(`提交号必须是 40 位小写 hex：${sha}`);
}

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string };
    const output = `${detail.stdout ?? ''}${detail.stderr ?? ''}`.slice(-4000);
    throw new Error(`${cmd} ${args.join(' ')} 失败\n${output}`);
  }
}

async function readJsonVersion(path: string): Promise<string> {
  const data = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown };
  if (typeof data.version !== 'string') throw new Error(`${path} 缺少 version`);
  return data.version;
}

async function gitHead(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
  return stdout.trim();
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      sha: { type: 'string' },
      updater: { type: 'string' },
      'verify-install': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.out) throw new Error('缺少 --out <dir>');
  const out = resolve(values.out);
  const sha = values.sha ?? process.env.SCK_RELEASE_SHA ?? (await gitHead());
  if (!SHA40.test(sha)) throw new Error(`提交号必须是 40 位小写 hex：${sha}`);

  await run('sh', ['scripts/vendor.sh'], PLUGIN_DIR);

  const version = await readJsonVersion(join(PLUGIN_DIR, 'package.json'));
  const rootVersion = await readJsonVersion(join(ROOT, 'package.json'));
  const companyVersion = await readJsonVersion(join(ROOT, 'company-release.json'));
  if (version !== rootVersion || version !== companyVersion) {
    throw new Error(`版本不一致：plugin ${version}，根 package.json ${rootVersion}，company-release.json ${companyVersion}`);
  }
  if (!SEMVER.test(version)) throw new Error(`版本号格式无效：${version}`);

  const { schemaRequirementFor } = await import('../src/company-release.ts');
  const { CLOUD_SCHEMA_VERSION } = await import('../src/database.ts');
  const requiredSchema = schemaRequirementFor(version).schema;
  if (requiredSchema !== CLOUD_SCHEMA_VERSION) {
    throw new Error(`schema 要求不一致：版本 ${version} 需要 ${requiredSchema}，src/database.ts 为 ${CLOUD_SCHEMA_VERSION}`);
  }

  await mkdir(out, { recursive: true });
  const stage = join(out, 'stage');
  const stagePluginDir = join(stage, 'plugin');
  await stagePlugin(PLUGIN_DIR, stagePluginDir);
  await writeReleaseStamp(stagePluginDir, { version, sha });
  await writeReleaseJson(stage, { version, sha, requiredSchema });

  const tgzPath = join(out, packageAssetName(version));
  await packTarball(stage, tgzPath);
  const updaterPath = join(out, UPDATER_ASSET);
  await buildUpdater(values.updater ?? UPDATER_ENTRY, updaterPath);

  const manifest = await buildManifest({
    version,
    sha,
    requiredSchema,
    createdAt: new Date().toISOString(),
    packageFile: tgzPath,
    updaterFile: updaterPath,
  });
  const manifestPath = join(out, MANIFEST_ASSET);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (values['verify-install']) await verifyInstall(stagePluginDir);

  for (const file of [tgzPath, manifestPath, updaterPath]) {
    const info = await stat(file);
    const { sha256, bytes } = await sha256File(file);
    console.log(`${file}  bytes=${info.size} (${bytes})  sha256=${sha256}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`打包失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
