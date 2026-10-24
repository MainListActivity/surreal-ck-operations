import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// SYS06 C1: the switch guard refuses a target whose own code does not prove the versioned machine policy. The checks run
// against fixture trees; the real entry points are kept in order by the structural assertions below (install and remote
// deploy both ask this guard, after RW06/SYS02/IR06 and before their first side effect).
const ROOT = join(import.meta.dir, '..');
const GUARD = join(ROOT, 'scripts/policy-guard.sh');
const SERVICE = join(ROOT, 'scripts/company-service.sh');
const DEPLOY = join(ROOT, 'scripts/deploy-mcp-remote.sh');

/** The policy execution layer the guard requires: one judgement, one read layer, plan/isolation, dispatcher seam, facts. */
const JUDGEMENT = [
  'export function resolveEffective(rows: never[], chain: never[], epoch: number, now: number) { return { hash: `${epoch}${now}`, domains: [] }; }',
  'export function checkWriteAuthority(contract: unknown, input: unknown) { return { ok: input !== undefined }; }',
  'export function dispatchVerdict(facts: unknown, contract: unknown) { return { verdict: facts === contract ? "clear" : "stale", hash: "h" }; }',
].join('\n') + '\n';
const STORE = [
  'export async function readEffectiveContract(db: unknown, chain: unknown, now: number) { return { contract: now, rows: [], epoch: 0 }; }',
  'export async function readTaskPolicyRow(db: unknown, taskId: string) { return { id: taskId, state: "ready" }; }',
].join('\n') + '\n';
const CORE = [
  'class Core {',
  '  async policyPlan(credential: string, input: unknown) { return input; }',
  '  async policyEnforce(credential: string, input: unknown) {',
  "    return `CREATE audit CONTENT { action: 'policy_blocked', policy_block_reason: 'x', state: 'blocked' }`;",
  '  }',
  '}',
].join('\n') + '\n';
const WORKFORCE = 'export class Workforce {\n  async policyDispatchVerdict(taskId: string) { return { verdict: "clear", hash: taskId }; }\n}\n';
const CONTRACTS = 'export interface PolicyPlanInput { policyId: string }\nexport interface TaskView {\n  id: string;\n  policyBlockReason?: string;\n}\n';
const DATABASE = "export const MIGRATIONS = ['035-effective-policy.surql'];\n";
const SCHEMA = [
  'DEFINE TABLE IF NOT EXISTS policy SCHEMALESS PERMISSIONS NONE;',
  'DEFINE FIELD IF NOT EXISTS policy_hash ON task TYPE option<string>;',
  'DEFINE FIELD IF NOT EXISTS lease_policy_hash ON task TYPE option<string>;',
  'DEFINE FIELD IF NOT EXISTS policy_block_reason ON task TYPE option<string>;',
].join('\n') + '\n';
const SCHEMA_PATH = 'schema/035-effective-policy.surql';

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sck-sys06-guard-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

/** A release tree carrying the contract at the given paths; the overrides model an old or incomplete target. */
function release(files: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    'src/mcp/run.ts': 'export {};\n',
    'src/dispatcher/run.ts': 'export {};\n',
    'src/policy.ts': JUDGEMENT,
    'src/policy-store.ts': STORE,
    'src/core.ts': CORE,
    'src/workforce.ts': WORKFORCE,
    'src/contracts.ts': CONTRACTS,
    'src/database.ts': DATABASE,
    [SCHEMA_PATH]: SCHEMA,
  };
  for (const [path, body] of Object.entries(files)) base[path] = body;
  return tree(base);
}

function withPlugin(core: Record<string, string>, vendor = true): string {
  const dir = release(core);
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  if (vendor) {
    const vendored: Record<string, string> = {
      'src/policy.ts': JUDGEMENT, 'src/policy-store.ts': STORE, 'src/core.ts': CORE, 'src/workforce.ts': WORKFORCE,
      'src/contracts.ts': CONTRACTS, 'src/database.ts': DATABASE, [SCHEMA_PATH]: SCHEMA, ...core,
    };
    for (const [path, body] of Object.entries(vendored)) {
      mkdirSync(join(dir, 'plugin', 'server', 'vendor', dirname(path)), { recursive: true });
      writeFileSync(join(dir, 'plugin', 'server', 'vendor', path), body);
    }
  }
  return dir;
}

