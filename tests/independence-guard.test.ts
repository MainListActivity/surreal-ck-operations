import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// IR06 C1: the switch guard refuses a target whose own code does not prove the source-contributor dynamic avoidance.
// The checks run against fixture trees; the real entry points are kept in order by the structural assertions at the end
// (install and remote deploy both ask this guard, after the RW06 guard and before their first side effect).
const ROOT = join(import.meta.dir, '..');
const GUARD = join(ROOT, 'scripts/independence-guard.sh');
const SERVICE = join(ROOT, 'scripts/company-service.sh');
const DEPLOY = join(ROOT, 'scripts/deploy-mcp-remote.sh');

/** The independence contract the guard requires: the protocol constant, the source guard and the gate, the two views. */
const MODULE = 'export const INDEPENDENCE_LIMITS = { sources: 20, excluded: 100 } as const;\n';
const CORE = 'const INDEPENDENCE_GUARD_SQL = `FOR $g IN $indep_guards`;\nclass Core {\n  private async independenceGate(taskId: string) { return taskId; }\n}\n';
const CONTRACTS = 'export interface IndependencePolicy { schema: 1 }\nexport interface IdentityPrincipalView { id: string }\n';

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sck-ir06-guard-'));
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
    'src/independence.ts': MODULE,
    'src/core.ts': CORE,
    'src/contracts.ts': CONTRACTS,
  };
  for (const [path, body] of Object.entries(files)) base[path] = body;
  return tree(base);
}

function withPlugin(core: Record<string, string>, vendor = true): string {
  const dir = release(core);
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  if (vendor) {
    for (const [path, body] of Object.entries({ 'src/independence.ts': MODULE, 'src/core.ts': CORE, 'src/contracts.ts': CONTRACTS, ...core })) {
      mkdirSync(join(dir, 'plugin', 'server', 'vendor', dirname(path)), { recursive: true });
      writeFileSync(join(dir, 'plugin', 'server', 'vendor', path), body);
    }
  }
  return dir;
}

/** Runs one guard function in a shell, exactly as the scripts source it. */
function guard(fn: string, ...args: string[]): { code: number; out: string } {
  const script = `. "$1/scripts/independence-guard.sh"; shift; ${fn} "$@"`;
  const child = Bun.spawnSync(['sh', '-c', script, 'guard-test', ROOT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` };
}

test('a target that carries the contract is supported, and the plugin vendor must carry it too', () => {
  const good = release();
  const goodWithPlugin = withPlugin({});
  const pluginWithoutVendor = withPlugin({}, false);
  try {
    expect(guard('independence_target_supported', good).code).toBe(0);
    expect(guard('independence_target_supported', goodWithPlugin).code).toBe(0);
    // The plugin surface runs the same core: a shipped plugin without a generated vendor is unknown, so it is refused.
    expect(guard('independence_target_supported', pluginWithoutVendor).code).not.toBe(0);
    // Scope `core` is the remote deploy, whose payload is the service core only.
    expect(guard('independence_target_supported', pluginWithoutVendor, 'core').code).toBe(0);
  } finally {
    for (const dir of [good, goodWithPlugin, pluginWithoutVendor]) rmSync(dir, { recursive: true, force: true });
  }
});

test('old or incomplete targets are refused: no module, no source guard, no gate method, missing views, unmatched vendor', () => {
  const noModule = release({ 'src/independence.ts': '' });
  const noGuardSql = release({ 'src/core.ts': 'export const OTHER = 1;\nclass Core {\n  private async independenceGate(t: string) { return t; }\n}\n' });
  const noGate = release({ 'src/core.ts': 'const INDEPENDENCE_GUARD_SQL = `FOR $g IN $indep_guards`;\nexport const X = 1;\n' });
  const noViews = release({ 'src/contracts.ts': 'export interface TaskView { state: string }\n' });
  const vendorOld = withPlugin({});
  try {
    for (const dir of [noModule, noGuardSql, noGate, noViews]) {
      expect(guard('independence_target_supported', dir).code).not.toBe(0);
    }
    // The root carries the contract but its generated vendor does not: the two surfaces drifted, so it is refused.
    writeFileSync(join(vendorOld, 'plugin', 'server', 'vendor', 'src', 'core.ts'), 'export const OTHER = 1;\n');
    expect(guard('independence_target_supported', vendorOld).code).not.toBe(0);
    // The refusal says why, names the target, and never claims that nothing is excluded.
    const message = guard('independence_refuse', noModule).out;
    expect(message).toContain('refused:');
    expect(message).toContain('independence');
    expect(message).toContain(`target=${noModule}`);
    expect(message).toContain('excluded tasks=unknown');
  } finally {
    for (const dir of [noModule, noGuardSql, noGate, noViews, vendorOld]) rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard rejects on capability alone: no task rows are read, so a policy written after the check cannot open it', () => {
  const source = readFileSync(GUARD, 'utf8');
  // No database access of any kind in the guard: the decision cannot depend on how many tasks hold a policy today.
  expect(source).not.toMatch(/surrealdb|surreal |psql|sqlite|SELECT /i);
  expect(source).toContain('no authorised read seam');
  // It is sourced by both switch entry points, after the RW06 guard and before their first side effect.
  const service = readFileSync(SERVICE, 'utf8');
  const install = service.indexOf('independence_target_supported "$release"');
  expect(install).toBeGreaterThan(service.indexOf('review_wait_target_supported "$release"'));
  expect(install).toBeLessThan(service.indexOf('mkdir -p "$service_home/bin"'));
  expect(install).toBeLessThan(service.indexOf('ln -s "$release" "$service_home/active.next"'));
  const deploy = readFileSync(DEPLOY, 'utf8');
  const remote = deploy.indexOf('independence_target_supported "$staging/probe" core');
  expect(remote).toBeGreaterThan(deploy.indexOf('review_wait_target_supported "$staging/probe" core'));
  expect(remote).toBeLessThan(deploy.indexOf('ssh $ssh_opts'));
});

test('markers that exist only in comments do not make a target compatible', () => {
  // The same non-blocking review point RW06 carried: a tree that merely mentions the contract in comments is refused.
  const fake = release({
    'src/independence.ts': '// export const INDEPENDENCE_LIMITS = { sources: 20 } as const;\nexport const OTHER = 1;\n',
    'src/core.ts': '// const INDEPENDENCE_GUARD_SQL = `FOR $g IN $indep_guards`;\nexport const X = 1;\n',
    'src/contracts.ts': '// export interface IndependencePolicy { schema: 1 }\nexport interface T { a: string }\n',
  });
  try {
    expect(guard('independence_target_supported', fake).code).not.toBe(0);
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
