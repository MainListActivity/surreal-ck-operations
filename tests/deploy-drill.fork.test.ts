import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;

/**
 * Runs the real drill oracle driver from this tree against a real company-fork database: leftover
 * isolation states must not be dispatchable, must not change (zero write), and a ready positive
 * control must be claimable. This is the oracle half of the drill; the process-level faces are
 * exercised on the host by the deployed runner (task c3736677).
 */
run('deploy drill oracle: leftover zero-claim zero-write with a live positive control', async () => {  const dir = mkdtempSync(join(tmpdir(), 'drill-oracle-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const password = 'drill-oracle-only';
  const server = spawn(join(homedir(), '.surrealdb/surreal'), ['start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', password, '--log', 'error', `rocksdb:${dir}/database`], { stdio: 'ignore' });
  try {
    let ready = false;
    for (let n = 0; n < 160 && !ready; n++) { try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {} if (!ready) await Bun.sleep(25); }
    expect(ready).toBe(true);
    mkdirSync(join(dir, 'private'), { recursive: true });
    writeFileSync(join(dir, 'private', 'company-db.env'),
      `SURREAL_URL=ws://127.0.0.1:${port}/rpc\nSURREAL_ROOT_USER=root\nSURREAL_ROOT_PASS=${password}\n`);
    // The oracle reads the drill database through SCK_SERVICE_HOME only: no production variable is set.
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'scripts', 'deploy-drill-oracle.ts'), dir], {
      env: { PATH: process.env.PATH!, HOME: process.env.HOME! },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`oracle failed: ${stderr || stdout}`.slice(0, 800));
    const summaryLine = stdout.split('\n').find(line => line.startsWith('DRILL_ORACLE_OK '));
    if (!summaryLine) throw new Error(`oracle produced no summary; stdout tail: ${stdout.slice(-200)}`);
    const summary = JSON.parse(summaryLine.replace(/^DRILL_ORACLE_OK /, ''));
    expect(summary.leftoverDigestUnchanged).toBe(true);
    expect(summary.leftoverRefusal).not.toContain('UNEXPECTEDLY');
    expect(summary.positiveControl.claimed).toBe(true);
    expect(summary.positiveControl.deliveryId).toBeTruthy();
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
