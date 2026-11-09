import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaseoCli, type PaseoGateway } from '../src/dispatcher/paseo.ts';
import { Dispatcher, type DispatcherDeps } from '../src/dispatcher/dispatcher.ts';
import { DEFAULT_CONFIG, type EmployeeDef, type EmployeeInst } from '../src/workforce.ts';

// SYS-DISP AC02 / B4: the adapter the tick reads Paseo through, checked against the shapes the local Paseo CLI really returns
// (CLI 0.12.0). The fixtures in tests/fixtures/paseo are redacted: enum values, booleans, nulls and key structure are real,
// strings are placeholders, identifiers are synthetic. See tests/fixtures/paseo/README.md for the sampling record.
// Negative cases run through a fake CLI that fails in one controlled way; each one must read as `unknown`, never as idle or busy.
const FIXTURES = join(import.meta.dir, 'fixtures', 'paseo');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const fixturePath = (name: string) => join(FIXTURES, name);

const IDLE = '00000000-0000-4000-8000-000000000011';
const RUNNING = '00000000-0000-4000-8000-000000000012';
const CLOSED = '00000000-0000-4000-8000-000000000013';
const UNKNOWN_AGENT = '00000000-0000-4000-8000-000000000099';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const NO_STATUS = '00000000-0000-4000-8000-0000000000a2';

