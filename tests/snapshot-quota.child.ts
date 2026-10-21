// Child OS process for tests/snapshot-quota.fork.test.ts (SYS01 R4). It opens its own database connection, reports READY,
// waits for one JSON job line on stdin, runs the job against the shared quota record, and prints one RESULT line.
// Usage: bun tests/snapshot-quota.child.ts <namespace> <database>. Connection settings come from the environment.
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SnapshotStore, type SnapshotLimits } from '../src/snapshot-store.ts';

interface BeginInput { owner: string; kind: 'context' | 'history' | 'worktrees'; digest: string; role: string; takenAt: string; rows: number; bytes: number }
interface CreateInput { owner: string; kind: 'context' | 'history' | 'worktrees'; digest: string; role: string; takenAt: string; bodies: string[] }
export type ChildJob =
  | { op: 'begin-all'; limits: SnapshotLimits; inputs: BeginInput[] }
  | { op: 'create-all'; limits: SnapshotLimits; inputs: CreateInput[] }
  | { op: 'release-all'; limits: SnapshotLimits; ids: string[] }
  | { op: 'write-fail'; limits: SnapshotLimits; input: BeginInput; body: string }
  | { op: 'hold'; limits: SnapshotLimits; input: BeginInput; bodies: string[] };

type Settled<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const settle = async <T>(work: () => Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'error';
    return { ok: false, code, message: (error as Error).message };
  }
};
/** Runs calls concurrently and reports the window in which this process had them in flight. */
async function fanOut<T, R>(items: T[], call: (item: T) => Promise<R>) {
  const start = Date.now();
  const results = await Promise.all(items.map(item => settle(() => call(item))));
  return { results, window: { start, end: Date.now() } };
}

async function readJobLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const newline = buffered.indexOf('\n');
    if (newline >= 0) return buffered.slice(0, newline);
    const { value, done } = await reader.read();
    if (done) throw new Error('no job received on stdin');
    buffered += decoder.decode(value, { stream: true });
  }
}

async function main(): Promise<void> {
  const [namespace, database] = process.argv.slice(2);
  if (!namespace || !database) throw new Error('usage: snapshot-quota.child.ts <namespace> <database>');
  const db = new CompanyDatabase({ ...loadDatabaseConfig(), namespace, database });
  await db.connect();
  await db.useDatabase();
  console.log('@@READY');
  const job = JSON.parse(await readJobLine()) as ChildJob;
  const store = new SnapshotStore(db.db, job.limits);
  let result: unknown;
  switch (job.op) {
    case 'begin-all':
      result = await fanOut(job.inputs, input => store.begin(input));
      break;
    case 'create-all':
      result = await fanOut(job.inputs, input => store.create(input));
      break;
    case 'release-all':
      result = await fanOut(job.ids, id => store.release(id));
      break;
    case 'write-fail': {
      const reservation = await store.begin(job.input);
      const written = await settle(() => store.writeRows(reservation, [job.body]));
      const released = await store.release(reservation.id);
      result = { id: reservation.id, write: written.ok ? 'written' : written.code, released };
      break;
    }
    case 'hold': {
      const reservation = await store.begin(job.input);
      await store.writeRows(reservation, job.bodies);
      console.log(`@@RESULT ${JSON.stringify({ id: reservation.id, rows: reservation.rows, bytes: reservation.bytes })}`);
      // Keep the connection and the reservation open until the parent kills this process.
      setInterval(() => {}, 60_000);
      return;
    }
  }
  console.log(`@@RESULT ${JSON.stringify(result)}`);
  await db.close();
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
