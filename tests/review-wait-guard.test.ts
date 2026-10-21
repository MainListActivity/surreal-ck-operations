import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// RW06 C1: the switch guard refuses a target whose own code does not prove the persistent review-wait contract. The checks run
// against fixture trees; the real entry points are kept in order by the structural assertions at the end (install and remote
// deploy both ask this guard before their first side effect).
const ROOT = join(import.meta.dir, '..');
const GUARD = join(ROOT, 'scripts/review-wait-guard.sh');
const SERVICE = join(ROOT, 'scripts/company-service.sh');
const DEPLOY = join(ROOT, 'scripts/deploy-mcp-remote.sh');

const CAPABILITY = "export const REVIEW_WAIT_PROTOCOL = 'review-wait/1';\n";
const CORE = "LET $restore_phase = IF $source_phase = 'review' THEN 'review' ELSE 'ready' END;\nUPDATE $t SET resume_state = NONE;\n";
const CONTRACTS = 'interface TaskView {\n  resumeState?: string;\n  resumeRole?: string;\n}\n';

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sck-rw06-guard-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

/** A release tree with the contract at the given paths; `omit` drops one file to model an old or incomplete target. */
function release(files: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    'src/mcp/run.ts': 'export {};\n',
    'src/dispatcher/run.ts': 'export {};\n',
    'src/review-wait-capability.ts': CAPABILITY,
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
    for (const [path, body] of Object.entries({ 'src/review-wait-capability.ts': CAPABILITY, 'src/core.ts': CORE, 'src/contracts.ts': CONTRACTS, ...core })) {
      mkdirSync(join(dir, 'plugin', 'server', 'vendor', dirname(path)), { recursive: true });
      writeFileSync(join(dir, 'plugin', 'server', 'vendor', path), body);
    }
  }
  return dir;
}

