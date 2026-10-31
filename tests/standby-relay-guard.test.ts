import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const GUARD = join(ROOT, 'scripts/standby-relay-guard.sh');

// Every guard call reads the target with the repository's TypeScript parser, so it starts a
// parser process; the matrix below therefore runs a few hundred of them.
const TIMEOUT = 60_000;

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
    'const STANDBY_TIMEOUT = "standby timeout";',
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
}, TIMEOUT);

// R14: under full scope a tree without plugin/ cannot prove the plugin face, so it is refused
// the same way a tree with plugin/ but without vendor is refused. Scope=core (the remote MCP
// deploy) still accepts the same tree, because that payload is the service core only.
test('full scope refuses a tree without plugin/, while core scope still accepts it', () => {
  const noPlugin = mkdtempSync(join(tmpdir(), 'sck-standby-noplugin-'));
  writeTree(noPlugin, VALID_FILES);
  try {
    const full = Bun.spawnSync([
      'sh', '-c', '. "$1"; standby_relay_target_supported "$2" full',
      'standby-relay-guard-test', GUARD, noPlugin,
    ], { stdout: 'pipe', stderr: 'pipe' });
    expect(full.exitCode, `full: ${full.stderr.toString()}`).not.toBe(0);
    const refused = Bun.spawnSync([
      'sh', '-c', '. "$1"; standby_relay_refuse "$2" full',
      'standby-relay-guard-test', GUARD, noPlugin,
    ], { stdout: 'pipe', stderr: 'pipe' });
    expect(`${refused.stdout.toString()}${refused.stderr.toString()}`).toContain('缺少插件树');
    const core = Bun.spawnSync([
      'sh', '-c', '. "$1"; standby_relay_target_supported "$2" core',
      'standby-relay-guard-test', GUARD, noPlugin,
    ], { stdout: 'pipe', stderr: 'pipe' });
    expect(core.exitCode, `core: ${core.stderr.toString()}`).toBe(0);
  } finally {
    rmSync(noPlugin, { recursive: true, force: true });
  }
}, TIMEOUT);

// R15: a release under a path that contains spaces (the production layout is
// $HOME/Library/Application Support/SurrealCKCompany/releases/<sha>) must still resolve the
// repository TypeScript parser from the scanner's own directory, even when the caller's cwd has
// no node_modules. fileURLToPath is required: URL.pathname keeps %20 and require.resolve fails.
test('a spaced release path resolves the TypeScript parser regardless of cwd', () => {
  const spaced = mkdtempSync(join(tmpdir(), 'sck standby spaced-'));
  const scripts = join(spaced, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'standby-relay-guard.sh'), readFileSync(GUARD));
  writeFileSync(join(scripts, 'standby-relay-scan.mjs'), readFileSync(join(ROOT, 'scripts/standby-relay-scan.mjs')));
  symlinkSync(join(ROOT, 'node_modules'), join(spaced, 'node_modules'));
  writeTree(spaced, VALID_FILES);
  const bareCwd = mkdtempSync(join(tmpdir(), 'sck-standby-bare-cwd-'));
  try {
    const result = Bun.spawnSync([
      'sh', '-c', '. "$1"; standby_relay_target_supported "$2" core',
      'standby-relay-guard-spaced-test', join(scripts, 'standby-relay-guard.sh'), spaced,
    ], {
      cwd: bareCwd,
      env: { ...process.env, STANDBY_RELAY_RUNTIME: process.execPath, PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, `${result.stdout.toString()}${result.stderr.toString()}`).toBe(0);
  } finally {
    rmSync(spaced, { recursive: true, force: true });
    rmSync(bareCwd, { recursive: true, force: true });
  }
}, TIMEOUT);

const COMMENT_MARKERS = [
  { path: 'src/standby-relay-capability.ts', line: "export const STANDBY_RELAY_PROTOCOL = 'standby-relay/1';", replacement: "export const OTHER_PROTOCOL = 'standby-relay/0';", marker: "export const STANDBY_RELAY_PROTOCOL = 'standby-relay/1';" },
  { path: 'src/standby-relay-capability.ts', line: "export const STANDBY_RELAY_PROTOCOL = 'standby-relay/1';", replacement: "export const OTHER_PROTOCOL = 'standby-relay/0';", marker: 'STANDBY_RELAY_PROTOCOL[[:space:]]*=' },
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
  { path: 'src/dispatcher/dispatcher.ts', line: 'const STANDBY_TIMEOUT = "standby timeout";', replacement: 'const STANDBY_TIMEOUT = "ordinary timeout";', marker: 'standby timeout' },
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
}, TIMEOUT);

