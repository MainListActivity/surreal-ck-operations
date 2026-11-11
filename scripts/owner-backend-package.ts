// bun --no-env-file scripts/owner-backend-package.ts --out DIR --sha SHA --version VERSION
import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dir, '..');
const { values } = parseArgs({
  args: process.argv.slice(2), strict: true,
  options: { out: { type: 'string' }, sha: { type: 'string' }, version: { type: 'string' } },
});
const number = '(?:0|[1-9][0-9]*)';
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
if (!values.out || !values.sha || !/^[0-9a-f]{40}$/.test(values.sha) ||
    !values.version || values.version.length > 128 || !semver.test(values.version)) {
  throw new Error('需要 --out DIR --sha <40位小写SHA> --version <semver>');
}
const out = resolve(values.out);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('输出目录必须为空，避免将其他文件混入发布包');

const build = await Bun.build({
  entrypoints: ['server.ts', 'server-cron.ts'].map((name) => resolve(root, 'owner-end/src', name)),
  target: 'bun', format: 'esm', packages: 'bundle', splitting: false,
  minify: true, sourcemap: 'none', naming: '[name].js',
});
if (!build.success) throw new AggregateError(build.logs, '老板端后端打包失败');
const files: Record<string, { sha256: string; size: number }> = {};
for (const artifact of build.outputs) {
  const name = artifact.path.split('/').at(-1)!;
  if (name !== 'server.js' && name !== 'server-cron.js') throw new Error('构建产生非白名单文件');
  const content = new Uint8Array(await artifact.arrayBuffer());
  files[name] = { sha256: createHash('sha256').update(content).digest('hex'), size: content.byteLength };
  await writeFile(resolve(out, name), content, { mode: 0o644, flag: 'wx' });
}
if (Object.keys(files).length !== 2) throw new Error('构建产物缺少服务或 cron 入口');
const manifest = { schema: 1, version: values.version, sha: values.sha, files };
await writeFile(resolve(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
console.log(JSON.stringify({ out, ...manifest }));
