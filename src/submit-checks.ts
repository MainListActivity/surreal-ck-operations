import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * System checks an engineering submit to the company repo must pass before any reviewer is spent on it. They catch the
 * defects reviewers returned most often (type errors, the version not raised, a tool registered on one surface only, a
 * test list naming a missing file) and send the submit straight back to its author.
 *
 * Employee code is never executed here: the version and wiring checks only read files and git objects, and the
 * compiler only reads sources. The compiler runs from the service's own release, not from the employee's tree, and
 * inside the employee sandbox profile when one is installed.
 */
export interface SystemCheckInput { worktreePath: string; branch?: string }
export type SystemCheck = (input: SystemCheckInput) => Promise<string[]>;

export type Runner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; out: string }>;

export const runProcess: Runner = (cmd, args, opts) => new Promise(resolve => {
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
  child.stdout.on('data', chunk => { if (out.length < 200_000) out += chunk; });
  child.stderr.on('data', chunk => { if (out.length < 200_000) out += chunk; });
  child.on('error', error => { clearTimeout(timer); resolve({ code: -1, out: String(error) }); });
  child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
});

const SOURCE = /^(src|plugin\/server|plugin\/client|scripts)\//;
/** MCP tools the sidecar serves through its own lease path instead of a `case`. */
const SIDECAR_NATIVE = new Set(['claim_next', 'heartbeat']);

const version = (text: string | undefined): string | undefined => {
  try { const v = JSON.parse(text ?? '').version; return typeof v === 'string' ? v : undefined; } catch { return undefined; }
};
const newer = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
};
const read = (root: string, rel: string): string | undefined => {
  const path = join(root, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

/** Version metadata: a branch that changes code raises package.json past main, and every release file carries that version. */
export async function versionProblems(root: string, run: Runner = runProcess): Promise<string[]> {
  const base = await run('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: root, timeoutMs: 10_000 });
  if (base.code !== 0) return [];
  const changed = await run('git', ['diff', '--name-only', base.out.trim(), '--'], { cwd: root, timeoutMs: 10_000 });
  if (changed.code !== 0 || !changed.out.split('\n').some(file => SOURCE.test(file))) return [];
  const main = await run('git', ['show', 'origin/main:package.json'], { cwd: root, timeoutMs: 10_000 });
  const mainVersion = main.code === 0 ? version(main.out) : undefined;
  const own = version(read(root, 'package.json'));
  const problems: string[] = [];
  if (!own) return ['package.json 没有可读的 version'];
  if (mainVersion && !newer(own, mainVersion)) problems.push(`package.json 版本 ${own} 未高于 main 的 ${mainVersion}：改了代码要提高版本号`);
  for (const rel of ['plugin/package.json', 'company-release.json']) {
    const v = version(read(root, rel));
    if (v !== undefined && v !== own) problems.push(`${rel} 版本 ${v} 与 package.json ${own} 不一致`);
  }
  return problems;
}

/** Tool wiring: every MCP tool reaches the sidecar, and every test file a package script names exists. */
export function wiringProblems(root: string): string[] {
  const problems: string[] = [];
  const server = read(root, 'src/mcp/server.ts'), sidecar = read(root, 'src/runner/sidecar.ts') ?? read(root, 'plugin/server/sidecar.ts');
  if (server && sidecar) {
    const tools = [...server.matchAll(/registerTool\('([a-z_]+)'/g)].map(m => m[1]!);
    const cases = new Set([...sidecar.matchAll(/case "([a-z_]+)":/g)].map(m => m[1]!));
    // The tool tables are the quoted names outside the dispatch `case` labels and their error strings.
    const listed = new Set([...sidecar.replace(/case "[a-z_]+":[^\n]*(\n\s+[?:][^\n]*)*/g, '').matchAll(/"([a-z_]+)"/g)].map(m => m[1]!));
    const unrouted = tools.filter(tool => !SIDECAR_NATIVE.has(tool) && !cases.has(tool));
    if (unrouted.length) problems.push(`MCP 工具未接到 sidecar 分发：${unrouted.join('、')}`);
    const unlisted = tools.filter(tool => !SIDECAR_NATIVE.has(tool) && cases.has(tool) && !listed.has(tool));
    if (unlisted.length) problems.push(`MCP 工具未列入 sidecar 工具表：${unlisted.join('、')}`);
  }
  const pkg = read(root, 'package.json');
  if (pkg) {
    let scripts: Record<string, string> = {};
    try { scripts = JSON.parse(pkg).scripts ?? {}; } catch { return [...problems, 'package.json 不是合法 JSON']; }
    const missing = [...new Set(Object.values(scripts).flatMap(s => s.match(/tests\/[\w.-]+\.ts/g) ?? []))].filter(f => !existsSync(join(root, f)));
    if (missing.length) problems.push(`package.json 测试脚本引用了不存在的文件：${missing.join('、')}`);
  }
  return problems;
}

/** Type errors, from the service's own compiler; the first lines of output are enough to act on. */
export async function typeProblems(root: string, opts: { bun: string; tsc: string; sandbox?: string; home?: string; service?: string }, run: Runner = runProcess): Promise<string[]> {
  const cmd = [opts.bun, opts.tsc, '--noEmit', '-p', join(root, 'tsconfig.json')];
  const [bin, ...args] = opts.sandbox && opts.home && opts.service
    ? ['/usr/bin/sandbox-exec', '-f', opts.sandbox, '-D', `HOME=${opts.home}`, '-D', `SERVICE=${opts.service}`, ...cmd] : cmd;
  const result = await run(bin!, args, { cwd: root, timeoutMs: 120_000 });
  if (result.code === 0) return [];
  // A tree without its packages installed reports cascades of errors that are not the author's: skip, the reviewer still checks.
  if (/error TS2307: Cannot find module '[^.]|error TS2688/.test(result.out)) return [];
  const errors = result.out.split('\n').filter(line => /error TS\d+/.test(line));
  // A compiler that could not run (killed, missing) is not the author's defect either.
  if (!errors.length) return [];
  return [`tsc 报 ${errors.length} 个类型错误：${errors.slice(0, 5).join('；')}`];
}

/** The production check: version, wiring and types, read from the employee's tree. */
export function createSystemCheck(opts: { serviceHome: string; home: string }, run: Runner = runProcess): SystemCheck {
  const active = join(opts.serviceHome, 'active');
  const bun = join(opts.serviceHome, 'runtime-bun/bin/bun');
  const tsc = join(active, 'node_modules/typescript/bin/tsc');
  const sandbox = join(opts.serviceHome, 'sandbox/employee.sb');
  return async ({ worktreePath }) => {
    if (!existsSync(join(worktreePath, 'package.json'))) return [];
    const problems = [...await versionProblems(worktreePath, run), ...wiringProblems(worktreePath)];
    if (existsSync(bun) && existsSync(tsc) && existsSync(join(worktreePath, 'tsconfig.json'))) {
      problems.push(...await typeProblems(worktreePath,
        { bun, tsc, ...(existsSync(sandbox) ? { sandbox, home: opts.home, service: opts.serviceHome } : {}) }, run));
    }
    return problems;
  };
}
