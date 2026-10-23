// Controlled local integration entry. QA needs no company credentials or employee creation rights.
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { stopGroups } from './test-processes.ts';
const dir = mkdtempSync(join(tmpdir(), 'sck-wt-regression-'));
const groups: number[] = [];
let finished = false;
let watchdog: ReturnType<typeof Bun.spawn> | undefined;
const save = () => {
  const state = { parent: process.pid, groups, finished, watchdog: watchdog?.pid, dir };
  writeFileSync(join(dir, 'processes.tmp'), JSON.stringify(state), { mode: 0o600 });
  renameSync(join(dir, 'processes.tmp'), join(dir, 'processes.json'));
  if (process.env.SCK_TEST_PROCESS_MANIFEST) writeFileSync(process.env.SCK_TEST_PROCESS_MANIFEST, JSON.stringify(state), { mode: 0o600 });
};
save();
watchdog = Bun.spawn([process.execPath, join(import.meta.dir, 'test-watchdog.ts'), String(process.pid), dir], { detached: true, stdout: 'ignore', stderr: 'ignore' });
let cleanupPromise: Promise<void> | undefined;
const cleanup = () => cleanupPromise ??= (async () => {
  await stopGroups(groups);
  finished = true; save();
  if (watchdog) {
    await Promise.race([watchdog.exited, Bun.sleep(1000)]);
    if (watchdog.exitCode === null) watchdog.kill();
  }
  rmSync(dir, { recursive: true, force: true });
})();
let interrupted: number | undefined;
const terminate = (code: number) => { interrupted ??= code; void cleanup().then(() => process.exit(interrupted)); };
process.once('SIGINT', () => terminate(130));
process.once('SIGTERM', () => terminate(143));
const seconds = Number(process.env.SCK_TEST_TIMEOUT_SECONDS ?? 1800);
if (!Number.isFinite(seconds) || seconds <= 0) { await cleanup(); throw new Error('SCK_TEST_TIMEOUT_SECONDS must be positive'); }
const deadline = setTimeout(() => terminate(124), seconds * 1000);
const socket = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
const port = socket.port!; socket.stop(true);
const rootPassword = 'isolated-local-regression-only';
const server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', rootPassword,
  '--log', 'error', `rocksdb:${dir}/db`], { detached: true, stdout: 'ignore', stderr: 'ignore' });
groups.push(server.pid); save();
let exit = 1;
try {
  let ready = false;
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
  if (!ready) throw new Error('Company fork fixture did not become healthy');
  const explicit = process.argv.slice(2).filter(arg => arg.endsWith('.test.ts'));
  const targets = explicit.length ? explicit : process.argv.includes('--all') ? [] : [
    'tests/model-ranking.test.ts', 'tests/model-ranking.fork.test.ts',
    'tests/model-routing.test.ts', 'tests/model-routing.fork.test.ts',
    'tests/worktree-lock.test.ts', 'tests/worktree-reclaim.test.ts', 'tests/worktree-registry.fork.test.ts',
    'tests/artifact-reclaim.test.ts', 'tests/artifact-sweeper.test.ts', 'tests/artifact-reclaim.fork.test.ts',
    'tests/magpie-quota.test.ts', 'tests/agent-model.test.ts', 'tests/quota-store.fork.test.ts',
    'tests/mcp-run-reclaim.fork.test.ts', 'tests/paseo-dead-paths.test.ts',
    'tests/db.integration.test.ts', 'tests/v3.integration.test.ts',
    'tests/implementer-binding.integration.test.ts', 'tests/contributor-cas.integration.test.ts',
    'tests/dispatcher-sidecar.fork.test.ts', 'tests/dispatch-episode.fork.test.ts', 'tests/review-capacity-replay.fork.test.ts',
    'tests/idle-sessions.fork.test.ts', 'tests/ops-denial-circuit.fork.test.ts', 'tests/ops-denial-circuit.test.ts', 'tests/host-resources.test.ts', 'tests/scratch-gc.test.ts', 'tests/test-runner-cleanup.test.ts',
    'tests/quota-turn.test.ts', 'tests/turn-closeout.test.ts', 'tests/quota-scoring.fork.test.ts',
    'tests/dispatcher-sidecar.test.ts', 'tests/dispatcher-manager-routing.test.ts', 'tests/sidecar.test.ts',
    'tests/sidecar-late-lease.test.ts', 'tests/mcp.transport.test.ts', 'tests/worktrees.test.ts',
    'tests/owner-aging.fork.test.ts', 'tests/pipelines.fork.test.ts', 'tests/story-author.fork.test.ts', 'tests/cinematography.fork.test.ts', 'tests/owner-reassign.fork.test.ts', 'tests/pr-gate.fork.test.ts', 'tests/loop-breaker.fork.test.ts', 'tests/owner-commands.fork.test.ts',
    'tests/goal-acceptance-repair.integration.test.ts', 'tests/query-paging.integration.test.ts', 'tests/acceptance-gate.fork.test.ts',
    'tests/deployment-source.fork.test.ts',
    'tests/input-bounds.integration.test.ts',
    'tests/rollback-isolation.fork.test.ts', 'tests/rollback-isolation-independence.fork.test.ts', 'tests/null-absent.fork.test.ts',
    'tests/snapshot-quota.fork.test.ts',
    'tests/independence.test.ts', 'tests/independence-policy.fork.test.ts', 'tests/independence-check.fork.test.ts',  ];
  const test = Bun.spawn([process.execPath, 'test', ...targets], { detached: true, stdout: 'inherit', stderr: 'inherit', env: {
    ...process.env, SCK_PRODUCT_ENV: '/dev/null', SURREAL_URL: `ws://127.0.0.1:${port}/rpc`, SURREAL_ROOT_USER: 'root', SURREAL_ROOT_PASS: rootPassword,
    RUN_SCK_WORKTREE_FORK_TESTS: '1', RUN_SCK_CHANNEL_FORK_TESTS: '1', RUN_SCK_OWNER_AGING_TESTS: '1', RUN_SCK_PIPELINE_TESTS: '1', RUN_SCK_STORY_AUTHOR_TESTS: '1', RUN_SCK_CINEMATOGRAPHY_TESTS: '1', RUN_SCK_REASSIGN_TESTS: '1', RUN_SCK_PR_GATE_TESTS: '1', RUN_SCK_LOOP_BREAKER_TESTS: '1', RUN_SCK_OWNER_COMMANDS_TESTS: '1', RUN_SCK_ARTIFACT_FORK_TESTS: '1', RUN_SCK_ROLLBACK_FORK_TESTS: '1',
  } });
  groups.push(test.pid); save();
  exit = await test.exited;
} finally { clearTimeout(deadline); await cleanup(); }
process.exit(interrupted ?? exit);
