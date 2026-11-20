import { expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Paseo installs the plugin by bundling index.server.ts with esbuild; the vendored ops src must not
 * drag in bun-only modules. Real regression (0.13.81): dispatcher imported isActivationRefused from
 * runner/native.ts → native-lock.ts → bun:ffi, and `paseo plugin install` failed with
 * "Could not resolve bun:ffi" while every test and typecheck stayed green.
 * esbuild must be the real one — Bun.build understands bun:* and would never see the failure.
 * The version is pinned to a release older than the incident so `bunx` resolves deterministically.
 */
test('插件服务端经 esbuild 打包：vendored src 不含 bun 专有模块', async () => {
  const plugin = join(import.meta.dir, '..', 'plugin');
  const vendor = Bun.spawn(['sh', 'scripts/vendor.sh'], { cwd: plugin, stdout: 'pipe', stderr: 'pipe' });
  expect(await vendor.exited).toBe(0);
  expect(existsSync(join(plugin, 'server', 'vendor', 'src', 'runner', 'activation-refused.ts'))).toBe(true);
  const out = join(import.meta.dir, '..', '.plugin-bundle-check.js');
  try {
    const proc = Bun.spawn(['bunx', 'esbuild@0.25.9', 'index.server.ts', '--bundle', '--platform=node',
      '--format=esm', `--outfile=${out}`], { cwd: plugin, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    expect(`${stdout}\n${stderr}`).not.toMatch(/Could not resolve "bun:/);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
  } finally { rmSync(out, { force: true }); }
}, 120_000);
