import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  nopolicy: '5555555555555555555555555555555555555555',
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

// SYS02 C2: the acceptance baseline contract the target guard requires (baseline declarations, the evaluator merge,
// the schema/bootstrap link). A fixture target without it is refused before any install side effect.
const ACCEPTANCE_FILES = {
  'src/acceptance.ts': "export const ACCEPTANCE_BASELINE_VERSION = 1;\nexport const BASELINE_IDS = { implement: { machine: 'AC-BASE-IMPL-1', human: 'AC-BASE-IMPL-2' } };\nexport function mergeAcceptanceCriteria(leg, custom) { return custom; }\nexport function isTrustedCodeDeliverable(subject) { return true; }\nif (trusted) criteria = mergeAcceptanceCriteria(leg, criteria);\n",
  'src/database.ts': "await this.db.query(loadSchema('026-acceptance.surql'));\n// company_meta:acceptance_gate\n",
  'schema/026-acceptance.surql': "DEFINE FIELD IF NOT EXISTS acceptance_criteria ON task TYPE option<array<object>>;\nDEFINE TABLE IF NOT EXISTS acceptance_evidence SCHEMAFULL;\n",
};

function makeRelease(releases: string, sha: string, withGit = false, capable = true) {
  const dir = join(releases, sha);
  mkdirSync(join(dir, 'src', 'mcp'), { recursive: true });
  mkdirSync(join(dir, 'src', 'dispatcher'), { recursive: true });
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  writeFileSync(join(dir, 'src', 'mcp', 'run.ts'), 'export {};\n');
  writeFileSync(join(dir, 'src', 'dispatcher', 'run.ts'), 'export {};\n');
  if (capable) {
const files = { ...ACCEPTANCE_FILES, 'src/core.ts': '', 'src/contracts.ts': '', 'src/dispatcher/dispatcher.ts': 'export {};\n' };
    const appends: Array<[string, string]> = [['src/core.ts', "export const ACCEPTANCE_CORE = 'mergeAcceptanceCriteria(leg, criteria); isTrustedCodeDeliverable(subject);';\n"]];
    mkdirSync(join(dir, 'schema'), { recursive: true });
    mkdirSync(join(dir, 'src', 'ops'), { recursive: true });
    for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
    for (const [path, body] of appends) appendFileSync(join(dir, path), body);
    // The plugin surface runs the same core; its generated vendor must carry both contracts too.
    mkdirSync(join(dir, 'plugin', 'server', 'vendor', 'src', 'ops'), { recursive: true });
    mkdirSync(join(dir, 'plugin', 'server', 'vendor', 'src', 'dispatcher'), { recursive: true });
    mkdirSync(join(dir, 'plugin', 'server', 'vendor', 'schema'), { recursive: true });
    for (const [path, body] of Object.entries(files)) {
      writeFileSync(join(dir, 'plugin', 'server', 'vendor', path), body);
    }
    for (const [path, body] of appends) appendFileSync(join(dir, 'plugin', 'server', 'vendor', path), body);
  }
  if (withGit) writeFileSync(join(dir, '.git'), 'gitdir: /tmp/company-service-test\n');
  return dir;
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
  // and fetch calls install also makes stay trivial. The mismatch case is covered with a real repository in the release-content tests below.
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
  const fakePaseo = join(root, 'fake paseo');
  executable(fakePaseo, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_PASEO_LOG"
case "$1 $2" in
  "plugin ls")
    count=$(grep -c '^plugin ls ' "$FAKE_PASEO_LOG" 2>/dev/null || printf '0')
    case "\${FAKE_PASEO_MODE:-normal}:$count" in
      fail-retention:1) exit 1 ;;
      bad-json-retention:1)
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
  // A developer's SCK_BUN must not change which runtime these fixtures resolve.
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

/**
 * The switch guards against the real checkout, not a fixture: a guard probes declarations, so a fixture shaped
 * differently from the tree it protects can pass while the real tree is refused — and a release that cannot pass a
 * guard cannot be installed, which blocks the deploy leg of the very version that introduced the capability.
 * This runs the shipped guards on the repository root and on the plugin vendor tree.
 */
const SWITCH_GUARDS: Array<[string, string]> = [
  ['acceptance-guard.sh', 'acceptance_target_supported'],
];

