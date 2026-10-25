// RB01 rollback drill, previous-release side. tests/rollback-isolation.fork.test.ts and
// tests/fault-rollback-isolation.fork.test.ts extract the previous release from git, vendor its plugin the way
// plugin/scripts/vendor.sh does, and run this file with RB01_OLD_ROOT pointing at that tree.
// Every company module loaded below is the previous release's code: the old Dispatcher and the old SidecarPool drive
// the isolated fork database, and requests go through the old comm client. Only the Paseo gateway is a stub.
// Output is one line: RB01_RESULT <json>. Nothing here reads credential files or touches the deployed release tree.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OLD = process.env.RB01_OLD_ROOT ?? '';
const NAMESPACE = process.env.RB01_NAMESPACE ?? '';
const DATABASE = process.env.RB01_DATABASE ?? '';
const TICKS = Number(process.env.RB01_TICKS ?? '3');
const PURPOSES = ['execute', 'review', 'gm-attention', 'eval'];

type Row = { id: unknown; title: string; state: string; blocked_to?: string | null; current_employee?: string | null; version: number };
type Relay = { exit: number; stdout: string; stderr: string; data: unknown };

const load = (rel: string): Promise<any> => import(join(OLD, rel));

async function main(): Promise<Record<string, unknown>> {
  if (!OLD || !NAMESPACE || !DATABASE) throw new Error('RB01_OLD_ROOT, RB01_NAMESPACE and RB01_DATABASE are required');
  const { loadDatabaseConfig } = await load('src/config.ts');
  const { CompanyDatabase } = await load('src/database.ts');
  const { SurrealCompanyCore, asId } = await load('src/core.ts');
  const { OwnerDesk } = await load('src/owner.ts');
  const { Workforce } = await load('src/workforce.ts');
  const { Dispatcher } = await load('src/dispatcher/dispatcher.ts');
  const { SidecarPool } = await load('plugin/server/sidecar.ts');

  const dir = mkdtempSync(join(tmpdir(), 'rb01-old-run-'));
  const db = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NAMESPACE, database: DATABASE });
  try {
    await db.connect();
    await db.bootstrap();
    const core = new SurrealCompanyCore(db);
    const owner = new OwnerDesk(db);
    const wf = new Workforce(db, join(dir, 'unused-credential-files'));

    const agents = new Map<string, { id: string; status: string }>();
    const envs = new Map<string, Record<string, string>>();
    const spawns: Array<{ role: string; def: string }> = [];
    const paseo = {
      list: async () => agents,
      status: async (id: string) => (agents.get(id) ? { status: agents.get(id)!.status, pendingPermissions: 0 } : undefined),
      lastError: async () => '',
      logsTail: async () => 'rb01 synthetic transcript',
      lastInputTokens: async () => 0,
      spawn: async (b: { env: Record<string, string>; labels: { employee_id: string; role: string; def: string } }) => {
        const id = `agent-${b.labels.employee_id}`;
        agents.set(id, { id, status: 'running' });
        envs.set(id, b.env);
        spawns.push({ role: b.labels.role, def: b.labels.def });
        return id;
      },
      send: async (id: string) => { agents.get(id)!.status = 'running'; },
      stop: async (id: string) => { agents.get(id)!.status = 'idle'; },
      archive: async (id: string) => { agents.get(id)!.status = 'archived'; pool.detachAgent(id); },
      listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {},
    };
    const pool = new SidecarPool({ core, workforce: wf, runDir: join(dir, 'comm'), sweepMs: 5 });
    const logs: string[] = [];
    const dispatcher = new Dispatcher({
      workforce: wf, owner, paseo, sidecar: pool, rand: () => 0,
      env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' },
      log: (message: string) => { logs.push(message.slice(0, 200)); },
    });

    const snapshot = async (): Promise<Row[]> => {
      const [rows] = await db.db.query('SELECT id, title, state, blocked_to, current_employee, version FROM task ORDER BY title;');
      return (rows ?? []) as Row[];
    };
    const seeded = await snapshot();
    const seededVersion = new Map(seeded.map(row => [row.title, row.version]));
    const taskIds = new Map(seeded.map(row => [row.title, asId(row.id) as string]));

    const reports = [];
    for (let n = 0; n < TICKS; n++) reports.push(await dispatcher.tick());
    const after = await snapshot();

    const tasks: Record<string, unknown> = {};
    for (const row of after) {
      const taskId = asId(row.id) as string;
      // recordDispatch keys on the version the task had when the pass picked it, i.e. the seeded version.
      const version = seededVersion.get(row.title) ?? row.version;
      const dispatch: Record<string, boolean> = {};
      for (const purpose of PURPOSES) dispatch[purpose] = Boolean(await wf.lastDispatch(taskId, version, purpose));
      tasks[row.title] = {
        state: row.state,
        blockedTo: row.blocked_to ?? null,
        occupied: Boolean(row.current_employee),
        occupiedBy: row.current_employee === 'rb01-held-employee' ? 'rb01-held-employee' : row.current_employee ? 'instance' : null,
        version: row.version,
        dispatch,
      };
    }

    const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
    // Probe as the instance that the previous dispatcher actually leased a ready task to.
    const holder = after.find(row => row.title.startsWith('rb01-ready') && row.current_employee);
    const eng = (await wf.insts()).find((inst: { id: string; paseoAgentId?: string }) => inst.id === holder?.current_employee && inst.paseoAgentId);
    const env = eng ? envs.get(eng.paseoAgentId) : undefined;
    // Reported, not thrown: a drill that only says "no leased instance" hides why the previous release stayed quiet.
    if (!holder || !env) {
      return { ok: false, error: 'no ready task leased to an instance with a comm environment after the rollback ticks',
        bootstrap: true, taskTotal: after.length, ticks: reports, spawns: spawns.map(s => `${s.role}:${s.def}`).sort(), tasks, logs: logs.slice(0, 40) };
    }
    // The previous release's own client, pointed at the instance comm dir the old pool serves.
    const call = async (tool: string, args: Record<string, unknown>): Promise<Relay> => {
      const proc = Bun.spawn([process.execPath, join(OLD, 'src/mcp/client-cli.ts'), 'call', tool, JSON.stringify(args)], {
        cwd: OLD, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, SCK_COMM_DIR: env.SCK_COMM_DIR, SCK_COMM_KEY: env.SCK_COMM_KEY },
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const exit = await proc.exited;
      return { exit, stdout: stdout.trim(), stderr: stderr.trim(), data: parse(stdout.trim()) };
    };
    const shape = (data: unknown) => (data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort() : null);
    const ownTaskId = asId(holder.id) as string;
    // The cursor below is deliberately bogus, and it is the drill's only liveness probe of `get_context` on the old
    // runtime: the release verifies cursors (they are versioned and signed), so a made-up one is refused by name. That
    // refusal is the old release's own designed behaviour, present before and after SYS03 — the drill records it so a
    // reviewer can tell it apart from a SYS03 difference instead of reading it as a new failure (QA V8).
    const ctx = await call('get_context', { pageSize: 2, cursor: 'v1.not-a-real-cursor.AAAA' });
    const hist = await call('get_task_history', { taskId: ownTaskId, pageSize: 1 });
    const worktrees = await call('list_worktrees', { pageSize: 1 });
    const summary = await call('get_admin_summary', {});
    const text = await call('read_task_text', { taskId: ownTaskId, offset: 0 });
    // SYS03 RB01: the disposition tools the new release adds. The previous release must refuse them by name.
    const status = await call('disposition_status', { taskId: ownTaskId });
    const notices = await call('holder_notices', {});
    const data = (r: Relay) => (r.data ?? {}) as Record<string, unknown>;
    const relays = {
      getContext: { exit: ctx.exit, keys: shape(ctx.data), taskCount: Array.isArray(data(ctx).tasks) ? (data(ctx).tasks as unknown[]).length : null, stderr: ctx.stderr },
      getTaskHistory: { exit: hist.exit, keys: shape(hist.data), historyCount: Array.isArray(data(hist).history) ? (data(hist).history as unknown[]).length : null, stderr: hist.stderr },
      listWorktrees: { exit: worktrees.exit, isArray: Array.isArray(worktrees.data), stderr: worktrees.stderr },
      getAdminSummary: { exit: summary.exit, stdout: summary.stdout, stderr: summary.stderr },
      readTaskText: { exit: text.exit, stdout: text.stdout, stderr: text.stderr },
      dispositionStatus: { exit: status.exit, stdout: status.stdout, stderr: status.stderr },
      holderNotices: { exit: notices.exit, stdout: notices.stdout, stderr: notices.stderr },
    };

    return {
      ok: true,
      bootstrap: true,
      taskTotal: after.length,
      ticks: reports.map(r => ({
        woke: r.woke.length, revoked: r.revoked.length, retired: r.retired.length, extended: r.extended.length,
        notices: r.notices.length, decisions: r.decisions.length, skipped: r.skipped ?? null,
      })),
      spawns: spawns.map(s => `${s.role}:${s.def}`).sort(),
      tasks,
      relays,
      logs: logs.slice(0, 40),
    };
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  result => { console.log(`RB01_RESULT ${JSON.stringify(result)}`); process.exit(0); },
  (error: unknown) => {
    console.log(`RB01_RESULT ${JSON.stringify({ ok: false, error: String((error as Error)?.message ?? error) })}`);
    process.exit(1);
  },
);
