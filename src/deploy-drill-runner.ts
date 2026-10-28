import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DRILL_PHASES, type DrillPhase, type DrillPlan } from './deploy-drill.ts';

/**
 * Executes one controlled drill inside the host process. Every phase writes a structured stage record
 * (runId, phase, sha, environment, UTC time, result, full-log sha256) under <root>/stages/ and its raw
 * log under <root>/logs/. The harness only ever touches paths under the drill root and never invokes
 * launchctl or paseo: the MCP face is a real `run-service.sh mcp` child of the drill root, and the
 * plugin-side face is the real client-cli -> sidecar -> drill-fork channel driven by the fixed face
 * driver shipped in the release tree.
 */

export interface DrillExec {
  run: (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;
  spawnDetached: (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; logFile: string }) => Promise<number>;
  killTree: (pid: number) => Promise<void>;
  healthy: (url: string) => Promise<boolean>;
  nowIso: () => string;
}

export interface DrillHost {
  repo: string;
  forkBinary: string;
  /** The parent service home: the pinned runtime-bun is copied from here into the drill root. */
  /** The Bun every drill child runs under (never Node: process.execPath is Node in the plugin face). */
  bun: string;
  serviceHome: string;
  exec: DrillExec;
  state: (plan: DrillPlan) => { status: string } | undefined;
  writeState: (plan: DrillPlan, state: { status: string; phase?: string; error?: string; runId: string }) => void;
}

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function runDrill(plan: DrillPlan, host: DrillHost): Promise<{ reportPath: string }> {
  const { exec } = host;
  if (host.state(plan)?.status === 'running') throw new Error('drill already running');
  host.writeState(plan, { runId: plan.runId, status: 'running' });
  mkdirSync(plan.logsRoot, { recursive: true });
  mkdirSync(plan.stagesRoot, { recursive: true });
  mkdirSync(plan.releasesRoot, { recursive: true });
  mkdirSync(join(plan.root, 'private'), { recursive: true });
  mkdirSync(join(plan.root, 'database'), { recursive: true });
  const pids: number[] = [];
  const stages: StageRecord[] = [];
  let phase: DrillPhase = 'prepare';
  const writeReport = (status: 'passed' | 'failed', error?: string): string => {
    const report = {
      runId: plan.runId, baseSha: plan.baseSha, candidateSha: plan.candidateSha, environment: 'drill',
      startedAt: stages[0]?.at ?? exec.nowIso(), finishedAt: exec.nowIso(), status, ...(error ? { error } : {}),
      phases: stages.map(({ runId: _r, environment: _e, ...rest }) => rest),
      oracleAssumption: 'older releases already contain the RB01 semantics; the oracle proves drill isolation and the faces did not misdispatch, not that the candidate introduced the behavior',
    };
    const path = join(plan.root, 'report.json');
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    return path;
  };
  try {
    // prepare: archive both releases, vendor, plugin deps, content binding, target guards.
    for (const sha of [plan.baseSha, plan.candidateSha]) {
      await drillPhase(plan, host, stages, 'prepare', sha, async log => {
        const release = join(plan.releasesRoot, sha);
        const archive = join(plan.root, `${sha}.tar`);
        await exec.run('git', ['-C', host.repo, 'archive', '--format=tar', `--output=${archive}`, sha], {}).then(assertOk);
        mkdirSync(release, { recursive: true });
        await exec.run('tar', ['-xf', archive, '-C', release], {}).then(assertOk);
        rmSync(archive, { force: true });
        const pluginDeps = join(host.repo, 'plugin', 'node_modules');
        if (existsSync(pluginDeps)) {
          mkdirSync(join(release, 'plugin', 'node_modules'), { recursive: true });
          await exec.run('cp', ['-RL', pluginDeps, join(release, 'plugin', 'node_modules')], {}).then(assertOk);
        }
        // The pinned service runtime rides into the drill root, so the faces run the same Bun production
        // runs (bun-runtime.sh resolves runtime-bun under the service home before ~/.bun).
        const pinnedRuntime = join(host.serviceHome, 'runtime-bun');
        if (existsSync(pinnedRuntime)) {
          await exec.run('cp', ['-RL', pinnedRuntime, join(plan.root, 'runtime-bun')], {}).then(assertOk);
          log('pinned runtime-bun copied into the drill root');
        }
        await exec.run('sh', [join(release, 'plugin', 'scripts', 'vendor.sh')], { cwd: release }).then(assertOk);
        // Content binding + all four target guards, from the target's own scripts: the drill must prove
        // the candidate passes exactly what a production switch would demand before it is switched to.
        await exec.run('sh', ['-c', '. "$1/scripts/release-content.sh"; release_matches_commit "$1" "$2" "$3"', 'bind', release, sha, host.repo], {}).then(assertOk);
        for (const guard of ['review-wait-guard.sh:review_wait_target_supported', 'independence-guard.sh:independence_target_supported',
          'policy-guard.sh:policy_target_supported', 'goal-workspace-guard.sh:goal_workspace_target_supported']) {
          const [script, fn] = guard.split(':');
          const r = await exec.run('sh', ['-c', `. "$1/scripts/${script}"; ${fn} "$1"`, 'guard', release], {});
          if (r.code !== 0) throw new Error(`target guard ${fn} refused ${sha}: ${r.stderr.slice(0, 300)}`);
        }
        log(`release ${sha} archived, vendored, content-bound and guard-checked`);
      });
    }
    // db-up: the company fork on the drill port; rocksdb lives only under the drill root.
    await drillPhase(plan, host, stages, 'db-up', plan.candidateSha, async () => {
      const env = drillDbEnv(plan);
      const pid = await exec.spawnDetached(host.forkBinary, ['start', '--bind', `127.0.0.1:${plan.dbPort}`, '--user', 'root', '--pass', env.SURREAL_ROOT_PASS, '--log', 'error', `rocksdb:${plan.dbPath}`],
        { env: {}, logFile: join(plan.logsRoot, 'fork-db.log') });
      pids.push(pid);
      await waitHealthy(exec, `http://127.0.0.1:${plan.dbPort}/health`);
      writeFileSync(join(plan.root, 'private', 'company-db.env'), `SURREAL_URL=ws://127.0.0.1:${plan.dbPort}/rpc\nSURREAL_ROOT_USER=root\nSURREAL_ROOT_PASS=${env.SURREAL_ROOT_PASS}\n`, { mode: 0o600 });
    });
    // base-up / switch / rollback share one face lifecycle helper.
    const facesUp = async (sha: string, phaseName: DrillPhase) => {
      await drillPhase(plan, host, stages, phaseName, sha, async log => {
        const release = join(plan.releasesRoot, sha);
        const serviceEnv = [
          `SCK_MCP_PORT=${plan.mcpPort}`, `SCK_COMPANY_NS=${plan.namespace}`, 'SCK_COMPANY_DB=control_plane',
          `SCK_AGENT_CWD=${host.repo}`,
        ].join('\n') + '\n';
        writeFileSync(join(plan.root, 'private', 'service.env'), serviceEnv, { mode: 0o600 });
        rmSync(join(plan.root, 'active.tmp'), { force: true });
        symlinkSync(release, join(plan.root, 'active.tmp'));
        renameSync(join(plan.root, 'active.tmp'), join(plan.root, 'active'));
        for (const pid of pids) await exec.killTree(pid).catch(() => undefined);
        pids.length = 0;
        const mcpLog = join(plan.logsRoot, `mcp-${sha.slice(0, 8)}.log`);
        const mcpPid = await exec.spawnDetached('sh', [join(release, 'scripts', 'run-service.sh'), 'mcp'],
          { env: { SCK_SERVICE_HOME: plan.root }, logFile: mcpLog });
        pids.push(mcpPid);
        await waitHealthy(exec, `http://127.0.0.1:${plan.mcpPort}/health`);
        await waitHealthy(exec, `http://127.0.0.1:${plan.mcpPort}/ready`);
        const faceLog = join(plan.logsRoot, `plugin-face-${sha.slice(0, 8)}.log`);
        const facePid = await exec.spawnDetached(host.bun, [join(release, 'scripts', 'deploy-drill-face.ts'), 'serve', plan.root],
          { env: {}, logFile: faceLog });
        pids.push(facePid);
        await waitHealthy(exec, `http://127.0.0.1:${plan.mcpPort}/ready`);
        // The channel round-trip is the real client-cli -> sidecar -> drill-fork path (`sck call get_context`):
        // a separate client process writes the request and reads the answer, exactly like production `sck call`.
        const channel = JSON.parse(readFileSync(join(plan.root, 'face-channel.json'), 'utf8')) as { SCK_COMM_DIR: string; SCK_COMM_KEY: string };
        const relay = await exec.run(host.bun, [join(release, 'src', 'mcp', 'client-cli.ts'), 'call', 'get_context', '{}'],
          { env: { SCK_COMM_DIR: channel.SCK_COMM_DIR, SCK_COMM_KEY: channel.SCK_COMM_KEY } });
        if (relay.code !== 0 || !relay.stdout.includes('"principal"')) {
          throw new Error(`plugin-face channel probe failed: ${(relay.stderr || relay.stdout).slice(0, 300)}`);
        }
        log(`both faces up from ${sha.slice(0, 8)}; mcp health/ready ok; channel probe ok`);
      });
    };
    await facesUp(plan.baseSha, 'base-up');
    // repoint-failure: the plugin face switch to a corrupted candidate source must fail and recover.
    await drillPhase(plan, host, stages, 'repoint-failure', plan.candidateSha, async log => {
      const release = join(plan.releasesRoot, plan.candidateSha);
      const vendor = join(release, 'plugin', 'server', 'vendor');
      const hidden = join(plan.root, 'vendor.hidden');
      renameSync(vendor, hidden);
      try {
        const r = await exec.run('sh', ['-c', '. "$1/scripts/release-content.sh"; release_matches_commit "$1" "$2" "$3"', 'bind', release, plan.candidateSha, host.repo], {});
        if (r.code === 0) throw new Error('content binding did not detect the corrupted candidate vendor; the drill oracle failed');
        log('corrupted candidate refused by content binding; switching proceeds only after restore');
      } finally {
        renameSync(hidden, vendor);
      }
    });
    await facesUp(plan.candidateSha, 'switch');
    // oracle: seed leftovers on the drill DB, then prove zero misdispatch / zero write with the candidate's own code.
    await drillPhase(plan, host, stages, 'oracle', plan.candidateSha, async log => {
      const r = await exec.run(host.bun, [join(plan.releasesRoot, plan.candidateSha, 'scripts', 'deploy-drill-oracle.ts'), plan.root], {}).then(assertOk);
      log(r.stdout.trim().slice(0, 500));
    });
    await facesUp(plan.baseSha, 'rollback');
    await drillPhase(plan, host, stages, 'cleanup', plan.baseSha, async log => {
      for (const pid of pids) await exec.killTree(pid).catch(() => undefined);
      pids.length = 0;
      rmSync(join(plan.root, 'database'), { recursive: true, force: true });
      rmSync(plan.releasesRoot, { recursive: true, force: true });
      rmSync(join(plan.root, 'runtime-bun'), { recursive: true, force: true });
      log('processes stopped; releases, runtime and drill database removed; stage records kept');
    });
    const reportPath = writeReport('passed');
    host.writeState(plan, { runId: plan.runId, status: 'passed' });
    return { reportPath };
  } catch (error) {
    for (const pid of pids) await host.exec.killTree(pid).catch(() => undefined);
    const message = String((error as Error).message ?? error).slice(0, 500);
    // The failure report is the machine-readable handoff to the audit and the rerunning task; write it
    // before rethrowing so a failed drill is never a bare running state without evidence.
    writeReport('failed', message).toString();
    host.writeState(plan, { runId: plan.runId, status: 'failed', phase, error: message });
    throw error;
  }
}

