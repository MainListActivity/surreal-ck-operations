import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { validateDrillPlan, drillRootFor, type DrillPlan, type DrillHostContext } from './deploy-drill.ts';
import { runDrill, type DrillExec, type DrillHost } from './deploy-drill-runner.ts';

/**
 * Host-side glue for the deploy drill: builds the validation context and the executor against the real
 * filesystem/process surface, runs inside the MCP service process (launchd-hosted, never the employee
 * sandbox). The child environment is constructed explicitly — production database variables are never
 * inherited, so a drill driver cannot resolve the production database by accident.
 */

export interface DrillState { runId: string; status: 'running' | 'passed' | 'failed'; phase?: string; error?: string }

const CHILD_ENV = (): Record<string, string> => ({
  PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${homedir()}/.bun/bin`,
  HOME: homedir(), TMPDIR: tmpdir(),
});

const exec: DrillExec = {
  run: (cmd, args, opts) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...CHILD_ENV(), ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  }),
  spawnDetached: (cmd, args, opts) => new Promise((resolve, reject) => {
    mkdirSync(dirname(opts.logFile), { recursive: true, mode: 0o700 });
    const out = openSync(opts.logFile, 'a');
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...CHILD_ENV(), ...opts.env }, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    if (child.pid) resolve(child.pid); else child.once('spawn', () => resolve(child.pid!));
    child.once('error', reject);
  }),
  killTree: pid => new Promise((resolve, reject) => {
    const child = spawn('kill', ['-TERM', `-${pid}`], { stdio: 'ignore' });
    child.once('close', () => resolve());
    child.once('error', reject);
  }),
  healthy: async url => { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } },
  nowIso: () => new Date().toISOString(),
};

const readState = (root: string): DrillState | undefined => {
  try { return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as DrillState; } catch { return undefined; }
};

export function drillHost(serviceHome: string, repo: string): DrillHost & { ctx: DrillHostContext } {
  const ctx: DrillHostContext = {
    serviceHome,
    existingRun: runId => {
      const root = drillRootFor(serviceHome, runId);
      return existsSync(join(root, 'state.json')) ? readState(root) : existsSync(root) ? { status: 'incomplete' } : undefined;
    },
    commitExists: async sha => (await exec.run('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], {})).code === 0,
    isAncestor: async (ancestor, descendant) => (await exec.run('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant], {})).code === 0,
    portFree: async port => {
      try { const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') }); server.stop(true); return true; } catch { return false; }
    },
  };
  return {
    ctx, exec, repo,
    forkBinary: join(homedir(), '.surrealdb', 'surreal'),
    serviceHome,
    state: plan => readState(plan.root),
    writeState: (plan, state) => writeFileSync(join(plan.root, 'state.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }),
  };
}

/** Launches the drill in a detached child (the service process must not block on a minutes-long drill). */
export function startDrill(serviceHome: string, repo: string, plan: DrillPlan): number {
  writeFileSync(join(plan.root, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
  const child = spawn(process.execPath, [join(repo, 'src', 'deploy-drill-run.ts'), plan.runId],
    { cwd: repo, env: { ...CHILD_ENV(), SCK_DRILL_HOME: serviceHome, SCK_DRILL_REPO: repo }, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid!;
}

/** Entry for the detached child: reloads the plan and runs the drill to completion. */
export async function runDrillDetached(serviceHome: string, repo: string, runId: string): Promise<void> {
  const host = drillHost(serviceHome, repo);
  const plan = JSON.parse(readFileSync(join(drillRootFor(serviceHome, runId), 'plan.json'), 'utf8')) as DrillPlan;
  try { await runDrill(plan, host); } catch { /* state written by runDrill */ }
}

export const readDrillStatus = (serviceHome: string, runId: string): { state?: DrillState; stages?: string[] } => {
  const root = drillRootFor(serviceHome, runId);
  const state = readState(root);
  if (!state) return {};
  let stages: string[] = [];
  try { stages = readdirSync(join(root, 'stages')).sort(); } catch {}
  return { state, stages };
};
