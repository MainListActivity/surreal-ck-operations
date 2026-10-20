// Measures the snapshot listing path (SYS01 AC-D) on an isolated company fork. It starts its own fork instance in a temporary
// directory (never production). Setup is written straight to that fork and timed as seeding, reported apart from the requests.
// The measured requests go through a counting TCP proxy, so the bytes it reports are the bytes on the socket in each direction,
// not a JSON.stringify estimate. With a rate the proxy carries each direction at that many bytes per second in total, across
// all connections through it, split fairly between them in 1 KiB pieces. That is a simulated constraint (the WSS channel to the
// production database is documented at about 50 KiB/s), and the output labels it as such.
//
// Each attempt is one first-page request: a new listing is built on the seeded store and its first page is read. Attempts run
// one after another on the same store, and every attempt is reported, refusals included. Control requests (claim, read,
// heartbeat, release) run afterwards: the baseline first, then while listings are built back to back. Each rate in --rates is
// one phase of this sequence, run in order on the same seeded store, so a fixture is seeded once for all of its phases.
//
// Usage: bun scripts/snapshot-measure.ts <label> [--tasks N] [--context-bytes B] [--samples K] [--attempts A]
//          [--rates BPS[,BPS...] | --rate BPS] [--batch-kib K] [--direct] [--no-hedge] [--out FILE]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { CompanyError } from '../src/core-errors.ts';
import { answerBytes, RESPONSE_BUDGET_BYTES } from '../src/response-budget.ts';
import { DEFAULT_SNAPSHOT_LIMITS, type SnapshotBuildStats } from '../src/snapshot-store.ts';

const args = process.argv.slice(2);
const label = args[0] ?? 'run';
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const TASKS = flag('tasks', 300);
const CONTEXT_BYTES = flag('context-bytes', 2800);
const SAMPLES = flag('samples', 12);
const ATTEMPTS = flag('attempts', 12);
// One phase per rate, run in order on the same seeded store. 0 is unconstrained loopback.
const RATES: number[] = args.includes('--rates')
  ? String(args[args.indexOf('--rates') + 1]).split(',').map(Number)
  : [flag('rate', 0)];
if (RATES.some(rate => !Number.isFinite(rate) || rate < 0)) throw new Error('--rates takes non-negative numbers, for example 0,51200');
const BATCH_KIB = flag('batch-kib', 0);
// --direct connects to the fork without the proxy; --no-hedge leaves the first read of a listing unabandoned (diagnosis only).
const DIRECT = args.includes('--direct');
const NO_HEDGE = args.includes('--no-hedge');
if (DIRECT && RATES.some(rate => rate > 0)) throw new Error('--direct carries no proxy, so it cannot be combined with a rate');
const outAt = args.indexOf('--out');
const OUT = outAt >= 0 ? args[outAt + 1]!
  : join(homedir(), 'Library/Application Support/SurrealCKCompany/evidence/e1becaaa-4ff9-48a3-abfc-95ed04ade911/review-measure', `${label}.json`);
const NS = 'sck_agent_snapshot_measure';
const unit = '中文🙂字符';

/** Synthetic, non-private text of about `bytes` UTF-8 bytes. Real task text is never copied into a measurement. */
function textOf(bytes: number, prefix = ''): string {
  let text = prefix;
  while (Buffer.byteLength(text, 'utf8') < bytes) text += unit;
  return text;
}

const TICK_MS = 20;
const PIECE_BYTES = 1024;
type Dir = 'down' | 'up';
const counters: Record<Dir, number> = { down: 0, up: 0 };
interface Side { write(data: Uint8Array): number; end(): void }
interface Link { client?: Side; upstream?: Side; down: Uint8Array[]; up: Uint8Array[]; closed: boolean }

/**
 * A TCP proxy in front of the fork. Bytes are counted as they are written to each side. At rate 0 bytes pass straight through.
 * With a rate, each direction carries at most `rate` bytes per second in total: every tick adds its share to an allowance (unused
 * allowance carries over for at most two ticks), and the allowance is spent one piece at a time, round robin across the connections
 * that have bytes waiting, so a small request is not queued behind a large transfer on another connection. setRate changes the rate
 * for the bytes that follow; leaving the constrained mode sends what is queued at once.
 */
