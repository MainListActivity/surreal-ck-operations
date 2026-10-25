// Off-site backup of the company control plane: bun scripts/company-backup.ts backup|verify
//
// backup: export the local company database, zstd it, refuse anything over FILE_LIMIT, upload it to R2 as
//   hourly/<stamp>.surql.zst (and daily/<date>.surql.zst for the first backup of a UTC day), then prune R2 to
//   the newest KEEP_HOURLY hourly copies plus as many daily copies as fit TOTAL_LIMIT.
// verify: restore the newest backup into a throwaway in-memory instance and compare its row counts with the live DB.
//
// Credentials are read from files by path and passed to children through the environment, never argv or output:
//   private/company-db.env   SURREAL_URL, SURREAL_ROOT_USER, SURREAL_ROOT_PASS (the local instance)
//   private/credentials/r2-backup.env   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, R2_BUCKET
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { loadDatabaseConfig } from '../src/config.ts';

export const FILE_LIMIT = 20 * 1024 * 1024;
export const TOTAL_LIMIT = 40 * 1024 * 1024;
export const KEEP_HOURLY = 2;
const COUNTED = ['task', 'audit', 'goal', 'employee', 'scorecard'];

const home = process.env.SCK_SERVICE_HOME || join(homedir(), 'Library/Application Support/SurrealCKCompany');
const surreal = process.env.SCK_SURREAL_BIN || join(homedir(), '.surrealdb/surreal');

function envFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export interface StoredObject { key: string; size: number }

/** Which objects to delete: keep the newest hourly copies, then daily copies newest-first while the total fits. */
export function prunePlan(objects: StoredObject[], keepHourly = KEEP_HOURLY, total = TOTAL_LIMIT): string[] {
  const newest = (prefix: string) => objects.filter(o => o.key.startsWith(prefix)).sort((a, b) => b.key.localeCompare(a.key));
  const hourly = newest('hourly/'), daily = newest('daily/');
  const keep = new Set<string>();
  let used = 0;
  for (const o of hourly.slice(0, keepHourly)) { keep.add(o.key); used += o.size; }
  for (const o of daily) { if (used + o.size > total) break; keep.add(o.key); used += o.size; }
  return objects.filter(o => !keep.has(o.key)).map(o => o.key);
}

