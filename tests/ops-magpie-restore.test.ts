// ops_magpie_route_restore: the controlled plan/apply repair for a missing `group/work` and an
// unsealed supplier username. Every test runs against an isolated providers.json and the fake
// loopback gateway; no model is called and no provider credential is read as a value.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, test } from 'bun:test';
import { OpsBroker } from '../src/ops/broker.ts';
import { sha256 } from '../src/ops/proof-contract.ts';
import { applyMagpieRouteRestore, applyMagpieRouteRestoreRetained, spliceGroup } from '../src/ops/magpie-restore.ts';
import { FakeCompany, FakeWorld, brokerConfig } from './support/ops-world.ts';

const ALIAS = 'MAGPIE';
const PURPOSE = 'magpie route restore test';
const MEMBER = 'sensenova/sn-sensenova-6-8-flash';
const SECRET_VALUE = 'internal-value-that-must-not-leave';
const SEALED_NAME = 'SUPPLIER_MAGPIE_USERNAME';
const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

const baseConfig = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  revision: SECRET_VALUE,
  groups: [{ id: 'group/chat', members: [MEMBER], affinity: 'smart' }],
  providers: [{ id: 'sensenova', routing: 'smart', api_key: '{{SECRET_magpie_config}}' }],
  ...overrides,
}, null, 2) + '\n';

interface Rig {
  world: FakeWorld;
  company: FakeCompany;
  broker: OpsBroker;
  home: string;
  configPath: string;
  journalPath: string;
  qa: string;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  seal: (name: string, value: string) => Promise<void>;
  setSealFailure: (fail: boolean) => void;
  audits: () => string;
}

interface RigOptions {
  config?: string;
  sealed?: string;
  extraAccounts?: string[];
  mode?: number;
  roles?: string[];
  /** Point the broker at a symlink to the real config. */
  linkConfig?: boolean;
  /** Point the broker at a directory instead of a file. */
  directoryConfig?: boolean;
}

function rig(options: RigOptions = {}): Rig {
  const world = new FakeWorld();
  const company = new FakeCompany();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ops-magpie-restore-')));
  homes.push(home);
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const realPath = join(configDir, 'providers.json');
  writeFileSync(realPath, options.config ?? baseConfig(), { mode: options.mode ?? 0o640 });
  let configPath = realPath;
  if (options.linkConfig) {
    const link = join(configDir, 'link.json');
    symlinkSync(realPath, link);
    configPath = link;
  }
  if (options.directoryConfig) configPath = configDir;
  if (options.sealed) company.sealed.set(`demo/production/${SEALED_NAME}`, options.sealed);
  company.env('demo', 'production', brokerConfig(options.roles ? { roles: options.roles } : {}), { healthUrl: 'https://app.test/health' });
  let sealFailure = false;
  const seal = async (name: string, value: string) => {
    if (sealFailure) throw new Error('seal unavailable');
    company.sealed.set(`demo/production/${name}`, value);
  };
  const projects = {
    ...company.projects,
    setSecret: async (input: { project: string; env: string; name: string; value: string }) => seal(input.name, input.value),
  };
  const fetch = options.extraAccounts?.length
    ? async (input: string | URL | Request, init?: RequestInit) => {
        const response = await world.fetch(input, init);
        if (String(input).includes('/v1/magpie/quotas') && response.ok) {
          const rows = await response.json() as Array<Record<string, unknown>>;
          return new Response(JSON.stringify([...rows, ...options.extraAccounts!.map(user => ({ ...rows[0], user }))]), {
            status: response.status, headers: { 'content-type': 'application/json' },
          });
        }
        return response;
      }
    : world.fetch;
  const journalPath = join(home, 'magpie-restore', 'journal.json');
  const broker = new OpsBroker({
    core: company.core, projects: projects as never, secretKey: () => Buffer.alloc(32),
    fetch, now: world.now, d1: () => world.d1, queryAsUser: world.queryAsUser, browser: world.browser,
    serviceHome: home, sleep: async (ms) => { world.clock += ms; },
    magpie: { base: world.magpie.base, endpointSource: 'injected', readProviders: async () => readFileSync(configPath, 'utf8'), configPath, journalPath },
  });
  return {
    world, company, broker, home, configPath, journalPath, fetch, seal,
    qa: company.lease('qa-1', 'qa', 'task-1'),
    setSealFailure: (fail: boolean) => { sealFailure = fail; },
    audits: () => JSON.stringify(company.audits),
  };
}

