import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'company-service.sh');
const SHAS = {
  current: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  previous: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  plugin: 'cccccccccccccccccccccccccccccccccccccccc',
  spare: 'dddddddddddddddddddddddddddddddddddddddd',
  old: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  worktree: 'ffffffffffffffffffffffffffffffffffffffff',
  incomplete: '1111111111111111111111111111111111111111',
  symlink: '2222222222222222222222222222222222222222',
  nondir: '3333333333333333333333333333333333333333',
  incompatible: '4444444444444444444444444444444444444444',
} as const;

type Fixture = {
  root: string;
  home: string;
  serviceHome: string;
  releases: string;
  release: string;
  fakeBin: string;
  fakePaseo: string;
  paseoLog: string;
  opsRepo: string;
};

function executable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

// The review-wait contract RW06's switch guard requires (src/review-wait-capability.ts, the restoring unlock in core, and the
// view fields in contracts). A fixture release without it is the "old target" case the guard must refuse.
const REVIEW_WAIT_FILES = {
  'src/review-wait-capability.ts': "export const REVIEW_WAIT_PROTOCOL = 'review-wait/1';\n",
  'src/core.ts': "export const UNLOCK = `\n  LET $restore_phase = IF $source_phase = 'review' THEN 'review' ELSE 'ready' END;\n  UPDATE $t SET resume_state = NONE;\n`;\n",
  'src/contracts.ts': 'export interface TaskView {\n  resumeState?: string;\n  resumeRole?: string;\n}\n',
};

function makeRelease(releases: string, sha: string, withGit = false, capable = true) {
  const dir = join(releases, sha);
  mkdirSync(join(dir, 'src', 'mcp'), { recursive: true });
  mkdirSync(join(dir, 'src', 'dispatcher'), { recursive: true });
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  writeFileSync(join(dir, 'src', 'mcp', 'run.ts'), 'export {};\n');
  writeFileSync(join(dir, 'src', 'dispatcher', 'run.ts'), 'export {};\n');
  if (capable) {
    for (const [path, body] of Object.entries(REVIEW_WAIT_FILES)) writeFileSync(join(dir, path), body);
    // The plugin surface runs the same core; its generated vendor must carry the contract too.
    mkdirSync(join(dir, 'plugin', 'server', 'vendor', 'src'), { recursive: true });
    for (const [path, body] of Object.entries(REVIEW_WAIT_FILES)) {
      writeFileSync(join(dir, 'plugin', 'server', 'vendor', path), body);
    }
  }
  if (withGit) writeFileSync(join(dir, '.git'), 'gitdir: /tmp/company-service-test\n');
  return dir;
}