const drillDbEnv = (plan: DrillPlan) => ({
  SURREAL_URL: `ws://127.0.0.1:${plan.dbPort}/rpc`,
  SURREAL_ROOT_USER: 'root',
  SURREAL_ROOT_PASS: `drill-${plan.runId.slice(0, 8)}`,
});

async function waitHealthy(exec: DrillExec, url: string): Promise<void> {
  for (let n = 0; n < 200; n++) {
    if (await exec.healthy(url)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`drill face did not become healthy: ${url}`);
}

function assertOk(r: { code: number; stderr: string }): { code: number; stdout: string; stderr: string } {
  if (r.code !== 0) throw new Error(`drill command failed: ${r.stderr.slice(0, 300)}`);
  return r as { code: number; stdout: string; stderr: string };
}

/** One phase = one structured stage record + one raw log, both under the drill root. */
async function drillPhase(plan: DrillPlan, host: DrillHost, stages: StageRecord[], phase: DrillPhase, sha: string, body: (log: (line: string) => void) => Promise<void>): Promise<void> {
  const started = host.exec.nowIso();
  const logFile = join(plan.logsRoot, `${phase}.log`);
  const lines: string[] = [`phase ${phase} started ${started} sha ${sha}`];
  try {
    await body(line => lines.push(`${new Date().toISOString()} ${line}`));
    lines.push(`phase ${phase} ok ${host.exec.nowIso()}`);
    writeFileSync(logFile, lines.join('\n') + '\n');
    collectStage(plan, stages, { runId: plan.runId, phase, sha, environment: 'drill', at: started, finishedAt: host.exec.nowIso(), result: 'ok', logSha256: sha256File(logFile) });
  } catch (error) {
    lines.push(`phase ${phase} FAILED ${host.exec.nowIso()}: ${String((error as Error).message ?? error)}`);
    writeFileSync(logFile, lines.join('\n') + '\n');
    collectStage(plan, stages, { runId: plan.runId, phase, sha, environment: 'drill', at: started, finishedAt: host.exec.nowIso(), result: 'failed', logSha256: sha256File(logFile), error: String((error as Error).message ?? error).slice(0, 500) });
    throw error;
  }
}

interface StageRecord {
  runId: string; phase: DrillPhase; sha: string; environment: 'drill';
  at: string; finishedAt: string; result: 'ok' | 'failed'; logSha256: string; error?: string;
}

function collectStage(plan: DrillPlan, stages: StageRecord[], record: StageRecord): void {
  stages.push(record);
  const n = readdirSync(plan.stagesRoot).length;
  writeFileSync(join(plan.stagesRoot, `${String(n).padStart(2, '0')}-${record.phase}.json`), JSON.stringify(record, null, 2) + '\n');
}