const call = (r: Rig, args: Record<string, unknown>) => r.broker.call(r.qa, 'task-1', 'ops_magpie_route_restore', args) as Promise<Record<string, any>>;
const plan = (r: Rig) => call(r, { mode: 'plan', alias: ALIAS, purpose: PURPOSE });
const key = (label: string) => `${label}-${Math.random().toString(36).slice(2, 12)}`;

/** The io the broker would build for the retained (unreleased) implementation. */
const retainedIo = (r: Rig) => ({
  project: 'demo', env: 'production', taskId: 'task-1', alias: ALIAS, purpose: PURPOSE,
  readSealed: async (name: string) => r.company.sealed.get(`demo/production/${name}`),
  fetch: r.fetch, now: r.world.now,
  evidenceDir: join(r.home, 'evidence'),
  journalPath: r.journalPath, configPath: r.configPath,
  readProviders: async () => readFileSync(r.configPath, 'utf8'),
  base: r.world.magpie.base, endpointSource: 'injected' as const,
  sealUsername: (name: string, value: string) => r.seal(name, value),
});

/**
 * Apply tests exercise the retained implementation directly: the broker and the published entry
 * refuse apply in this release (covered by the `apply is closed` suite).
 */
async function apply(r: Rig, planned: Record<string, any>, overrides: Record<string, unknown> = {}) {
  return applyMagpieRouteRestoreRetained({
    ...retainedIo(r),
    planDigest: planned.planDigest, planIssuedAt: planned.issuedAt,
    expectedConfigSha256: planned.config.sha256,
    accountHash: planned.proposedAccount?.accountHash ?? planned.accounts[0]?.accountHash,
    members: [MEMBER],
    idempotencyKey: key('restore'),
    ...overrides,
  }) as Promise<Record<string, any>>;
}

async function failure(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try { await promise; throw new Error('expected the call to fail'); } catch (error) { return error as { code?: string; message: string }; }
}

const listBackups = (r: Rig) => readdirSync(join(r.home, 'config')).filter(name => name.startsWith('providers.json.bak-'));

function leaks(haystack: string): string[] {
  return ['snv-magpie-account', '{{SECRET', SECRET_VALUE, 'api_key', 'second-account'].filter(needle => haystack.includes(needle));
}

describe('plan', () => {
  test('reports the missing group, the unsealed binding and same-provider candidates without leaking a secret', async () => {
    const r = rig();
    const out = await plan(r);
    expect(out.mode).toBe('plan');
    expect(out.config.groupPresent).toBe(false);
    expect(out.binding.status).toBe('missing');
    expect(out.accounts).toHaveLength(1);
    expect(String(out.accounts[0].accountRef).startsWith('mgp')).toBe(true);
    expect(out.proposedAccount).toEqual({ accountHash: out.accounts[0].accountHash, provider: 'sensenova' });
    expect(out.candidates.provider).toBe('sensenova');
    expect(out.candidates.models).toEqual([MEMBER]);
    expect(out.groups).toEqual([{ id: 'group/chat', memberCount: 1 }]);
    expect(out.providers).toEqual([{ id: 'sensenova', routing: 'smart' }]);
    expect(out.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(out.expiresAt) - Date.parse(out.issuedAt)).toBe(15 * 60_000);
    expect(out.gatewayReload).toBe('unknown');
    expect(out.writeAvailable).toBe(false);
    expect(out.notes.join(' ')).toContain('read-only plan');
    expect(leaks(JSON.stringify(out))).toEqual([]);
    expect(r.company.audits.at(-1)?.action).toBe('ops_magpie_restore');
    expect(leaks(r.audits())).toEqual([]);
  });

  test('never proposes a member for another provider and never lists unsafe group ids', async () => {
    const r = rig({ config: baseConfig({ groups: [{ id: 'not safe/id' }, { id: 'group/chat', members: [MEMBER] }] }) });
    r.world.magpie.groupMembers = [MEMBER, 'other/other-model'];
    const out = await plan(r);
    expect(out.unsafeGroupIds).toBe(1);
    expect(out.groups.map((row: any) => row.id)).toEqual(['group/chat']);
    expect(out.candidates.models).toEqual([MEMBER]);
    expect(JSON.stringify(out)).not.toContain('other-model');
  });

  test('does not guess an account when the gateway reports several and none is bound', async () => {
    const r = rig({ extraAccounts: ['second-account'] });
    const out = await plan(r);
    expect(out.accounts).toHaveLength(2);
    expect(out.proposedAccount).toBeUndefined();
    expect(out.candidates).toBeUndefined();
    expect(out.binding.status).toBe('missing');
    expect(leaks(JSON.stringify(out))).toEqual([]);
  });
});