// The install requires both release records for the SHA on the runtime the services run with (scripts/bun-runtime.sh: the
// pinned runtime-bun under the service home). The fixture pins that runtime and its version, so it does not depend on the host Bun;
// the gate runner itself is covered by tests/release-gate.test.ts.
function writeGateRecord(serviceHome: string, sha: string) {
  for (const gate of ['comm-slow-pipe', 'sidecar-review']) {
    const dir = join(serviceHome, 'gates', gate);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sha}.json`), JSON.stringify({ gate, sha, bun: '1.4.2', platform: 'darwin', result: 'pass' }));
  }
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'sck-company-service-'));
  const home = join(root, 'home with spaces');
  const serviceHome = join(home, 'Library', 'Application Support', 'SurrealCKCompany');
  const releases = join(serviceHome, 'releases');
  const fakeBin = join(root, 'fake bin');
  const paseoLog = join(root, 'paseo.log');
  const opsRepo = join(root, 'ops repo');
  mkdirSync(join(serviceHome, 'private'), { recursive: true });
  mkdirSync(releases, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(opsRepo, '.git'), { recursive: true });
  writeFileSync(join(serviceHome, 'private', 'service.env'), `SCK_AGENT_CWD=${opsRepo}\n`);

  const release = makeRelease(releases, SHAS.current);
  makeRelease(releases, SHAS.previous);
  makeRelease(releases, SHAS.plugin);
  makeRelease(releases, SHAS.spare);
  makeRelease(releases, SHAS.old);
  makeRelease(releases, SHAS.worktree, true);
  mkdirSync(join(releases, SHAS.incomplete, 'plugin'), { recursive: true });
  symlinkSync(join(releases, SHAS.previous), join(releases, SHAS.symlink));
  writeFileSync(join(releases, SHAS.nondir), 'not a directory\n');
  mkdirSync(join(releases, 'plugin-source-not-a-release'), { recursive: true });
  symlinkSync(join(releases, SHAS.previous), join(serviceHome, 'active'));

  const now = Date.now() / 1000;
  utimesSync(join(releases, SHAS.spare), now, now - 10);
  utimesSync(join(releases, SHAS.old), now, now - 20);
  utimesSync(join(releases, SHAS.worktree), now, now - 30);

  // Test stand-in for git. install verifies that a release directory holds the commit it is named after (SYS01 B2,
  // scripts/release-content.sh), so archive/cat-file answer from the fixture release directory for that commit; the ancestry
  // and fetch calls install also makes stay trivial. The mismatch case is covered with a real repository in release-gate.test.ts.
  executable(join(fakeBin, 'git'), [
    '#!/bin/sh',
    'mode=""; sha=""',
    'for arg in "$@"; do case "$arg" in archive|cat-file) mode="$arg";; esac; sha="$arg"; done',
    'sha="${sha%\\^*}"',
    'if [ "$mode" = archive ]; then exec tar -c -C "$FAKE_RELEASES_DIR/$sha" .; fi',
    'if [ "$mode" = cat-file ]; then [ -d "$FAKE_RELEASES_DIR/$sha" ] && exit 0; exit 1; fi',
    'exit 0',
  ].join('\n') + '\n');
  executable(join(fakeBin, 'launchctl'), '#!/bin/sh\ncase "$1" in print) exit 1;; *) exit 0;; esac\n');
  executable(join(fakeBin, 'lsof'), '#!/bin/sh\n[ "${FAKE_LSOF_ERROR:-0}" = 1 ] && exit 2\n[ "${FAKE_LSOF_OPEN:-0}" = 1 ] && { printf \'open\n\'; exit 0; }\nexit 1\n');
  // The pinned runtime the services run with; the Bun on PATH (1.3.11) is a decoy that install must not consult.
  mkdirSync(join(serviceHome, 'runtime-bun', 'bin'), { recursive: true });
  executable(join(serviceHome, 'runtime-bun', 'bin', 'bun'), '#!/bin/sh\necho 1.4.2\n');
  executable(join(fakeBin, 'bun'), '#!/bin/sh\necho 1.3.11\n');
  writeGateRecord(serviceHome, SHAS.current);
  const fakePaseo = join(root, 'fake paseo');
  executable(fakePaseo, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_PASEO_LOG"
case "$1 $2" in
  "plugin ls")
    count=$(grep -c '^plugin ls ' "$FAKE_PASEO_LOG" 2>/dev/null || printf '0')
    case "\${FAKE_PASEO_MODE:-normal}:$count" in
      fail-preflight:1|always-fail:*) exit 1 ;;
      fail-retention:2) exit 1 ;;
      bad-json-preflight:1|bad-json-retention:2)
        printf '%s\\n' '{not-json}'
        exit 0
        ;;
    esac
    printf '%s\\n' "$FAKE_PLUGIN_JSON"
    ;;
esac
exit 0
`);

  return { root, home, serviceHome, releases, release, fakeBin, fakePaseo, paseoLog, opsRepo };
}

