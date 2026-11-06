import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readFileSync as rf, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDrill, type DrillExec, type DrillHost } from '../src/deploy-drill-runner.ts';
import type { DrillPlan } from '../src/deploy-drill.ts';

/** The detached worker entry must ship with the runner: startDrill spawns it by path. */
test('drill worker entry exists and wires runDrillDetached', () => {
  // fileURLToPath, not .pathname: the release lives under "Application Support", and .pathname leaves the space
  // percent-encoded, so existsSync would look for a path that cannot exist.
  const entry = fileURLToPath(new URL('../src/deploy-drill-run.ts', import.meta.url));
  expect(existsSync(entry)).toBe(true);
  expect(rf(entry, 'utf8')).toContain('runDrillDetached');
});

const stubExec = (failOn?: string): { exec: DrillExec; calls: string[]; killed: number[] } => {
  const calls: string[] = [];
  const killed: number[] = [];
  let nextPid = 4242;
  return {
    calls,
    killed,
    exec: {
      run: async (cmd, args) => {
        const line = `${cmd} ${args.join(' ')}`;
        calls.push(line);
        if (line.includes('vendor.sh')) {
          // The real vendor.sh materializes plugin/server/vendor; mirror that side effect.
          // args[0] is <release>/plugin/scripts/vendor.sh → vendor lives at ../../server/vendor from it.
          mkdirSync(join(args[0]!, '..', '..', 'server', 'vendor'), { recursive: true });
        }
        if (cmd === 'git' && args[0] === 'archive') {
          // A real archive carries both lockfiles; the prepare phase keys its installs on them.
          const out = args.find(a => a.startsWith('--output='))!.slice('--output='.length);
          mkdirSync(join(out, '..'), { recursive: true });
          writeFileSync(out, '');
          chmodSync(out, 0o644);
        }
        if (cmd === 'tar' && args[0] === '-xf') {
          const release = args[args.indexOf('-C') + 1]!;
          mkdirSync(join(release, 'plugin'), { recursive: true });
          mkdirSync(join(release, 'src'), { recursive: true });
          writeFileSync(join(release, 'src', 'core.ts'), '// archived candidate source\n');
          writeFileSync(join(release, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
          writeFileSync(join(release, 'plugin', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
        }
        if (line.includes('release_matches_commit')) {
          // Mirror the real binding: the manifest covers tracked files (not the generated vendor tree),
          // so any edit to an archived file must be refused.
          const release = args[3]!;
          if (readFileSync(join(release, 'src', 'core.ts'), 'utf8') !== '// archived candidate source\n') {
            return { code: 1, stdout: '', stderr: 'stub: release content differs from its commit' };
          }
          mkdirSync(join(release, 'plugin', 'server', 'vendor'), { recursive: true });
        }
        if (failOn && line.includes(failOn)) return { code: 1, stdout: '', stderr: `stub failure for ${failOn}` };
        if (line.includes('-e console.log(JSON.stringify({ bun: process.versions.bun }))')) {
          return { code: 0, stdout: JSON.stringify({ bun: '1.3.11' }), stderr: '' };
        }
        const stdout = line.includes('client-cli.ts')
          ? JSON.stringify({ principal: 'drill-fixture-eng', tasks: [] })
          // Long enough to exceed the old 500-character slice, like the real summary plus its auth-timing lines.
          : `DRILL_ORACLE_OK ${JSON.stringify({ leftoverTask: '90bc6a0d-dc28-498d-bc42-e26123737c8b', leftoverRefusal: 'conflict', leftoverDigestUnchanged: true, positiveControl: { taskId: 'e272a58b-bcea-44c4-80a4-07b725a3aaaa', claimed: true, deliveryId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, policyEpochPresent: true, authTiming: 'query=1ms digest=0ms total=1ms concurrentAtStart=1 queryOk=true '.repeat(6) })}`;
        return { code: 0, stdout, stderr: '' };
      },
      // The real face driver writes the channel file after it starts; the runner deletes the previous
      // one first, so the stub must re-publish per spawn or the next phase would read a dead channel.
      spawnDetached: async (_cmd, _args, opts) => {
        calls.push(`spawn ${opts.logFile}`);
        if (opts.logFile.includes('plugin-face-')) {
          writeFileSync(join(opts.logFile, '..', '..', 'face-channel.json'), JSON.stringify({ SCK_COMM_DIR: join(opts.logFile, '..', '..', 'comm'), SCK_COMM_KEY: 'k' }));
        }
        return nextPid++;
      },
      killTree: async pid => { killed.push(pid); },
      probe: async () => ({ ok: true, detail: "HTTP 200 ok" }),
      nowIso: () => new Date().toISOString(),
    },
  };
};

const plan = (root: string): DrillPlan => ({
  runId: '11111111-2222-4333-8444-555555555555', baseSha: 'a'.repeat(40), candidateSha: 'b'.repeat(40),
  root, releasesRoot: join(root, 'releases'), logsRoot: join(root, 'logs'), stagesRoot: join(root, 'stages'),
  dbPath: join(root, 'database'), mcpPort: '39201', dbPort: '39202', namespace: 'sck_drill_probe',
});

const host = (exec: DrillExec, serviceHome: string, states: unknown[]): DrillHost => ({
  repo: serviceHome, forkBinary: '/fixture/surreal', serviceHome, bun: '/fixture/bun', exec,
  state: () => undefined,
  writeState: (_plan, state) => { states.push(state); },
});

test('drill runner: success path writes report.json and passes every phase', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-runner-ok-'));
  try {
    mkdirSync(join(root, 'plugin', 'node_modules'), { recursive: true });
    // The face driver writes this at runtime; the runner reads it after the faces come up.
    writeFileSync(join(root, 'face-channel.json'), JSON.stringify({ SCK_COMM_DIR: join(root, 'comm'), SCK_COMM_KEY: 'k' }));
    const { exec, calls } = stubExec();
    const states: unknown[] = [];
    const { reportPath } = await runDrill(plan(root), host(exec, join(root, 'service-home'), states));
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.status).toBe('passed');
    expect(report.baseSha).toBe('a'.repeat(40));
    expect(report.phases.length).toBeGreaterThanOrEqual(9); // prepare x2, db-up, base-up, repoint, switch, oracle, rollback, cleanup
    expect(report.phases.every((p: { result: string }) => p.result === 'ok')).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: 'passed' });
    // The channel round-trip, the oracle and the cleanup all actually ran through the stub.
    expect(calls.some(c => c.includes('client-cli.ts'))).toBe(true);
    expect(calls.some(c => c.includes('deploy-drill-oracle.ts'))).toBe(true);
    expect(calls.some(c => c.includes('acceptance-guard.sh'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The drill database must outlive every face swap: killing it with the faces broke base-up's mcp child. */
test('drill runner keeps the fork database alive across face swaps and stops it at cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-runner-db-'));
  try {
    writeFileSync(join(root, 'face-channel.json'), JSON.stringify({ SCK_COMM_DIR: join(root, 'comm'), SCK_COMM_KEY: 'k' }));
    const { exec, calls, killed } = stubExec();
    const states: unknown[] = [];
    await runDrill(plan(root), host(exec, join(root, 'service-home'), states));
    // db-up spawns first (4242), then each face phase spawns mcp + face.
    const dbPid = 4242;
    const faceSpawns = calls.filter(c => c.startsWith('spawn ')).length - 1; // minus the database itself
    expect(faceSpawns).toBe(6); // base-up, switch, rollback × (mcp + face)
    // Faces are killed between phases, but the database pid is only stopped at cleanup (and never before).
    const dbKillsBeforeCleanup = killed.slice(0, killed.lastIndexOf(dbPid)).filter(pid => pid === dbPid).length;
    expect(dbKillsBeforeCleanup).toBe(0);
    expect(killed.at(-1)).toBe(dbPid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drill runner: failure path still writes report.json and marks the state failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-runner-fail-'));
  try {
    mkdirSync(join(root, 'plugin', 'node_modules'), { recursive: true });
    const { exec } = stubExec('acceptance-guard.sh'); // the candidate guard refuses: drill fails before any switch
    const states: unknown[] = [];
    await expect(runDrill(plan(root), host(exec, join(root, 'service-home'), states))).rejects.toThrow('acceptance_target_supported');
    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
    expect(report.status).toBe('failed');
    expect(String(report.error)).toContain('acceptance_target_supported');
    expect(states.at(-1)).toMatchObject({ status: 'failed' });
    // The failure happened in prepare: no face process was ever spawned.
    expect(report.phases.at(-1)?.result).toBe('failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** AC03: the release's own dependency trees are installed from its lockfiles, not copied from production. */
test('drill prepare installs both dependency trees from the release lockfiles and never copies production node_modules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-runner-deps-'));
  try {
    writeFileSync(join(root, 'face-channel.json'), JSON.stringify({ SCK_COMM_DIR: join(root, 'comm'), SCK_COMM_KEY: 'k' }));
    const { exec, calls } = stubExec();
    const states: unknown[] = [];
    await runDrill(plan(root), host(exec, join(root, 'service-home'), states));
    const pnpmRoot = calls.filter(c => c.startsWith('pnpm --dir ') && c.includes('--frozen-lockfile'));
    // One install per release for the root tree and one for its plugin tree (2 releases × 2 trees).
    expect(pnpmRoot.length).toBe(4);
    expect(calls.some(c => c.startsWith('cp -RL '))).toBe(false); // no production tree is copied in
    // The plugin tree is installed from <release>/plugin, the root tree from <release>.
    expect(pnpmRoot.some(c => new RegExp(`pnpm --dir .*/releases/[a-f0-9]{40}/plugin install`).test(c))).toBe(true);
    expect(pnpmRoot.some(c => new RegExp(`pnpm --dir .*/releases/[a-f0-9]{40} install`).test(c))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** AC05: a missing Bun must be named, not disguised as a face that never became healthy. */
test('drill refuses a non-Bun runtime before any phase runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-runner-runtime-'));
  try {
    const { exec, calls } = stubExec();
    // A Node execPath answers with no process.versions.bun — the exact shape of the production failure.
    const realRun = exec.run;
    exec.run = async (cmd, args, opts) => args.join(' ').includes('process.versions.bun')
      ? { code: 0, stdout: JSON.stringify({}), stderr: '' }
      : realRun(cmd, args, opts);
    const states: unknown[] = [];
    await expect(runDrill(plan(root), host(exec, join(root, 'service-home'), states))).rejects.toThrow('is not Bun');
    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
    expect(report.status).toBe('failed');
    expect(String(report.error)).toContain('Node cannot run the TypeScript worker/face/oracle');
    // Nothing else ran: no archive, no install, no face.
    expect(calls.some(c => c.startsWith('git -C'))).toBe(false);
    expect(calls.some(c => c.startsWith('spawn '))).toBe(false);
    expect(states.at(-1)).toMatchObject({ status: 'failed' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** AC05: a failed dependency install stops prepare and names the tree; later phases never run. */
test('drill stops at prepare when a release dependency install fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-runner-deps-fail-'));
  try {
    const { exec, calls } = stubExec('pnpm --dir');
    const states: unknown[] = [];
    await expect(runDrill(plan(root), host(exec, join(root, 'service-home'), states))).rejects.toThrow('pnpm install (root) failed with exit 1');
    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
    expect(report.status).toBe('failed');
    expect(report.phases.at(-1)?.phase).toBe('prepare');
    expect(calls.some(c => c.startsWith('spawn '))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** AC04: every stage record must hash to the log file it names — two prepare runs share a phase name. */
test('drill stage records keep a distinct, verifiable log hash per prepare run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-runner-logs-'));
  try {
    writeFileSync(join(root, 'face-channel.json'), JSON.stringify({ SCK_COMM_DIR: join(root, 'comm'), SCK_COMM_KEY: 'k' }));
    const { exec } = stubExec();
    const states: unknown[] = [];
    const { reportPath } = await runDrill(plan(root), host(exec, join(root, 'service-home'), states));
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const prepare = report.phases.filter((p: { phase: string }) => p.phase === 'prepare');
    expect(prepare.length).toBe(2);
    // Distinct SHAs → distinct log files → distinct hashes; the same file overwritten fails this.
    expect(prepare[0].logSha256).not.toBe(prepare[1].logSha256);
    for (const phase of report.phases) {
      const file = readFileSync(join(root, 'logs', `${phase.phase}${phase.phase === 'prepare' ? `-${phase.sha.slice(0, 8)}` : ''}.log`));
      expect(createHash('sha256').update(file).digest('hex')).toBe(phase.logSha256);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** AC04: the oracle summary must be recorded whole — truncation cut the positive control's deliveryId off. */
test('drill runner records the complete oracle summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-runner-oracle-'));
  try {
    writeFileSync(join(root, 'face-channel.json'), JSON.stringify({ SCK_COMM_DIR: join(root, 'comm'), SCK_COMM_KEY: 'k' }));
    const { exec } = stubExec();
    const states: unknown[] = [];
    await runDrill(plan(root), host(exec, join(root, 'service-home'), states));
    const oracle = readFileSync(join(root, 'logs', 'oracle.log'), 'utf8');
    const line = oracle.split('\n').find(l => l.includes('DRILL_ORACLE_OK'));
    expect(line).toBeDefined();
    // The recorded summary parses back as JSON: a truncated slice would throw here.
    const summary = JSON.parse(line!.slice(line!.indexOf('{')));
    expect(summary.leftoverDigestUnchanged).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