// The review probes for attempt 4 (fv06-attempt4-guard-probe*.ts) plus the multi-line block
// comment and quote-state cases they exposed. Every fixture below keeps a required marker only
// inside a comment, or verifies that a legitimate marker stays accepted.
const SQL = 'standby_until = IF $assigned THEN math::min([$standby_not_after, $now + $standby_budget]) ELSE NONE END';
const UNAVAILABLE = 'standby employee unavailable';
const DENIED = 'standby denied: unmet dependencies remain';
const lines = (...xs: string[]) => xs.join('\n') + '\n';

test('a multi-line block comment cannot stand in for declarations or behavior markers', () => {
  const roots: string[] = [];
  try {
    // The protocol declaration lives only inside a block comment; the budget default is real code.
    const protocolInBlock = release({
      'src/standby-relay-capability.ts': lines('/*', "export const STANDBY_RELAY_PROTOCOL = 'standby-relay/1';", '*/', 'export const STANDBY_BUDGET_SECONDS_DEFAULT = 600;'),
    });
    // Both workforce declarations live only inside a block comment; the row key and audit action are real code.
    const budgetInBlock = release({
      'src/workforce.ts': lines('export interface CompanyConfig {', '}', 'const DEFAULT_CONFIG = {', '};', '/*', 'standbyBudgetSeconds: number;', 'standbyBudgetSeconds: STANDBY_BUDGET_SECONDS_DEFAULT,', '*/', 'row.standby_budget_seconds', "action: 'standby_timeout',"),
    });
    // The view field lives only inside a block comment.
    const viewInBlock = release({
      'src/contracts.ts': lines('export interface TaskView {', '}', '/*', 'standbyUntil?: string;', '*/'),
    });
    // All three core markers live only inside one block comment.
    const coreInBlock = release({
      'src/core.ts': lines('/*', SQL, UNAVAILABLE, DENIED, '*/'),
    });
    roots.push(protocolInBlock, budgetInBlock, viewInBlock, coreInBlock);
    for (const root of roots) expectRefused(root);
    // Control: a block comment that contains none of the markers does not affect a complete tree.
    const commented = release({
      'src/core.ts': lines('/* note: this file carries the bounded standby relay */', SQL, UNAVAILABLE, DENIED),
    });
    roots.push(commented);
    expect(probe(commented).code).toBe(0);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

test('quote state cannot swallow a later comment: apostrophes, backticks and regex literals', () => {
  const roots: string[] = [];
  try {
    const cases: Array<[string, string]> = [
      // An apostrophe inside a double-quoted string must not open a single-quoted string.
      ['same-line-dq-apostrophe-then-comment', lines(SQL, `const note = "it's"; // ${UNAVAILABLE}`, DENIED)],
      ['earlier-line-dq-apostrophe-then-comment', lines(SQL, `const note = "operator's note";`, `// ${UNAVAILABLE}`, DENIED)],
      // A backtick inside a double-quoted string must not open a template literal.
      ['dq-odd-backtick-then-comment', lines(SQL, 'const label = "use ` only";', `// ${UNAVAILABLE}`, DENIED)],
      // A quote inside a regex literal must not open a string: same line and earlier line.
      ['same-line-regex-quote-then-line-comment', lines(SQL, `const quoteRe = /'/; // ${UNAVAILABLE}`, DENIED)],
      ['regex-quote-then-comment', lines(SQL, `const quoteRe = /'/;`, `// ${UNAVAILABLE}`, DENIED)],
      // Block comments after a string carrying a quote are still comments.
      ['earlier-line-dq-apostrophe-then-block-comment', lines(SQL, `const note = "operator's note";`, `/* ${UNAVAILABLE} */`, DENIED)],
      ['same-line-dq-apostrophe-then-block-comment', lines(SQL, `const note = "it's"; /* ${UNAVAILABLE} */`, DENIED)],
      ['same-line-regex-quote-then-block-comment', lines(SQL, `const quoteRe = /'/; /* ${UNAVAILABLE} */`, DENIED)],
    ];
    for (const [name, core] of cases) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).not.toBe(0);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

test('a core file holding only comments is refused, even after a line with an apostrophe', () => {
  const roots: string[] = [];
  try {
    const plain = release({ 'src/core.ts': lines(`// ${SQL}`, `// ${UNAVAILABLE}`, `// ${DENIED}`) });
    const afterQuote = release({ 'src/core.ts': lines(`const note = "it's"; // ${SQL}`, `// ${UNAVAILABLE}`, `// ${DENIED}`) });
    roots.push(plain, afterQuote);
    for (const root of roots) expectRefused(root);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

test('real markers inside strings and a same-line double-quoted URL are still accepted', () => {
  const roots: string[] = [];
  try {
    // A double-quoted URL contains "//"; a real single-quoted marker follows on the same line.
    const urlSameLine = release({
      'src/core.ts': lines(`const url = "http://example.test"; const label = '${UNAVAILABLE}';`, SQL, DENIED),
    });
    // A marker inside a double-quoted string is real code too.
    const markerInDq = release({
      'src/core.ts': lines(SQL, `const msg = "${UNAVAILABLE}";`, DENIED),
    });
    // A regex literal with a quote on its own line, then a real code marker.
    const regexThenMarker = release({
      'src/core.ts': lines(SQL, `const quoteRe = /'/;`, `const label = "${UNAVAILABLE}";`, DENIED),
    });
    // A multi-line block comment with an apostrophe, then a real code marker.
    const multiBlockThenMarker = release({
      'src/core.ts': lines(SQL, '/*', "it's a note", '*/', `const label = "${UNAVAILABLE}";`, DENIED),
    });
    roots.push(urlSameLine, markerInDq, regexThenMarker, multiBlockThenMarker);
    for (const root of roots) expect(probe(root).code, root).toBe(0);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

test('both switch entry points ask the standby guard before their first side effect', () => {
  const source = readFileSync(GUARD, 'utf8');
  // The decision cannot depend on live state: the guard reads files, never a database.
  expect(source).not.toMatch(/surrealdb|surreal |psql|sqlite|SELECT /i);
  expect(source).toContain('no authorised read seam');
  // Install: after the earlier content guards, before the bin copies and the active symlink.
  const service = readFileSync(join(ROOT, 'scripts/company-service.sh'), 'utf8');
  const install = service.indexOf('standby_relay_target_supported "$release"');
  expect(install).toBeGreaterThan(service.indexOf('goal_workspace_target_supported "$release"'));
  expect(install).toBeLessThan(service.indexOf('mkdir -p "$service_home/bin"'));
  expect(install).toBeLessThan(service.indexOf('ln -s "$release" "$service_home/active.next"'));
  // Remote deploy: after the earlier guards and before any ssh/scp step reaches the host.
  const deploy = readFileSync(join(ROOT, 'scripts/deploy-mcp-remote.sh'), 'utf8');
  const remote = deploy.indexOf('standby_relay_target_supported "$staging/probe" core');
  expect(remote).toBeGreaterThan(deploy.indexOf('goal_workspace_target_supported "$staging/probe" core'));
  expect(remote).toBeLessThan(deploy.indexOf('ssh $ssh_opts'));
}, TIMEOUT);

// R7 (attempt-5 return): regex after keywords/=>/) and LineContinuation. The previous
// regex-start char class only covered operators/openers, so return /'/, typeof /'/, => /'/,
// and if (s) /'/ were treated as division; a quote inside them flipped quote state and a
// comment-only marker was accepted. ECMAScript also allows LineContinuation (odd trailing
// unescaped \) to keep a single/double quote open across lines.
test('regex after keywords, arrows and if-heads, plus LineContinuation, cannot smuggle markers', () => {
  const roots: string[] = [];
  try {
    const refused: Array<[string, string]> = [
      ['FO1-kw-return-regex-quote-then-line-comment', lines(SQL, `  return /'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['FO2-kw-typeof-regex-quote-then-line-comment', lines(SQL, `const t = typeof /'/; // ${UNAVAILABLE}`, DENIED)],
      ['FO3-arrow-regex-quote-then-line-comment', lines(SQL, `const f = (s: string) => /'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['FO4-paren-regex-quote-then-line-comment', lines(SQL, `if (s) /'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['FO5-kw-return-regex-quote-then-block-comment', lines(SQL, `  return /'/.test(s); /* ${UNAVAILABLE} */`, DENIED)],
      ['FO6-arrow-regex-backtick-flips-state-for-later-comment', lines(SQL, 'const f = (s: string) => /`/.test(s);', `// ${UNAVAILABLE}`, DENIED)],
      ['FO7-sq-line-continuation-then-line-comment', lines(SQL, "const note = 'operator \\", `def'; // ${UNAVAILABLE}`, DENIED)],
      ['FO8-dq-line-continuation-then-line-comment', lines(SQL, 'const note = "operator \\', `def"; // ${UNAVAILABLE}`, DENIED)],
      // Controls that must keep refusing even when the regex itself has no quote.
      ['C2-arrow-regex-plain-then-line-comment', lines(SQL, `const f = (s: string) => /x/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['C3-paren-regex-plain-then-line-comment', lines(SQL, `if (s) /x/.test(s); // ${UNAVAILABLE}`, DENIED)],
    ];
    for (const [name, core] of refused) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).not.toBe(0);
    }
    const accepted: Array<[string, string]> = [
      ['C1-kw-regex-quote-then-code-marker-in-dq', lines(SQL, `  return /'/.test(s); const label = "${UNAVAILABLE}";`, DENIED)],
      ['C4-operator-regex-quote-then-line-comment-still-refused-elsewhere', lines(SQL, `const quoteRe = /'/; const label = "${UNAVAILABLE}";`, DENIED)],
      ['C5-template-expression-code-marker', lines(SQL, 'const msg = `${"' + UNAVAILABLE + '"}`;', DENIED)],
      ['C6-sq-line-continuation-then-code-marker', lines(SQL, "const note = 'operator \\", `def'; const label = "${UNAVAILABLE}";`, DENIED)],
      ['C7-kw-regex-slash-in-class-then-code-marker', lines(SQL, `  return /[/]/.test(s); const label = "${UNAVAILABLE}";`, DENIED)],
    ];
    for (const [name, core] of accepted) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).toBe(0);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

// R8 (attempt-6 return): division after ], }, member names that equal keywords, TS non-null
// assertions, export default, non-ASCII identifiers, and nested template literals must not
// flip the lexer into a state that treats a later comment as code.
test('division after primaries and nested templates cannot smuggle comment markers', () => {
  const roots: string[] = [];
  try {
    const refused: Array<[string, string]> = [
      ['G1-keyword-named-member-div', lines(SQL, `const r = stats.in / total; // ${UNAVAILABLE}`, DENIED)],
      ['G2-keyword-named-member-new-div', lines(SQL, `const pct = stats.new / stats.total; // ${UNAVAILABLE}`, DENIED)],
      ['G3-ts-non-null-then-div', lines(SQL, `const avg = total! / count; // ${UNAVAILABLE}`, DENIED)],
      ['G4-ts-non-null-member-then-div', lines(SQL, `const avg = this.total! / this.count; // ${UNAVAILABLE}`, DENIED)],
      ['G5-object-literal-then-div', lines(SQL, `const o = {} / 2; // ${UNAVAILABLE}`, DENIED)],
      ['G6-default-export-regex-quote', lines(SQL, `export default /'/.test; // ${UNAVAILABLE}`, DENIED)],
      ['K1-index-div', lines(SQL, `const r = arr[0] / 2; // ${UNAVAILABLE}`, DENIED)],
      ['K2-paren-div', lines(SQL, `const r = (a + b) / 2; // ${UNAVAILABLE}`, DENIED)],
      ['K3-member-div', lines(SQL, `const r = a.b / 2; // ${UNAVAILABLE}`, DENIED)],
      ['K4-postfix-increment-div', lines(SQL, `let n = i++ / 2; // ${UNAVAILABLE}`, DENIED)],
      ['K5-nullish-regex-quote', lines(SQL, `const v = a ?? /'/.exec(s); // ${UNAVAILABLE}`, DENIED)],
      ['K6-and-regex-quote', lines(SQL, `const v = ok && /'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['K7-ternary-regex-quote', lines(SQL, `const v = ok ? /'/ : null; // ${UNAVAILABLE}`, DENIED)],
      ['K8-prefix-not-regex-quote', lines(SQL, `const v = !/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['K9-if-head-not-equal-regex-quote', lines(SQL, `if (a !== b) /'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['K10-regex-statement-after-block', lines(SQL, 'function f() {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['N1-nested-template-apostrophe-then-comment', lines(SQL, "const label = `${ok ? `it's fine` : 'no'}`; // " + UNAVAILABLE, DENIED)],
      ['N3-nested-html-template-then-comment', lines(SQL, "const h = `${xs.map((x) => `<li>${x}</li>`).join('')}`; // " + UNAVAILABLE, DENIED)],
      ['U1-non-ascii-identifier-div-then-comment', lines(SQL, 'const 总数 = 4; const avg = 总数 / 2; // ' + UNAVAILABLE, DENIED)],
      ['C1-simple-template-then-comment', lines(SQL, "const t = `${a}`; // " + UNAVAILABLE, DENIED)],
      ['E1-eof-in-template', lines(SQL, 'const t = `open', UNAVAILABLE)],
    ];
    for (const [name, core] of refused) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).not.toBe(0);
    }
    const accepted: Array<[string, string]> = [
      ['C1-arrow-regex-quote-then-code-marker', lines(SQL, `const f = (s: string) => /'/.test(s); const label = "${UNAVAILABLE}";`, DENIED)],
      ['C2-keyword-named-member-div-then-code-marker', lines(SQL, `const r = stats.in / total; const label = "${UNAVAILABLE}";`, DENIED)],
      ['C3-nonnull-div-then-code-marker', lines(SQL, `const avg = total! / count; const label = "${UNAVAILABLE}";`, DENIED)],
      ['C2-simple-template-then-code-marker', lines(SQL, "const t = `${a}`; const label = '" + UNAVAILABLE + "';", DENIED)],
      ['F1-nested-html-template-then-code-marker', lines(SQL, "const h = `${xs.map((x) => `<li>${x}</li>`).join('')}`; const label = '" + UNAVAILABLE + "';", DENIED)],
    ];
    for (const [name, core] of accepted) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).toBe(0);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

// R9 (attempt-7 return): template text must honour backslash escapes; class/function
// expressions and a bare identifier named of must keep a following slash as division.
test('template escapes, class/function expressions and of-as-ident cannot smuggle markers', () => {
  const roots: string[] = [];
  try {
    const refused: Array<[string, string]> = [
      ['R9-1-escaped-backtick-then-comment', lines(SQL, 'const s = `a\\`b`; // ' + UNAVAILABLE, DENIED)],
      ['R9-2-two-escaped-backticks-then-comment', lines(SQL, 'const s = `\\`x\\``; // ' + UNAVAILABLE, DENIED)],
      ['R9-3-escaped-dollar-brace-then-comment', lines(SQL, 'const s = `\\${`; // ' + UNAVAILABLE, DENIED)],
      ['R9-4-escaped-backslash-close-then-comment', lines(SQL, 'const s = `a\\\\`; // ' + UNAVAILABLE, DENIED)],
      ['R9-6-of-identifier-div-then-comment', lines(SQL, 'const of = 4; const r = of / 2; // ' + UNAVAILABLE, DENIED)],
      ['R9-7-function-expression-div-then-comment', lines(SQL, 'const r = function () {} / 2; // ' + UNAVAILABLE, DENIED)],
      ['R9-8-escaped-backtick-parity-then-comment', lines(SQL, 'const s = `a\\`b`; const t = `c`; // ' + UNAVAILABLE, 'const u = `\\``;', DENIED)],
      ['R9-11-class-expression-div-then-comment', lines(SQL, 'const r = class {} / 2; // ' + UNAVAILABLE, DENIED)],
    ];
    for (const [name, core] of refused) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).not.toBe(0);
    }
    const accepted: Array<[string, string]> = [
      ['R9-5-escaped-backtick-then-code-marker', lines(SQL, "const s = `a\\`b`; const label = '" + UNAVAILABLE + "';", DENIED)],
      ['R9-9-escaped-backtick-parity-then-code-marker', lines(SQL, 'const s = `a\\`b`; const t = `c`; const label = "' + UNAVAILABLE + '";', 'const u = `\\``;', DENIED)],
      ['R9-10-escaped-dollar-brace-then-code-marker', lines(SQL, 'const s = `\\${`; const label = "' + UNAVAILABLE + '";', DENIED)],
    ];
    for (const [name, core] of accepted) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).toBe(0);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

// R10 (attempt-8 return): the reviewer adversarial probe's fail-open rows. A for-of/in head,
// an else/do/try body, a labelled statement, export default and an async function expression
// must keep the following slash in its correct role; otherwise a quote inside the regex body
// opens a string state and a comment-only marker is read as code. Controls put the same marker
// in real code and must stay accepted.
test('for-heads, block bodies, labels, export default and async functions cannot smuggle markers', () => {
  const BT = '`';
  const BS = '\\';
  const D = '$';
  const roots: string[] = [];
  try {
    const refused: Array<[string, string]> = [
      ['forof-regex-quote-comment', lines(SQL, `for (const x of /'/) {} // ${UNAVAILABLE}`, DENIED)],
      ['forof-regex-backtick-comment', lines(SQL, `for (const x of /${BT}/) {} // ${UNAVAILABLE}`, `// ${BT}`, DENIED)],
      ['forin-regex-quote-comment', lines(SQL, `for (const k in /'/) {} // ${UNAVAILABLE}`, DENIED)],
      ['else-block-regex-quote-comment', lines(SQL, 'if (a) { b(); } else { c(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['label-block-regex-quote-comment', lines(SQL, 'foo: { x(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['export-default-function-regex-quote-comment', lines(SQL, 'export default function () {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['async-function-expr-div-quote-comment', lines(SQL, `const f = async function () {} / '/'.length; // ${UNAVAILABLE}`, DENIED)],
      ['try-catch-regex-quote-comment', lines(SQL, 'try { x(); } catch (e) { y(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['try-finally-regex-quote-comment', lines(SQL, 'try { x(); } finally { y(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['do-while-regex-quote-comment', lines(SQL, 'do { x(); } while (y)', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
    ];
    for (const [name, core] of refused) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).not.toBe(0);
    }
    const accepted: Array<[string, string]> = [
      ['forof-regex-quote-code-marker', lines(SQL, `for (const x of /'/) {} const t = '${UNAVAILABLE}';`, DENIED)],
      ['else-regex-quote-code-marker', lines(SQL, 'if (a) { b(); } else { c(); }', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['label-regex-quote-code-marker', lines(SQL, 'foo: { x(); }', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['stmt-class-regex-quote-code-marker', lines(SQL, 'class A {}', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['expr-class-div-code-marker', lines(SQL, `const r = class {} / 2; const t = '${UNAVAILABLE}';`, DENIED)],
      ['tpl-escaped-dollar-code-marker', lines(SQL, 'const s = ' + BT + 'a' + BS + D + '{b}' + BT + "; const t = '" + UNAVAILABLE + "';", DENIED)],
      ['tpl-nested-escape-code-marker', lines(SQL, 'const h = ' + BT + D + '{' + BT + 'x' + BS + BT + 'y' + BT + '}z' + BT + "; const t = '" + UNAVAILABLE + "';", DENIED)],
    ];
    for (const [name, core] of accepted) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).toBe(0);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

// R11 (attempt-9 return): the 18 fail-open rows from the reviewer's 93-case TypeScript-oracle
// probe. Covers export-default-async, statement-start blocks, case/default labels, ??/?. then
// label, reserved in, type aliases, and catch-without-params — each with a code-marker control.
test('export-default-async, statement blocks, case labels, in-operator and type aliases cannot smuggle markers', () => {
  const roots: string[] = [];
  try {
    const refused: Array<[string, string]> = [
      ['a01-export-default-async-anon', lines(SQL, 'export default async function () {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['a02-export-default-async-named', lines(SQL, 'export default async function f() {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['b01-block-after-semi-same-line', lines(SQL, `x(); { y(); } /'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['b02-block-after-semi-newline', lines(SQL, 'x();', '{ y(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['b03-block-after-if-block', lines(SQL, 'if (a) { b(); }', '{ y(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['c01-case-number', lines(SQL, 'switch (a) { case 1: { x(); }', `/'/.test(s); } // ${UNAVAILABLE}`, DENIED)],
      ['c02-case-string', lines(SQL, "switch (a) { case 'a': { x(); }", `/'/.test(s); } // ${UNAVAILABLE}`, DENIED)],
      ['c03-default', lines(SQL, 'switch (a) { default: { x(); }', `/'/.test(s); } // ${UNAVAILABLE}`, DENIED)],
      ['c06-case-number-same-line', lines(SQL, `switch (a) { case 1: { x(); } /'/.test(s); } // ${UNAVAILABLE}`, DENIED)],
      ['q01-nullish-then-label', lines(SQL, 'const v = b ?? c;', 'foo: { x(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['q02-optchain-then-label', lines(SQL, 'const v = b?.c;', 'foo: { x(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['q03-optchain-then-case-ident', lines(SQL, 'const v = b?.c;', 'switch (a) { case x: { x(); }', `/'/.test(s); } // ${UNAVAILABLE}`, DENIED)],
      ['i01-string-in-regex', lines(SQL, `const r = 'a' in /'/.constructor; // ${UNAVAILABLE}`, DENIED)],
      ['i02-ident-in-regex', lines(SQL, `const r = x in /'/.constructor; // ${UNAVAILABLE}`, DENIED)],
      ['i03-in-call-args', lines(SQL, `const r = f('a' in /'/.constructor); // ${UNAVAILABLE}`, DENIED)],
      ['i04-in-inside-for-of-call', lines(SQL, `for (const k of f('a' in /'/.constructor)) {} // ${UNAVAILABLE}`, DENIED)],
      ['t01-type-object-then-regex', lines(SQL, 'type T = { a: 1 }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['k07-try-catch-no-param', lines(SQL, 'try { x(); } catch { y(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
    ];
    for (const [name, core] of refused) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).not.toBe(0);
    }
    const accepted: Array<[string, string]> = [
      ['export-default-async-code', lines(SQL, 'export default async function () {}', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['block-after-semi-code', lines(SQL, 'x();', '{ y(); }', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['case-number-code', lines(SQL, 'switch (a) { case 1: { x(); }', `/'/.test(s); const t = '${UNAVAILABLE}'; }`, DENIED)],
      ['nullish-then-label-code', lines(SQL, 'const v = b ?? c;', 'foo: { x(); }', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['string-in-regex-code', lines(SQL, `const r = 'a' in /'/.constructor; const t = '${UNAVAILABLE}';`, DENIED)],
      ['type-object-code', lines(SQL, 'type T = { a: 1 }', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['catch-no-param-code', lines(SQL, 'try { x(); } catch { y(); }', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
    ];
    for (const [name, core] of accepted) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).toBe(0);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

// R12 (attempt-10 return): adjacent syntax variants of class/interface bodies, function
// bodies and ASI, case ternaries, for-await, and type/annotation line endings. Keep these as
// families because one-token patches leave nearby legal TypeScript fail-open.
test('class/function/type syntax variants cannot smuggle comment markers', () => {
  const roots: string[] = [];
  try {
    const refused: Array<[string, string]> = [
      ['e01-export-default-class-anon', lines(SQL, 'export default class {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['e02-export-default-abstract-class', lines(SQL, 'export default abstract class {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['e03-export-default-class-generic', lines(SQL, 'export default class<T> {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['s01-return-asi-block', lines(SQL, 'function f() { return', '{ y(); }', `/'/.test(s); } // ${UNAVAILABLE}`, DENIED)],
      ['s02-yield-asi-block', lines(SQL, 'function* g() { yield', '{ y(); }', `/'/.test(s); } // ${UNAVAILABLE}`, DENIED)],
      ['s03-void-return-type-body', lines(SQL, 'function f(): void { x(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['s04-promise-void-return-body', lines(SQL, 'async function f(): Promise<void> { x(); }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['s05-class-extends-generic-body', lines(SQL, 'class A extends B<C> {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['s06-class-generic-decl-body', lines(SQL, 'class A<T> {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['s07-interface-generic-body', lines(SQL, 'interface I<T> { a: T }', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['s08-class-implements-generic-body', lines(SQL, 'class A implements B<C> {}', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['c07-case-ternary-label', lines(SQL, 'switch (a) { case b ? 1 : 2: { x(); }', `/'/.test(s); } // ${UNAVAILABLE}`, DENIED)],
      ['o01-for-await-of-regex', lines(SQL, `async function f() { for await (const x of /'/.x) {} } // ${UNAVAILABLE}`, DENIED)],
      ['t02-type-alias-ident-then-regex', lines(SQL, 'type T = string', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['t03-type-alias-qualified-then-regex', lines(SQL, 'type T = A.B', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['t04-type-alias-tuple-then-regex', lines(SQL, 'type T = [a, b]', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['t06-declare-const-annotation-then-regex', lines(SQL, 'declare const x: string', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['t07-let-annotation-then-regex', lines(SQL, 'let x: string', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
      ['t08-let-typeof-annotation-then-regex', lines(SQL, 'let x: typeof y', `/'/.test(s); // ${UNAVAILABLE}`, DENIED)],
    ];
    for (const [name, core] of refused) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).not.toBe(0);
    }
    const accepted: Array<[string, string]> = [
      ['y01-return-asi-block-code', lines(SQL, 'function f() { return', '{ y(); }', `/'/.test(s); } const t = '${UNAVAILABLE}';`, DENIED)],
      ['y02-void-return-body-code', lines(SQL, 'function f(): void { x(); }', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['y03-class-extends-generic-code', lines(SQL, 'class A extends B<C> {}', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['y04-type-alias-string-code', lines(SQL, 'type T = string', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['y05-export-default-class-code', lines(SQL, 'export default class {}', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
      ['y06-for-await-of-code', lines(SQL, `async function f() { for await (const x of /'/.x) {} } const t = '${UNAVAILABLE}';`, DENIED)],
      ['y07-case-ternary-code', lines(SQL, 'switch (a) { case b ? 1 : 2: { x(); }', `/'/.test(s); const t = '${UNAVAILABLE}'; }`, DENIED)],
      ['y08-let-annotation-code', lines(SQL, 'let x: string', `/'/.test(s); const t = '${UNAVAILABLE}';`, DENIED)],
    ];
    for (const [name, core] of accepted) {
      const root = release({ 'src/core.ts': core });
      roots.push(root);
      const result = probe(root);
      expect(result.code, `${name}: ${result.output}`).toBe(0);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);

// R13 (attempt-11 return): the review's A-E families that the previous implementation read as
// code. Each base is a legal TypeScript construct whose lexical state a hand-written lexer reads
// wrongly - a brace inside a class/interface head, a return or yield whose block follows a
// comment or a blank line, the lone ? of an optional parameter, a case value holding an object
// literal, a type alias or an annotation that ends at a line break. The marker sits in a trailing
// comment (the guard must refuse it) or in code (the guard must accept it).
const REVIEW_SAMPLES: Array<[string, string[]]> = [
  ['A01-class-default-generic-object', ['class A<T = {}> {}', "/'/.test(s); @M@"]],
  ['A05-export-default-class-generic-default', ['export default class<T = {}> {}', "/'/.test(s); @M@"]],
  ['A06-declare-class-generic-default', ['declare class A<T = {}> {}', "/'/.test(s); @M@"]],
  ['A08-abstract-class-generic-default', ['abstract class A<T = {}> {}', "/'/.test(s); @M@"]],
  ['B01-function-object-param-return-void', ['function f(x: { a: 1 }): void { x(); }', "/'/.test(s); @M@"]],
  ['B02-function-generic-default-return-void', ['function f<T = {}>(): void { x(); }', "/'/.test(s); @M@"]],
  ['B03-function-destructured-param-return-void', ['function f({ a }: B): void { x(); }', "/'/.test(s); @M@"]],
  ['B06-return-asi-line-comment', ['function f() { return', '// note', '{ y(); }', "/'/.test(s); } @M@"]],
  ['B07-return-asi-blank-line', ['function f() { return', '', '{ y(); }', "/'/.test(s); } @M@"]],
  ['B08-return-asi-block-comment-brace', ['function f() { return', '/* note */ {', 'y(); }', "/'/.test(s); } @M@"]],
  ['B09-yield-asi-blank-line', ['function* g() { yield', '', '{ y(); }', "/'/.test(s); } @M@"]],
  ['B15-param-array-object-type-return-void', ['function f(a: { b: 1 }[]): void { x(); }', "/'/.test(s); @M@"]],
  ['C05-case-ternary-object-value', ['switch (a) { case b ? { c: 1 } : 2: { x(); }', "/'/.test(s); } @M@"]],
  ['C08-optional-param-then-label-block', ['function f(a?) {}', 'foo: { x(); }', "/'/.test(s); } @M@"]],
  ['C09-optional-method-then-label-block', ['class A { m?() {} }', 'foo: { x(); }', "/'/.test(s); } @M@"]],
  ['C10-two-optional-params-then-label-block', ['function f(a?, b?) {}', 'foo: { x(); }', "/'/.test(s); } @M@"]],
  ['E01-type-alias-array-of-object', ['type T = { a: 1 }[]', "/'/.test(s); @M@"]],
  ['E02-type-alias-union-null-after-object', ['type T = { a: 1 } | null', "/'/.test(s); @M@"]],
  ['E03-type-alias-generic-object-array', ['type T = Array<{ a: 1 }>[]', "/'/.test(s); @M@"]],
  ['E05-let-definite-assignment-annotation', ['let x!: string', "/'/.test(s); @M@"]],
  ['E06-declare-function-return-annotation', ['declare function f(): string', "/'/.test(s); @M@"]],
  ['E07-export-declare-function-return', ['export declare function f(): string', "/'/.test(s); @M@"]],
  ['E08-let-object-destructuring-annotation', ['let { a }: Foo', "/'/.test(s); @M@"]],
  ['E09-let-array-destructuring-annotation', ['let [a]: Foo', "/'/.test(s); @M@"]],
];

test('the class, function, case and type families cannot smuggle a comment marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'sck-standby-sample-'));
  const file = join(root, 'sample.ts');
  try {
    for (const [name, base] of REVIEW_SAMPLES) {
      const commented = base.join('\n').replace('@M@', `// ${UNAVAILABLE}`);
      const coded = base.join('\n').replace('@M@', `const t = '${UNAVAILABLE}';`);
      writeFileSync(file, commented);
      const refused = Bun.spawnSync([
        'sh', '-c', '. "$1"; standby_relay_has_code_marker "$2" "$3"',
        'standby-relay-guard-marker-test', GUARD, file, UNAVAILABLE,
      ], { stdout: 'pipe', stderr: 'pipe' });
      expect(refused.exitCode, `${name} (comment): ${refused.stderr.toString()}`).not.toBe(0);
      writeFileSync(file, coded);
      const accepted = Bun.spawnSync([
        'sh', '-c', '. "$1"; standby_relay_has_code_marker "$2" "$3"',
        'standby-relay-guard-marker-test', GUARD, file, UNAVAILABLE,
      ], { stdout: 'pipe', stderr: 'pipe' });
      expect(accepted.exitCode, `${name} (code): ${accepted.stderr.toString()}`).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT);