function runInstall(f: Fixture, extraEnv: Record<string, string> = {}, target = f.release) {
  // A developer's SCK_BUN must not decide the gate of these fixtures: the runtime is the one the fixture pins (see writeGateRecord).
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'SCK_BUN'));
  return Bun.spawnSync(['sh', SCRIPT, 'install', target], {
    env: {
      ...inherited,
      HOME: f.home,
      PATH: `${f.fakeBin}:/usr/bin:/bin`,
      PASEO: f.fakePaseo,
      SCK_SERVICE_HOME: f.serviceHome,
      SCK_OPS_REPO: f.opsRepo,
      FAKE_RELEASES_DIR: f.releases,
      FAKE_PASEO_LOG: f.paseoLog,
      FAKE_PASEO_MODE: 'normal',
      FAKE_PLUGIN_JSON: JSON.stringify([{ installation: { identity: { path: join(f.releases, SHAS.plugin, 'plugin') } } }]),
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function cleanup(f: Fixture) {
  rmSync(f.root, { recursive: true, force: true });
}

function activeTarget(f: Fixture) {
  return readlinkSync(join(f.serviceHome, 'active'));
}

test('install prunes old releases under the default space-containing service path safely', () => {
  const f = fixture();
  try {
    const result = runInstall(f, { SCK_RELEASE_KEEP: '1' });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(0);
    expect(activeTarget(f)).toBe(f.release);
    expect(readFileSync(join(f.home, 'Library', 'LaunchAgents', 'org.surrealck.company-mcp.plist'), 'utf8')).toContain(f.serviceHome);

    for (const sha of [SHAS.current, SHAS.previous, SHAS.plugin, SHAS.spare, SHAS.worktree, SHAS.incomplete, SHAS.symlink, SHAS.nondir]) {
      expect(existsSync(join(f.releases, sha))).toBe(true);
    }
    expect(lstatSync(join(f.releases, SHAS.symlink)).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(f.releases, SHAS.nondir)).isDirectory()).toBe(false);
    expect(existsSync(join(f.releases, SHAS.old))).toBe(false);
    expect(existsSync(join(f.releases, 'plugin-source-not-a-release'))).toBe(true);
    expect(stdout).toContain(`release pruned: ${SHAS.old}`);
    expect(stdout).not.toContain(`release pruned: ${SHAS.worktree}`);
    expect(stderr).toContain(`release retained: ${SHAS.incomplete} (incomplete snapshot)`);
    expect(stderr).toContain(`release retained: ${SHAS.worktree} (registered Git worktree)`);
  } finally {
    cleanup(f);
  }
});

for (const [mode, label] of [
  ['fail-preflight', 'a non-zero preflight Paseo query'],
  ['bad-json-preflight', 'malformed preflight Paseo JSON'],
] as const) {
  test(`${label} fails closed before changing active`, () => {
    const f = fixture();
    try {
      const result = runInstall(f, { FAKE_PASEO_MODE: mode });
      expect(result.exitCode).toBe(1);
      expect(activeTarget(f)).toBe(join(f.releases, SHAS.previous));
      expect(existsSync(join(f.releases, SHAS.current))).toBe(true);
      expect(existsSync(join(f.releases, SHAS.old))).toBe(true);
      expect(result.stderr.toString()).toContain('active release was not changed');
      expect(readFileSync(f.paseoLog, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      cleanup(f);
    }
  });
}

for (const [mode, label] of [
  ['fail-retention', 'a non-zero retention Paseo query'],
  ['bad-json-retention', 'malformed retention Paseo JSON'],
] as const) {
  test(`${label} keeps install successful and skips destructive retention`, () => {
    const f = fixture();
    try {
      const result = runInstall(f, { FAKE_PASEO_MODE: mode });
      expect(result.exitCode).toBe(0);
      expect(activeTarget(f)).toBe(f.release);
      expect(existsSync(join(f.releases, SHAS.old))).toBe(true);
      expect(result.stderr.toString()).toContain('skipping release pruning');
      expect(result.stdout.toString()).not.toContain(`release pruned: ${SHAS.old}`);
    } finally {
      cleanup(f);
    }
  });
}

test('install gates the runtime the launchd service resolves, not the SCK_BUN of the calling shell', () => {
  const f = fixture();
  try {
    // The caller's SCK_BUN reports another version with no gate record. launchd does not pass it on, so the services run the pinned
    // runtime (1.4.2), which has a passing record: the install must go ahead.
    const callerPin = join(f.home, 'caller-bun');
    executable(callerPin, '#!/bin/sh\necho 1.3.11\n');
    const result = runInstall(f, { SCK_BUN: callerPin });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(join(f.home, 'Library', 'LaunchAgents', 'org.surrealck.company-mcp.plist'))).toBe(true);
  } finally {
    cleanup(f);
  }
});

test('install refuses a release without a passing comm-slow-pipe gate and leaves active unchanged', () => {
  const f = fixture();
  try {
    rmSync(join(f.serviceHome, 'gates'), { recursive: true, force: true });
    const result = runInstall(f, { SCK_RELEASE_KEEP: '1' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('no passing comm-slow-pipe gate');
    expect(activeTarget(f)).toBe(join(f.releases, SHAS.previous));
    expect(existsSync(join(f.releases, SHAS.old))).toBe(true);
    expect(existsSync(join(f.home, 'Library', 'LaunchAgents', 'org.surrealck.company-mcp.plist'))).toBe(false);
  } finally {
    cleanup(f);
  }
});

test('install refuses a target whose code lacks the review-wait contract, before any switch side effect', () => {
  const f = fixture();
  try {
    // Everything else about this target is valid (sha named release, fake ancestry and content, a passing gate record); only the
    // RW06 contract is missing, which is exactly the pre-RW06 target the product drill showed unlocks a review wait into ready.
    const old = makeRelease(f.releases, SHAS.incompatible, false, false);
    writeGateRecord(f.serviceHome, SHAS.incompatible);
    const result = runInstall(f, { SCK_RELEASE_KEEP: '1' }, old);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('refused:');
    expect(result.stderr.toString()).toContain('复核等待');
    expect(result.stderr.toString()).toContain(`target=${old}`);
    expect(result.stderr.toString()).toContain('waiting items=unknown');
    // No side effect: active still points at the previous release, no plist was written, no release pruned, Paseo untouched.
    expect(activeTarget(f)).toBe(join(f.releases, SHAS.previous));
    expect(existsSync(join(f.home, 'Library', 'LaunchAgents', 'org.surrealck.company-mcp.plist'))).toBe(false);
    expect(existsSync(join(f.releases, SHAS.old))).toBe(true);
    expect(existsSync(f.paseoLog) ? readFileSync(f.paseoLog, 'utf8').trim() : '').toBe('');
  } finally {
    cleanup(f);
  }
});

test('an open file handle protects a candidate release from pruning', () => {
  const f = fixture();
  try {
    const result = runInstall(f, { FAKE_LSOF_OPEN: '1', SCK_RELEASE_KEEP: '0' });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(f.releases, SHAS.old))).toBe(true);
    expect(result.stdout.toString()).not.toContain(`release pruned: ${SHAS.old}`);
    expect(result.stderr.toString()).toContain(`release retained: ${SHAS.old} (open file handle)`);
  } finally {
    cleanup(f);
  }
});

test('an indeterminate open-file check protects a candidate release from pruning', () => {
  const f = fixture();
  try {
    const result = runInstall(f, { FAKE_LSOF_ERROR: '1', SCK_RELEASE_KEEP: '0' });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(f.releases, SHAS.old))).toBe(true);
    expect(result.stdout.toString()).not.toContain(`release pruned: ${SHAS.old}`);
    expect(result.stderr.toString()).toContain(`release retained: ${SHAS.old} (unable to verify open file handles)`);
  } finally {
    cleanup(f);
  }
});

test('invalid spare counts skip the whole retention pass without deleting releases', () => {
  const f = fixture();
  try {
    const result = runInstall(f, { SCK_RELEASE_KEEP: 'not-a-number' });
    expect(result.exitCode).toBe(0);
    expect(activeTarget(f)).toBe(f.release);
    expect(existsSync(join(f.releases, SHAS.spare))).toBe(true);
    expect(existsSync(join(f.releases, SHAS.old))).toBe(true);
    expect(result.stdout.toString()).not.toContain(`release pruned: ${SHAS.old}`);
    expect(result.stderr.toString()).toContain('invalid SCK_RELEASE_KEEP');
  } finally {
    cleanup(f);
  }
});

for (const [keep, spareKept, oldKept] of [
  ['0', false, false],
  ['1', true, false],
  ['2', true, true],
] as const) {
  test(`SCK_RELEASE_KEEP=${keep} preserves exactly the configured spare count`, () => {
    const f = fixture();
    try {
      const result = runInstall(f, { SCK_RELEASE_KEEP: keep });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(f.releases, SHAS.spare))).toBe(spareKept);
      expect(existsSync(join(f.releases, SHAS.old))).toBe(oldKept);
    } finally {
      cleanup(f);
    }
  });
}