class R2 {
  private readonly base: string;
  private readonly token: string;
  constructor(env: Record<string, string>) {
    if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.R2_BUCKET) throw new Error('r2-backup.env needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, R2_BUCKET');
    this.token = env.CLOUDFLARE_API_TOKEN;
    this.base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${env.R2_BUCKET}/objects`;
  }
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.base + path, { ...init, headers: { authorization: `Bearer ${this.token}`, ...init.headers } });
    if (!res.ok) throw new Error(`R2 ${init.method ?? 'GET'} ${path.split('?')[0]} → ${res.status}`);
    return res;
  }
  put(key: string, body: Uint8Array) { return this.call(`/${key}`, { method: 'PUT', body: new Blob([body as Uint8Array<ArrayBuffer>]), headers: { 'content-type': 'application/zstd' } }); }
  async get(key: string) { return new Uint8Array(await (await this.call(`/${key}`)).arrayBuffer()); }
  delete(key: string) { return this.call(`/${key}`, { method: 'DELETE' }); }
  async list(): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ per_page: '1000', ...(cursor ? { cursor } : {}) });
      const body = await (await this.call(`?${q}`)).json() as { result: Array<{ key: string; size: number }>; result_info?: { cursor?: string; is_truncated?: boolean } };
      out.push(...body.result.map(o => ({ key: o.key, size: Number(o.size) })));
      cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined;
    } while (cursor);
    return out;
  }
}

function httpEndpoint(url: string): string {
  return url.replace(/\/rpc\/?$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

async function exportDb(file: string): Promise<void> {
  const cfg = loadDatabaseConfig();
  const p = Bun.spawn([surreal, 'export', '--endpoint', httpEndpoint(cfg.url), '--namespace', cfg.namespace, '--database', cfg.database, file],
    { env: { ...process.env, SURREAL_USER: cfg.rootUser, SURREAL_PASS: cfg.rootPassword }, stdout: 'ignore', stderr: 'pipe' });
  if (await p.exited !== 0) throw new Error(`surreal export failed: ${(await new Response(p.stderr).text()).slice(0, 300)}`);
}

async function notice(text: string): Promise<void> {
  const db = new CompanyDatabase(loadDatabaseConfig());
  try {
    await db.connect(); await db.useDatabase();
    await db.db.query('UPSERT $id MERGE { key: $key, text: $text, at: time::now() };',
      { id: new RecordId('owner_notice', 'company-backup'), key: 'company-backup', text });
  } finally { await db.close().catch(() => {}); }
}

async function counts(cfg: { url: string; rootUser: string; rootPassword: string; namespace: string; database: string }): Promise<Record<string, number>> {
  const db = new CompanyDatabase(cfg);
  try {
    await db.connect(); await db.useDatabase();
    const out: Record<string, number> = {};
    for (const t of COUNTED) out[t] = ((await db.db.query<[Array<{ n: number }>]>('SELECT count() AS n FROM type::table($t) GROUP ALL;', { t }))[0]?.[0]?.n) ?? 0;
    return out;
  } finally { await db.close().catch(() => {}); }
}

async function backup(r2: R2): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sck-backup-'));
  try {
    const raw = join(dir, 'company.surql');
    await exportDb(raw);
    const packed = Bun.zstdCompressSync(readFileSync(raw), { level: 19 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
    if (packed.length > FILE_LIMIT) {
      const mb = (packed.length / 1048576).toFixed(1);
      await notice(`公司库备份 ${mb}MB 超过单文件 20MB 上限，本次未上传 R2。需要收紧数据保留期或清理大表。`).catch(() => {});
      throw new Error(`backup ${mb}MB exceeds the ${FILE_LIMIT / 1048576}MB file limit; not uploaded`);
    }
    const existing = await r2.list();
    await r2.put(`hourly/${stamp}.surql.zst`, packed);
    const day = `daily/${stamp.slice(0, 8)}.surql.zst`;
    const uploaded = [{ key: `hourly/${stamp}.surql.zst`, size: packed.length }];
    if (!existing.some(o => o.key === day)) { await r2.put(day, packed); uploaded.push({ key: day, size: packed.length }); }
    const remove = prunePlan([...existing.filter(o => !uploaded.some(u => u.key === o.key)), ...uploaded]);
    for (const key of remove) await r2.delete(key);
    const total = (await r2.list()).reduce((a, o) => a + o.size, 0);
    console.log(`backup ${stamp}: ${(packed.length / 1048576).toFixed(2)}MB uploaded, ${remove.length} pruned, R2 total ${(total / 1048576).toFixed(2)}MB`);
    writeFileSync(join(home, 'backups', 'last-backup.json'), JSON.stringify({ at: new Date().toISOString(), bytes: packed.length, totalBytes: total }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function verify(r2: R2): Promise<void> {
  const latest = (await r2.list()).filter(o => o.key.startsWith('hourly/')).sort((a, b) => b.key.localeCompare(a.key))[0];
  if (!latest) throw new Error('no backup in R2');
  const dir = mkdtempSync(join(tmpdir(), 'sck-restore-'));
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = listener.port!; listener.stop(true);
  const pass = crypto.randomUUID();
  const server = Bun.spawn([surreal, 'start', '--bind', `127.0.0.1:${port}`, '--log', 'error', 'memory'],
    { env: { ...process.env, SURREAL_USER: 'root', SURREAL_PASS: pass }, stdout: 'ignore', stderr: 'ignore' });
  try {
    const file = join(dir, 'restore.surql');
    writeFileSync(file, Bun.zstdDecompressSync(await r2.get(latest.key)));
    for (let n = 0; n < 200; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(25); }
    const live = loadDatabaseConfig();
    const p = Bun.spawn([surreal, 'import', '--endpoint', `http://127.0.0.1:${port}`, '--namespace', live.namespace, '--database', live.database, file],
      { env: { ...process.env, SURREAL_USER: 'root', SURREAL_PASS: pass }, stdout: 'ignore', stderr: 'pipe' });
    if (await p.exited !== 0) throw new Error(`restore import failed: ${(await new Response(p.stderr).text()).slice(0, 300)}`);
    const restored = await counts({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: pass, namespace: live.namespace, database: live.database });
    const current = await counts(live);
    // The live DB keeps moving after the backup; a restore that lost a table shows up as a large gap, not a small lag.
    const short = COUNTED.filter(t => restored[t]! < current[t]! * 0.9 || (current[t]! > 0 && restored[t] === 0));
    console.log(`verify ${latest.key}: restored ${JSON.stringify(restored)} live ${JSON.stringify(current)}`);
    if (short.length) {
      await notice(`公司库备份恢复演练失败：${latest.key} 恢复后 ${short.join('、')} 行数明显少于在线库。`).catch(() => {});
      throw new Error(`restore short on ${short.join(', ')}`);
    }
  } finally { server.kill(); rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const mode = process.argv[2];
  const r2 = new R2(envFile(join(home, 'private/credentials/r2-backup.env')));
  if (mode === 'backup') await backup(r2);
  else if (mode === 'verify') await verify(r2);
  else { console.error('usage: company-backup.ts backup|verify'); process.exit(2); }
}