/** Runs one guard function in a shell, exactly as the scripts source it. */
function guard(fn: string, ...args: string[]): { code: number; out: string } {
  const script = `. "$1/scripts/review-wait-guard.sh"; shift; ${fn} "$@"`;
  const child = Bun.spawnSync(['sh', '-c', script, 'guard-test', ROOT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` };
}

test('a target that carries the contract is supported, and the plugin vendor must carry it too', () => {
  const good = release();
  const goodWithPlugin = withPlugin({});
  const pluginWithoutVendor = withPlugin({}, false);
  try {
    expect(guard('review_wait_target_supported', good).code).toBe(0);
    expect(guard('review_wait_target_supported', goodWithPlugin).code).toBe(0);
    // The plugin surface runs the same core: a shipped plugin without a generated vendor is unknown, so it is refused.
    expect(guard('review_wait_target_supported', pluginWithoutVendor).code).not.toBe(0);
    // Scope `core` is the remote deploy, whose payload is the service core only.
    expect(guard('review_wait_target_supported', pluginWithoutVendor, 'core').code).toBe(0);
  } finally {
    for (const dir of [good, goodWithPlugin, pluginWithoutVendor]) rmSync(dir, { recursive: true, force: true });
  }
});

test('old or incomplete targets are refused: no capability module, the pre-RW06 unlock, missing view fields, unmatched vendor', () => {
  const oldCore = release({ 'src/core.ts': 'UPDATE $child SET state = "ready";\n' });
  const noCapability = release({ 'src/review-wait-capability.ts': '' });
  const noContract = release({ 'src/contracts.ts': 'interface TaskView { state: string }\n' });
  const vendorOld = withPlugin({ 'src/core.ts': 'UPDATE $child SET state = "ready";\n' });
  try {
    for (const dir of [oldCore, noCapability, noContract, vendorOld]) {
      expect(guard('review_wait_target_supported', dir).code).not.toBe(0);
    }
    // The refusal says why, names the target, and never claims that nothing is waiting.
    const message = guard('review_wait_refuse', oldCore).out;
    expect(message).toContain('refused:');
    expect(message).toContain('review-wait');
    expect(message).toContain(`target=${oldCore}`);
    expect(message).toContain('waiting items=unknown');
  } finally {
    for (const dir of [oldCore, noCapability, noContract, vendorOld]) rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard rejects on capability alone: no task rows are read, so a zero-row state or a concurrent defer cannot open it', () => {
  const source = readFileSync(GUARD, 'utf8');
  // No database access of any kind in the guard: the decision cannot depend on how many tasks are waiting at check time.
  expect(source).not.toMatch(/surrealdb|surreal |psql|sqlite|SELECT /i);
  expect(source).toContain('no authorised read seam');
  // It is sourced by both switch entry points before their first side effect.
  const service = readFileSync(SERVICE, 'utf8');
  expect(service.indexOf('review_wait_target_supported "$release"')).toBeGreaterThan(0);
  expect(service.indexOf('review_wait_target_supported "$release"')).toBeLessThan(service.indexOf('mkdir -p "$service_home/bin"'));
  expect(service.indexOf('review_wait_target_supported "$release"')).toBeLessThan(service.indexOf('ln -s "$release" "$service_home/active.next"'));
  const deploy = readFileSync(DEPLOY, 'utf8');
  expect(deploy.indexOf('review_wait_target_supported "$staging/probe" core')).toBeGreaterThan(0);
  expect(deploy.indexOf('review_wait_target_supported "$staging/probe" core')).toBeLessThan(deploy.indexOf('ssh $ssh_opts'));
});

test('markers that exist only in comments do not make a target compatible', () => {
  // The non-blocking review point: a tree that merely mentions the contract in comments must be refused.
  const fake = release({
    'src/review-wait-capability.ts': '// export const REVIEW_WAIT_PROTOCOL = \'review-wait/1\';\nexport const OTHER = 1;\n',
    'src/core.ts': "// LET $restore_phase = IF $source_phase = 'review' THEN 'review' ELSE 'ready' END;\nexport const X = 1;\n",
    'src/contracts.ts': '// resumeState?: string; // resumeRole?: string\nexport interface T { a: string }\n',
  });
  try {
    expect(guard('review_wait_target_supported', fake).code).not.toBe(0);
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

// SYS02 C2: the acceptance baseline target guard. The fixture carries both the RW06 contract and the SYS02 baseline markers
// because a real target must pass both guards; the old tree has neither acceptance file nor baseline declarations.
const ACCEPTANCE = "export const ACCEPTANCE_BASELINE_VERSION = 1;\n"
  + "export const BASELINE_IDS = { implement: { machine: 'AC-BASE-IMPL-1', human: 'AC-BASE-IMPL-2' } };\n"
  + "export function mergeAcceptanceCriteria(leg: string, custom: unknown[]) { return custom; }\n"
  + "export function isTrustedCodeDeliverable(subject: object) { return true; }\n"
  + "if (trusted) criteria = mergeAcceptanceCriteria(leg, criteria);\n";
const ACCEPTANCE_CORE = "const criteria = mergeAcceptanceCriteria(leg, custom);\nconst trusted = isTrustedCodeDeliverable(subject);\n";
const ACCEPTANCE_DB = "await this.db.query(loadSchema('026-acceptance.surql'));\n// company_meta:acceptance_gate\n";
const ACCEPTANCE_SCHEMA = "DEFINE FIELD IF NOT EXISTS acceptance_criteria ON task TYPE option<array<object>>;\nDEFINE TABLE IF NOT EXISTS acceptance_evidence SCHEMAFULL;\n";

function acceptanceFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'src/review-wait-capability.ts': CAPABILITY, 'src/core.ts': CORE + ACCEPTANCE_CORE, 'src/contracts.ts': CONTRACTS,
    'src/acceptance.ts': ACCEPTANCE, 'src/database.ts': ACCEPTANCE_DB, 'schema/026-acceptance.surql': ACCEPTANCE_SCHEMA,
    ...overrides,
  };
}
function acceptanceTarget(overrides: Record<string, string> = {}, plugin: 'none' | 'vendor' | 'empty' = 'none'): string {
  const dir = tree(acceptanceFiles(overrides));
  if (plugin !== 'none') {
    mkdirSync(join(dir, 'plugin', 'server'), { recursive: true });
    if (plugin === 'vendor') {
      for (const [path, body] of Object.entries(acceptanceFiles())) {
        mkdirSync(join(dir, 'plugin', 'server', 'vendor', dirname(path)), { recursive: true });
        writeFileSync(join(dir, 'plugin', 'server', 'vendor', path), body);
      }
    }
  }
  return dir;
}

test('the SYS02 target guard accepts a content-bound baseline target and refuses old or incomplete ones', () => {
  const full = acceptanceTarget();
  const withVendor = acceptanceTarget({}, 'vendor');
  const emptyPlugin = acceptanceTarget({}, 'empty');
  const old = tree({ 'src/mcp/run.ts': 'export {};\n' });
  const noBaseline = acceptanceTarget({ 'src/acceptance.ts': 'export const OTHER = 1;\n' });
  const commentOnly = acceptanceTarget({
    'src/acceptance.ts': "// export const ACCEPTANCE_BASELINE_VERSION = 1;\n// export function mergeAcceptanceCriteria(leg, custom) {}\n// if (trusted) criteria = mergeAcceptanceCriteria(leg, criteria);\n",
  });
  const vendorOld = acceptanceTarget({});
  mkdirSync(join(vendorOld, 'plugin', 'server', 'vendor', 'src'), { recursive: true });
  writeFileSync(join(vendorOld, 'plugin', 'server', 'vendor', 'src', 'acceptance.ts'), 'export const OTHER = 1;\n');
  try {
    expect(guard('acceptance_target_supported', full).code).toBe(0);
    expect(guard('acceptance_target_supported', withVendor).code).toBe(0);
    expect(guard('acceptance_target_supported', emptyPlugin, 'core').code).toBe(0);
    expect(guard('acceptance_target_supported', emptyPlugin).code).not.toBe(0);
    for (const dir of [old, noBaseline, commentOnly, vendorOld]) {
      expect(guard('acceptance_target_supported', dir).code, dir).not.toBe(0);
    }
    const message = guard('acceptance_refuse', old).out;
    expect(message).toContain('refused:');
    expect(message).toContain('SYS02');
    expect(message).toContain('row counts are not a safety proof');
  } finally {
    for (const dir of [full, withVendor, emptyPlugin, old, noBaseline, commentOnly, vendorOld]) rmSync(dir, { recursive: true, force: true });
  }
});

test('both switch entry points ask the SYS02 target guard before their first side effect', () => {
  const service = readFileSync(SERVICE, 'utf8');
  expect(service.indexOf('acceptance_target_supported "$release"')).toBeGreaterThan(0);
  expect(service.indexOf('acceptance_target_supported "$release"')).toBeGreaterThan(service.indexOf('release_matches_commit "$release" "$sha" "$ops_repo"'));
  expect(service.indexOf('acceptance_target_supported "$release"')).toBeLessThan(service.indexOf('mkdir -p "$service_home/bin"'));
  expect(service.indexOf('acceptance_target_supported "$release"')).toBeLessThan(service.indexOf('ln -s "$release" "$service_home/active.next"'));
  const deploy = readFileSync(DEPLOY, 'utf8');
  expect(deploy.indexOf('acceptance_target_supported "$staging/probe" core')).toBeGreaterThan(0);
  expect(deploy.indexOf('acceptance_target_supported "$staging/probe" core')).toBeLessThan(deploy.indexOf('ssh $ssh_opts'));
});