function runSwitchGuard(script: string, entry: string, root: string, scope = 'full') {
  return Bun.spawnSync(['sh', '-c', `. "${join(ROOT, 'scripts', script)}"; ${entry} "${root}" "${scope}"`], {
    // The standby guard reads the target with the repository's TypeScript parser, so it needs a
    // runtime that can load it; the fixture's own runtime is a stub (see fixture()).
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

test('every switch guard accepts the real checkout and its plugin vendor tree', () => {
  // The tree that ships this version must be installable by its own guards. The vendor face runs
  // the same core: for guards that require plugin/ under full scope (standby-relay), probe the
  // vendor face with scope=core; the release itself is still probed with full.
  const vendor = join(ROOT, 'plugin', 'server', 'vendor');
  for (const [script, entry] of SWITCH_GUARDS) {
    const releaseResult = runSwitchGuard(script, entry, ROOT, 'full');
    expect(`${script} ${ROOT} full: ${releaseResult.stderr.toString().trim()}`).toBe(`${script} ${ROOT} full: `);
    expect(releaseResult.exitCode).toBe(0);
    const vendorScope = 'full';
    const vendorResult = runSwitchGuard(script, entry, vendor, vendorScope);
    expect(`${script} ${vendor} ${vendorScope}: ${vendorResult.stderr.toString().trim()}`).toBe(`${script} ${vendor} ${vendorScope}: `);
    expect(vendorResult.exitCode).toBe(0);
  }
}, 30_000); // Ten guard runs take about 4.5s on the CI runner (main: 4.4-4.6s), too close to Bun's 5s default.

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

test('install refuses a target whose code lacks the acceptance baseline contract, before any switch side effect', () => {
  const f = fixture();
  try {
    // Everything else about this target is valid (sha named release, fake ancestry and content); only the
    // SYS02 baseline is missing, which is exactly the pre-SYS02 target the guard exists to refuse.
    const old = makeRelease(f.releases, SHAS.incompatible, false, true);
    writeFileSync(join(old, 'src', 'acceptance.ts'), 'export {};\n');
    const result = runInstall(f, { SCK_RELEASE_KEEP: '1' }, old);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('refused:');
    expect(result.stderr.toString()).toContain('验收基线');
    expect(result.stderr.toString()).toContain(`target=${old}`);
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

// Launcher runtime resolution (scripts/run-service.sh, scripts/bun-runtime.sh): the services run SCK_BUN, then the pinned
// runtime-bun under the service home, then ~/.bun, never the Bun on PATH. An explicit pin is never replaced by another Bun.
const LAUNCHER = join(ROOT, 'scripts', 'run-service.sh');

function stubBun(path: string, version: string, label: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n[ "$1" = --version ] && { echo ${version}; exit 0; }\necho ran:${label}\n`);
  chmodSync(path, 0o755);
}

function launcherHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sck-launcher-'));
  mkdirSync(join(home, 'private'), { recursive: true });
  mkdirSync(join(home, 'active'), { recursive: true });
  writeFileSync(join(home, 'private', 'service.env'), '');
  stubBun(join(home, 'runtime-bun', 'bin', 'bun'), '1.4.2', 'pinned');
  return home;
}

function launch(home: string, extra: Record<string, string> = {}): string {
  const pathBin = join(home, 'path-bin');
  stubBun(join(pathBin, 'bun'), '1.3.11', 'path');
  const child = Bun.spawnSync(['sh', LAUNCHER, 'mcp'], {
    env: { ...process.env, SCK_SERVICE_HOME: home, SCK_BUN: '', SCK_GITHUB_REPOSITORY: '', HOME: join(home, 'user-home'), PATH: `${pathBin}:${process.env.PATH ?? ''}`, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return child.stdout.toString();
}

test('the launcher runs SCK_BUN, then the pinned runtime, then ~/.bun, and never the Bun on PATH', () => {
  const home = launcherHome();
  try {
    expect(launch(home)).toContain('ran:pinned');
    const override = join(home, 'override', 'bun');
    stubBun(override, '9.9.9', 'override');
    expect(launch(home, { SCK_BUN: override })).toContain('ran:override');
    writeFileSync(join(home, 'private', 'service.env'), `SCK_BUN="${override}"\n`);
    expect(launch(home)).toContain('ran:override');
    writeFileSync(join(home, 'private', 'service.env'), '');
    rmSync(join(home, 'runtime-bun'), { recursive: true, force: true });
    stubBun(join(home, 'user-home', '.bun', 'bin', 'bun'), '1.3.11', 'home');
    expect(launch(home)).toContain('ran:home');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an explicit pin that is missing is never replaced by another Bun', () => {
  const home = launcherHome();
  try {
    stubBun(join(home, 'user-home', '.bun', 'bin', 'bun'), '1.3.11', 'home');
    writeFileSync(join(home, 'private', 'service.env'), `SCK_BUN=${join(home, 'missing', 'bun')}\n`);
    expect(launch(home)).not.toContain('ran:home');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Release content is bound to the commit, not to the directory name (scripts/release-content.sh, which install calls).
function opsFixture(home: string) {
  const repo = join(home, 'ops-repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0);
  writeFileSync(join(repo, 'src', 'core.ts'), 'export const committed = true;\n');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  Bun.spawnSync(['git', '-C', repo, 'add', '-A']);
  expect(Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'fixture']).exitCode).toBe(0);
  const sha = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD']).stdout.toString().trim();
  const release = join(home, 'releases', sha);
  mkdirSync(release, { recursive: true });
  const archive = Bun.spawnSync(['git', '-C', repo, 'archive', '--format=tar', sha]).stdout;
  expect(Bun.spawnSync(['tar', '-x', '-C', release], { stdin: archive, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
  return { repo, sha, release };
}

function releaseMatches(release: string, sha: string, repo: string): number {
  return Bun.spawnSync(['sh', '-c', '. "$1/scripts/release-content.sh"; release_matches_commit "$2" "$3" "$4"', 'release-content-test', ROOT, release, sha, repo], {
    stdout: 'pipe',
    stderr: 'pipe',
  }).exitCode;
}

test('a release cut from the commit matches; generated paths are not part of the comparison', () => {
  const home = mkdtempSync(join(tmpdir(), 'sck-release-content-'));
  try {
    const { repo, sha, release } = opsFixture(home);
    expect(releaseMatches(release, sha, repo)).toBe(0);
    // Dependencies, generated vendor, build output and the service runtime dir are added after the archive and never come
    // from the commit. `.runtime/` matters most: it is gitignored, so it exists only in the release copy.
    mkdirSync(join(release, 'node_modules', 'left-pad'), { recursive: true });
    mkdirSync(join(release, 'plugin', 'server', 'vendor'), { recursive: true });
    mkdirSync(join(release, 'vault', 'build'), { recursive: true });
    mkdirSync(join(release, '.runtime'), { recursive: true });
    writeFileSync(join(release, 'plugin', 'server', 'vendor', 'core.ts'), 'generated\n');
    writeFileSync(join(release, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(release, '.runtime', 'state.json'), '{}\n');
    expect(releaseMatches(release, sha, repo)).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a directory named after the commit but holding other content is refused, as is an unknown commit', () => {
  const home = mkdtempSync(join(tmpdir(), 'sck-release-content-'));
  try {
    const { repo, sha, release } = opsFixture(home);
    // The stub case the review reproduced: right name, wrong content, and even an extra file the commit never had.
    writeFileSync(join(release, 'src', 'core.ts'), 'export const committed = false;\n');
    expect(releaseMatches(release, sha, repo)).not.toBe(0);
    writeFileSync(join(release, 'src', 'core.ts'), 'export const committed = true;\n');
    writeFileSync(join(release, 'src', 'planted.ts'), 'export const planted = true;\n');
    expect(releaseMatches(release, sha, repo)).not.toBe(0);
    rmSync(join(release, 'src', 'planted.ts'));
    expect(releaseMatches(release, sha, repo)).toBe(0);
    // A commit the ops repo does not have cannot be verified, so it does not match.
    expect(releaseMatches(release, 'b'.repeat(40), repo)).not.toBe(0);
    expect(releaseMatches(release, sha, join(home, 'no-such-repo'))).not.toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install verifies the content against the commit before it switches the active release', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  const content = script.indexOf('release_matches_commit "$release" "$sha" "$ops_repo"');
  const switchPoint = script.indexOf('ln -s "$release" "$service_home/active.next"');
  expect(content).toBeGreaterThan(0);
  expect(switchPoint).toBeGreaterThan(content);
});
