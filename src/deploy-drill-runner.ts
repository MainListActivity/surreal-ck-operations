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
  probe: (url: string) => Promise<{ ok: boolean; detail: string }>;
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
  // Faces are replaced on every switch, so they are killed and respawned per phase. The drill database
  // outlives all of them: it is tracked separately, or the first base-up would take it down with the
  // previous faces and every mcp child would then fail to connect.
  const pids: number[] = [];
  let dbPid: number | undefined;
  // AC04: the report names the runtime the drill actually resolved, so "ran under Bun, not Node" is
  // evidence rather than an assumption about the host.
  let runtimeBun: { path: string; version: string } | undefined;
  const stages: StageRecord[] = [];
  let phase: DrillPhase = 'prepare';
  const writeReport = (status: 'passed' | 'failed', error?: string): string => {
    const report = {
      runId: plan.runId, baseSha: plan.baseSha, candidateSha: plan.candidateSha, environment: 'drill',
      startedAt: stages[0]?.at ?? exec.nowIso(), finishedAt: exec.nowIso(), status, ...(error ? { error } : {}),
      ...(runtimeBun ? { runtime: runtimeBun } : {}),
      phases: stages.map(({ runId: _r, environment: _e, ...rest }) => rest),
      oracleAssumption: 'older releases already contain the RB01 semantics; the oracle proves drill isolation and the faces did not misdispatch, not that the candidate introduced the behavior',
    };
    const path = join(plan.root, 'report.json');
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    return path;
  };
  try {
    // AC02/AC05: prove the runtime before any phase can look like progress. A Node execPath or a
    // missing Bun must fail here with the runtime named, not surface later as a face that never
    // reported healthy (which reads like a port problem).
    const runtime = await exec.run(host.bun, ['-e', 'console.log(JSON.stringify({ bun: process.versions.bun }))'], {});
    assertOk(runtime, `drill runtime ${host.bun}`);
    let runtimeVersion: string | undefined;
    try { runtimeVersion = (JSON.parse(runtime.stdout.trim()) as { bun?: string }).bun; } catch { runtimeVersion = undefined; }
    if (!runtimeVersion) throw new Error(`drill runtime ${host.bun} is not Bun (no process.versions.bun); Node cannot run the TypeScript worker/face/oracle`);
    runtimeBun = { path: host.bun, version: runtimeVersion };
    // prepare: archive both releases, vendor, plugin deps, content binding, target guards.
    for (const sha of [plan.baseSha, plan.candidateSha]) {
      await drillPhase(plan, host, stages, 'prepare', sha, async log => {
        const release = join(plan.releasesRoot, sha);
        const archive = join(plan.root, `${sha}.tar`);
        await exec.run('git', ['-C', host.repo, 'archive', '--format=tar', `--output=${archive}`, sha], {}).then(r => assertOk(r, `git archive ${sha.slice(0, 8)}`));
        mkdirSync(release, { recursive: true });
        await exec.run('tar', ['-xf', archive, '-C', release], {}).then(r => assertOk(r, `untar ${sha.slice(0, 8)}`));
        rmSync(archive, { force: true });
        // AC03: both dependency trees are installed from the release's own frozen lockfiles. Copying the
        // ops checkout's plugin/node_modules would tie the drill to a mutable production tree, and the
        // checkout's root node_modules is the running service's own — neither is drill evidence.
        // node_modules is excluded from the content binding, so the release stays content-bound.
        for (const [dir, label] of [[release, 'root'], [join(release, 'plugin'), 'plugin']] as const) {
          if (!existsSync(join(dir, 'pnpm-lock.yaml'))) continue;
          await exec.run('pnpm', ['--dir', dir, 'install', '--frozen-lockfile', '--ignore-scripts'], {}).then(r => assertOk(r, `pnpm install (${label})`));
          log(`${label} dependencies installed from the release lockfile`);
        }
        // The pinned service runtime rides into the drill root, so the faces run the same Bun production
        // runs (bun-runtime.sh resolves runtime-bun under the service home before ~/.bun).
        const pinnedRuntime = join(host.serviceHome, 'runtime-bun');
        if (existsSync(pinnedRuntime)) {
          await exec.run('cp', ['-RL', pinnedRuntime, join(plan.root, 'runtime-bun')], {}).then(r => assertOk(r, 'copy pinned runtime'));
          log('pinned runtime-bun copied into the drill root');
        }
        await exec.run('sh', [join(release, 'plugin', 'scripts', 'vendor.sh')], { cwd: release }).then(r => assertOk(r, `vendor ${sha.slice(0, 8)}`));
        // Content binding + all four target guards, from the target's own scripts: the drill must prove
        // the candidate passes exactly what a production switch would demand before it is switched to.
        await exec.run('sh', ['-c', '. "$1/scripts/release-content.sh"; release_matches_commit "$1" "$2" "$3"', 'bind', release, sha, host.repo], {}).then(r => assertOk(r, `content binding ${sha.slice(0, 8)}`));
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
      dbPid = pid;
      await waitHealthy(exec, `http://127.0.0.1:${plan.dbPort}/health`);
      writeFileSync(join(plan.root, 'private', 'company-db.env'), `SURREAL_URL=ws://127.0.0.1:${plan.dbPort}/rpc\nSURREAL_ROOT_USER=root\nSURREAL_ROOT_PASS=${env.SURREAL_ROOT_PASS}\n`, { mode: 0o600 });
    });
    // base-up / switch / rollback share one face lifecycle helper.
    const facesUp = async (sha: string, phaseName: DrillPhase) => {
      await drillPhase(plan, host, stages, phaseName, sha, async log => {
        const release = join(plan.releasesRoot, sha);
        // Every release's face driver enrolls its fixed fixture manager on startup, and all phases share
        // one drill database (same data across the switch — that is the point). Clearing the fixture
        // identity first keeps the old driver working from its own tree, which cannot be patched here.
        const reset = await exec.probe(`http://127.0.0.1:${plan.dbPort}/health`); // liveness only; keeps failures legible
        if (!reset.ok) throw new Error(`drill database is not healthy before ${phaseName}: ${reset.detail}`);
        const cleared = await exec.run('sh', ['-c',
          'body=$(curl -fsS -u "$1:$2" -H "surreal-ns: $3" -H "surreal-db: control_plane" -H "accept: application/json" ' +
          '--data "DELETE employee:\\`drill-fixture-manager\\`;" "http://127.0.0.1:$4/sql") || { printf "%s" "$body"; exit 1; }; ' +
          // The first phase runs before any face has created the namespace: nothing to clear is success.
          'case "$body" in *\'"kind":"NotFound"\'*) exit 0;; *\'"status":"ERR"\'*) printf "%s" "$body"; exit 1;; esac; printf "%s" "$body"', 'fixtures',
          'root', `drill-${plan.runId.slice(0, 8)}`, plan.namespace, plan.dbPort], {});
        assertOk(cleared, `reset face fixtures (${phaseName})`);
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
        await waitHealthy(exec, `http://127.0.0.1:${plan.mcpPort}/health`, log);
        await waitHealthy(exec, `http://127.0.0.1:${plan.mcpPort}/ready`, log);
        const faceLog = join(plan.logsRoot, `plugin-face-${sha.slice(0, 8)}.log`);
        // Remove the previous face's channel first: it points at a process this phase just stopped, so
        // waiting only for the file to exist would read the dead face's key and time out.
        const channelFile = join(plan.root, 'face-channel.json');
        rmSync(channelFile, { force: true });
        const facePid = await exec.spawnDetached(host.bun, [join(release, 'scripts', 'deploy-drill-face.ts'), 'serve', plan.root],
          // Without the namespace here the face falls back to the default company namespace, which is
          // not the drill's: fixtures and leftovers would live outside the namespace the oracle checks.
          { env: { SCK_COMPANY_NS: plan.namespace, SCK_COMPANY_DB: 'control_plane' }, logFile: faceLog });
        pids.push(facePid);
        // The face mints its comm channel after connecting to the drill database and enrolling its
        // fixtures, so the channel file appears late.
        for (let n = 0; n < 600 && !existsSync(channelFile); n++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!existsSync(channelFile)) {
          const tail = existsSync(faceLog) ? readFileSync(faceLog, 'utf8').trim().slice(-400) : '(no face log)';
          throw new Error(`plugin face did not publish its channel: ${tail || '(empty log)'}`);
        }
        const channel = JSON.parse(readFileSync(channelFile, 'utf8')) as { SCK_COMM_DIR: string; SCK_COMM_KEY: string };
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
    // The corruption hits a file the binding actually covers — plugin/server/vendor is generated after
    // the archive and is excluded from the manifest, so hiding it proves nothing.
    await drillPhase(plan, host, stages, 'repoint-failure', plan.candidateSha, async log => {
      const release = join(plan.releasesRoot, plan.candidateSha);
      const target = join(release, 'src', 'core.ts');
      const original = readFileSync(target);
      const bind = () => exec.run('sh', ['-c', '. "$1/scripts/release-content.sh"; release_matches_commit "$1" "$2" "$3"', 'bind', release, plan.candidateSha, host.repo], {});
      writeFileSync(target, Buffer.concat([original, Buffer.from('\n// drill corruption\n')]));
      try {
        const r = await bind();
        if (r.code === 0) throw new Error('content binding did not detect the corrupted candidate source; the drill oracle failed');
        log('corrupted candidate refused by content binding');
      } finally {
        writeFileSync(target, original);
      }
      const recovered = await bind();
      if (recovered.code !== 0) throw new Error(`candidate binding did not recover after restore: ${recovered.stderr.slice(0, 300)}`);
      log('candidate source restored; binding passes again, switching proceeds only from the restored tree');
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
      if (dbPid) await exec.killTree(dbPid).catch(() => undefined);
      dbPid = undefined;
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
    if (dbPid) await host.exec.killTree(dbPid).catch(() => undefined);
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

async function waitHealthy(exec: DrillExec, url: string, log?: (line: string) => void): Promise<void> {
  // A deadline rather than a fixed attempt count: each probe can spend up to its own timeout, so a
  // fixed 200-attempt loop gave up after ~10s while the switched-in MCP was still bootstrapping.
  const deadline = Date.now() + 120_000;
  let last = 'no attempt completed';
  let attempts = 0;
  while (Date.now() < deadline) {
    const result = await exec.probe(url).catch((error: unknown) => ({ ok: false, detail: String((error as Error)?.message ?? error) }));
    attempts += 1;
    if (result.ok) return;
    if (attempts % 20 === 1) log?.(`probe ${url} attempt ${attempts}: ${result.detail}`);
    last = result.detail;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // The probe detail is the only evidence of *why* a face never came up: without it a failed drill
  // only says "did not become healthy".
  throw new Error(`drill face did not become healthy within 120s: ${url} (last probe: ${last})`);
}

function assertOk(r: { code: number; stdout: string; stderr: string }, what = 'command'): { code: number; stdout: string; stderr: string } {
  if (r.code !== 0) {
    // Name the step and keep both streams: a bare "drill command failed" hid why prepare died.
    const detail = `${r.stderr}`.trim() || `${r.stdout}`.trim() || '(no output)';
    throw new Error(`${what} failed with exit ${r.code}: ${detail.slice(0, 400)}`);
  }
  return r;
}

/** One phase = one structured stage record + one raw log, both under the drill root. */
async function drillPhase(plan: DrillPlan, host: DrillHost, stages: StageRecord[], phase: DrillPhase, sha: string, body: (log: (line: string) => void) => Promise<void>): Promise<void> {
  const started = host.exec.nowIso();
  // prepare runs once per release: one log per phase would overwrite the base run with the candidate
  // one and leave the first stage record pointing at a file it no longer hashes to.
  const logFile = join(plan.logsRoot, `${phase}${phase === 'prepare' ? `-${sha.slice(0, 8)}` : ''}.log`);
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
