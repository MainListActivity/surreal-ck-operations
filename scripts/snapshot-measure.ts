// Measures the snapshot listing path (SYS01 AC-D) on an isolated company fork. It starts its own fork instance in a temporary
// directory (never production) and routes every client connection through a counting TCP proxy, so the bytes it reports are the
// bytes on the socket in each direction, not a JSON.stringify estimate. With --rate the proxy carries each direction at that many
// bytes per second in total, across all connections through it, split fairly between them in 1 KiB pieces. That is a simulated
// constraint (the WSS channel to the production database is documented at about 50 KiB/s), and the output labels it as such.
//
// Usage: bun scripts/snapshot-measure.ts <label> [--tasks N] [--context-bytes B] [--samples K] [--rate BYTES_PER_SECOND]
//          [--batch-kib K] [--out FILE]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { CompanyError } from '../src/core-errors.ts';
import { answerBytes, RESPONSE_BUDGET_BYTES } from '../src/response-budget.ts';
import type { SnapshotBuildStats } from '../src/snapshot-store.ts';

const args = process.argv.slice(2);
const label = args[0] ?? 'run';
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const TASKS = flag('tasks', 300);
const CONTEXT_BYTES = flag('context-bytes', 2800);
const SAMPLES = flag('samples', 12);
const RATE = flag('rate', 0);
const BATCH_KIB = flag('batch-kib', 0);
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
 * A TCP proxy in front of the fork. Bytes are counted as they are written to each side. Without a rate, bytes pass straight through.
 * With a rate, each direction carries at most `rate` bytes per second in total: every tick adds its share to an allowance (unused
 * allowance carries over for at most two ticks), and the allowance is spent one piece at a time, round robin across the connections
 * that have bytes waiting, so a small request is not queued behind a large transfer on another connection.
 */
function startProxy(targetPort: number, rate: number) {
  const links = new Set<Link>();
  const allowance: Record<Dir, number> = { down: 0, up: 0 };
  const perTick = (rate * TICK_MS) / 1000;
  let turn = 0;
  const closeLink = (link: Link) => {
    if (link.closed) return;
    link.closed = true;
    links.delete(link);
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
  const timer = rate > 0 ? setInterval(() => {
    for (const dir of ['down', 'up'] as const) {
      allowance[dir] = Math.min(allowance[dir] + perTick, 2 * perTick);
      send(dir, false);
    }
  }, TICK_MS) : undefined;
  const server = Bun.listen<Link>({
    hostname: '127.0.0.1', port: 0,
    socket: {
      open(client) {
        const link: Link = { client, down: [], up: [], closed: false };
        client.data = link;
        links.add(link);
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
  return { port: server.port, stop: () => { if (timer) clearInterval(timer); for (const link of links) closeLink(link); server.stop(true); } };
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
  if (stats.length === 0) return { n: 0, outcomes };
  const spread = (pick: (stat: SnapshotBuildStats) => number) => summary(stats.map(pick));
  return {
    n: stats.length, outcomes,
    totalMs: spread(stat => stat.totalMs), serverMs: spread(stat => stat.serverMs), loadMs: spread(stat => stat.loadMs),
    writeMs: spread(stat => stat.writeMs), commitMs: spread(stat => stat.commitMs),
    batchesMean: round(stats.reduce((sum, stat) => sum + stat.batches, 0) / stats.length),
  };
};

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sck-snapshot-measure-'));
  const password = `measure-${randomUUID()}`;
  const fork = await startFork(dir, password);
  const proxy = startProxy(fork.port, RATE);
  const database = new CompanyDatabase({ url: `ws://127.0.0.1:${proxy.port}/rpc`, rootUser: 'root', rootPassword: password, namespace: NS, database: 'control_plane' });
  const result: Record<string, unknown> = {
    label, tasks: TASKS, contextBytes: CONTEXT_BYTES, samples: SAMPLES, rateBytesPerSecond: RATE,
    channel: RATE > 0 ? 'simulated constraint: the proxy shares the rate across all connections in each direction (not a measurement of the production WSS channel)' : 'loopback, unconstrained',
    batchKiB: BATCH_KIB > 0 ? BATCH_KIB : 'default', startedAt: new Date().toISOString(),
  };
  try {
    await database.connect();
    await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
    await database.db.use({ namespace: NS });
    await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
    await database.bootstrap();
    // Every listing build reports its phases and the server time of its statements (SnapshotBuildStats).
    const buildLog: SnapshotBuildStats[] = [];
    const core = new SurrealCompanyCore(database, {
      ...(BATCH_KIB > 0 ? { snapshots: { batchBytes: BATCH_KIB * 1024 } } : {}),
      snapshotObserve: stats => { buildLog.push(stats); },
    });
    const enrollment = new LocalEnrollmentAdmin(database);
    const gm = await enrollment.enroll('measure-gm', 'gm', ['execute', 'review', 'manage']);
    // Two engineers, one per control worker: an employee holds one lease at a time, so one credential cannot claim in parallel.
    const engs = [await enrollment.enroll('measure-eng-a', 'engineering', ['execute', 'review']), await enrollment.enroll('measure-eng-b', 'engineering', ['execute', 'review'])];

    // Setup (not measured): one write at a time. A write refused as contention is retried, so the working set is complete.
    let setupRetries = 0;
    const retried = async <T>(run: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try { return await run(); } catch (error) {
          if (attempt < 50 && error instanceof CompanyError && error.code === 'temporarily_unavailable') {
            setupRetries++;
            await Bun.sleep(5 + 7 * attempt);
            continue;
          }
          throw error;
        }
      }
    };
    const setupStart = performance.now();
    for (let index = 0; index < TASKS; index++) {
      await retried(() => core.createTask(gm, { title: `测量样例 ${index} ${unit}`, context: textOf(CONTEXT_BYTES, `样例 ${index} `),
        executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `measure-${label}-${index}-${randomUUID()}` }));
    }
    const controls: string[] = [];
    for (let index = 0; index < 2 * SAMPLES; index++) {
      const task = await retried(() => core.createTask(gm, { title: `控制样例 ${index}`, context: '控制样例正文',
        executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: `control-${label}-${index}-${randomUUID()}` }));
      controls.push(task.id);
    }
    result.setupSeconds = round((performance.now() - setupStart) / 1000);
    result.setupRetries = setupRetries;

    // ---- first page of the GM working set: the listing is built, then its first page is read ----
    const before = { ...counters };
    let rssPeak = process.memoryUsage().rss;
    const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 10);
    const firstFrom = buildLog.length;
    const firstStart = performance.now();
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
    result.firstPage = {
      outcome, seconds: round((performance.now() - firstStart) / 1000), pageRows: rows, answerBytes: answer, budgetBytes: RESPONSE_BUDGET_BYTES,
      wireDownBytes: counters.down - before.down, wireUpBytes: counters.up - before.up, clientRssPeakMb: round(rssPeak / 1048576),
      builds: buildLog.slice(firstFrom).map(stat => ({
        outcome: stat.outcome, rows: stat.rows, bytes: stat.bytes, batches: stat.batches, loadMs: round(stat.loadMs),
        reserveMs: round(stat.reserveMs), writeMs: round(stat.writeMs), commitMs: round(stat.commitMs), totalMs: round(stat.totalMs),
        serverMs: round(stat.serverMs),
      })),
    };

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
    const baseline = await runControl(controls.slice(0, SAMPLES), false);
    const disturbed = await runControl(controls.slice(SAMPLES, 2 * SAMPLES), true);
    result.control = { baseline, disturbed };
    result.finishedAt = new Date().toISOString();
  } finally {
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
