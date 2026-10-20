import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CI gate guard (SYS01 review defect 1). A missing space once glued two test paths into one token, so the bridge
// gate silently ran 9 files instead of 11. Every test path a gate script names must be one existing file.
const ROOT = join(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const gates = Object.entries(pkg.scripts).filter(([name, command]) => name.startsWith('test:') && command.startsWith('bun test'));

test('every test file a gate script names is one existing path', () => {
  expect(gates.length).toBeGreaterThan(0);
  for (const [name, command] of gates) {
    for (const token of command.split(/\s+/).filter(part => part.includes('.test.'))) {
      expect(token, `${name}: one path per token`).toMatch(/^tests\/[\w.-]+\.test\.ts$/);
      expect(existsSync(join(ROOT, token)), `${name}: ${token} exists`).toBe(true);
    }
  }
});

test('the bridge gate runs the response budget and ops login suites', () => {
  const tokens = pkg.scripts['test:bridge']!.split(/\s+/);
  expect(tokens).toContain('tests/response-budget.test.ts');
  expect(tokens).toContain('tests/ops-login-transport.test.ts');
});

test('the comm gate runs the client and slow pipe regressions, and CI runs the comm gate', () => {
  const comm = pkg.scripts['test:comm']!;
  for (const file of ['tests/comm-client.test.ts', 'tests/comm-slow-pipe.test.ts', 'tests/ci-gates.test.ts']) expect(comm).toContain(file);
  expect(readFileSync(join(ROOT, '.github/workflows/quality-gate.yml'), 'utf8')).toContain('pnpm test:comm');
});

// SYS01 AC-B: the macOS slow-pipe regression is no longer a hosted paid job. It runs at release time through the local gate, and
// install refuses a release that has no passing record for it. No workflow may name a hosted macOS runner again.
test('no workflow runs on a hosted macOS runner, and the release gate for the slow pipe exists', () => {
  // Every workflow file, not a fixed list: a new file must not name a macOS runner either. Comment lines are skipped, so a note
  // that says "macOS" does not count as a runner label.
  const dir = join(ROOT, '.github/workflows');
  const workflows = readdirSync(dir).filter(file => /\.ya?ml$/.test(file));
  expect(workflows.length).toBeGreaterThan(0);
  for (const workflow of workflows) {
    const jobs = readFileSync(join(dir, workflow), 'utf8').split('\n').filter(line => !line.trimStart().startsWith('#'));
    expect(jobs.join('\n'), `${workflow}: names no macOS runner`).not.toMatch(/macos/i);
  }
  expect(existsSync(join(ROOT, 'scripts/release-gate.sh'))).toBe(true);
  expect(readFileSync(join(ROOT, 'scripts/release-gate.sh'), 'utf8')).toContain('tests/comm-slow-pipe.test.ts');
});

// SYS01 AC-B (review fix): the remote switch to a commit refuses before any step reaches the host, unless the release gate holds a
// passing comm-slow-pipe record for that exact SHA and the Bun version the remote runs.
const deploy = join(ROOT, 'scripts/deploy-mcp-remote.sh');
const deploySha = '0123456789abcdef0123456789abcdef01234567';

// SYS01 AC-B (manager ruling v31, M2): the remote Bun check is run, not only ordered. The real deploy script runs against a sandbox:
// ssh, scp, sudo and the account tools are stubs; the remote home, the deploy key and the product env are sandbox paths (the key is
// never read); the ssh stub ends a run at its first payload step, so nothing reaches the switch.
function runDeploy(sandbox: string, remoteBun: string) {
  const bin = join(sandbox, 'bin');
  const home = join(sandbox, 'home');
  const remote = join(sandbox, 'remote');
  const log = join(sandbox, 'remote.log');
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  mkdirSync(bin);
  mkdirSync(join(home, 'gates/comm-slow-pipe'), { recursive: true });
  writeFileSync(join(home, 'gates/comm-slow-pipe', `${sha}.json`), JSON.stringify({ gate: 'comm-slow-pipe', sha, bun: '1.4.2', platform: 'darwin', result: 'pass' }));
  writeFileSync(join(sandbox, 'product.env'), 'SURREAL_ROOT_USER=stub\nSURREAL_ROOT_PASS=stub\n');
  writeFileSync(join(sandbox, 'deploy.key'), '');
  const remoteBunPath = join(remote, 'runtime-bun/bin/bun');
  mkdirSync(join(remote, 'runtime-bun/bin'), { recursive: true });
  writeFileSync(remoteBunPath, `#!/bin/sh\n[ "$1" = --version ] && echo '${remoteBun}'\nexit 0\n`);
  chmodSync(remoteBunPath, 0o755);
  stub('ssh', `while [ "$1" = -o ]; do shift 2; done\nshift\necho "ssh: $*" >> '${log}'\ncase "$*" in\n  *releases/*) echo 'stub: deploy stopped at the payload step' >&2; exit 255 ;;\nesac\nexec sh -c "$*"`);
  stub('scp', `echo "scp: $*" >> '${log}'`);
  stub('sudo', 'while [ "$1" = -u ]; do shift 2; done\nexec "$@"');
  stub('id', 'exit 0');
  stub('chown', 'exit 0');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SCK_')));
  const result = spawnSync('sh', [deploy, sha], {
    encoding: 'utf8',
    env: {
      ...inherited,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SCK_SERVICE_HOME: home,
      SCK_PRODUCT_ENV: join(sandbox, 'product.env'),
      SCK_DEPLOY_KEY: join(sandbox, 'deploy.key'),
      SCK_REMOTE_HOST: 'deploy-test.invalid',
      SCK_REMOTE_HOME: remote,
    },
  });
  return { status: result.status, stderr: result.stderr, log: existsSync(log) ? readFileSync(log, 'utf8') : '', remote };
}

test('the remote Bun check refuses a runtime that is not the gated version, before any payload upload or switch', () => {
  for (const reported of ['1.3.11', '']) {
    const sandbox = mkdtempSync(join(tmpdir(), 'sck-deploy-bun-'));
    try {
      const run = runDeploy(sandbox, reported);
      expect(run.log, `bun '${reported}': the remote check was reached`).toContain('ssh: sudo bash -s');
      expect(run.status, `bun '${reported}': refused`).not.toBe(0);
      expect(run.stderr, `bun '${reported}': reason`).toContain('refused: remote bun');
      expect(run.log, `bun '${reported}': no payload step`).not.toContain('releases/');
      expect(run.log, `bun '${reported}': no scp`).not.toContain('scp:');
      expect(existsSync(join(run.remote, 'current')), `bun '${reported}': no switch`).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
}, 20_000);

test('a remote runtime of the gated version passes the check and reaches the payload step, without a switch', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sck-deploy-bun-'));
  try {
    const run = runDeploy(sandbox, '1.4.2');
    expect(run.stderr, 'the check passed').not.toContain('refused');
    expect(run.stderr, 'the run stopped at its first payload step').toContain('stub: deploy stopped at the payload step');
    expect(run.log, 'the payload step was reached').toContain('releases/');
    expect(existsSync(join(run.remote, 'current')), 'no switch before the stop').toBe(false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

test('the deploy script checks the release gate before any remote step', () => {
  const lines = readFileSync(deploy, 'utf8').split('\n').filter(line => !line.trimStart().startsWith('#'));
  const gate = lines.findIndex(line => line.startsWith('release_gate_ok "$commit"'));
  const remote = lines.findIndex(line => /(^|[\s|])(ssh|scp)\s/.test(line) || line.includes('ln -sfn') || line.includes('git -C "$repo_root" archive'));
  expect(gate, 'the gate call exists').toBeGreaterThan(-1);
  expect(remote, 'a remote step exists after the gate').toBeGreaterThan(gate);
});

test('the deploy script checks the remote Bun version before any payload upload or switch', () => {
  const lines = readFileSync(deploy, 'utf8').split('\n').filter(line => !line.trimStart().startsWith('#'));
  const compare = lines.findIndex(line => line.includes('actual" = "$bun_version"'));
  const payload = lines.findIndex(line => line.includes('releases/$commit'));
  const switchLink = lines.findIndex(line => line.includes('ln -sfn'));
  expect(compare, 'the remote version comparison exists').toBeGreaterThan(-1);
  expect(compare, 'the comparison precedes the first payload step').toBeLessThan(payload);
  expect(compare, 'the comparison precedes the switch').toBeLessThan(switchLink);
});

test('without a passing record for the SHA and Bun version, the deploy script never reaches ssh or scp', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'sck-deploy-gate-'));
  try {
    mkdirSync(join(sandbox, 'bin'));
    const reached = join(sandbox, 'reached.log');
    for (const tool of ['ssh', 'scp']) {
      writeFileSync(join(sandbox, 'bin', tool), `#!/bin/sh\necho ${tool} >> '${reached}'\nexit 0\n`);
      chmodSync(join(sandbox, 'bin', tool), 0o755);
    }
    const run = (sha: string) => spawnSync('sh', [deploy, sha], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(sandbox, 'bin')}:${process.env.PATH ?? ''}`,
        SCK_SERVICE_HOME: join(sandbox, 'home'),
        SCK_PRODUCT_ENV: join(sandbox, 'missing.env'),
        SCK_REMOTE_HOST: 'deploy-test.invalid',
      },
    });
    const refused = (sha: string, reason: string) => {
      const result = run(sha);
      expect(result.status, `${sha}: refused`).not.toBe(0);
      expect(result.stderr, `${sha}: reason`).toContain(reason);
      expect(existsSync(reached), `${sha}: no remote step ran`).toBe(false);
    };
    const writeRecord = (fields: Record<string, string>) => {
      mkdirSync(join(sandbox, 'home/gates/comm-slow-pipe'), { recursive: true });
      writeFileSync(join(sandbox, 'home/gates/comm-slow-pipe', `${deploySha}.json`), JSON.stringify({ gate: 'comm-slow-pipe', sha: deploySha, bun: '1.4.2', platform: 'darwin', result: 'pass', ...fields }));
    };
    refused('main', 'is not a commit sha');
    refused(deploySha, 'no passing comm-slow-pipe gate');
    const stale: Record<string, string>[] = [{ sha: 'f'.repeat(40) }, { bun: '1.3.11' }, { platform: 'linux' }, { result: 'fail' }];
    for (const fields of stale) {
      writeRecord(fields);
      refused(deploySha, 'no passing comm-slow-pipe gate');
    }
    writeRecord({});
    const passed = run(deploySha);
    expect(passed.stderr).not.toContain('no passing comm-slow-pipe gate');
    expect(passed.stderr).toContain('product env missing');
    expect(existsSync(reached), 'a passing record stops at the local product env check, before any ssh').toBe(false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
