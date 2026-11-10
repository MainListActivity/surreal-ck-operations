import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sidecarToolTable, typeProblems, versionProblems, wiringProblems, type Runner } from '../src/submit-checks.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const write = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const pkg = (version: string) => JSON.stringify({ version, scripts: { test: 'bun test tests/a.test.ts' } });

/** A repo whose origin/main is at `mainVersion`, with a task branch checked out on top of it. */
function repo(mainVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), 'submit-checks-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'package.json', pkg(mainVersion));
  write(root, 'company-release.json', JSON.stringify({ version: mainVersion }));
  write(root, 'tests/a.test.ts', '');
  write(root, 'src/x.ts', 'export {};\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-qb', 'task/abc');
  return root;
}

test('a code change that does not raise the version is refused; docs-only changes are not', async () => {
  const root = repo('0.3.7');
  write(root, 'docs/a.md', 'doc');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'docs');
  expect(await versionProblems(root)).toEqual([]);
  write(root, 'src/x.ts', 'export const y = 1;\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'code');
  expect(await versionProblems(root)).toEqual(['package.json 版本 0.3.7 未高于 main 的 0.3.7：改了代码要提高版本号']);
  // Uncommitted work counts too: the tree is what gets reviewed.
  write(root, 'package.json', pkg('0.3.10'));
  expect(await versionProblems(root)).toEqual(['company-release.json 版本 0.3.7 与 package.json 0.3.10 不一致']);
  write(root, 'company-release.json', JSON.stringify({ version: '0.3.10' }));
  expect(await versionProblems(root)).toEqual([]);
});

test('tool wiring names sidecar tools missing from dispatch and test lists naming missing files', () => {
  const root = repo('1.0.0');
  write(root, 'src/runner/sidecar.ts', 'const BASE_TOOLS = [\n  "alpha", // comment "ignored"\n  "beta",\n];\nswitch (x) { case "alpha": break; }');
  write(root, 'package.json', JSON.stringify({ version: '1.0.0', scripts: { test: 'bun test tests/a.test.ts tests/gone.test.ts' } }));
  expect(wiringProblems(root)).toEqual([
    'sidecar 工具未接到分发：beta',
    'package.json 测试脚本引用了不存在的文件：tests/gone.test.ts',
  ]);
  write(root, 'src/runner/sidecar.ts', 'switch (x) { case "alpha": break; case "beta": break; }\nconst BASE_TOOLS = ["alpha"];');
  expect(wiringProblems(root)).toContain('sidecar 分发了未列入工具表的工具：beta');
});

test('the sidecar tool table is read from the text, never by importing the employee sidecar', () => {
  expect(sidecarToolTable('const BASE_TOOLS = ["get_context", "heartbeat"];\nconst X = ["not_a_tool"];')).toEqual(['get_context', 'heartbeat']);
  expect(sidecarToolTable('no table here')).toEqual([]);
});

test('type errors refuse; a compiler that cannot run or a tree without packages does not', async () => {
  const answer = (code: number, out: string): Runner => async () => ({ code, out });
  const opts = { bun: '/bun', tsc: '/tsc' };
  expect(await typeProblems('/r', opts, answer(0, ''))).toEqual([]);
  expect(await typeProblems('/r', opts, answer(2, "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.")))
    .toEqual(["tsc 报 1 个类型错误：src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'."]);
  expect(await typeProblems('/r', opts, answer(-1, 'killed'))).toEqual([]);
  expect(await typeProblems('/r', opts, answer(2, "src/a.ts(1,1): error TS2307: Cannot find module 'zod'\nsrc/b.ts(2,2): error TS7006: x"))).toEqual([]);
  // A relative import that does not resolve is the author's defect.
  expect(await typeProblems('/r', opts, answer(2, "src/a.ts(1,1): error TS2307: Cannot find module './gone.ts'"))).toHaveLength(1);
  // The compiler runs inside the employee sandbox when one is installed.
  let argv: string[] = [];
  await typeProblems('/r', { ...opts, sandbox: '/s.sb', home: '/h', service: '/svc' }, async (cmd, args) => { argv = [cmd, ...args]; return { code: 0, out: '' }; });
  expect(argv.slice(0, 7)).toEqual(['/usr/bin/sandbox-exec', '-f', '/s.sb', '-D', 'HOME=/h', '-D', 'SERVICE=/svc']);
});