describe('apply', () => {
  test('appends only the missing group, keeps every other byte, seals the username and samples', async () => {
    const r = rig();
    const before = readFileSync(r.configPath, 'utf8');
    const planned = await plan(r);
    const out = await apply(r, planned);
    expect(out.status).toBe('applied');
    expect(out.groupOperation).toBe('created');
    expect(out.bindingOperation).toBe('sealed');
    expect(out.config.sha256After).not.toBe(out.config.sha256Before);
    expect(out.sampled.status).toBe('sampled');
    expect(out.sampled.routeDigest).toMatch(/^[0-9a-f]{64}$/);

    const after = readFileSync(r.configPath, 'utf8');
    expect(after).toContain('"id":"group/work"');
    expect(after).toContain(SECRET_VALUE);
    expect(after).toContain('{{SECRET_magpie_config}}');
    const beforeData = JSON.parse(before);
    const afterData = JSON.parse(after);
    const withoutWork = afterData.groups.filter((row: any) => row.id !== 'group/work');
    expect(withoutWork).toEqual(beforeData.groups);
    expect({ ...afterData, groups: withoutWork }).toEqual(beforeData);
    expect(afterData.groups.find((row: any) => row.id === 'group/work')).toEqual({ id: 'group/work', members: [MEMBER] });
    expect(statSync(r.configPath).mode & 0o777).toBe(0o640);

    const backups = listBackups(r);
    expect(backups).toHaveLength(1);
    expect(statSync(join(r.home, 'config', backups[0]!)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(r.home, 'config', backups[0]!), 'utf8')).toBe(before);
    expect(r.company.sealed.get(`demo/production/${SEALED_NAME}`)).toBe('snv-magpie-account');

    const journal = readFileSync(r.journalPath, 'utf8');
    expect(Object.values(JSON.parse(journal).entries as Record<string, { phase: string }>)[0]!.phase).toBe('done');
    expect(leaks(JSON.stringify(out))).toEqual([]);
    expect(leaks(r.audits())).toEqual([]);
    expect(leaks(journal)).toEqual([]);
  });

  test('an identical existing group and a matched binding are a no-op', async () => {
    const config = baseConfig({ groups: [{ id: 'group/work', members: [MEMBER], affinity: 'smart' }] });
    const r = rig({ config, sealed: 'snv-magpie-account' });
    const planned = await plan(r);
    expect(planned.config.groupPresent).toBe(true);
    expect(planned.binding.status).toBe('matched');
    const before = readFileSync(r.configPath, 'utf8');
    const out = await apply(r, planned);
    expect(out.status).toBe('unchanged');
    expect(out.groupOperation).toBe('unchanged');
    expect(out.bindingOperation).toBe('already-bound');
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    expect(listBackups(r)).toHaveLength(0);
  });

  test('an existing group with different members is refused and never modified', async () => {
    const config = baseConfig({ groups: [{ id: 'group/work', members: ['sensenova/other-model'], affinity: 'smart' }] });
    const r = rig({ config });
    r.world.magpie.groupMembers = [MEMBER, 'sensenova/other-model'];
    const before = readFileSync(r.configPath, 'utf8');
    const planned = await plan(r);
    const out = await apply(r, planned);
    expect(out.status).toBe('refused');
    expect(out.refusal.code).toBe('group-conflict');
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    expect(listBackups(r)).toHaveLength(0);
  });

  test('a mismatched sealed binding is refused before any write', async () => {
    const r = rig({ sealed: 'someone-else' });
    const planned = await plan(r);
    expect(planned.binding.status).toBe('mismatch');
    const before = readFileSync(r.configPath, 'utf8');
    const out = await apply(r, planned);
    expect(out.refusal.code).toBe('binding-mismatch');
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    expect(r.company.sealed.get(`demo/production/${SEALED_NAME}`)).toBe('someone-else');
  });

  test('a matched sealed binding refuses an explicitly selected different account before any write', async () => {
    const r = rig({ sealed: 'snv-magpie-account', extraAccounts: ['second-account'] });
    const planned = await plan(r);
    expect(planned.binding.status).toBe('matched');
    expect(planned.accounts).toHaveLength(2);
    const before = readFileSync(r.configPath, 'utf8');
    const other = planned.accounts.find((account: { accountHash: string }) => account.accountHash !== planned.binding.accountHash)!;
    const out = await apply(r, planned, { accountHash: other.accountHash });
    expect(out.status).toBe('refused');
    expect(out.refusal.code).toBe('binding-mismatch');
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    expect(r.company.sealed.get(`demo/production/${SEALED_NAME}`)).toBe('snv-magpie-account');
    expect(listBackups(r)).toHaveLength(0);
  });

  test('members from another provider are refused', async () => {
    const r = rig();
    r.world.magpie.groupMembers = [MEMBER, 'other/other-model'];
    const before = readFileSync(r.configPath, 'utf8');
    const planned = await plan(r);
    const out = await apply(r, planned, { members: ['other/other-model'] });
    expect(out.refusal.code).toBe('member-unknown');
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    expect(listBackups(r)).toHaveLength(0);
  });

  test('an account hash that matches no gateway account is refused', async () => {
    const r = rig();
    const planned = await plan(r);
    const out = await apply(r, planned, { accountHash: 'a'.repeat(24) });
    expect(out.refusal.code).toBe('account-ambiguous');
  });
});

