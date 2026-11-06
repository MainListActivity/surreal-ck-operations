import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { CompanyError } from '../src/core-errors.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { Workforce } from '../src/workforce.ts';
import { PLUGIN_RUNTIME_ROLES, type PluginRuntimeView } from '../src/contracts.ts';

// SYS04: the plugin runtime diagnostics name the release the company service is loaded from, so they are an
// operator fact. gm/product/qa may read them; a general employee may not, and an unauthorized read must
// produce NO diagnostic at all — not a refused one that still touched the filesystem.
//
// The core owns the authorization and the plugin host owns the sampling, so this runs the real core against
// the company fork with real credentials: the check is proven on the real identity path, not on a fake.
const NS = 'sck_agent_company_test_plugin_runtime';
const database = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: NS, database: 'control_plane' });
setDefaultTimeout(180_000);
const credDir = mkdtempSync(join(tmpdir(), 'sck-plugin-runtime-'));
const workforce = new Workforce(database, credDir);
const enrollment = new LocalEnrollmentAdmin(database);
const core = new SurrealCompanyCore(database, { workforce });
const tokens: Record<string, string> = {};

/** A stand-in for the plugin host's sampler: it records that it ran, and reports the plugin host context. */
const sampler = (calls: string[]) => (): PluginRuntimeView => {
  calls.push('sampled');
  return {
    context: 'plugin-host',
    collectedAt: new Date().toISOString(),
    process: { pid: 1, nodeVersion: 'v0.0.0', execPath: '/test/node', bunShim: false },
    loaded: { basis: 'registered-plugin-source', selfPath: '/test/plugin/server/runtime-diagnostics.ts', serverDir: '/test/plugin/server', vendorDir: '/test/plugin/server/vendor', vendorResolvedBy: 'vendor-child-of-server-dir' },
    binding: { kind: 'plugin-server-dir', path: '/test' },
    modules: [{ name: 'core', path: '/test/plugin/server/vendor/src/core.ts', sha256: 'a'.repeat(64), bytes: 1 }],
    notRead: ['private/ (service credentials)'],
  };
};

beforeAll(async () => {
  await database.connect();
  await database.db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
  await database.db.use({ namespace: NS });
  await database.db.query('REMOVE DATABASE IF EXISTS control_plane;');
  await database.bootstrap();
  for (const [name, role, caps] of [
    ['owner', 'owner', ['execute', 'review', 'manage']],
    ['product', 'product', ['execute', 'review', 'manage']],
    ['qa', 'qa', ['review']],
    ['eng', 'engineering', ['execute', 'review']],
    ['cs', 'cs', ['execute', 'review']],
    ['eval', 'eval', ['review']],
  ] as const) tokens[name] = await enrollment.enroll(`t-${name}`, role, caps);
});

afterAll(async () => {
  await database.close();
  rmSync(credDir, { recursive: true, force: true });
});

const failureOf = async (run: Promise<unknown>): Promise<CompanyError> => {
  try { await run; } catch (error) { return error as CompanyError; }
  throw new Error('expected the call to fail');
};

test('gm, product and qa may read the plugin runtime diagnostics, and the sampler runs', async () => {
  for (const who of ['owner', 'product', 'qa']) {
    const calls: string[] = [];
    const view = await core.pluginRuntimeDiagnostics(tokens[who]!, sampler(calls));
    expect([who, view.context]).toEqual([who, 'plugin-host']);
    expect([who, calls]).toEqual([who, ['sampled']]);
    expect([who, view.binding.kind]).toEqual([who, 'plugin-server-dir']);
  }
});

test('the allowed roles are exactly gm, product and qa', async () => {
  // The set is the contract, not a side effect of who happened to be tested.
  expect([...PLUGIN_RUNTIME_ROLES].sort()).toEqual(['owner', 'product', 'qa']);
});

test('an unauthorized role is refused and NO diagnostic is produced', async () => {
  // The sample is the sensitive part: a refusal must arrive before the plugin host is asked to touch the
  // filesystem, so `calls` stays empty for a role that may not read.
  for (const who of ['eng', 'cs', 'eval']) {
    const calls: string[] = [];
    const refusal = await failureOf(core.pluginRuntimeDiagnostics(tokens[who]!, sampler(calls)));
    expect([who, refusal.code]).toEqual([who, 'forbidden']);
    expect([who, calls]).toEqual([who, []]);
  }
});

test('an invalid credential is refused before any sampling', async () => {
  const calls: string[] = [];
  const refusal = await failureOf(core.pluginRuntimeDiagnostics('sck_not-a-real-token', sampler(calls)));
  expect(refusal.code).toBe('unauthorized');
  expect(calls).toEqual([]);
});

test('the refusal names the roles that may read, and leaks nothing about the host', async () => {
  const refusal = await failureOf(core.pluginRuntimeDiagnostics(tokens.cs, sampler([])));
  expect(refusal.message).toContain('gm, product or qa');
  // The message is a role statement, not a runtime fact: it must not name a path or a version.
  expect(refusal.message).not.toContain('/');
  expect(refusal.message).not.toContain('plugin/server');
});