function startProxy(targetPort: number, initialRate: number) {
  const links = new Set<Link>();
  // Every connection the proxy carries: opened and closed as the sockets really open and close, so a build's connections show here.
  const connections = { opened: 0, closed: 0, open: 0, peakOpen: 0 };
  const allowance: Record<Dir, number> = { down: 0, up: 0 };
  let rate = initialRate;
  let turn = 0;
  const closeLink = (link: Link) => {
    if (link.closed) return;
    link.closed = true;
    links.delete(link);
    connections.closed++;
    connections.open--;
    try { link.client?.end(); } catch { /* already closed */ }
    try { link.upstream?.end(); } catch { /* already closed */ }
  };
  const send = (dir: Dir, unlimited: boolean) => {
    for (;;) {
      const ordered = [...links];
      if (ordered.length === 0) return;
      let wrote = false;
      for (let offset = 0; offset < ordered.length; offset++) {
        if (!unlimited && allowance[dir] < 1) return;
        const link = ordered[(turn + offset) % ordered.length]!;
        const queue = dir === 'down' ? link.down : link.up;
        const target = dir === 'down' ? link.client : link.upstream;
        if (!target || link.closed || queue.length === 0) continue;
        const head = queue[0]!;
        const room = unlimited ? Number.POSITIVE_INFINITY : Math.min(PIECE_BYTES, allowance[dir]);
        const take = Math.min(head.byteLength, room);
        const piece = take === head.byteLength ? head : head.subarray(0, take);
        if (take === head.byteLength) queue.shift(); else queue[0] = head.subarray(take);
        target.write(piece);
        counters[dir] += piece.byteLength;
        if (!unlimited) allowance[dir] -= take;
        turn = (turn + offset + 1) % ordered.length;
        wrote = true;
        break;
      }
      if (!wrote) return;
    }
  };
  // The tick runs for the life of the proxy and does nothing while the proxy is unconstrained.
  const timer = setInterval(() => {
    if (rate <= 0) return;
    const share = (rate * TICK_MS) / 1000;
    for (const dir of ['down', 'up'] as const) {
      allowance[dir] = Math.min(allowance[dir] + share, 2 * share);
      send(dir, false);
    }
  }, TICK_MS);
  const server = Bun.listen<Link>({
    hostname: '127.0.0.1', port: 0,
    socket: {
      open(client) {
        const link: Link = { client, down: [], up: [], closed: false };
        client.data = link;
        links.add(link);
        connections.opened++;
        connections.open++;
        connections.peakOpen = Math.max(connections.peakOpen, connections.open);
        Bun.connect({
          hostname: '127.0.0.1', port: targetPort,
          socket: {
            open(upstream) { link.upstream = upstream; if (rate <= 0) send('up', true); },
            data(_upstream, chunk) { link.down.push(new Uint8Array(chunk)); if (rate <= 0) send('down', true); },
            close() { closeLink(link); },
            error() { closeLink(link); },
          },
        }).catch(() => closeLink(link));
      },
      data(client, chunk) {
        const link = client.data;
        link.up.push(new Uint8Array(chunk));
        if (rate <= 0) send('up', true);
      },
      close(client) { closeLink(client.data); },
      error(client) { closeLink(client.data); },
    },
  });
  return {
    port: server.port,
    connections,
    setRate: (next: number) => {
      rate = next;
      allowance.down = 0;
      allowance.up = 0;
      if (rate <= 0) { send('down', true); send('up', true); }
    },
    stop: () => { clearInterval(timer); for (const link of links) closeLink(link); server.stop(true); },
  };
}

async function startFork(dir: string, password: string): Promise<{ port: number; stop: () => Promise<void> }> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') });
  const port = probe.port!;
  probe.stop(true);
  const proc = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', password,
    '--log', 'error', `rocksdb:${dir}/db`], { stdout: 'ignore', stderr: 'ignore' });
  for (let attempt = 0; attempt < 240; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(25);
  }
  return { port, stop: async () => { proc.kill(); await proc.exited; } };
}

