// The standby relay switch guard's scanner.
//
// The guard has to answer one question about a target tree: does this marker occurrence sit in
// CODE or in a COMMENT? A hand-written lexer cannot answer it reliably: every legal TypeScript
// construct adds a lexical state (is this slash a regex or a division, whose brace is this, does
// this colon close a ternary, does this line end a statement), and a state read wrongly turns a
// comment into code - which is exactly the fail-open the guard exists to prevent. So the decision
// is delegated to the repository's own TypeScript parser: it knows the comment ranges of a file,
// and a marker occurrence that is not inside one of those ranges is code (string and template
// text included, because a query marker written in a template literal is real code).
//
// The parser is the same one the release was type-checked with (node_modules/typescript), so the
// guard and the compiler agree on what the source says. When the parser cannot be loaded, or a
// file cannot be read, nothing is decided: the scanner exits 3 and the guard refuses (fail-closed).
//
// Usage (exit codes: 0 the check holds, 1 it does not, 3 the scanner could not decide):
//   standby-relay-scan.mjs marker  <file> <needle>       needle occurs in code
//   standby-relay-scan.mjs pattern <file> <ere>          a code line matches the POSIX ERE
//   standby-relay-scan.mjs batch                          checks on stdin, one per line:
//                                                           <kind>\t<file>\t<needle>
// The verdict is printed on stdout ("yes" holds, "no" does not) and not only encoded in the exit
// code, so a caller can tell a real answer from a runtime that printed nothing. The batch mode
// prints the checks that did not hold after its verdict, so the caller can name them.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// The repository's TypeScript: resolved from this file's parent (the repository root that ships
// the scanner), with createRequire(import.meta.url) as a second chance from the scanner's own
// directory, and the working directory as a last resort. fileURLToPath decodes %20 so a release
// under "$HOME/Library/Application Support/..." still resolves; .pathname alone does not.
// A module that loads but does not expose createSourceFile and ScriptTarget (for example a Bun
// global cache of an incompatible typescript build) is not a parser the guard can use: refuse it
// instead of crashing mid-decision.
function loadTypeScript() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const attempts = [
    () => require(require.resolve('typescript', { paths: [repoRoot] })),
    () => require('typescript'),
    () => require(require.resolve('typescript', { paths: [process.cwd()] })),
  ];
  for (const attempt of attempts) {
    try {
      const candidate = attempt();
      if (
        candidate
        && typeof candidate.createSourceFile === 'function'
        && candidate.ScriptTarget != null
        && typeof candidate.getLeadingCommentRanges === 'function'
        && typeof candidate.getTrailingCommentRanges === 'function'
      ) {
        return candidate;
      }
    } catch {
      // try the next location
    }
  }
  return null;
}

const ts = loadTypeScript();

if (!ts) {
  process.stderr.write('standby-relay-scan: the repository TypeScript parser (node_modules/typescript with createSourceFile/ScriptTarget) is not available\n');
  process.exit(3);
}

// The parser's diagnostics for a source file that ends inside an unterminated construct: a
// template literal (1160) or a block comment (1010). In such a file the parser cannot tell
// template text from a comment, so the guard refuses it instead of guessing.
const UNREADABLE_CODES = new Set([1160, 1010]);

// The comment ranges of one source file. The parser has already decided what a string, a template,
// a regex literal and a division are, so the ranges are the comments and only the comments.
// It also reports whether the file can be read at all: a file that ends inside a template literal
// or inside a block comment is not a TypeScript file the guard can reason about (the parser cannot
// tell a comment from template text there), so it is refused rather than read.
function readSourceFile(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const unreadable = (sourceFile.parseDiagnostics ?? []).some((diagnostic) => UNREADABLE_CODES.has(diagnostic.code));
  const ranges = [];
  const visit = (node) => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      // A token: its leading and trailing trivia hold the comments around it.
      for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) ranges.push(range);
      for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) ranges.push(range);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);
  return { ranges, unreadable };
}

// True when the needle occurs at least once outside every comment range.
function occursInCode(text, ranges, needle) {
  if (!needle) return false;
  let at = text.indexOf(needle);
  while (at !== -1) {
    const inComment = ranges.some((range) => at >= range.pos && at < range.end);
    if (!inComment) return true;
    at = text.indexOf(needle, at + 1);
  }
  return false;
}

// The source with its comment text blanked out. Newlines stay, so an anchored pattern still sees
// one code line per source line; a declaration cannot be assembled across a comment either.
function codeOnly(text, ranges) {
  const ordered = [...ranges].sort((a, b) => a.pos - b.pos);
  let out = '';
  let cursor = 0;
  for (const range of ordered) {
    if (range.pos < cursor) continue;
    out += text.slice(cursor, range.pos);
    out += text.slice(range.pos, range.end).replace(/[^\n]/g, ' ');
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

// POSIX character classes as the guard's patterns spell them.
const POSIX_CLASSES = {
  '[[:space:]]': '\\s',
  '[[:alnum:]]': '[0-9A-Za-z]',
  '[[:digit:]]': '[0-9]',
  '[[:upper:]]': '[A-Z]',
  '[[:lower:]]': '[a-z]',
};

function ereToJs(ere) {
  let out = ere;
  for (const [posix, js] of Object.entries(POSIX_CLASSES)) out = out.split(posix).join(js);
  return out;
}

// True when a code line matches the pattern. The pattern is anchored per line (as the guard's
// declaration probes are), and a pattern the scanner cannot compile holds nothing (fail-closed).
function patternHolds(text, ranges, ere) {
  let expression;
  try {
    expression = new RegExp(ereToJs(ere));
  } catch {
    return false;
  }
  for (const line of codeOnly(text, ranges).split('\n')) {
    if (expression.test(line)) return true;
  }
  return false;
}

function readSource(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function decide(kind, file, needle) {
  const text = readSource(file);
  if (text === null) return { holds: false, reason: `unreadable ${file}` };
  const { ranges, unreadable } = readSourceFile(text, file);
  if (unreadable) return { holds: false, reason: `unreadable ${file} (the source does not close its template or block comment)` };
  const holds = kind === 'pattern' ? patternHolds(text, ranges, needle) : occursInCode(text, ranges, needle);
  return { holds, reason: holds ? '' : `missing ${kind} ${file} ${needle}` };
}

const args = process.argv.slice(2);
const mode = args[0];

if (mode === 'marker' || mode === 'pattern') {
  const [, file, needle] = args;
  if (!file) {
    process.stderr.write(`standby-relay-scan: ${mode} needs a file and a needle\n`);
    process.exit(3);
  }
  const result = decide(mode, file, needle ?? '');
  process.stdout.write(result.holds ? 'yes\n' : 'no\n');
  process.exit(result.holds ? 0 : 1);
} else if (mode === 'batch') {
  const failures = [];
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    process.stderr.write('standby-relay-scan: the batch checks could not be read\n');
    process.exit(3);
  }
  for (const line of input.split('\n')) {
    if (!line.trim()) continue;
    const [kind, file, needle] = line.split('\t');
    if (!kind || !file) {
      failures.push(`malformed check ${line}`);
      continue;
    }
    const result = decide(kind, file, needle ?? '');
    if (!result.holds) failures.push(result.reason);
  }
  process.stdout.write(failures.length ? 'no\n' : 'yes\n');
  for (const failure of failures) process.stdout.write(`${failure}\n`);
  process.exit(failures.length ? 1 : 0);
} else {
  process.stderr.write('standby-relay-scan: usage: marker <file> <needle> | pattern <file> <ere> | batch\n');
  process.exit(3);
}
