import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';

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

function writeRecord(home: string, sha: string, fields: Record<string, unknown>, gate = 'comm-slow-pipe') {
  const dir = join(home, 'gates', gate);
  mkdirSync(dir, { recursive: true });
  const record = { gate, sha, bun: PINNED, platform: 'darwin', result: 'pass', ...fields };
  writeFileSync(join(dir, `${sha}.json`), JSON.stringify(record));
}

/** Both release gates are required: a release is not installable with only one passing record. */
function writeBoth(home: string, sha: string, fields: Record<string, unknown> = {}) {
  writeRecord(home, sha, fields, 'comm-slow-pipe');
  writeRecord(home, sha, fields, 'sidecar-review');
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

test('check-gate refuses a release with only one of the two required gate records', () => {
  const home = serviceHome();
  try {
    writeRecord(home, SHA, {}, 'comm-slow-pipe');
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
    writeRecord(home, SHA, {}, 'sidecar-review');
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a passing darwin record for this commit and the pinned runtime opens the gate', () => {
  const home = serviceHome();
  try {
    writeBoth(home, SHA);
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
    writeBoth(home, SHA, { bun: PATH_BUN });
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
    writeBoth(home, SHA, { result: 'fail' });
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
    rmSync(join(home, 'gates'), { recursive: true, force: true });

    // A record copied from another commit does not open this one: the sha inside must be the one the file is named for.
    writeBoth(home, SHA);
    const file = join(home, 'gates', 'comm-slow-pipe', `${SHA}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), sha: 'b'.repeat(40) }));
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
    rmSync(join(home, 'gates'), { recursive: true, force: true });

    writeBoth(home, SHA, { bun: '0.0.0-other' });
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
    rmSync(join(home, 'gates'), { recursive: true, force: true });

    writeBoth(home, SHA, { platform: 'linux' });
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
    // Both gates are required for install; this test exercises the slow-pipe record itself.
    writeRecord(home, SHA, {}, 'sidecar-review');
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(0);

    const red = sh(GATE, ['slow-pipe', release], home, { FAKE_TEST_RC: '1' });
    expect(red.code).toBe(1);
    expect(JSON.parse(readFileSync(recordFile, 'utf8'))).toMatchObject({ result: 'fail', exitCode: 1 });
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(!existsSync('/usr/bin/python3'))('a sidecar-review gate run records the fork mode, not the slow-pipe mode', () => {
  const home = serviceHome();
  try {
    const release = join(home, 'releases', SHA);
    mkdirSync(join(release, 'tests'), { recursive: true });
    writeFileSync(join(release, 'tests', 'dispatcher-sidecar.fork.test.ts'), '');
    const pinned = join(home, 'runtime-bun', 'bin', 'bun');
    writeFileSync(pinned, '#!/bin/sh\n[ "$1" = --version ] && { echo 1.4.2; exit 0; }\necho "sidecar stand-in, fork=${RUN_SCK_CHANNEL_FORK_TESTS:-0}"\nexit "${FAKE_TEST_RC:-0}"\n');
    chmodSync(pinned, 0o755);
    const run = sh(GATE, ['sidecar-review', release], home);
    expect(run.code).toBe(0);
    const record = JSON.parse(readFileSync(join(home, 'gates', 'sidecar-review', `${SHA}.json`), 'utf8'));
    expect(record).toMatchObject({ gate: 'sidecar-review', sha: SHA, bun: PINNED, platform: 'darwin', result: 'pass', exitCode: 0 });
    expect(readFileSync(join(home, 'gates', 'sidecar-review', `${SHA}.log`), 'utf8')).toContain('fork=1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install checks the gate before it points the active release at the new one', () => {
  const script = readFileSync(SERVICE, 'utf8');
  const slow = script.indexOf('check_gate comm-slow-pipe "$sha"');
  const review = script.indexOf('check_gate sidecar-review "$sha"');
  const switchPoint = script.indexOf('ln -s "$release" "$service_home/active.next"');
  expect(slow).toBeGreaterThan(0);
  expect(review).toBeGreaterThan(slow);
  expect(switchPoint).toBeGreaterThan(review);
});

test('the launcher and the gate resolve one runtime: SCK_BUN, then the pinned runtime-bun, then ~/.bun, never PATH', () => {
  const home = serviceHome();
  try {
    // The pinned runtime (1.4.2) is the default: the launcher executes it and the gate records its version.
    expect(sh(LAUNCHER, ['mcp'], home).out).toContain('ran:pinned');
    writeBoth(home, SHA);
    expect(sh(SERVICE, ['check-gate', SHA], home).code).toBe(0);

    // SCK_BUN in the environment wins for the launcher, which runs in the caller's environment. The install's check does not read it:
    // launchd does not pass the caller's environment to the services, so the gate checks the runtime they resolve (the pinned one).
    const override = join(home, 'override', 'bun');
    fakeBun(override, '9.9.9', 'override');
    expect(sh(LAUNCHER, ['mcp'], home, { SCK_BUN: override }).out).toContain('ran:override');
    expect(sh(SERVICE, ['check-gate', SHA], home, { SCK_BUN: override }).out).toContain('on bun 1.4.2');

    // SCK_BUN in private/service.env: the launcher sources that line and the gate reads it, so both pick the same override.
    writeBoth(home, SHA, { bun: '9.9.9' });
    writeFileSync(join(home, 'private', 'service.env'), `SCK_BUN="${override}"\n`);
    expect(sh(LAUNCHER, ['mcp'], home).out).toContain('ran:override');
    expect(sh(SERVICE, ['check-gate', SHA], home).out).toContain('on bun 9.9.9');
    writeFileSync(join(home, 'private', 'service.env'), '');

    // Without the pinned runtime, both fall back to ~/.bun/bin/bun, never to the Bun on PATH.
    rmSync(join(home, 'runtime-bun'), { recursive: true, force: true });
    fakeBun(join(home, 'user-home', '.bun', 'bin', 'bun'), '1.3.11', 'home');
    expect(sh(LAUNCHER, ['mcp'], home).out).toContain('ran:home');
    writeBoth(home, SHA, { bun: '1.3.11' });
    expect(sh(SERVICE, ['check-gate', SHA], home).out).toContain('on bun 1.3.11');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an explicit pin that is missing is never replaced by another Bun: the launcher does not run ~/.bun and the gate refuses', () => {
  const home = serviceHome();
  try {
    fakeBun(join(home, 'user-home', '.bun', 'bin', 'bun'), '1.3.11', 'home');
    writeFileSync(join(home, 'private', 'service.env'), `SCK_BUN=${join(home, 'missing', 'bun')}\n`);
    writeBoth(home, SHA, { bun: '1.3.11' });
    expect(sh(LAUNCHER, ['mcp'], home).out).not.toContain('ran:home');
    const check = sh(SERVICE, ['check-gate', SHA], home);
    expect(check.code).not.toBe(0);
    expect(check.out).not.toContain('gate ok');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// SYS01 AC-B, review B2: the gate and the switch are keyed on the release commit, so the directory's *content* must be that
// commit's. A directory merely named after a commit used to be installable; release-content.sh is what install and the gate call.
describe('release content is bound to the commit, not to the directory name', () => {
  const git = (args: string[], options: Parameters<typeof Bun.spawnSync>[1] = {}) =>
    Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe', ...options });

  /** A one-commit ops repo, its sha, and a release directory cut from that commit with `git archive`. */
  function fixture(home: string) {
    const repo = join(home, 'ops-repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    expect(git(['init', '-q', repo]).exitCode).toBe(0);
    writeFileSync(join(repo, 'src', 'core.ts'), 'export const committed = true;\n');
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    git(['-C', repo, 'add', '-A']);
    expect(git(['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'fixture']).exitCode).toBe(0);
    const sha = git(['-C', repo, 'rev-parse', 'HEAD']).stdout!.toString().trim();
    const release = join(home, 'releases', sha);
    mkdirSync(release, { recursive: true });
    const archive = git(['-C', repo, 'archive', '--format=tar', sha]).stdout! as Uint8Array;
    const extracted = Bun.spawnSync(['tar', '-x', '-C', release], { stdin: archive, stdout: 'pipe', stderr: 'pipe' });
    expect(extracted.exitCode).toBe(0);
    return { repo, sha, release };
  }

  /** Runs release_matches_commit in a shell, exactly as the scripts do. */
  function matches(release: string, sha: string, repo: string): number {
    return Bun.spawnSync(['sh', '-c', '. "$1/scripts/release-content.sh"; release_matches_commit "$2" "$3" "$4"',
      'release-content-test', ROOT, release, sha, repo], { stdout: 'pipe', stderr: 'pipe' }).exitCode;
  }

  test('a release cut from the commit matches; generated paths are not part of the comparison', () => {
    const home = serviceHome();
    try {
      const { repo, sha, release } = fixture(home);
      expect(matches(release, sha, repo)).toBe(0);
      // Dependencies, generated vendor, build output and the service runtime dir are added after the archive and never come
      // from the commit. `.runtime/` matters most: it is gitignored, so it exists only in the release copy.
      mkdirSync(join(release, 'node_modules', 'left-pad'), { recursive: true });
      mkdirSync(join(release, 'plugin', 'server', 'vendor'), { recursive: true });
      mkdirSync(join(release, 'vault', 'build'), { recursive: true });
      mkdirSync(join(release, '.runtime'), { recursive: true });
      writeFileSync(join(release, 'plugin', 'server', 'vendor', 'core.ts'), 'generated\n');
      writeFileSync(join(release, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
      writeFileSync(join(release, '.runtime', 'state.json'), '{}\n');
      expect(matches(release, sha, repo)).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a directory named after the commit but holding other content is refused, as is an unknown commit', () => {
    const home = serviceHome();
    try {
      const { repo, sha, release } = fixture(home);
      // The stub case the review reproduced: right name, wrong content, and even an extra file the commit never had.
      writeFileSync(join(release, 'src', 'core.ts'), 'export const committed = false;\n');
      expect(matches(release, sha, repo)).not.toBe(0);
      writeFileSync(join(release, 'src', 'core.ts'), 'export const committed = true;\n');
      writeFileSync(join(release, 'src', 'planted.ts'), 'export const planted = true;\n');
      expect(matches(release, sha, repo)).not.toBe(0);
      rmSync(join(release, 'src', 'planted.ts'));
      expect(matches(release, sha, repo)).toBe(0);
      // A commit the ops repo does not have cannot be verified, so it does not match.
      expect(matches(release, 'b'.repeat(40), repo)).not.toBe(0);
      expect(matches(release, sha, join(home, 'no-such-repo'))).not.toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('install verifies the content against the commit before it switches the active release', () => {
    const script = readFileSync(SERVICE, 'utf8');
    const content = script.indexOf('release_matches_commit "$release" "$sha" "$ops_repo"');
    const switchPoint = script.indexOf('ln -s "$release" "$service_home/active.next"');
    expect(content).toBeGreaterThan(0);
    expect(switchPoint).toBeGreaterThan(content);
    // The gate itself refuses a release whose content is not the commit it would record a pass for.
    expect(readFileSync(GATE, 'utf8')).toContain('release_matches_commit "$release" "$sha" "$gate_ops_repo"');
  });
});
