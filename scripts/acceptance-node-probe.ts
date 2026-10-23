#!/usr/bin/env bun
// SYS02 C3 packed template: build the fixture for Node with Bun, then execute its default request path with Node itself.
// The record carries the Node version and the bundle hash; a Bun-only pass is refused by the server adapter.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
};
const out = value('out');
const runId = process.env.GITHUB_RUN_ID;
if (!runId) throw new Error('GITHUB_RUN_ID is required');
const dir = mkdtempSync(join(tmpdir(), 'sck-node-probe-'));
try {
  const bundle = join(dir, 'bundle.mjs');
  const build = Bun.spawnSync([process.execPath, 'build', 'scripts/acceptance-pack-fixture.ts', '--target=node', '--outfile', bundle], { stdout: 'pipe', stderr: 'pipe' });
  if (build.exitCode !== 0) throw new Error(`bun build failed: ${build.stderr.toString().slice(0, 400)}`);
  const runner = join(dir, 'run.mjs');
  writeFileSync(runner, `import handler from ${JSON.stringify(pathToFileURL(bundle).href)};
const value = await handler();
if (!value || value.ok !== true || value.path !== '/default') { console.error(JSON.stringify(value)); process.exit(1); }
console.log('node-ok');
`);
  const exec = Bun.spawnSync(['node', runner], { stdout: 'pipe', stderr: 'pipe' });
  if (exec.exitCode !== 0) throw new Error(`node failed: ${exec.stderr.toString().slice(0, 400)}`);
  const output = exec.stdout.toString().trim();
  if (output !== 'node-ok') throw new Error(`node output was ${JSON.stringify(output)}`);
  const version = Bun.spawnSync(['node', '--version'], { stdout: 'pipe' }).stdout.toString().trim();
  const bundleHash = createHash('sha256').update(readFileSync(bundle)).digest('hex');
  const record = {
    probe: 'acceptance', runId, jobId: process.env.GITHUB_JOB, readAt: new Date().toISOString(), inProgress: true,
    observationHash: createHash('sha256').update(output).digest('hex'), probeVersion: 'acceptance-probe/2',
    kind: 'node-packed', nodeVersion: version, bundleHash, target: 'scripts/acceptance-pack-fixture.ts', result: 'ok',
  };
  if (out) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
} finally { rmSync(dir, { recursive: true, force: true }); }
