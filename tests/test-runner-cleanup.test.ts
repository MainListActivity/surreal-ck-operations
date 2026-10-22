import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const run = existsSync(join(homedir(), '.surrealdb/surreal')) ? test : test.skip;
for (const mode of ['SIGTERM', 'SIGKILL', 'timeout'] as const) run(`local fork runner cleans DB, nested children and temporary data after ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-cleanup-'));
  const manifest = join(root, 'manifest.json'), nested = join(root, 'nested.json');
  const fixture = join(root, 'hanging.test.ts');
  writeFileSync(fixture, `import { test } from 'bun:test';\n test('hang', async () => {\n const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);\n await Bun.write(process.env.SCK_NESTED_PID!, JSON.stringify({pid:child.pid}));\n await new Promise(() => {});\n }, 100000);`);
  const runner = Bun.spawn([process.execPath, 'scripts/test-worktrees.ts', fixture], { stdout: 'ignore', stderr: 'ignore',
    env: { ...process.env, SCK_PRODUCT_ENV: '/dev/null', SCK_TEST_PROCESS_MANIFEST: manifest, SCK_NESTED_PID: nested, SCK_TEST_TIMEOUT_SECONDS: mode === 'timeout' ? '3' : '30' } });
  let state: { groups: number[]; watchdog: number; dir: string } | undefined;
  try {
    for (let n = 0; n < 200 && !existsSync(nested); n++) await Bun.sleep(25);
    expect(existsSync(nested)).toBe(true);
    state = JSON.parse(readFileSync(manifest, 'utf8'));
    const leaf = JSON.parse(readFileSync(nested, 'utf8')).pid as number;
    const pids = [...state!.groups, state!.watchdog, leaf];
    if (mode !== 'timeout') runner.kill(mode);
    await runner.exited;
    for (let n = 0; n < 240 && (pids.some(alive) || existsSync(state!.dir)); n++) await Bun.sleep(25);
    expect(pids.filter(alive)).toEqual([]);
    expect(existsSync(state!.dir)).toBe(false);
    if (mode === 'timeout') expect(runner.exitCode).toBe(124);
  } finally {
    if (runner.exitCode === null) runner.kill('SIGKILL');
    for (const pid of state?.groups ?? []) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
