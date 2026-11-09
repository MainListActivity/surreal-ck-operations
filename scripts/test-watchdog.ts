// Lifetime is one local test run. Parent SIGKILL cannot run finally; adoption ends its owned children here.
import { readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { stopGroups } from './test-processes.ts';
const parent = Number(process.argv[2]);
const dir = process.argv[3]!;
if (!Number.isSafeInteger(parent) || parent < 2 || !basename(dir).startsWith('sck-wt-regression-') || !dir.startsWith(tmpdir())) process.exit(2);
// Bun caches process.ppid: an adopted watchdog keeps reporting the dead runner's pid, so ask the kernel whether the runner exists.
const runnerGone = (): boolean => {
  try { process.kill(parent, 0); return false; }
  catch (error) { return (error as { code?: string }).code !== 'EPERM'; }
};
for (;;) {
  let state: { parent: number; groups: number[]; finished: boolean };
  try { state = JSON.parse(readFileSync(join(dir, 'processes.json'), 'utf8')); }
  catch { if (runnerGone()) process.exit(1); await Bun.sleep(100); continue; }
  if (state.parent !== parent) process.exit(2);
  if (state.finished) process.exit(0);
  if (runnerGone()) {
    await stopGroups(state.groups);
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }
  await Bun.sleep(100);
}
