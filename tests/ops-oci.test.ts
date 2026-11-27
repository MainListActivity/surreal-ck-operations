import { describe, expect, test } from 'bun:test';
import { CompanyError } from '../src/core-errors.ts';
import { OPS_TOOLS, OpsBroker, type OpsDeps } from '../src/ops/broker.ts';
import {
  DEFAULT_OCI_ROLES, formatOciResult, ociAuditSummary, parseOciRequest, resolveOciRoles, vaultOciRunner,
  type OciRunner,
} from '../src/ops/oci.ts';
import { redactText } from '../src/ops/redact.ts';
import { brokerConfig, FakeCompany, FakeWorld } from './support/ops-world.ts';

function makeRig(options: { hasEnv?: boolean; roles?: string[]; oci?: OciRunner; vault?: OpsDeps['vault'] } = {}) {
  const world = new FakeWorld();
  const company = new FakeCompany();
  if (options.hasEnv ?? true) {
    company.env('demo', 'production', brokerConfig(options.roles ? { roles: options.roles } : {}));
  }
  const broker = new OpsBroker({
    core: company.core,
    projects: company.projects as never,
    secretKey: () => Buffer.alloc(32),
    fetch: world.fetch,
    now: world.now,
    oci: options.oci,
    vault: options.vault,
    ociRoles: () => DEFAULT_OCI_ROLES,
  } satisfies OpsDeps);
  const eng = company.lease('eng-1', 'engineering', 'task-1');
  return { company, broker, eng };
}

describe('ops_oci request parsing & roles', () => {
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

  test('resolveOciRoles defaults to DEFAULT_OCI_ROLES and parses SCK_OPS_OCI_ROLES', () => {
    expect(resolveOciRoles({})).toEqual(DEFAULT_OCI_ROLES);
    expect(resolveOciRoles({ SCK_OPS_OCI_ROLES: 'engineering, qa, engineering' })).toEqual(['engineering', 'qa']);
    expect(() => resolveOciRoles({ SCK_OPS_OCI_ROLES: 'not-a-role' })).toThrow();
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

describe('OpsBroker ops_oci vault integration', () => {
  test('ops_oci delegates to sck-vault through OpsBroker with lease + audit', async () => {
    expect(OPS_TOOLS).toContain('ops_oci');
    const seen: Array<{ argv: string[]; timeoutSec?: number }> = [];
    const { broker, company, eng } = makeRig({
      vault: {
        oci: async (argv, timeoutSec) => {
          seen.push({ argv, timeoutSec });
          return { exitCode: 0, stdout: '{"data":"mynamespace"}', stderr: '', durationMs: 42 };
        },
      },
    });
    const res = await broker.call(eng, 'task-1', 'ops_oci', { argv: ['os', 'ns', 'get'], timeoutSec: 20 }) as Record<string, unknown>;
    expect(res).toEqual({ ok: true, exitCode: 0, data: { data: 'mynamespace' }, truncated: false, durationMs: 42 });
    expect(seen).toEqual([{ argv: ['os', 'ns', 'get'], timeoutSec: 20 }]);
    expect(company.audits.at(-1)).toMatchObject({ action: 'ops_call' });
    expect(company.audits.at(-1)!.evidence).toContain('ops_oci os ns get (argc=3) → exit=0');
  });

  test('propagates not_configured when sck-vault has no OCI credentials sealed in Keychain', async () => {
    const runner = vaultOciRunner({
      oci: async () => { throw new CompanyError('not_configured', 'oci 凭据未配置：请运行 sck-vault setup oci'); },
    });
    const { broker, eng } = makeRig({ oci: runner });
    await expect(broker.call(eng, 'task-1', 'ops_oci', { argv: ['os', 'ns', 'get'] }))
      .rejects.toMatchObject({ code: 'not_configured' });
  });

  test('works for infrastructure projects without project_env.broker (e.g. sck_company) while still enforcing lease & roles', async () => {
    const { broker, company, eng } = makeRig({
      hasEnv: false,
      oci: async () => ({ exitCode: 0, stdout: '{"data":[]}', stderr: '', durationMs: 15 }),
    });
    const res = await broker.call(eng, 'task-1', 'ops_oci', { argv: ['compute', 'instance', 'list'] }) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ data: [] });

    const cs = company.lease('cs-1', 'cs', 'task-2');
    await expect(broker.call(cs, 'task-2', 'ops_oci', { argv: ['os', 'ns', 'get'] }))
      .rejects.toMatchObject({ code: 'forbidden' });

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
