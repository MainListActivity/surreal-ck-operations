// Controlled local integration entry. QA needs no company credentials or employee creation rights.
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'sck-wt-regression-'));
const socket = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
const port = socket.port!; socket.stop(true);
const rootPassword = 'isolated-local-regression-only';
const server = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', rootPassword,
  '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
let exit = 1;
try {
  let ready = false;
  for (let n = 0; n < 160; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
  if (!ready) throw new Error('Company fork fixture did not become healthy');
  const explicit = process.argv.slice(2).filter(arg => arg.endsWith('.test.ts'));
  const targets = explicit.length ? explicit : process.argv.includes('--all') ? [] : [
    'tests/worktree-lock.test.ts', 'tests/worktree-reclaim.test.ts', 'tests/worktree-registry.fork.test.ts',
    'tests/artifact-reclaim.test.ts', 'tests/artifact-sweeper.test.ts', 'tests/artifact-reclaim.fork.test.ts',
    'tests/mcp-run-reclaim.fork.test.ts', 'tests/paseo-dead-paths.test.ts',
    'tests/db.integration.test.ts', 'tests/v3.integration.test.ts',
    'tests/dispatcher-sidecar.fork.test.ts', 'tests/dispatcher-sidecar.test.ts', 'tests/sidecar.test.ts',
    'tests/sidecar-late-lease.test.ts', 'tests/mcp.transport.test.ts', 'tests/worktrees.test.ts',
    'tests/owner-aging.fork.test.ts', 'tests/pipelines.fork.test.ts', 'tests/story-author.fork.test.ts', 'tests/cinematography.fork.test.ts', 'tests/owner-reassign.fork.test.ts', 'tests/pr-gate.fork.test.ts', 'tests/loop-breaker.fork.test.ts', 'tests/owner-commands.fork.test.ts',
    'tests/goal-acceptance-repair.integration.test.ts',
  ];
  const test = Bun.spawn(['bun', 'test', ...targets], { stdout: 'inherit', stderr: 'inherit', env: {
    ...process.env, SCK_PRODUCT_ENV: '/dev/null', SURREAL_URL: `ws://127.0.0.1:${port}/rpc`, SURREAL_ROOT_USER: 'root', SURREAL_ROOT_PASS: rootPassword,
    RUN_SCK_WORKTREE_FORK_TESTS: '1', RUN_SCK_CHANNEL_FORK_TESTS: '1', RUN_SCK_OWNER_AGING_TESTS: '1', RUN_SCK_PIPELINE_TESTS: '1', RUN_SCK_STORY_AUTHOR_TESTS: '1', RUN_SCK_CINEMATOGRAPHY_TESTS: '1', RUN_SCK_REASSIGN_TESTS: '1', RUN_SCK_PR_GATE_TESTS: '1', RUN_SCK_LOOP_BREAKER_TESTS: '1', RUN_SCK_OWNER_COMMANDS_TESTS: '1', RUN_SCK_ARTIFACT_FORK_TESTS: '1',
  } });
  exit = await test.exited;
} finally { server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); }
process.exit(exit);
