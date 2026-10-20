import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Local release gate (SYS01 AC-B). The macOS slow-pipe regression has no hosted runner any more: company-service.sh install must
// refuse a release unless scripts/release-gate.sh recorded a passing run for that commit on the Bun version installed now.
const ROOT = join(import.meta.dir, '..');
const SERVICE = join(ROOT, 'scripts/company-service.sh');
const GATE = join(ROOT, 'scripts/release-gate.sh');
const SHA = 'a'.repeat(40);

const bunVersion = () => Bun.spawnSync(['bun', '--version']).stdout.toString().trim();

function serviceHome(): string {
  return mkdtempSync(join(tmpdir(), 'sck-release-gate-'));
}

function sh(script: string, args: string[], home: string) {
  const child = Bun.spawnSync(['sh', script, ...args], { env: { ...process.env, SCK_SERVICE_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
}

function writeRecord(home: string, sha: string, fields: Record<string, unknown>) {
  const dir = join(home, 'gates', 'comm-slow-pipe');
  mkdirSync(dir, { recursive: true });
  const record = { gate: 'comm-slow-pipe', sha, bun: bunVersion(), platform: 'darwin', result: 'pass', ...fields };
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

test('a passing darwin record for this commit and the installed Bun version opens the gate', () => {
  const home = serviceHome();
  try {
    writeRecord(home, SHA, {});
    const run = sh(SERVICE, ['check-gate', SHA], home);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`gate ok: ${SHA}`);
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

test('the release gate refuses a relative path, a name that is not a commit sha, and a missing slow-pipe test', () => {
  const home = serviceHome();
  try {
    expect(sh(GATE, ['slow-pipe', 'relative/release'], home).code).toBe(2);
    expect(sh(GATE, ['slow-pipe', '/tmp/not-a-sha'], home).code).toBe(2);
    expect(sh(GATE, ['slow-pipe', `/tmp/${SHA}`], home).code).toBe(2);
    expect(sh(GATE, ['unknown-gate', `/tmp/${SHA}`], home).code).toBe(2);
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
