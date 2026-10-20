import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';

// Local release gate (SYS01 AC-B). The macOS slow-pipe regression has no hosted runner any more: company-service.sh install must
// refuse a release unless scripts/release-gate.sh recorded a passing run for that commit on the Bun runtime the services run with
// (scripts/bun-runtime.sh: SCK_BUN, then the pinned runtime-bun, then ~/.bun). The Bun on PATH is not that runtime.
const ROOT = join(import.meta.dir, '..');
const SERVICE = join(ROOT, 'scripts/company-service.sh');
const GATE = join(ROOT, 'scripts/release-gate.sh');
const LAUNCHER = join(ROOT, 'scripts/run-service.sh');
const SHA = 'a'.repeat(40);
const PINNED = '1.4.2';
const PATH_BUN = '1.3.11';

// A stand-in Bun: `--version` reports the version; any other call prints which runtime the launcher executed.
function fakeBun(path: string, version: string, label: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n[ "$1" = --version ] && { echo ${version}; exit 0; }\necho ran:${label}\n`);
  chmodSync(path, 0o755);
}

// The gate's first check is `uname -s` (Darwin only). Each run's uname answers `-s` with FAKE_KERNEL (Darwin unless a test sets it) and
// runs the real uname for anything else, so the refusal cases reach their own checks on any host.
function fakeUname(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n[ "$1" = -s ] && { echo "${FAKE_KERNEL:-Darwin}"; exit 0; }\nexec /usr/bin/uname "$@"\n');
  chmodSync(path, 0o755);
}

function serviceHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sck-release-gate-'));
  mkdirSync(join(home, 'private'), { recursive: true });
  mkdirSync(join(home, 'active'), { recursive: true });
  writeFileSync(join(home, 'private', 'service.env'), '');
  fakeBun(join(home, 'runtime-bun', 'bin', 'bun'), PINNED, 'pinned');
  return home;
}

// Every run gets a PATH whose bun reports 1.3.11 and whose uname reports Darwin for -s, an empty SCK_BUN and a HOME without a Bun,
// so only the resolution under test picks a runtime and the scripts' own checks decide each outcome.
function env(home: string, extra: Record<string, string> = {}) {
  const pathBin = join(home, 'path-bin');
  fakeBun(join(pathBin, 'bun'), PATH_BUN, 'path');
  fakeUname(join(pathBin, 'uname'));
  return {
    ...process.env,
    SCK_SERVICE_HOME: home,
    SCK_BUN: '',
    SCK_GITHUB_REPOSITORY: '',
    HOME: join(home, 'user-home'),
    PATH: `${pathBin}:${process.env.PATH ?? ''}`,
    ...extra,
  };
}

function sh(script: string, args: string[], home: string, extra: Record<string, string> = {}) {
  const child = Bun.spawnSync(['sh', script, ...args], { env: env(home, extra), stdout: 'pipe', stderr: 'pipe' });
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
}

function writeRecord(home: string, sha: string, fields: Record<string, unknown>) {
  const dir = join(home, 'gates', 'comm-slow-pipe');
  mkdirSync(dir, { recursive: true });
  const record = { gate: 'comm-slow-pipe', sha, bun: PINNED, platform: 'darwin', result: 'pass', ...fields };
  writeFileSync(join(dir, `${sha}.json`), JSON.stringify(record));
}

test('a release with no gate record is refused by check-gate, which install runs before it switches', () => {
  const home = serviceHome();
  try {
    const run = sh(SERVICE, ['check-gate', SHA], home);
    expect(run.code).toBe(1);
    expect(run.err).toContain('no passing comm-slow-pipe gate');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a passing darwin record for this commit and the pinned runtime opens the gate', () => {
  const home = serviceHome();
  try {
    writeRecord(home, SHA, {});
    const run = sh(SERVICE, ['check-gate', SHA], home);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`gate ok: ${SHA} on bun ${PINNED}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a record made with the Bun on PATH does not open the gate, because the services never run that runtime', () => {
  const home = serviceHome();
  try {
    writeRecord(home, SHA, { bun: PATH_BUN });
    const run = sh(SERVICE, ['check-gate', SHA], home);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`on bun ${PINNED}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed run, another commit, another Bun version or a non-darwin host does not open the gate', () => {
  const home = serviceHome();
  try {
    writeRecord(home, SHA, { result: 'fail' });
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
    rmSync(join(home, 'gates'), { recursive: true, force: true });

    // A record copied from another commit does not open this one: the sha inside must be the one the file is named for.
    writeRecord(home, SHA, {});
    const file = join(home, 'gates', 'comm-slow-pipe', `${SHA}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), sha: 'b'.repeat(40) }));
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
    rmSync(join(home, 'gates'), { recursive: true, force: true });

    writeRecord(home, SHA, { bun: '0.0.0-other' });
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
    rmSync(join(home, 'gates'), { recursive: true, force: true });

    writeRecord(home, SHA, { platform: 'linux' });
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the release gate refuses a relative path, a name that is not a commit sha, and a missing slow-pipe test, each for its own reason', () => {
  const home = serviceHome();
  try {
    const relative = sh(GATE, ['slow-pipe', 'relative/release'], home);
    expect(relative.code).toBe(2);
    expect(relative.err).toContain('Release path must be absolute');

    const notSha = sh(GATE, ['slow-pipe', '/tmp/not-a-sha'], home);
    expect(notSha.code).toBe(2);
    expect(notSha.err).toContain("release dir 'not-a-sha' is not a commit sha");
    const short = sh(GATE, ['slow-pipe', `/tmp/${'a'.repeat(39)}`], home);
    expect(short.code).toBe(2);
    expect(short.err).toContain('is not a 40-character commit sha');

    const noTest = sh(GATE, ['slow-pipe', `/tmp/${SHA}`], home);
    expect(noTest.code).toBe(2);
    expect(noTest.err).toContain('has no tests/comm-slow-pipe.test.ts');

    const unknown = sh(GATE, ['unknown-gate', `/tmp/${SHA}`], home);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown gate: unknown-gate');

    // A refused run writes nothing: the gates directory is created only after every check has passed.
    expect(existsSync(join(home, 'gates'))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the release gate refuses to run off macOS before it looks at the release', () => {
  const home = serviceHome();
  try {
    const run = sh(GATE, ['slow-pipe', `/tmp/${SHA}`], home, { FAKE_KERNEL: 'Linux' });
    expect(run.code).toBe(2);
    expect(run.err).toContain('the slow-pipe gate runs on macOS only');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The gate's own record, end to end: a passing run writes the record check-gate accepts for this commit and runtime, and a red run
// replaces it with a failing record that check-gate refuses. The record step runs /usr/bin/python3, so the test is skipped without it.
test.skipIf(!existsSync('/usr/bin/python3'))('a gate run writes the record check-gate reads: a pass opens the gate, a red run closes it', () => {
  const home = serviceHome();
  try {
    const release = join(home, 'releases', SHA);
    mkdirSync(join(release, 'tests'), { recursive: true });
    writeFileSync(join(release, 'tests', 'comm-slow-pipe.test.ts'), '');
    // Stand-in for `bun test` on the pinned runtime: it exits with FAKE_TEST_RC (0 unless a run sets it) and reports the control mode.
    const pinned = join(home, 'runtime-bun', 'bin', 'bun');
    writeFileSync(pinned, '#!/bin/sh\n[ "$1" = --version ] && { echo 1.4.2; exit 0; }\necho "slow-pipe stand-in, control=${SCK_COMM_CONTROL:-0}"\nexit "${FAKE_TEST_RC:-0}"\n');
    chmodSync(pinned, 0o755);
    const recordFile = join(home, 'gates', 'comm-slow-pipe', `${SHA}.json`);

    const pass = sh(GATE, ['slow-pipe', release], home);
    expect(pass.code).toBe(0);
    expect(pass.out).toContain(`comm-slow-pipe pass for ${SHA} on bun ${PINNED}`);
    expect(readFileSync(join(home, 'gates', 'comm-slow-pipe', `${SHA}.log`), 'utf8')).toContain('control=1');
    expect(JSON.parse(readFileSync(recordFile, 'utf8'))).toMatchObject({ gate: 'comm-slow-pipe', sha: SHA, bun: PINNED, platform: 'darwin', result: 'pass', exitCode: 0 });
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(0);

    const red = sh(GATE, ['slow-pipe', release], home, { FAKE_TEST_RC: '1' });
    expect(red.code).toBe(1);
    expect(JSON.parse(readFileSync(recordFile, 'utf8'))).toMatchObject({ result: 'fail', exitCode: 1 });
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install checks the gate before it points the active release at the new one', () => {
  const script = readFileSync(SERVICE, 'utf8');
  const check = script.indexOf('check_gate "$sha" ||');
  const switchPoint = script.indexOf('ln -s "$release" "$service_home/active.next"');
  expect(check).toBeGreaterThan(0);
  expect(switchPoint).toBeGreaterThan(check);
});

test('the launcher and the gate resolve one runtime: SCK_BUN, then the pinned runtime-bun, then ~/.bun, never PATH', () => {
  const home = serviceHome();
  try {
    // The pinned runtime (1.4.2) is the default: the launcher executes it and the gate records its version.
    expect(sh(LAUNCHER, ['mcp'], home).out).toContain('ran:pinned');
    writeRecord(home, SHA, {});
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(0);

    // SCK_BUN in the environment wins over the pinned runtime, for both.
    const override = join(home, 'override', 'bun');
    fakeBun(override, '9.9.9', 'override');
    expect(sh(LAUNCHER, ['mcp'], home, { SCK_BUN: override }).out).toContain('ran:override');
    writeRecord(home, SHA, { bun: '9.9.9' });
    expect(sh(SERVICE, ['check-gate', SHA], home, { SCK_BUN: override }).out).toContain('on bun 9.9.9');

    // SCK_BUN in private/service.env: the launcher sources that line and the gate reads it, so both pick the same override.
    writeFileSync(join(home, 'private', 'service.env'), `SCK_BUN=${override}\n`);
    expect(sh(LAUNCHER, ['mcp'], home).out).toContain('ran:override');
    expect(sh(SERVICE, ['check-gate', SHA], home).out).toContain('on bun 9.9.9');
    writeFileSync(join(home, 'private', 'service.env'), '');

    // Without the pinned runtime, both fall back to ~/.bun/bin/bun, never to the Bun on PATH.
    rmSync(join(home, 'runtime-bun'), { recursive: true, force: true });
    fakeBun(join(home, 'user-home', '.bun', 'bin', 'bun'), '1.3.11', 'home');
    expect(sh(LAUNCHER, ['mcp'], home).out).toContain('ran:home');
    writeRecord(home, SHA, { bun: '1.3.11' });
    expect(sh(SERVICE, ['check-gate', SHA], home).out).toContain('on bun 1.3.11');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