test('repeating the same install is idempotent after retention has run once', () => {
  const f = fixture();
  try {
    const first = runInstall(f, { SCK_RELEASE_KEEP: '1' });
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(f.releases, SHAS.old))).toBe(false);

    const second = runInstall(f, { SCK_RELEASE_KEEP: '1' });
    expect(second.exitCode).toBe(0);
    expect(activeTarget(f)).toBe(f.release);
    expect(existsSync(join(f.releases, SHAS.old))).toBe(false);
    expect([SHAS.previous, SHAS.spare].filter((sha) => existsSync(join(f.releases, sha)))).toHaveLength(1);

    const afterSecond = [SHAS.current, SHAS.previous, SHAS.plugin, SHAS.spare, SHAS.old, SHAS.worktree, SHAS.incomplete]
      .filter((sha) => existsSync(join(f.releases, sha)));
    const third = runInstall(f, { SCK_RELEASE_KEEP: '1' });
    expect(third.exitCode).toBe(0);
    const afterThird = [SHAS.current, SHAS.previous, SHAS.plugin, SHAS.spare, SHAS.old, SHAS.worktree, SHAS.incomplete]
      .filter((sha) => existsSync(join(f.releases, sha)));
    expect(afterThird).toEqual(afterSecond);
  } finally {
    cleanup(f);
  }
});
