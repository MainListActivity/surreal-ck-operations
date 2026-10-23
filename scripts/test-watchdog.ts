// Lifetime is one local test run. Parent SIGKILL cannot run finally; adoption ends its owned children here.
import { readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { stopGroups } from './test-processes.ts';
const parent = Number(process.argv[2]);
const dir = process.argv[3]!;
if (!Number.isSafeInteger(parent) || parent < 2 || !basename(dir).startsWith('sck-wt-regression-') || !dir.startsWith(tmpdir())) process.exit(2);
for (;;) {
  let state: { parent: number; groups: number[]; finished: boolean };
  try { state = JSON.parse(readFileSync(join(dir, 'processes.json'), 'utf8')); }
  catch { if (process.ppid !== parent) process.exit(1); await Bun.sleep(100); continue; }
  if (state.parent !== parent) process.exit(2);
  if (state.finished) process.exit(0);
  if (process.ppid !== parent) {
    await stopGroups(state.groups);
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }
  await Bun.sleep(100);
}
