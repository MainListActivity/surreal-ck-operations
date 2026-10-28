import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readFileSync as rf, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDrill, type DrillExec, type DrillHost } from '../src/deploy-drill-runner.ts';
import type { DrillPlan } from '../src/deploy-drill.ts';

/** The detached worker entry must ship with the runner: startDrill spawns it by path. */
test('drill worker entry exists and wires runDrillDetached', () => {
  const entry = new URL('../src/deploy-drill-run.ts', import.meta.url).pathname;
  expect(existsSync(entry)).toBe(true);
  expect(rf(entry, 'utf8')).toContain('runDrillDetached');
});

const stubExec = (failOn?: string): { exec: DrillExec; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    exec: {
      run: async (cmd, args) => {
        const line = `${cmd} ${args.join(' ')}`;
        calls.push(line);
        if (line.includes('vendor.sh')) {
          // The real vendor.sh materializes plugin/server/vendor; mirror that side effect.
          // args[0] is <release>/plugin/scripts/vendor.sh → vendor lives at ../../server/vendor from it.
          mkdirSync(join(args[0]!, '..', '..', 'server', 'vendor'), { recursive: true });
        }
        if (line.includes('release_matches_commit')) {
          // Mirror the real binding: the check fails while the release's vendor tree is absent.
          const vendorDir = join(args[3]!, 'plugin', 'server', 'vendor');
          if (!existsSync(vendorDir)) return { code: 1, stdout: '', stderr: 'stub: vendor missing' };
        }
        if (failOn && line.includes(failOn)) return { code: 1, stdout: '', stderr: `stub failure for ${failOn}` };
        const stdout = line.includes('client-cli.ts')
          ? JSON.stringify({ principal: 'drill-fixture-eng', tasks: [] })
          : `DRILL_ORACLE_OK ${JSON.stringify({ leftoverDigestUnchanged: true })}`;
        return { code: 0, stdout, stderr: '' };
      },
      spawnDetached: async (_cmd, _args, opts) => { calls.push(`spawn ${opts.logFile}`); return 4242; },
      killTree: async () => {},
      healthy: async () => true,
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
    expect(calls.some(c => c.includes('goal-workspace-guard.sh'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drill runner: failure path still writes report.json and marks the state failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-runner-fail-'));
  try {
    mkdirSync(join(root, 'plugin', 'node_modules'), { recursive: true });
    const { exec } = stubExec('policy-guard.sh'); // the candidate guard refuses: drill fails before any switch
    const states: unknown[] = [];
    await expect(runDrill(plan(root), host(exec, join(root, 'service-home'), states))).rejects.toThrow('policy_target_supported');
    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
    expect(report.status).toBe('failed');
    expect(String(report.error)).toContain('policy_target_supported');
    expect(states.at(-1)).toMatchObject({ status: 'failed' });
    // The failure happened in prepare: no face process was ever spawned.
    expect(report.phases.at(-1)?.result).toBe('failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