/** Runs one guard function in a shell, exactly as the scripts source it. */
function guard(fn: string, ...args: string[]): { code: number; out: string } {
  const script = `. "$1/scripts/policy-guard.sh"; shift; ${fn} "$@"`;
  const child = Bun.spawnSync(['sh', '-c', script, 'guard-test', ROOT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` };
}

test('a target that carries the contract is supported, and the plugin vendor must carry it too', () => {
  const good = release();
  const goodWithPlugin = withPlugin({});
  const pluginWithoutVendor = withPlugin({}, false);
  try {
    expect(guard('policy_target_supported', good).code).toBe(0);
    expect(guard('policy_target_supported', goodWithPlugin).code).toBe(0);
    // The plugin surface runs the same core: a shipped plugin without a generated vendor is unknown, so it is refused.
    expect(guard('policy_target_supported', pluginWithoutVendor).code).not.toBe(0);
    // Scope `core` is the remote deploy, whose payload is the service core only.
    expect(guard('policy_target_supported', pluginWithoutVendor, 'core').code).toBe(0);
  } finally {
    for (const dir of [good, goodWithPlugin, pluginWithoutVendor]) rmSync(dir, { recursive: true, force: true });
  }
});

test('the real worktree is a target both entry points would accept: its source and its generated vendor mirror carry the contract', () => {
  // Not a fixture: a release cut from this branch must pass the probe the install and remote paths call, vendor included.
  expect(guard('policy_target_supported', ROOT).code).toBe(0);
  expect(guard('policy_target_supported', ROOT, 'core').code).toBe(0);
});

test('old or incomplete targets are refused: no judgement, no read layer, no plan/enforce, no seam, no facts, no migration', () => {
  const noJudgement = release({ 'src/policy.ts': 'export const OTHER = 1;\n' });
  const noReadLayer = release({ 'src/policy-store.ts': 'export const OTHER = 1;\n' });
  const noIsolation = release({ 'src/core.ts': 'class Core {\n  async policyPlan(c: string, i: unknown) { return i; }\n}\n' });
  const noAudit = release({ 'src/core.ts': 'class Core {\n  async policyPlan(c: string, i: unknown) { return i; }\n  async policyEnforce(c: string, i: unknown) { return i; }\n}\n' });
  const noSeam = release({ 'src/workforce.ts': 'export class Workforce {}\n' });
  const noFacts = release({ 'src/contracts.ts': 'export interface TaskView { id: string }\n' });
  const noMigration = release({ [SCHEMA_PATH]: 'DEFINE TABLE IF NOT EXISTS policy SCHEMALESS PERMISSIONS NONE;\n' });
  const notLoaded = release({ 'src/database.ts': 'export const MIGRATIONS = [];\n' });
  try {
    for (const dir of [noJudgement, noReadLayer, noIsolation, noAudit, noSeam, noFacts, noMigration, notLoaded]) {
      expect(guard('policy_target_supported', dir).code).not.toBe(0);
    }
    // The refusal says why, names the target, and never claims that nothing is affected.
    const message = guard('policy_refuse', noJudgement).out;
    expect(message).toContain('refused:');
    expect(message).toContain('有效策略执行层');
    expect(message).toContain(`target=${noJudgement}`);
    expect(message).toContain('affected tasks=unknown');
  } finally {
    for (const dir of [noJudgement, noReadLayer, noIsolation, noAudit, noSeam, noFacts, noMigration, notLoaded]) rmSync(dir, { recursive: true, force: true });
  }
});

test('the probe is content-bound: a renamed or edited copy of a compatible target is refused', () => {
  const renamed = release();
  const edited = release();
  try {
    // 改名即失效：探针读的是目标自己的文件，文件名换了就不再是那份会被审查的代码。
    renameSync(join(renamed, 'src', 'policy.ts'), join(renamed, 'src', 'policy-rules.ts'));
    expect(guard('policy_target_supported', renamed).code).not.toBe(0);
    // 改内容即失效：把判定换成旧语义（不做写权判定）就不再自证它会拒绝失去授权的任务。
    writeFileSync(join(edited, 'src', 'policy.ts'), 'export function resolveEffective() { return {}; }\n');
    expect(guard('policy_target_supported', edited).code).not.toBe(0);
  } finally {
    for (const dir of [renamed, edited]) rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard rejects on capability alone: no task or policy rows are read, so a write after the check cannot open it', () => {
  const source = readFileSync(GUARD, 'utf8');
  // No database access of any kind in the guard: the decision cannot depend on how many policy rows exist today.
  expect(source).not.toMatch(/surrealdb|surreal |psql|sqlite|SELECT /i);
  expect(source).toContain('no authorised read seam');
  // The zero-row exception is refused in as many words: "no policy written yet" is not a compatibility proof.
  expect(source).toContain('NO zero-row exception');
  // It is sourced by both switch entry points, after the IR06 guard and before their first side effect.
  const service = readFileSync(SERVICE, 'utf8');
  const install = service.indexOf('policy_target_supported "$release"');
  expect(install).toBeGreaterThan(service.indexOf('independence_target_supported "$release"'));
  expect(install).toBeLessThan(service.indexOf('mkdir -p "$service_home/bin"'));
  expect(install).toBeLessThan(service.indexOf('ln -s "$release" "$service_home/active.next"'));
  const deploy = readFileSync(DEPLOY, 'utf8');
  const remote = deploy.indexOf('policy_target_supported "$staging/probe" core');
  expect(remote).toBeGreaterThan(deploy.indexOf('independence_target_supported "$staging/probe" core'));
  expect(remote).toBeLessThan(deploy.indexOf('ssh $ssh_opts'));
});

test('markers that exist only in comments do not make a target compatible', () => {
  // The same non-blocking review point RW06 carried: a tree that merely mentions the contract in comments is refused.
  const fake = release({
    'src/policy.ts': '// export function dispatchVerdict(facts: unknown, contract: unknown) {}\nexport const OTHER = 1;\n',
    'src/policy-store.ts': '// export async function readEffectiveContract(db: unknown) {}\nexport const OTHER = 1;\n',
    'src/core.ts': "// action: 'policy_blocked'\nexport const OTHER = 1;\n",
    'src/workforce.ts': '// async policyDispatchVerdict(taskId: string) {}\nexport const OTHER = 1;\n',
    'src/contracts.ts': '// export interface PolicyPlanInput { policyId: string }\nexport interface T { a: string }\n',
  });
  try {
    expect(guard('policy_target_supported', fake).code).not.toBe(0);
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test('the guard is a plain read-only script: no line writes, installs or restarts anything', () => {
  const commands = readFileSync(GUARD, 'utf8').split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  for (const line of commands) {
    expect(line, `side effect in guard: ${line}`).not.toMatch(/^(mkdir|rm|ln|cp|mv|launchctl|ssh|scp|sudo)\b/);
  }
});