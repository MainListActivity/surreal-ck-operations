import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { OPS_TOOLS, OpsBroker, type OpsDeps } from '../src/ops/broker.ts';
import {
  DEFAULT_OCI_ROLES, execOciCli, formatOciResult, ociAuditSummary, parseOciRequest, resolveOciConfig,
  type OciControlConfig, type OciRunner,
} from '../src/ops/oci.ts';
import { redactText } from '../src/ops/redact.ts';
import { brokerConfig, FakeCompany, FakeWorld } from './support/ops-world.ts';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRig(options: { hasEnv?: boolean; roles?: string[]; oci?: OciRunner; ociConfig?: OciControlConfig } = {}) {
  const world = new FakeWorld();
  const company = new FakeCompany();
  if (options.hasEnv ?? true) {
    company.env('demo', 'production', brokerConfig(options.roles ? { roles: options.roles } : {}));
  }
  const ociConfig: OciControlConfig = options.ociConfig ?? {
    configFile: '/managed/private/oci/config',
    profile: 'DEFAULT',
    region: 'us-phoenix-1',
    roles: DEFAULT_OCI_ROLES,
  };
  const broker = new OpsBroker({
    core: company.core,
    projects: company.projects as never,
    secretKey: () => Buffer.alloc(32),
    fetch: world.fetch,
    now: world.now,
    oci: options.oci,
    ociConfig: () => ociConfig,
  } satisfies OpsDeps);
  const eng = company.lease('eng-1', 'engineering', 'task-1');
  return { company, broker, eng, ociConfig };
}

describe('ops_oci request parsing & config', () => {
  test('accepts standard OCI CLI argv including -c / --compartment-id / --query / --region', () => {
    const req = parseOciRequest({
      argv: ['network', 'vcn', 'list', '-c', 'ocid1.tenancy.oc1..example', '--region', 'us-phoenix-1', '--query', 'data[].id'],
      timeoutSec: 30,
    });
    expect(req).toEqual({
      argv: ['network', 'vcn', 'list', '-c', 'ocid1.tenancy.oc1..example', '--region', 'us-phoenix-1', '--query', 'data[].id'],
      timeoutSec: 30,
    });
  });

  test('rejects credential, endpoint, debug, interactive, file://, and local config commands', () => {
    const blocked: Array<Record<string, unknown>> = [
      { argv: [] },
      { argv: 'os ns get' },
      { argv: ['os', 'ns', 'get'], extra: 1 },
      { argv: ['os', 'ns', 'get'], timeoutSec: 0 },
      { argv: ['os', 'ns', 'get'], timeoutSec: 91 },
      { argv: ['--config-file', '/Users/y/.oci/config', 'os', 'ns', 'get'] },
      { argv: ['--config-file=/Users/y/.oci/config', 'os', 'ns', 'get'] },
      { argv: ['--profile', 'ADMIN', 'os', 'ns', 'get'] },
      { argv: ['--profile=ADMIN', 'os', 'ns', 'get'] },
      { argv: ['--auth', 'security_token', 'os', 'ns', 'get'] },
      { argv: ['--auth-purpose', 'x', 'os', 'ns', 'get'] },
      { argv: ['--cli-rc-file', '/tmp/rc', 'os', 'ns', 'get'] },
      { argv: ['--defaults-file', '/tmp/rc', 'os', 'ns', 'get'] },
      { argv: ['--cert-bundle', '/tmp/ca.pem', 'os', 'ns', 'get'] },
      { argv: ['--endpoint', 'https://evil.example', 'os', 'ns', 'get'] },
      { argv: ['--federation-endpoint', 'https://evil.example', 'os', 'ns', 'get'] },
      { argv: ['--debug', 'os', 'ns', 'get'] },
      { argv: ['--interactive'] },
      { argv: ['-i', 'os', 'ns', 'get'] },
      { argv: ['setup', 'config'] },
      { argv: ['session', 'authenticate'] },
      { argv: ['os', 'bucket', 'get', '--from-json', 'file:///Users/y/.oci/config'] },
      { argv: ['os', 'ns', 'get', 'bad\0arg'] },
    ];
    for (const args of blocked) {
      expect(() => parseOciRequest(args), JSON.stringify(args)).toThrow();
    }
  });

  test('resolveOciConfig defaults to <serviceHome>/private/oci/config and never falls back to ~/.oci/config', () => {
    const cfg = resolveOciConfig('/srv/company', {});
    expect(cfg).toEqual({
      configFile: '/srv/company/private/oci/config',
      profile: 'DEFAULT',
      roles: DEFAULT_OCI_ROLES,
    });
    const custom = resolveOciConfig('/srv/company', {
      SCK_OPS_OCI_CONFIG_FILE: '/opt/sck/oci.conf',
      SCK_OPS_OCI_PROFILE: 'AGENT_MIN',
      SCK_OPS_OCI_BIN: '/opt/homebrew/bin/oci',
      SCK_OPS_OCI_REGION: 'us-phoenix-1',
      SCK_OPS_OCI_ROLES: 'engineering, qa',
    });
    expect(custom).toEqual({
      configFile: '/opt/sck/oci.conf',
      profile: 'AGENT_MIN',
      bin: '/opt/homebrew/bin/oci',
      region: 'us-phoenix-1',
      roles: ['engineering', 'qa'],
    });
  });

  test('audit summary records only command verbs and argument count, never flag values', () => {
    expect(ociAuditSummary(['network', 'public-ip', 'create', '--compartment-id', 'ocid1.secret'])).toBe('network public-ip create (argc=5)');
    expect(ociAuditSummary(['--version'])).toBe('(flags) (argc=1)');
  });
});

