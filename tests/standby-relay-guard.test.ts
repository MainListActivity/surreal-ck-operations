import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const GUARD = join(ROOT, 'scripts/standby-relay-guard.sh');

const VALID_FILES: Record<string, string> = {
  'src/standby-relay-capability.ts': [
    "export const STANDBY_RELAY_PROTOCOL = 'standby-relay/1';",
    'export const STANDBY_BUDGET_SECONDS_DEFAULT = 600;',
  ].join('\n') + '\n',
  'src/core.ts': [
    'standby_until = IF $assigned THEN math::min([$standby_not_after, $now + $standby_budget]) ELSE NONE END',
    'standby employee unavailable',
    'standby denied: unmet dependencies remain',
  ].join('\n') + '\n',
  'src/contracts.ts': 'export interface TaskView {\n  standbyUntil?: string;\n}\n',
  'src/dispatcher/dispatcher.ts': [
    'export const STANDBY_WAKE_RETRY_SECONDS = 60;',
    "const STANDBY_TIMEOUT = 'standby timeout';",
  ].join('\n') + '\n',
  'src/workforce.ts': [
    'export interface CompanyConfig {',
    '  standbyBudgetSeconds: number;',
    '}',
    'const DEFAULT_CONFIG = {',
    '  standbyBudgetSeconds: STANDBY_BUDGET_SECONDS_DEFAULT,',
    '};',
    'row.standby_budget_seconds',
    "action: 'standby_timeout',",
  ].join('\n') + '\n',
};

function writeTree(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function release(files: Record<string, string> = {}, withVendor = true): string {
  const root = mkdtempSync(join(tmpdir(), 'sck-standby-guard-'));
  writeTree(root, { ...VALID_FILES, ...files });
  if (withVendor) {
    const vendorFiles = {
      ...VALID_FILES,
      ...Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('src/'))),
    };
    writeTree(join(root, 'plugin/server/vendor'), vendorFiles);
  } else {
    mkdirSync(join(root, 'plugin'), { recursive: true });
  }
  return root;
}

function probe(root: string): { code: number; output: string } {
  const child = Bun.spawnSync([
    'sh', '-c', '. "$1"; standby_relay_target_supported "$2" full',
    'standby-relay-guard-test', GUARD, root,
  ], { stdout: 'pipe', stderr: 'pipe' });
  return { code: child.exitCode, output: `${child.stdout.toString()}${child.stderr.toString()}` };
}

function expectRefused(root: string) {
  const result = probe(root);
  expect(result.code, result.output).not.toBe(0);
}

test('the standby switch guard accepts a complete release and refuses missing capability, budget, or vendor evidence', () => {
  const complete = release();
  const noCapability = release();
  unlinkSync(join(noCapability, 'src/standby-relay-capability.ts'));
  const noBudget = release({
    'src/workforce.ts': "row.standby_budget_seconds\naction: 'standby_timeout',\n",
  });
  const noVendor = release({}, false);
  const vendorWithoutCapability = release();
  writeFileSync(join(vendorWithoutCapability, 'plugin/server/vendor/src/standby-relay-capability.ts'), 'export const OTHER = 1;\n');
  try {
    expect(probe(complete).code).toBe(0);
    for (const root of [noCapability, noBudget, noVendor, vendorWithoutCapability]) expectRefused(root);
  } finally {
    for (const root of [complete, noCapability, noBudget, noVendor, vendorWithoutCapability]) rmSync(root, { recursive: true, force: true });
  }
});

const COMMENT_MARKERS = [
  { path: 'src/standby-relay-capability.ts', line: "export const STANDBY_RELAY_PROTOCOL = 'standby-relay/1';", replacement: "export const OTHER_PROTOCOL = 'standby-relay/0';", marker: "export const STANDBY_RELAY_PROTOCOL = 'standby-relay/1';" },
  { path: 'src/standby-relay-capability.ts', line: "export const STANDBY_RELAY_PROTOCOL = 'standby-relay/1';", replacement: "export const STANDBY_RELAY_PROTOCOL = 'standby-relay/0';", marker: 'standby-relay/1' },
  { path: 'src/core.ts', line: 'standby_until = IF $assigned THEN math::min([$standby_not_after, $now + $standby_budget]) ELSE NONE END', replacement: 'LET $standby_until = NONE;', marker: 'standby_until = IF $assigned THEN math::min([$standby_not_after, $now + $standby_budget]) ELSE NONE END' },
  { path: 'src/core.ts', line: 'standby employee unavailable', replacement: 'standby employee is active', marker: 'standby employee unavailable' },
  { path: 'src/core.ts', line: 'standby denied: unmet dependencies remain', replacement: 'standby dependencies are satisfied', marker: 'standby denied: unmet dependencies remain' },
  { path: 'src/contracts.ts', line: '  standbyUntil?: string;', replacement: '  resumeUntil?: string;', marker: 'standbyUntil?: string;' },
  { path: 'src/workforce.ts', line: '  standbyBudgetSeconds: number;', replacement: '  resumeBudgetSeconds: number;', marker: 'standbyBudgetSeconds: number;' },
  { path: 'src/workforce.ts', line: '  standbyBudgetSeconds: STANDBY_BUDGET_SECONDS_DEFAULT,', replacement: '  resumeBudgetSeconds: 600,', marker: 'standbyBudgetSeconds: STANDBY_BUDGET_SECONDS_DEFAULT,' },
  { path: 'src/workforce.ts', line: 'row.standby_budget_seconds', replacement: 'row.resume_budget_seconds', marker: 'standby_budget_seconds' },
  { path: 'src/workforce.ts', line: "action: 'standby_timeout',", replacement: "action: 'ordinary_reclaim',", marker: 'standby_timeout' },
  { path: 'src/dispatcher/dispatcher.ts', line: 'export const STANDBY_WAKE_RETRY_SECONDS = 60;', replacement: 'export const WAKE_RETRY_SECONDS = 60;', marker: 'STANDBY_WAKE_RETRY_SECONDS' },
  { path: 'src/dispatcher/dispatcher.ts', line: "const STANDBY_TIMEOUT = 'standby timeout';", replacement: "const STANDBY_TIMEOUT = 'ordinary timeout';", marker: 'standby timeout' },
];

const COMMENT_FORMS = [
  ['line-comment', (marker: string) => `// ${marker}`],
  ['inline-line-comment', (marker: string) => `const markerProbe = 1; // ${marker}`],
  ['block-comment', (marker: string) => `/* ${marker} */`],
  ['inline-block-comment', (marker: string) => `const markerProbe = 1; /* ${marker} */`],
] as const;

test('every required marker is refused when it appears only in a comment', () => {
  const roots: string[] = [];
  try {
    for (const { path, line, replacement, marker } of COMMENT_MARKERS) {
      for (const [form, comment] of COMMENT_FORMS) {
        const body = VALID_FILES[path];
        expect(body, `${path} has source marker for ${form}`).toContain(line);
        const root = release({ [path]: body.replace(line, `${replacement}\n${comment(marker)}`) });
        roots.push(root);
        const result = probe(root);
        expect(result.code, `${path} ${form} ${marker}: ${result.output}`).not.toBe(0);
      }
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
