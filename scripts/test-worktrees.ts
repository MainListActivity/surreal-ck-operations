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
  const targets = process.argv.includes('--all') ? [] : [
    'tests/worktree-lock.test.ts', 'tests/worktree-registry.fork.test.ts', 'tests/db.integration.test.ts', 'tests/v3.integration.test.ts',
    'tests/dispatcher-sidecar.fork.test.ts', 'tests/dispatcher-sidecar.test.ts', 'tests/sidecar.test.ts',
    'tests/sidecar-late-lease.test.ts', 'tests/mcp.transport.test.ts', 'tests/worktrees.test.ts',
  ];
  const test = Bun.spawn(['bun', 'test', ...targets], { stdout: 'inherit', stderr: 'inherit', env: {
    ...process.env, SCK_PRODUCT_ENV: '/dev/null', SURREAL_URL: `ws://127.0.0.1:${port}/rpc`, SURREAL_ROOT_USER: 'root', SURREAL_ROOT_PASS: rootPassword,
    RUN_SCK_WORKTREE_FORK_TESTS: '1', RUN_SCK_CHANNEL_FORK_TESTS: '1',
  } });
  exit = await test.exited;
} finally { server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); }
process.exit(exit);