describe('ops_oci redaction and formatting', () => {
  test('redacts PEM private keys and tokens inside stdout/stderr and parses valid JSON into data', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtokenpayload\n-----END RSA PRIVATE KEY-----';
    expect(redactText(`leak ${pem} done`)).toBe('leak [redacted] done');

    const jsonOut = formatOciResult({
      exitCode: 0,
      stdout: JSON.stringify({ data: { namespace: 'ax123', api_key: 'super-secret-value', raw: pem } }),
      stderr: 'Bearer verysecrettoken12345',
      durationMs: 88,
    });
    expect(jsonOut.ok).toBe(true);
    expect(jsonOut.exitCode).toBe(0);
    expect(jsonOut.stdout).toBeUndefined();
    expect(jsonOut.data).toEqual({ data: { namespace: 'ax123', api_key: '[redacted]', raw: '[redacted]' } });
    expect(jsonOut.stderr).toBe('Bearer [redacted]');
    expect(jsonOut.truncated).toBe(false);
  });

  test('returns plain stdout for non-JSON output and flags truncation when over budget', () => {
    const huge = 'x'.repeat(50_000);
    const out = formatOciResult({ exitCode: 0, stdout: huge, stderr: '', durationMs: 12 });
    expect(out.ok).toBe(true);
    expect(out.data).toBeUndefined();
    expect(out.truncated).toBe(true);
    expect(out.stdout).toContain('[truncated ');
  });
});

