// 执行端发行包打包：bun scripts/release-package.ts --out <dir> [--sha <40位小写 hex>] [--verify-install]
//
// 产物写入 --out：sck-company-<version>.tgz 与 manifest.json。发行包内是 release.json、runtime/ 与 scripts/：
//   runtime/  执行端运行目录：根 package.json 与 pnpm-lock.yaml、src/、schema/、landscape/（不含测试与 node_modules）。
//             节点自更新对它执行 pnpm install --prod --frozen-lockfile --ignore-scripts，current 指向它。
//   scripts/  sck.sh 与 bun-runtime.sh，新版本确认后装到 <服务目录>/bin/。
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
  MANIFEST_ASSET,
  PRODUCT_ID,
  packageAssetName,
  releaseManifestSchema,
  sha256File,
  MANIFEST_FORMAT,
  type ReleaseManifest,
} from '../src/release-manifest.ts';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dir, '..');
const SHA40 = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

/** 发行包内的运行目录名（节点自更新按 runtime/、plugin/ 顺序识别）。 */
export const PAYLOAD_DIR = 'runtime';

/** 运行目录白名单：从仓库根复制的顶层条目。 */
export const RUNTIME_ENTRIES = ['package.json', 'pnpm-lock.yaml', 'src', 'schema', 'landscape'] as const;

/** 执行端入口（相对运行目录）；--verify-install 确认它们在 --prod 安装后能打包。 */
export const RUNTIME_ENTRYPOINTS = ['src/runner/run.ts', 'src/sck-cli.ts'] as const;

/**
 * 发行包 scripts/ 里的 sck 工具脚本：新版本确认后 sck.sh 装为 bin/sck，bun-runtime.sh 装到 bin/（sck.sh 按同目录找它）。
 * 缺任一文件都不打包，发行包不会缺工具。
 */
export const TOOL_SCRIPTS = ['sck.sh', 'bun-runtime.sh'] as const;

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

/** 把仓库根的运行所需条目按白名单暂存到 stageRuntimeDir（即发行包内的 runtime/）。 */
export async function stageRuntime(repoRoot: string, stageRuntimeDir: string): Promise<void> {
  await rm(stageRuntimeDir, { recursive: true, force: true });
  await mkdir(stageRuntimeDir, { recursive: true });
  for (const entry of RUNTIME_ENTRIES) {
    const src = join(repoRoot, entry);
    await stat(src).catch(() => {
      throw new Error(`仓库缺少运行目录条目：${entry}`);
    });
    await copyTree(src, join(stageRuntimeDir, entry));
  }
  for (const entry of RUNTIME_ENTRYPOINTS) {
    await stat(join(stageRuntimeDir, entry)).catch(() => {
      throw new Error(`运行目录缺少执行端入口：${entry}`);
    });
  }
}

/** 把 TOOL_SCRIPTS 从检出的 scripts/ 复制到发行副本的 scripts/（即发行包内的 scripts/ 目录）。 */
export async function stageToolScripts(scriptsDir: string, stageScriptsDir: string): Promise<void> {
  await rm(stageScriptsDir, { recursive: true, force: true });
  await mkdir(stageScriptsDir, { recursive: true });
  for (const name of TOOL_SCRIPTS) {
    const src = join(scriptsDir, name);
    await stat(src).catch(() => {
      throw new Error(`发行包缺少 scripts/${name}`);
    });
    await copyFile(src, join(stageScriptsDir, name));
  }
}

/** 写 <stageDir>/release.json：节点切换前核对产品、版本与 schema 要求；执行端也从这里读自己的版本。 */
export async function writeReleaseJson(
  stageDir: string,
  info: { version: string; sha: string; requiredSchema: number },
): Promise<void> {
  assertVersionAndSha(info.version, info.sha);
  const body = { product: PRODUCT_ID, version: info.version, sha: info.sha, requiredSchema: info.requiredSchema };
  await writeFile(join(stageDir, 'release.json'), `${JSON.stringify(body, null, 2)}\n`);
}

/** 打包 release.json、runtime/ 与 scripts/，COPYFILE_DISABLE 禁止生成 AppleDouble 文件。 */
export async function packTarball(stageDir: string, tgzPath: string): Promise<void> {
  await execFileAsync('tar', ['-czf', resolve(tgzPath), '-C', stageDir, 'release.json', PAYLOAD_DIR, 'scripts'], {
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
}): Promise<ReleaseManifest> {
  const pkg = await sha256File(input.packageFile);
  return releaseManifestSchema.parse({
    format: MANIFEST_FORMAT,
    product: PRODUCT_ID,
    version: input.version,
    sha: input.sha,
    requiredSchema: input.requiredSchema,
    createdAt: input.createdAt,
    package: { name: packageAssetName(input.version), sha256: pkg.sha256, bytes: pkg.bytes },
  });
}

/** 在临时目录按 --prod 锁定安装，并确认执行端与 sck 入口在生产依赖下可以打包（导入都能解析）。 */
export async function verifyInstall(stageRuntimeDir: string): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'sck-runtime-verify-'));
  try {
    const dir = join(tmp, PAYLOAD_DIR);
    await copyTree(stageRuntimeDir, dir);
    await run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], dir);
    await run(process.execPath, ['build', ...RUNTIME_ENTRYPOINTS.map(entry => join(dir, entry)), '--target=bun', '--outdir', join(tmp, 'out')], dir);
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
      'verify-install': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.out) throw new Error('缺少 --out <dir>');
  const out = resolve(values.out);
  const sha = values.sha ?? process.env.SCK_RELEASE_SHA ?? (await gitHead());
  if (!SHA40.test(sha)) throw new Error(`提交号必须是 40 位小写 hex：${sha}`);

  const version = await readJsonVersion(join(ROOT, 'package.json'));
  const companyVersion = await readJsonVersion(join(ROOT, 'company-release.json'));
  if (version !== companyVersion) {
    throw new Error(`版本不一致：根 package.json ${version}，company-release.json ${companyVersion}`);
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
  const stageRuntimeDir = join(stage, PAYLOAD_DIR);
  await stageRuntime(ROOT, stageRuntimeDir);
  await stageToolScripts(join(ROOT, 'scripts'), join(stage, 'scripts'));
  await writeReleaseJson(stage, { version, sha, requiredSchema });

  const tgzPath = join(out, packageAssetName(version));
  await packTarball(stage, tgzPath);
  const manifest = await buildManifest({ version, sha, requiredSchema, createdAt: new Date().toISOString(), packageFile: tgzPath });
  const manifestPath = join(out, MANIFEST_ASSET);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (values['verify-install']) await verifyInstall(stageRuntimeDir);

  for (const file of [tgzPath, manifestPath]) {
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
