// Deploy-drill plugin-side face driver (SYS-INT). Runs this release's vendored core behind the real
// sck comm channel inside a drill root: `bun scripts/deploy-drill-face.ts serve <drill-root>`.
// Same wiring as the sidecar-review gate harness: a real SidecarPool answers a real client-cli on the
// comm channel it minted. Nothing here touches production — the database, ports, credential and comm
// directories all live under the drill root, and the drill runner stops this process when done.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[3];
if (process.argv[2] !== 'serve' || !root) {
  console.error('usage: deploy-drill-face.ts serve <drill-root>');
  process.exit(2);
}
process.env.SCK_SERVICE_HOME = root;

const { loadDatabaseConfig } = await import('../src/config.ts');
const { CompanyDatabase } = await import('../src/database.ts');
const { SurrealCompanyCore } = await import('../src/core.ts');
const { LocalEnrollmentAdmin } = await import('../src/enrollment.ts');
const { Workforce } = await import('../src/workforce.ts');
const { SidecarPool } = await import('../plugin/server/sidecar.ts');

const db = new CompanyDatabase(loadDatabaseConfig());
await db.connect();
await db.bootstrap();
const core = new SurrealCompanyCore(db);
const enrollment = new LocalEnrollmentAdmin(db);
await enrollment.enroll('drill-fixture-manager', 'owner', ['execute', 'review', 'manage']);
const wf = new Workforce(db, join(root, 'credentials'));
const def = { id: 'drill-fixture-eng', role: 'engineering' as const, provider: 'codex', model: 'drill-fixture', enabled: true };
await wf.upsertDef(def.id, def);
const inst = await wf.spawnInst(def);
const pool = new SidecarPool({
  core,
  workforce: wf,
  ops: { tools: [], call: async () => ({ available: false }), release: () => {} },
  runDir: join(root, 'comm'),
  sweepMs: 50,
  log: message => console.log(`[drill-face] ${message}`),
} as never);
const channelEnv = (pool as unknown as { env: (i: unknown) => Record<string, string> }).env(inst);
mkdirSync(join(root, 'comm'), { recursive: true });
writeFileSync(join(root, 'face-channel.json'), JSON.stringify({
  SCK_COMM_DIR: channelEnv.SCK_COMM_DIR,
  SCK_COMM_KEY: channelEnv.SCK_COMM_KEY,
  employeeId: inst.id,
}, null, 2) + '\n');
console.log(`drill plugin face serving for inst ${inst.id}`);
setInterval(() => {}, 60_000);