describe('OpsBroker ops_oci integration', () => {
  test('ops_oci is registered in OPS_TOOLS and runs through broker with lease + audit', async () => {
    expect(OPS_TOOLS).toContain('ops_oci');
    const calls: Array<{ cfg: OciControlConfig; argv: string[]; timeoutSec: number }> = [];
    const { broker, company, eng } = makeRig({
      oci: async (cfg, req) => {
        calls.push({ cfg, argv: req.argv, timeoutSec: req.timeoutSec });
        return { exitCode: 0, stdout: '{"data":"mynamespace"}', stderr: '', durationMs: 42 };
      },
    });
    const res = await broker.call(eng, 'task-1', 'ops_oci', { argv: ['os', 'ns', 'get'] }) as Record<string, unknown>;
    expect(res).toEqual({ ok: true, exitCode: 0, data: { data: 'mynamespace' }, truncated: false, durationMs: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(['os', 'ns', 'get']);
    expect(company.audits.at(-1)).toMatchObject({ action: 'ops_call' });
    expect(company.audits.at(-1)!.evidence).toContain('ops_oci os ns get (argc=3) → exit=0');
  });

  test('works for infrastructure projects without project_env.broker (e.g. sck_company) while still enforcing lease & roles', async () => {
    const { broker, company, eng } = makeRig({
      hasEnv: false,
      oci: async () => ({ exitCode: 0, stdout: '{"data":[]}', stderr: '', durationMs: 15 }),
    });
    const res = await broker.call(eng, 'task-1', 'ops_oci', { argv: ['compute', 'instance', 'list'] }) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ data: [] });

    // Disallowed role is rejected even without project_env.broker.
    const cs = company.lease('cs-1', 'cs', 'task-2');
    await expect(broker.call(cs, 'task-2', 'ops_oci', { argv: ['os', 'ns', 'get'] }))
      .rejects.toMatchObject({ code: 'forbidden' });

    // Ended lease is rejected before running anything.
    company.endLease('eng-1');
    await expect(broker.call(eng, 'task-1', 'ops_oci', { argv: ['os', 'ns', 'get'] }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  test('returns structured non-zero exit from OCI IAM without throwing upstream_error', async () => {
    const { broker, eng } = makeRig({
      oci: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'ServiceError: {"code":"NotAuthorizedOrNotFound","status":404}',
        durationMs: 120,
      }),
    });
    const res = await broker.call(eng, 'task-1', 'ops_oci', { argv: ['compute', 'instance', 'terminate', '--instance-id', 'ocid1.i'] }) as Record<string, unknown>;
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('NotAuthorizedOrNotFound');
  });
});

describe('execOciCli real child-process isolation', () => {
  test('fails closed with not_configured when managed config file is missing', async () => {
    const dir = mkTempDir('sck-oci-missing-');
    await expect(execOciCli({
      configFile: join(dir, 'config'),
      profile: 'DEFAULT',
      roles: DEFAULT_OCI_ROLES,
    }, { argv: ['os', 'ns', 'get'], timeoutSec: 5 })).rejects.toMatchObject({ code: 'not_configured' });
  });

  test('pins --config-file/--profile/--auth api_key and scrubs parent env from child process', async () => {
    const dir = mkTempDir('sck-oci-real-');
    const configFile = join(dir, 'config');
    writeFileSync(configFile, '[AGENT]\nregion=us-phoenix-1\n', { mode: 0o600 });
    const fakeOci = join(dir, 'fake-oci');
    writeFileSync(fakeOci, [
      '#!/usr/bin/env node',
      'const out = {',
      '  argv: process.argv.slice(2),',
      '  home: process.env.HOME,',
      '  leakedOci: process.env.OCI_CLI_KEY_FILE || null,',
      '  leakedSck: process.env.SCK_OPS_CLOUDFLARE_API_TOKEN || null,',
      '};',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n'), { mode: 0o755 });
    chmodSync(fakeOci, 0o755);

    const prevOci = process.env.OCI_CLI_KEY_FILE;
    const prevSck = process.env.SCK_OPS_CLOUDFLARE_API_TOKEN;
    process.env.OCI_CLI_KEY_FILE = '/should/not/leak.pem';
    process.env.SCK_OPS_CLOUDFLARE_API_TOKEN = 'cf-should-not-leak';
    try {
      const out = await execOciCli({
        configFile,
        profile: 'AGENT',
        bin: fakeOci,
        region: 'us-phoenix-1',
        roles: DEFAULT_OCI_ROLES,
      }, { argv: ['os', 'ns', 'get'], timeoutSec: 10 });
      expect(out.exitCode).toBe(0);
      const parsed = JSON.parse(out.stdout) as { argv: string[]; home: string; leakedOci: string | null; leakedSck: string | null };
      expect(parsed.argv).toEqual([
        '--config-file', configFile, '--profile', 'AGENT', '--auth', 'api_key',
        '--region', 'us-phoenix-1', 'os', 'ns', 'get',
      ]);
      expect(parsed.home).toBe(dir);
      expect(parsed.leakedOci).toBeNull();
      expect(parsed.leakedSck).toBeNull();
    } finally {
      if (prevOci === undefined) delete process.env.OCI_CLI_KEY_FILE; else process.env.OCI_CLI_KEY_FILE = prevOci;
      if (prevSck === undefined) delete process.env.SCK_OPS_CLOUDFLARE_API_TOKEN; else process.env.SCK_OPS_CLOUDFLARE_API_TOKEN = prevSck;
    }
  });
});
