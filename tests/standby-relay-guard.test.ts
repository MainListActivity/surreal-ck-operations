import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});