const round = (value: number) => Math.round(value * 10) / 10;
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}
const summary = (values: number[]) => ({ n: values.length, p50Ms: round(percentile(values, 50)), p95Ms: round(percentile(values, 95)), maxMs: round(Math.max(...values)) });
const codeOf = (error: unknown): string => (error instanceof CompanyError ? error.code : String(error).slice(0, 120));
/** Costs of a set of builds: outcomes, the spread of each phase in milliseconds, and the mean batch count. */
const buildSummary = (stats: SnapshotBuildStats[]) => {
  const outcomes: Record<string, number> = {};
  for (const stat of stats) outcomes[stat.outcome] = (outcomes[stat.outcome] ?? 0) + 1;
  const releases: Record<string, number> = {};
  for (const stat of stats) releases[stat.release] = (releases[stat.release] ?? 0) + 1;
  if (stats.length === 0) return { n: 0, outcomes, releases };
  const spread = (pick: (stat: SnapshotBuildStats) => number) => summary(stats.map(pick));
  return {
    n: stats.length, outcomes, releases,
    totalMs: spread(stat => stat.totalMs), serverMs: spread(stat => stat.serverMs), loadMs: spread(stat => stat.loadMs),
    writeMs: spread(stat => stat.writeMs), commitMs: spread(stat => stat.commitMs), releaseMs: spread(stat => stat.releaseMs),
    batchesMean: round(stats.reduce((sum, stat) => sum + stat.batches, 0) / stats.length),
  };
};

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sck-snapshot-measure-'));
  const password = `measure-${randomUUID()}`;
  const fork = await startFork(dir, password);
  const proxy = startProxy(fork.port, 0);
  // Setup goes straight to the fork, so seeding is not paced by the simulated rate; only the measured requests are.
  const seeder = new CompanyDatabase({ url: `ws://127.0.0.1:${fork.port}/rpc`, rootUser: 'root', rootPassword: password, namespace: NS, database: 'control_plane' });
  const database = new CompanyDatabase({ url: `ws://127.0.0.1:${DIRECT ? fork.port : proxy.port}/rpc`, rootUser: 'root', rootPassword: password, namespace: NS, database: 'control_plane' });
  const result: Record<string, unknown> = {
    label, runtime: `bun ${Bun.version}`, commit: process.env.SCK_MEASURE_COMMIT ?? 'not recorded', tasks: TASKS, contextBytes: CONTEXT_BYTES,
    samples: SAMPLES, attempts: ATTEMPTS, pageSize: 25, rates: RATES,
    batchKiB: BATCH_KIB > 0 ? BATCH_KIB : 'default', startedAt: new Date().toISOString(),
    route: DIRECT ? 'direct to the fork, no proxy' : 'through the counting proxy',
    loadHedgeMs: NO_HEDGE ? 'disabled (diagnosis only)' : DEFAULT_SNAPSHOT_LIMITS.loadHedgeMs,
    method: 'each first-page attempt builds a new listing on the same seeded store and reads its first page; the fork is not restarted between attempts or phases',
  };
  try {
    await seeder.connect();
    await seeder.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
    await seeder.db.use({ namespace: NS });
    await seeder.db.query('REMOVE DATABASE IF EXISTS control_plane;');
    await seeder.bootstrap();
    const seedCore = new SurrealCompanyCore(seeder);
    const enrollment = new LocalEnrollmentAdmin(seeder);
    const gm = await enrollment.enroll('measure-gm', 'gm', ['execute', 'review', 'manage']);
    // Two engineers, one per control worker: an employee holds one lease at a time, so one credential cannot claim in parallel.
    const engs = [await enrollment.enroll('measure-eng-a', 'engineering', ['execute', 'review']), await enrollment.enroll('measure-eng-b', 'engineering', ['execute', 'review'])];

    // Seeding (not measured as a request): one write at a time. A write refused as contention is retried, so the set is complete.
    let seedRetries = 0;
    const retried = async <T>(run: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try { return await run(); } catch (error) {
          if (attempt < 50 && error instanceof CompanyError && error.code === 'temporarily_unavailable') {
            seedRetries++;
            await Bun.sleep(5 + 7 * attempt);
            continue;
          }
          throw error;
        }
      }
    };
    const seedStart = performance.now();
    for (let index = 0; index < TASKS; index++) {
      await retried(() => seedCore.createTask(gm, { title: `测量样例 ${index} ${unit}`, context: textOf(CONTEXT_BYTES, `样例 ${index} `),
        executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `measure-${label}-${index}-${randomUUID()}` }));
    }
    // Two control tasks per sample and per phase, so no control request reuses a task another phase has released.
    const controls: string[] = [];
    for (let index = 0; index < 2 * SAMPLES * RATES.length; index++) {
      const task = await retried(() => seedCore.createTask(gm, { title: `控制样例 ${index}`, context: '控制样例正文',
        executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `control-${label}-${index}-${randomUUID()}` }));
      controls.push(task.id);
    }
    result.seedSeconds = round((performance.now() - seedStart) / 1000);
    result.seedRetries = seedRetries;
    await seeder.close().catch(() => undefined);

    // The measured connection: through the counting proxy, or direct with --direct. Its namespace and database are selected first:
    // connect() only opens the socket, and the first query on it fails with "Specify a namespace to use" otherwise.
    await database.connect();
    await database.useDatabase();
    const buildLog: SnapshotBuildStats[] = [];
    const core = new SurrealCompanyCore(database, {
      snapshots: { ...(BATCH_KIB > 0 ? { batchBytes: BATCH_KIB * 1024 } : {}), ...(NO_HEDGE ? { loadHedgeMs: 2 * 60 * 60 * 1000 } : {}) },
      snapshotObserve: stats => { buildLog.push(stats); },
    });

    // ---- control requests: claim, read, heartbeat, release, two workers, each sample timed; failures are counted, not hidden ----
    const runControl = async (slice: string[], withBuild: boolean) => {
      const timings = { claim: [] as number[], read: [] as number[], heartbeat: [] as number[], release: [] as number[] };
      const errors: Record<string, number> = {};
      const fail = (phase: string, error: unknown) => {
        const key = `${phase}:${codeOf(error)}`;
        errors[key] = (errors[key] ?? 0) + 1;
      };
      let next = 0;
      const worker = async (eng: string) => {
        while (next < slice.length) {
          const taskId = slice[next++]!;
          const t0 = performance.now();
          let claimed: Awaited<ReturnType<SurrealCompanyCore['claim']>>;
          try { claimed = await core.claim(eng, taskId); } catch (error) { fail('claim', error); continue; }
          timings.claim.push(performance.now() - t0);
          const t1 = performance.now();
          try { await core.getTask(gm, taskId); timings.read.push(performance.now() - t1); } catch (error) { fail('read', error); }
          const proof = { taskId, deliveryId: claimed.deliveryId, fence: claimed.fence, expectedVersion: claimed.task.version };
          const t2 = performance.now();
          try { await core.heartbeat(eng, proof); timings.heartbeat.push(performance.now() - t2); } catch (error) { fail('heartbeat', error); }
          const t3 = performance.now();
          try {
            await core.release(eng, proof, { text: '测量释放：合成样例，无真实内容，仅用于快照测量的控制请求。', idempotencyKey: `release-${label}-${taskId}-${randomUUID()}` });
            timings.release.push(performance.now() - t3);
          } catch (error) { fail('release', error); }
        }
      };
      const buildOutcomes: Record<string, number> = {};
      const from = buildLog.length;
      let finished = false;
      const workers = Promise.all([worker(engs[0]!), worker(engs[1]!)]);
      // Listings are built back to back until the control requests finish, so every control sample overlaps a build.
      const builds = withBuild ? (async () => {
        while (!finished) {
          const key = await core.contextView(gm, { pageSize: 25 }).then(() => 'ok', error => codeOf(error));
          buildOutcomes[key] = (buildOutcomes[key] ?? 0) + 1;
        }
      })() : Promise.resolve();
      try { await workers; } finally { finished = true; }
      await builds;
      return {
        claim: summary(timings.claim), read: summary(timings.read), heartbeat: summary(timings.heartbeat), release: summary(timings.release),
        errors, ...(withBuild ? { builds: buildOutcomes, buildStats: buildSummary(buildLog.slice(from)) } : {}),
      };
    };

    // ---- one phase: the first-page attempts at one rate, then the control requests at that rate ----
    const runPhase = async (rate: number, controlTasks: string[]) => {
      proxy.setRate(rate);
      // ---- first page of the GM working set: one listing built and read per attempt; every outcome is kept ----
      const attempts: Array<Record<string, unknown>> = [];
      for (let index = 0; index < ATTEMPTS; index++) {
        const before = { ...counters };
        const connBefore = { ...proxy.connections };
        const from = buildLog.length;
        let rssPeak = process.memoryUsage().rss;
        const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 10);
        const started = performance.now();
        let outcome = 'ok';
        let answer = 0;
        let rows = 0;
        try {
          const page = await core.contextView(gm, { pageSize: 25 });
          answer = answerBytes(page);
          rows = page.tasks?.length ?? 0;
        } catch (error) {
          outcome = error instanceof CompanyError ? `${error.code}: ${error.message.slice(0, 200)}` : String(error);
        } finally {
          clearInterval(sampler);
        }
        // The timing and the wire counts are taken before the settle below, so the settle is not part of either.
        const ms = Math.round(performance.now() - started);
        const wireDownBytes = counters.down - before.down;
        const wireUpBytes = counters.up - before.up;
        await Bun.sleep(100);
        const connAfter = { ...proxy.connections };
        attempts.push({
          attempt: index + 1, outcome, ms, pageRows: rows, answerBytes: answer, budgetBytes: RESPONSE_BUDGET_BYTES,
          wireDownBytes, wireUpBytes, clientRssPeakMb: round(rssPeak / 1048576),
          connections: { opened: connAfter.opened - connBefore.opened, closed: connAfter.closed - connBefore.closed, openAfter: connAfter.open },
          builds: buildLog.slice(from).map(stat => ({
            outcome: stat.outcome, rows: stat.rows, bytes: stat.bytes, batches: stat.batches, attempts: stat.loadAttempts, loadMs: round(stat.loadMs),
            reserveMs: round(stat.reserveMs), writeMs: round(stat.writeMs), commitMs: round(stat.commitMs), totalMs: round(stat.totalMs),
            serverMs: round(stat.serverMs), release: stat.release, releaseMs: round(stat.releaseMs),
          })),
        });
      }
      const isRefused = (outcome: unknown) => String(outcome).startsWith('temporarily_unavailable');
      const okMs = attempts.filter(item => item.outcome === 'ok').map(item => item.ms as number);
      const refusedMs = attempts.filter(item => isRefused(item.outcome)).map(item => item.ms as number);
      const firstPage = {
        attempts,
        summary: {
          n: attempts.length, ok: okMs.length, temporarilyUnavailable: refusedMs.length,
          otherErrors: attempts.filter(item => item.outcome !== 'ok' && !isRefused(item.outcome)).length,
          allMs: attempts.length > 0 ? summary(attempts.map(item => item.ms as number)) : null,
          okMs: okMs.length > 0 ? summary(okMs) : null,
          refusedMs: refusedMs.length > 0 ? summary(refusedMs) : null,
        },
      };
      const baseline = await runControl(controlTasks.slice(0, SAMPLES), false);
      const disturbed = await runControl(controlTasks.slice(SAMPLES, 2 * SAMPLES), true);
      // What is left for the sweep after this phase, and the build connections in use (SYS01 M1: pending work and counts are observable).
      const store = (core as unknown as { snapshots: { backlog(): Promise<{ due: number; listings: number }> } }).snapshots;
      const pendingSweep = await store.backlog();
      return {
        rateBytesPerSecond: rate,
        pendingSweep, buildConnections: database.buildConnectionStats(),
        channel: rate > 0 ? 'simulated constraint: the proxy shares the rate across all connections in each direction (not a measurement of the production WSS channel)' : 'loopback, unconstrained',
        firstPage, control: { baseline, disturbed },
      };
    };

    const phases: Array<Record<string, unknown>> = [];
    for (const [phaseIndex, rate] of RATES.entries()) {
      phases.push(await runPhase(rate, controls.slice(phaseIndex * 2 * SAMPLES, (phaseIndex + 1) * 2 * SAMPLES)));
    }
    result.phases = phases;
    result.proxyConnections = { ...proxy.connections };
    result.finishedAt = new Date().toISOString();
  } finally {
    await seeder.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    proxy.stop();
    await fork.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

await main();