describe('plan bounds and drift', () => {
  test('an expired plan is refused', async () => {
    const r = rig();
    const planned = await plan(r);
    r.world.clock += 16 * 60_000;
    const out = await apply(r, planned);
    expect(out.refusal.code).toBe('plan-expired');
  });

  test('a config changed after the plan is refused without touching the newer file', async () => {
    const r = rig();
    const planned = await plan(r);
    const thirdParty = baseConfig({ revision: 'third-party-edit' });
    writeFileSync(r.configPath, thirdParty);
    const out = await apply(r, planned);
    expect(out.refusal.code).toBe('plan-drifted');
    expect(readFileSync(r.configPath, 'utf8')).toBe(thirdParty);
    expect(listBackups(r)).toHaveLength(0);
  });

  test('a seam that disagrees with the file is refused rather than trusted', async () => {
    const r = rig();
    const planned = await plan(r);
    const stale = readFileSync(r.configPath, 'utf8');
    const thirdParty = baseConfig({ revision: 'third-party-edit' });
    writeFileSync(r.configPath, thirdParty);
    const error = await failure(applyMagpieRouteRestoreRetained({
      ...retainedIo(r), readProviders: async () => stale,
      planDigest: planned.planDigest, planIssuedAt: planned.issuedAt, expectedConfigSha256: planned.config.sha256,
      accountHash: planned.accounts[0].accountHash, members: [MEMBER], idempotencyKey: 'seam-mismatch-1',
    }));
    expect(error.code).toBe('conflict');
    expect(readFileSync(r.configPath, 'utf8')).toBe(thirdParty);
  });

  test('a fresh lock refuses the write and a stale lock is reclaimed', async () => {
    const r = rig();
    const planned = await plan(r);
    mkdirSync(join(r.home, 'magpie-restore'), { recursive: true });
    writeFileSync(`${r.journalPath}.lock`, 'held');
    const before = readFileSync(r.configPath, 'utf8');
    const refused = await failure(apply(r, planned));
    expect(refused.code).toBe('conflict');
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    utimesSync(`${r.journalPath}.lock`, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const out = await apply(r, planned);
    expect(out.status).toBe('applied');
    expect(readFileSync(r.configPath, 'utf8')).not.toBe(before);
  });

  test('config file guards: symlink, directory and oversize are refused', async () => {
    const linked = rig({ linkConfig: true });
    const before = readFileSync(join(linked.home, 'config', 'providers.json'), 'utf8');
    const linkedError = await failure(plan(linked));
    expect(linkedError.code).toBe('invalid');
    expect(readFileSync(join(linked.home, 'config', 'providers.json'), 'utf8')).toBe(before);

    const directory = rig({ directoryConfig: true });
    expect((await failure(plan(directory))).code).toBe('invalid');

    const oversized = rig({ config: JSON.stringify({ groups: [], padding: 'x'.repeat(300 * 1024) }) });
    expect((await failure(plan(oversized))).code).toBe('invalid');
  });
});

describe('idempotency and recovery', () => {
  test('the same key and plan replay without writing or re-sealing', async () => {
    const r = rig();
    const planned = await plan(r);
    const id = 'replay-key-0001';
    const first = await apply(r, planned, { idempotencyKey: id });
    expect(first.status).toBe('applied');
    const afterFirst = readFileSync(r.configPath, 'utf8');
    const backups = listBackups(r).length;
    const sealedAfterFirst = r.company.sealed.get(`demo/production/${SEALED_NAME}`);

    const second = await apply(r, planned, { idempotencyKey: id });
    expect(second.status).toBe('unchanged');
    expect(second.replayed).toBe(true);
    expect(second.config.sha256After).toBe(first.config.sha256After);
    expect(readFileSync(r.configPath, 'utf8')).toBe(afterFirst);
    expect(listBackups(r)).toHaveLength(backups);
    expect(r.company.sealed.get(`demo/production/${SEALED_NAME}`)).toBe(sealedAfterFirst);
  });

  test('the same key replays an unchanged done entry after plan expiry', async () => {
    const config = baseConfig({ groups: [{ id: 'group/work', members: [MEMBER], affinity: 'smart' }] });
    const r = rig({ config, sealed: 'snv-magpie-account' });
    const planned = await plan(r);
    const id = 'replay-expired-0001';
    const first = await apply(r, planned, { idempotencyKey: id });
    expect(first.status).toBe('unchanged');
    expect(listBackups(r)).toHaveLength(0);

    r.world.advance(16 * 60_000);
    const replay = await apply(r, planned, { idempotencyKey: id });
    expect(replay.status).toBe('unchanged');
    expect(replay.replayed).toBe(true);
    expect(replay.backupFile).toBeNull();
    expect(listBackups(r)).toHaveLength(0);
  });

  test('the same key replays an unchanged done entry after quota readAt drift', async () => {
    const config = baseConfig({ groups: [{ id: 'group/work', members: [MEMBER], affinity: 'smart' }] });
    const r = rig({ config, sealed: 'snv-magpie-account' });
    const planned = await plan(r);
    const id = 'replay-quota-drift-0001';
    const first = await apply(r, planned, { idempotencyKey: id });
    expect(first.status).toBe('unchanged');
    r.world.magpie.quotaReadAtSkewMs = 1_000;

    const replay = await apply(r, planned, { idempotencyKey: id });
    expect(replay.status).toBe('unchanged');
    expect(replay.replayed).toBe(true);
    expect(replay.backupFile).toBeNull();
    expect(listBackups(r)).toHaveLength(0);
  });

  test('a completed replay refuses a config that differs from the recorded result', async () => {
    const config = baseConfig({ groups: [{ id: 'group/work', members: [MEMBER], affinity: 'smart' }] });
    const r = rig({ config, sealed: 'snv-magpie-account' });
    const planned = await plan(r);
    const id = 'replay-config-drift-0001';
    const first = await apply(r, planned, { idempotencyKey: id });
    expect(first.status).toBe('unchanged');
    const thirdParty = baseConfig({ revision: 'third-party-edit', groups: [{ id: 'group/work', members: [MEMBER], affinity: 'smart' }] });
    writeFileSync(r.configPath, thirdParty);

    const replay = await apply(r, planned, { idempotencyKey: id });
    expect(replay.status).toBe('refused');
    expect(replay.refusal.code).toBe('state-drifted');
    expect(readFileSync(r.configPath, 'utf8')).toBe(thirdParty);
    expect(listBackups(r)).toHaveLength(0);
  });

  test('an unchanged done key cannot replay with different members', async () => {
    const alternate = 'sensenova/sensenova-6-8-flash-lite';
    const config = baseConfig({ groups: [{ id: 'group/work', members: [MEMBER], affinity: 'smart' }] });
    const r = rig({ config, sealed: 'snv-magpie-account' });
    r.world.magpie.groupMembers = [MEMBER, alternate];
    const planned = await plan(r);
    const id = 'replay-args-0001';
    const first = await apply(r, planned, { idempotencyKey: id });
    const before = readFileSync(r.configPath, 'utf8');
    const replay = await apply(r, planned, { idempotencyKey: id, members: [alternate] });

    expect(first.status).toBe('unchanged');
    expect(replay.status).toBe('refused');
    expect(replay.refusal.code).toBe('group-conflict');
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    expect(r.company.sealed.get(`demo/production/${SEALED_NAME}`)).toBe('snv-magpie-account');
    expect(listBackups(r)).toHaveLength(0);
  });

  test('the same key with a different plan is refused', async () => {
    const r = rig();
    const planned = await plan(r);
    const id = 'replay-key-0002';
    await apply(r, planned, { idempotencyKey: id });
    const out = await apply(r, planned, { idempotencyKey: id, planDigest: 'b'.repeat(64) });
    expect(out.refusal.code).toBe('idempotency-conflict');
  });

  test('the same key with a different plan issue time is refused', async () => {
    const r = rig();
    const planned = await plan(r);
    const id = 'replay-issued-at-0001';
    await apply(r, planned, { idempotencyKey: id });
    const out = await apply(r, planned, { idempotencyKey: id, planIssuedAt: new Date(Date.parse(planned.issuedAt) + 1).toISOString() });
    expect(out.refusal.code).toBe('idempotency-conflict');
  });

  test('a failed seal restores the config from the backup', async () => {
    const r = rig();
    const before = readFileSync(r.configPath, 'utf8');
    const planned = await plan(r);
    r.setSealFailure(true);
    const out = await apply(r, planned, { idempotencyKey: 'seal-failure-1' });
    expect(out.status).toBe('refused');
    expect(out.refusal.code).toBe('binding-failed');
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    expect(out.config.sha256After).toBe(out.config.sha256Before);
    expect(listBackups(r)).toHaveLength(1);
    expect(r.company.sealed.get(`demo/production/${SEALED_NAME}`)).toBeUndefined();
    const journal = JSON.parse(readFileSync(r.journalPath, 'utf8'));
    expect(Object.values(journal.entries)[0]).toMatchObject({ phase: 'failed' });
    expect(leaks(JSON.stringify(out))).toEqual([]);
  });

  test('a crash after the write is recognised from the journal and finished without rewriting the group', async () => {
    const r = rig();
    const planned = await plan(r);
    const before = readFileSync(r.configPath, 'utf8');
    const groupJson = JSON.stringify({ id: 'group/work', members: [MEMBER] });
    const written = spliceGroup(before, groupJson)!;
    expect(written).not.toBe(before);
    writeFileSync(r.configPath, written);
    const backupName = 'providers.json.bak-crash-1';
    writeFileSync(join(r.home, 'config', backupName), before, { mode: 0o600 });
    const id = 'crash-key-0001';
    const keyHash = sha256(`magpie-restore|${id}`);
    mkdirSync(join(r.home, 'magpie-restore'), { recursive: true });
    writeFileSync(r.journalPath, JSON.stringify({
      version: 1,
      entries: {
        [keyHash]: {
          keyHash, echo: id.slice(0, 8), planDigest: planned.planDigest, planIssuedAt: planned.issuedAt,
          phase: 'started', expectedConfigSha256: planned.config.sha256, accountHash24: planned.accounts[0].accountHash.slice(0, 24),
          backupFile: backupName, insertedGroup: groupJson, at: planned.issuedAt, updatedAt: planned.issuedAt,
        },
      },
    }, null, 2));

    const out = await apply(r, planned, { idempotencyKey: id });
    expect(out.status).toBe('applied');
    // The group exists because this key wrote it before the interruption: never presented as a no-write unchanged.
    expect(out.groupOperation).toBe('created');
    expect(out.recovered).toBe(true);
    expect(out.backupFile).toBe(backupName);
    expect(out.phases.map((item: any) => item.phase)).toEqual(expect.arrayContaining(['recovery-verified', 'recovery-completed']));
    expect(readFileSync(r.configPath, 'utf8')).toBe(written);
    expect(JSON.parse(readFileSync(r.configPath, 'utf8')).groups.filter((row: any) => row.id === 'group/work')).toHaveLength(1);
    expect(r.company.sealed.get(`demo/production/${SEALED_NAME}`)).toBe('snv-magpie-account');
    // The completed record keeps the backup pointer instead of overwriting it with null.
    const journal = JSON.parse(readFileSync(r.journalPath, 'utf8'));
    expect(journal.entries[keyHash]).toMatchObject({
      phase: 'done', backupFile: backupName, groupOperation: 'created', recoveredFromInterruptedWrite: true,
    });

    // A later replay of the same key reports the recorded backup and neither rewrites nor re-seals.
    const replay = await apply(r, planned, { idempotencyKey: id });
    expect(replay.status).toBe('unchanged');
    expect(replay.replayed).toBe(true);
    expect(replay.backupFile).toBe(backupName);
    expect(readFileSync(r.configPath, 'utf8')).toBe(written);
  });

  test('a different key cannot adopt an interrupted write as its own', async () => {
    const r = rig();
    const planned = await plan(r);
    const before = readFileSync(r.configPath, 'utf8');
    const groupJson = JSON.stringify({ id: 'group/work', members: [MEMBER] });
    writeFileSync(r.configPath, spliceGroup(before, groupJson)!);

    const out = await apply(r, planned, { idempotencyKey: 'other-key-0001' });
    expect(out.status).toBe('refused');
    expect(out.refusal.code).toBe('plan-drifted');
    expect(r.company.sealed.size).toBe(0);
  });

  test('a refusal with the same started key preserves identity and crash recovery metadata', async () => {
    const r = rig();
    const planned = await plan(r);
    const before = readFileSync(r.configPath, 'utf8');
    const groupJson = JSON.stringify({ id: 'group/work', members: [MEMBER] });
    const written = spliceGroup(before, groupJson)!;
    writeFileSync(r.configPath, written);
    const backupName = 'providers.json.bak-refused-retry-1';
    writeFileSync(join(r.home, 'config', backupName), before, { mode: 0o600 });
    const id = 'recovery-refuse-0001';
    const keyHash = sha256(`magpie-restore|${id}`);
    const started = {
      keyHash, echo: id.slice(0, 8), planDigest: planned.planDigest, planIssuedAt: planned.issuedAt,
      phase: 'started', expectedConfigSha256: planned.config.sha256, accountHash24: planned.accounts[0].accountHash.slice(0, 24),
      backupFile: backupName, insertedGroup: groupJson, groupOperation: 'created', bindingOperation: 'sealed',
      at: planned.issuedAt, updatedAt: planned.issuedAt,
    };
    mkdirSync(join(r.home, 'magpie-restore'), { recursive: true });
    writeFileSync(r.journalPath, JSON.stringify({ version: 1, entries: { [keyHash]: started } }, null, 2));

    const refused = await apply(r, planned, { idempotencyKey: id, planDigest: 'b'.repeat(64) });
    expect(refused.refusal.code).toBe('idempotency-conflict');
    const afterRefusal = JSON.parse(readFileSync(r.journalPath, 'utf8'));
    expect(afterRefusal.entries[keyHash]).toEqual(started);

    const recovered = await apply(r, planned, { idempotencyKey: id });
    expect(recovered.status).toBe('applied');
    expect(recovered.phases.map((item: any) => item.phase)).toContain('recovery-verified');
    expect(readFileSync(r.configPath, 'utf8')).toBe(written);
    expect(r.company.sealed.get(`demo/production/${SEALED_NAME}`)).toBe('snv-magpie-account');
  });

  test('a refusal does not rewrite an existing failed journal identity', async () => {
    const r = rig();
    const planned = await plan(r);
    const id = 'failed-record-0001';
    const keyHash = sha256(`magpie-restore|${id}`);
    const failed = {
      keyHash, echo: id.slice(0, 8), planDigest: planned.planDigest, planIssuedAt: planned.issuedAt,
      phase: 'failed', expectedConfigSha256: planned.config.sha256, accountHash24: planned.accounts[0].accountHash.slice(0, 24),
      backupFile: 'providers.json.bak-prior-failure', insertedGroup: '{"id":"group/work","members":["prior/member"]}',
      configShaAfter: 'd'.repeat(64), groupOperation: 'created', bindingOperation: 'sealed', sampledStatus: 'blocked',
      at: planned.issuedAt, updatedAt: planned.issuedAt,
    };
    mkdirSync(join(r.home, 'magpie-restore'), { recursive: true });
    writeFileSync(r.journalPath, JSON.stringify({ version: 1, entries: { [keyHash]: failed } }, null, 2));

    const out = await apply(r, planned, { idempotencyKey: id, planDigest: 'b'.repeat(64) });
    expect(out.refusal.code).toBe('idempotency-conflict');
    const afterRefusal = JSON.parse(readFileSync(r.journalPath, 'utf8'));
    expect(afterRefusal.entries[keyHash]).toEqual(failed);
  });

  test('plan reports an interrupted apply from the journal', async () => {
    const r = rig();
    const planned = await plan(r);
    const keyHash = sha256('magpie-restore|interrupted-key');
    mkdirSync(join(r.home, 'magpie-restore'), { recursive: true });
    writeFileSync(r.journalPath, JSON.stringify({
      version: 1,
      entries: {
        [keyHash]: {
          keyHash, echo: 'interrup', planDigest: planned.planDigest, planIssuedAt: planned.issuedAt,
          phase: 'started', expectedConfigSha256: 'c'.repeat(64), at: planned.issuedAt, updatedAt: planned.issuedAt,
        },
      },
    }));
    const out = await plan(r);
    expect(out.recovery.interrupted).toHaveLength(1);
    expect(out.recovery.interrupted[0].wroteConfig).toBe(true);
    expect(out.notes.join(' ')).toContain('interrupted');
  });
});

describe('input allowlist', () => {
  test('unknown parameters are rejected for both modes', async () => {
    const r = rig();
    expect((await failure(call(r, { mode: 'plan', alias: ALIAS, purpose: PURPOSE, members: [MEMBER] }))).code).toBe('invalid');
    expect((await failure(call(r, { mode: 'apply', alias: ALIAS, purpose: PURPOSE, extra: 1 }))).code).toBe('invalid');
  });

  test('only the MAGPIE business alias is served', async () => {
    const r = rig();
    expect((await failure(call(r, { mode: 'plan', alias: 'SNV_PROD', purpose: PURPOSE }))).code).toBe('invalid');
  });

  test('an apply without the plan material is refused as unavailable, not invalid', async () => {
    const r = rig();
    expect((await failure(call(r, { mode: 'apply', alias: ALIAS, purpose: PURPOSE }))).code).toBe('not_configured');
  });
});

describe('apply is closed', () => {
  const applyArgs = (planned: Record<string, any>) => ({
    mode: 'apply', alias: ALIAS, purpose: PURPOSE,
    planDigest: planned.planDigest, planIssuedAt: planned.issuedAt,
    expectedConfigSha256: planned.config.sha256,
    accountHash: planned.accounts[0]?.accountHash, members: [MEMBER], idempotencyKey: 'closed-apply-0001',
  });

  test('the broker refuses apply for every role with zero writes', async () => {
    for (const role of ['qa', 'engineering', 'product', 'owner']) {
      const r = rig({ roles: ['qa', 'engineering', 'product', 'owner'] });
      const planned = await plan(r);
      const before = readFileSync(r.configPath, 'utf8');
      const backups = listBackups(r).length;
      const lease = r.company.lease(`role-${role}`, role as never, 'task-1');
      const error = await failure(r.broker.call(lease, 'task-1', 'ops_magpie_route_restore', applyArgs(planned)));
      expect(error.code).toBe('not_configured');
      expect(error.message).toContain('write capability is unavailable');
      expect(readFileSync(r.configPath, 'utf8')).toBe(before);
      expect(listBackups(r)).toHaveLength(backups);
      expect(r.company.sealed.size).toBe(0);
      expect(existsSync(r.journalPath)).toBe(false);
    }
  });

  test('the published underlying entry refuses a direct call before any read or write', async () => {
    const r = rig();
    const planned = await plan(r);
    const before = readFileSync(r.configPath, 'utf8');
    const error = await failure(applyMagpieRouteRestore({
      ...retainedIo(r),
      planDigest: planned.planDigest, planIssuedAt: planned.issuedAt, expectedConfigSha256: planned.config.sha256,
      accountHash: planned.accounts[0].accountHash, members: [MEMBER], idempotencyKey: 'direct-apply-0001',
    }));
    expect(error.code).toBe('not_configured');
    expect((error as { details?: unknown }).details).toMatchObject({ capability: 'magpie_route_restore_apply', writeAvailable: false, gatewayReload: 'unknown' });
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    expect(r.company.sealed.size).toBe(0);
    expect(existsSync(r.journalPath)).toBe(false);
  });

  test('the retained write implementation is not reachable from production code', () => {
    const hits = execFileSync('git', ['grep', '-l', 'applyMagpieRouteRestoreRetained', '--', 'src'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    expect(hits).toEqual(['src/ops/magpie-restore.ts']);
  });
});