const dir = mkdtempSync(join(tmpdir(), 'sck-paseo-contract-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const archivedPath = join(dir, 'inspect-archived.json');
writeFileSync(archivedPath, JSON.stringify({ ...JSON.parse(fixture('inspect-idle.sample.json')), Id: IDLE, Archived: true, ArchivedAt: '<iso-8601-utc>' }));

let seq = 0;
/**
 * A fake `paseo`. `ls` answers with `lsBody`; `inspect <id>` runs the shell body registered for that id. Any other id gets the
 * CLI's real not-found answer (exit 1, AGENT_NOT_FOUND on stderr).
 */
function fakeCli(inspect: Record<string, string>, lsBody = `cat '${fixturePath('ls-global.sample.json')}'`, logsBody = `echo ''`, agentBody = `echo '{"agentId":"${AGENT}","status":"reloaded","timelineSize":1}'`): string {
  const bin = join(dir, `paseo-${++seq}`);
  const arms = Object.entries(inspect).map(([id, body]) => `      ${id}) ${body} ;;`).join('\n');
  writeFileSync(bin, [
    '#!/bin/sh',
    'case "$1" in',
    `  ls) ${lsBody} ;;`,
    `  logs) ${logsBody} ;;`,
    `  agent) ${agentBody} ;;`,
    '  inspect)',
    '    case "$2" in',
    arms,
    `      *) cat '${fixturePath('stderr-agent-not-found.sample.json')}' >&2; exit 1 ;;`,
    '    esac ;;',
    '  *) echo "unexpected subcommand" >&2; exit 2 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return bin;
}

const inspectOf = (id: string) => `cat '${fixturePath(`inspect-${id === IDLE ? 'idle' : id === RUNNING ? 'running' : 'closed'}.sample.json`)}'`;
const NONZERO = `echo '{"error":{"code":"INSPECT_FAILED","message":"<synthetic non-zero exit>"}}' >&2; exit 1`;
const NON_JSON = `echo 'Paseo daemon is starting'; exit 0`;
const SLEEP = `sleep 6`;
const EMPTY = `exit 0`;
const MISSING_STATUS = `echo '{"Id":"${NO_STATUS}","Archived":false,"PendingPermissions":[]}'; exit 0`;

const FIXTURE_LIST_STATUSES = ['idle', 'running', 'closed'];

test('calibration: the redacted fixtures keep the real key sets and enum values', () => {
  const ls = JSON.parse(fixture('ls-global.sample.json')) as Array<Record<string, unknown>>;
  expect(ls.map(r => r.status)).toEqual(FIXTURE_LIST_STATUSES);
  for (const row of ls) {
    expect(Object.keys(row).sort()).toEqual(['created', 'cwd', 'id', 'name', 'provider', 'shortId', 'status', 'thinking']);
    expect(row.shortId).toBe(String(row.id).slice(0, 7));
  }
  for (const name of ['inspect-idle', 'inspect-running', 'inspect-closed']) {
    const row = JSON.parse(fixture(`${name}.sample.json`)) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['Archived', 'ArchivedAt', 'AvailableModes', 'Capabilities', 'CreatedAt', 'Cwd', 'Id', 'LastUsage',
      'Mode', 'Model', 'Name', 'ParentAgentId', 'PendingPermissions', 'Provider', 'Status', 'Thinking', 'UpdatedAt', 'Worktree']);
    expect(typeof row.Status).toBe('string');
    expect(typeof row.Archived).toBe('boolean');
    expect(Array.isArray(row.PendingPermissions)).toBe(true);
  }
  const ws = JSON.parse(fixture('workspace-ls.sample.json')) as Array<Record<string, unknown>>;
  expect(ws.map(w => w.isolation).sort()).toEqual(['local', 'worktree']);
});

test('the list the tick reads keeps the real statuses: idle stays idle, running stays running, closed is not idle', async () => {
  const rows = await createPaseoCli(fakeCli({})).list();
  expect(rows.get(IDLE)?.status).toBe('idle');
  expect(rows.get(RUNNING)?.status).toBe('running');
  expect(rows.get(CLOSED)?.status).toBe('closed');
});

test('the per-agent read uses the real inspect shape and agrees with the list for the same idle session', async () => {
  const paseo = createPaseoCli(fakeCli({ [IDLE]: inspectOf(IDLE), [RUNNING]: inspectOf(RUNNING), [CLOSED]: inspectOf(CLOSED) }));
  expect(await paseo.status(IDLE)).toEqual({ status: 'idle', pendingPermissions: 0 });
  expect((await paseo.list()).get(IDLE)?.status).toBe('idle');
  expect(await paseo.status(RUNNING)).toEqual({ status: 'running', pendingPermissions: 0 });
  expect(await paseo.status(CLOSED)).toEqual({ status: 'closed', pendingPermissions: 0 });
});

test('an archived session reports archived through the fallback, whatever its last status says', async () => {
  const paseo = createPaseoCli(fakeCli({ [IDLE]: `cat '${archivedPath}'` }));
  expect((await paseo.status(IDLE))?.status).toBe('archived');
});

test('an agent the CLI confirms does not exist reads as undefined, never as idle', async () => {
  expect(await createPaseoCli(fakeCli({})).status(UNKNOWN_AGENT)).toBeUndefined();
});

// B4 negatives at the gateway: a CLI that did not answer is `unknown`, not `undefined` (which the dispatcher reads as missing).
test('B4a: a non-zero exit from the CLI reads as unknown', async () => {
  expect(await createPaseoCli(fakeCli({ [AGENT]: NONZERO }), { timeoutMs: 2000 }).status(AGENT)).toEqual({ status: 'unknown', pendingPermissions: 0 });
});

test('B4b: stdout that is not JSON reads as unknown', async () => {
  expect(await createPaseoCli(fakeCli({ [AGENT]: NON_JSON }), { timeoutMs: 2000 }).status(AGENT)).toEqual({ status: 'unknown', pendingPermissions: 0 });
});

test('B4c: a timeout reads as unknown and returns promptly', async () => {
  const started = Date.now();
  expect(await createPaseoCli(fakeCli({ [AGENT]: SLEEP }), { timeoutMs: 200 }).status(AGENT)).toEqual({ status: 'unknown', pendingPermissions: 0 });
  expect(Date.now() - started).toBeLessThan(2000);
});

test('B4d: empty stdout, or a reply without a Status field, reads as unknown', async () => {
  const paseo = createPaseoCli(fakeCli({ [AGENT]: EMPTY, [NO_STATUS]: MISSING_STATUS }), { timeoutMs: 2000 });
  expect(await paseo.status(AGENT)).toEqual({ status: 'unknown', pendingPermissions: 0 });
  expect(await paseo.status(NO_STATUS)).toEqual({ status: 'unknown', pendingPermissions: 0 });
});

// The dispatcher-level check: one real tick with a single instance, read back through the dispatcher's own state mapping.
const DEF: EmployeeDef = { id: 'test', role: 'engineering', provider: 'codex', model: 'fixture', enabled: true, maxInstances: 1, priority: 0, weight: 1, errorStreak: 0 };

async function observe(body: string) {
  const bin = fakeCli({ [AGENT]: body }, 'echo []');
  // Generous enough for a shell spawn on a loaded machine; only the SLEEP body is meant to hit it.
  const cli = createPaseoCli(bin, { timeoutMs: 2000 });
  const events: string[] = [];
  const paseo: PaseoGateway = {
    ...cli,
    stop: async id => { events.push(`stop:${id}`); },
    archive: async id => { events.push(`archive:${id}`); },
    send: async id => { events.push(`send:${id}`); },
    spawn: async () => { events.push('spawn'); return 'agent-new'; },
  };
  const inst = { id: 'employee-1', def: DEF.id, role: DEF.role, provider: DEF.provider, model: DEF.model, credential: 'fixture-1', paseoAgentId: AGENT } as unknown as EmployeeInst;
  const workforce = {
    config: async () => ({ ...DEFAULT_CONFIG, quotaFloorPct: 0, quotaWeeklyFloorPct: 0, sessionMaxWakes: 0, sessionMaxInputK: 0, jevDecisions: false }),
    defs: async () => [DEF], serverNow: async () => 1000, insts: async () => [inst], tasks: async () => [], providerHealth: async () => new Map(),
    retire: async (id: string, _reason: string, kind: string) => { events.push(`retire:${id}:${kind}`); },
    defFailure: async () => { events.push('defFailure'); return 1; },
  };
  const owner = { applyPending: async () => [], openNotices: async () => [], triagePending: async () => [], resolveNotice: async () => {}, raiseNotice: async () => true };
  const dispatcher = new Dispatcher({ workforce, owner, paseo, env: { opsRepo: '/fixture', sckBin: '/bin/sck', paseoBin: bin }, rand: () => 0 } as unknown as DispatcherDeps);
  const report = await dispatcher.tick();
  const session = dispatcher.sessionSnapshot().sessions.get(inst.id);
  return { state: session?.state, status: session?.status, retired: report.retired, events };
}

const untouched = (events: string[]) => events.every(e => !/^(retire|archive|stop|send|spawn)/.test(e));

const DISPATCHER_TEST_MS = 30_000;

test('B4 dispatcher: each unanswered CLI case maps to the unknown state, with no retirement, archive, stop or dispatch', async () => {
  for (const [name, body] of [['non-zero exit', NONZERO], ['non-JSON stdout', NON_JSON], ['timeout', SLEEP], ['empty stdout', EMPTY], ['missing Status', MISSING_STATUS]] as const) {
    const seen = await observe(body);
    expect({ name, state: seen.state, status: seen.status }).toEqual({ name, state: 'unknown', status: 'unknown' });
    expect({ name, retired: seen.retired }).toEqual({ name, retired: [] });
    expect({ name, untouched: untouched(seen.events) }).toEqual({ name, untouched: true });
  }
}, DISPATCHER_TEST_MS);

test('B4 dispatcher control: a CLI-confirmed missing agent still retires as before (down)', async () => {
  const seen = await observe(`cat '${fixturePath('stderr-agent-not-found.sample.json')}' >&2; exit 1`);
  expect(seen.state).toBe('down');
  expect(seen.events).toContain(`retire:employee-1:failure`);
}, DISPATCHER_TEST_MS);

test('B4 dispatcher control: idle, running and archived keep their states', async () => {
  expect((await observe(inspectOf(IDLE))).state).toBe('idle');
  expect((await observe(inspectOf(RUNNING))).state).toBe('busy');
  const archived = await observe(`cat '${archivedPath}'`);
  expect(archived.state).toBe('down');
  expect(archived.events).toContain('retire:employee-1:archive');
}, DISPATCHER_TEST_MS);

// The failure entry Paseo really writes does not start with the marker: it is a timeline line
// like `Error: Agent turn ended: model_usage_exhausted[System Error] Internal error: …`.
// Reading only lines that *begin* with "[System Error]" matched nothing, every quota exhaustion
// arrived as an empty string, and the dispatcher retired the session as "session error: unknown".
const LOGS_QUOTA = `printf '%s\\n%s\\n' '[Shell] date -u' 'Error: Agent turn ended: model_usage_exhausted[System Error] Internal error: Agent turn ended: model_usage_exhausted'`;
const LOGS_CLEAN = `printf '%s\\n%s\\n' '[Shell] date -u' '[Thought] nothing failed here'`;

test('lastError reads the real failure entry, which does not start with the marker', async () => {
  const paseo = createPaseoCli(fakeCli({}, undefined, LOGS_QUOTA));
  const error = await paseo.lastError(AGENT);
  expect(error).toContain('model_usage_exhausted');
  expect(error.startsWith('[')).toBe(false);
});

test('lastError keeps a healthy transcript empty instead of inventing a failure', async () => {
  const paseo = createPaseoCli(fakeCli({}, undefined, LOGS_CLEAN));
  expect(await paseo.lastError(AGENT)).toBe('');
});

test('lastError survives an unreadable transcript', async () => {
  const paseo = createPaseoCli(fakeCli({}, undefined, `exit 1`));
  expect(await paseo.lastError(AGENT)).toBe('');
});

test('the agent list carries the model the session actually serves', async () => {
  const rows = await createPaseoCli(fakeCli({})).list();
  // The fixture keeps the real key set but redacts the value; a bare placeholder has no slash,
  // so the model is unknown rather than guessed.
  for (const row of rows.values()) expect(row.model).toBeUndefined();
});

// The dispatcher restarts a quota-parked session in place; the adapter must call the CLI's
// `agent reload <id>` verb (there is no top-level `reload <id>`: that one reloads the daemon config).
test('reload runs the per-agent verb with the agent id', async () => {
  const argsFile = join(dir, 'reload-args.txt');
  const bin = fakeCli({}, undefined, undefined, `printf '%s ' "$@" > '${argsFile}'`);
  await createPaseoCli(bin).reload(AGENT);
  expect(readFileSync(argsFile, 'utf8').trim()).toBe(`agent reload ${AGENT}`);
});

test('a failed reload surfaces instead of passing for a restart', async () => {
  const bin = fakeCli({}, undefined, undefined, `echo '{"error":{"code":"RELOAD_FAILED"}}' >&2; exit 1`);
  await expect(createPaseoCli(bin).reload(AGENT)).rejects.toThrow();
});

test('goal workspace provisioning coalesces concurrent agents and survives a dispatcher restart or title change', async () => {
  const state = join(dir, `workspace-state-${++seq}.json`);
  const script = join(dir, `workspace-cli-${seq}.ts`);
  writeFileSync(state, JSON.stringify({ projects: [], workspaces: [], calls: [], agents: 0 }));
  writeFileSync(script, `#!/usr/bin/env bun
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const file=${JSON.stringify(state)};
const s=JSON.parse(readFileSync(file,'utf8'));const a=process.argv.slice(2);
const value=k=>a[a.indexOf(k)+1];
appendFileSync(file+'.calls',JSON.stringify(a)+'\\n');let out;
if(a[0]==='project'&&a[1]==='ls')out=s.projects;
else if(a[0]==='project'&&a[1]==='create'){out={projectId:'project-'+s.projects.length,name:'repo',path:a[2]};s.projects.push(out);}
else if(a[0]==='workspace'&&a[1]==='ls')out=s.workspaces;
else if(a[0]==='workspace'&&a[1]==='create'){out={workspaceId:'workspace-'+s.workspaces.length,name:value('--title'),cwd:value('--path'),project:value('--project')};s.workspaces.push(out);}
else if(a[0]==='run')out={agentId:'agent-'+(++s.agents)};
else throw Error('unexpected CLI '+a.join(' '));
writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(out));
`);
  chmodSync(script, 0o755);
  const input = { title: '工程', provider: 'claude', model: 'haiku', cwd: '/fixture/repo', repoHome: '/fixture/repo',
    workspaceScope: 'goal-a', workspaceTitle: '优化 [goal-a]', labels: {}, env: {}, prompt: 'fixture' };
  const paseo = createPaseoCli(script);
  // Provision concurrently without racing our deliberately simple fake run counter.
  await Promise.all([paseo.spawn(input), paseo.spawn(input)]);
  await createPaseoCli(script).spawn({ ...input, workspaceTitle: '改名 [goal-a]' });
  await paseo.spawn({ ...input, workspaceScope: 'goal-b', workspaceTitle: '目标 B [goal-b]' });
  const stored = JSON.parse(readFileSync(state, 'utf8'));
  expect(stored.projects).toHaveLength(1);
  expect(stored.workspaces).toHaveLength(2);
  expect(stored.workspaces.every((w: { project: string }) => w.project === 'project-0')).toBe(true);
  const runs = readFileSync(state + '.calls', 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter((a: string[]) => a[0] === 'run');
  expect(runs.slice(0, 3).map((a: string[]) => a[a.indexOf('--workspace') + 1])).toEqual(['workspace-0', 'workspace-0', 'workspace-0']);
  // A chain's container is created by ID, so two goals with one title stay apart, and spawn uses it as given.
  const first = await paseo.createWorkspace!('同名目标', '/fixture/repo', '/fixture/repo');
  const second = await paseo.createWorkspace!('同名目标', '/fixture/repo', '/fixture/repo');
  expect(first).not.toBe(second);
  await paseo.spawn({ ...input, workspaceScope: undefined, workspaceId: second, workspaceTitle: '同名目标' });
  const last = readFileSync(state + '.calls', 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter((a: string[]) => a[0] === 'run').at(-1)!;
  expect(last[last.indexOf('--workspace') + 1]).toBe(second);
});
