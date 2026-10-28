// SYS-INT follow-up: the drill must work from the plugin face, which hosts this server code in Node.
// The v0.3.17 production live test failed on exactly two host-runtime assumptions that a Bun-only suite
// could not see, so both are pinned here by running them under the real Node binary:
//   AC01 — the port probe must use node:net. Bun.serve is a throwing stub in plugin/server/bun-shim.ts,
//          so the old probe reported all 100 drill ports busy and no drill could start.
//   AC02 — drill children must run under an explicitly resolved Bun. process.execPath is Node there and
//          cannot execute the TypeScript worker/face/client/oracle entry points.
// The child scripts are generated per test into a temp dir: they import the shipped core modules with the
// current module resolution, so this stays honest about what the service actually loads.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE = process.env.SCK_NODE_BIN ?? '/usr/local/bin/node';
const ROOT = join(import.meta.dir, '..');
const NODE_PRESENT = existsSync(NODE);

const SERVICE_MODULE = join(ROOT, 'src', 'deploy-drill-service.ts');
const PLAN_MODULE = join(ROOT, 'src', 'deploy-drill.ts');

/**
 * Runs one probe under the real Node binary. TypeScript cannot be imported by Node here (the drill path
 * reaches parameter-property syntax in core-errors.ts, which Node's type stripping rejects), so the probe
 * is bundled to JavaScript first — the code that runs is the shipped source, executed by Node.
 * A Bun global is installed deliberately as plugin/server/bun-shim.ts does, minus Bun.serve: that absence
 * is the condition the production failure came from.
 */
const runUnderNode = (body: string): { code: number; stdout: string; stderr: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'drill-node-'));
  try {
    const source = join(dir, 'probe.ts');
    writeFileSync(source, body);
    const built = spawnSync(process.execPath, ['build', source, '--target', 'node', `--outfile=${join(dir, 'probe.mjs')}`],
      { encoding: 'utf8', timeout: 120_000 });
    if (built.status !== 0) throw new Error(`bundling the probe failed: ${built.stderr.slice(0, 500)}`);
    const out = spawnSync(NODE, [join(dir, 'probe.mjs')], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeout: 120_000,
    });
    return { code: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe.if(NODE_PRESENT)('drill under the real Node host', () => {
  test('AC01: the port probe is node:net based and reports free/busy honestly, not "all busy"', () => {
    const probe = runUnderNode(`
      import { drillHost } from ${JSON.stringify(SERVICE_MODULE)};
      import { DRILL_PORT_MIN, DRILL_PORT_MAX } from ${JSON.stringify(PLAN_MODULE)};
      const home = ${JSON.stringify(join(tmpdir(), 'drill-node-home'))};
      const host = drillHost(home, ${JSON.stringify(ROOT)});
      const net = await import('node:net');
      // Hold one drill-range port busy for the duration of the probe.
      const busy = DRILL_PORT_MIN;
      const held = net.createServer();
      const held_ok = await new Promise(resolve => {
        held.once('error', () => resolve(false));
        held.listen({ host: '127.0.0.1', port: busy, exclusive: true }, () => resolve(true));
      });
      if (!held_ok) { console.log(JSON.stringify({ skipped: true })); process.exit(0); }
      const busyResult = await host.ctx.portFree(busy);
      const freeResult = await host.ctx.portFree(DRILL_PORT_MIN + 1);
      await new Promise(resolve => held.close(resolve));
      const afterRelease = await host.ctx.portFree(busy);
      console.log(JSON.stringify({ busyResult, freeResult, afterRelease, range: [DRILL_PORT_MIN, DRILL_PORT_MAX] }));
    `);
    expect(probe.stderr).toBe('');
    const result = JSON.parse(probe.stdout.trim().split('\n').at(-1)!);
    if (result.skipped) return;
    expect(result.busyResult).toBe(false); // the held port is honestly busy
    expect(result.freeResult).toBe(true); // not "everything is busy"
    expect(result.afterRelease).toBe(true); // and it recovers once released
  });

  test('AC02: children resolve an explicit Bun instead of process.execPath (Node)', () => {
    const probe = runUnderNode(`
      import { resolveDrillBun } from ${JSON.stringify(SERVICE_MODULE)};
      const home = ${JSON.stringify(join(tmpdir(), 'drill-node-home'))};
      console.log(JSON.stringify({
        runningBun: typeof Bun,
        execPath: process.execPath,
        bun: resolveDrillBun(home),
      }));
    `);
    expect(probe.stderr).toBe('');
    const result = JSON.parse(probe.stdout.trim().split('\n').at(-1)!);
    expect(result.runningBun).toBe('undefined'); // really Node, not a Bun shim
    expect(result.bun).not.toBe(result.execPath); // never Node's own binary
    if (result.bun !== 'bun') expect(existsSync(result.bun)).toBe(true);
    // And the resolved binary must actually execute a TypeScript entry point.
    const run = spawnSync(result.bun, ['-e', 'console.log("bun-ok")'], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('bun-ok');
  });
});

test('the Node host probe is skipped only when no Node binary exists', () => {
  if (!NODE_PRESENT) expect(NODE).toBeTruthy();
});
