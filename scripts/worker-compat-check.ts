#!/usr/bin/env bun
/**
 * Worker 兼容性检查：从入口出发，用 TypeScript 解析器沿相对路径 import 递归展开依赖图，
 * 找出会让 Cloudflare Worker 运行失败的模块引用（node 内建模块、bun 专有模块、无法静态解析的引用）。
 *
 * 用法：bun scripts/worker-compat-check.ts [入口文件...]（缺省检查 WORKER_ENTRIES）
 *
 * 规则：
 * - import type / export type 只在编译期存在，不计入依赖图。
 * - 唯一允许的 node 内建模块是 node:crypto；其它 node:*、裸内建模块名（fs、path…）、bun:* 一律违规。
 * - 第三方包默认允许（要求是纯 JS）；DENIED_PACKAGES 里的已知 node 依赖直接违规。
 * - 无法解析的相对 import、非字面量的动态 import/require 也算违规，避免漏检。
 *
 * 只检查 import 图，不检查 process、Bun、Buffer 等全局对象的使用。
 */
import { readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const REPO_ROOT = resolve(import.meta.dir, '..');

/** 必须通过检查的入口：owner 命令层、通知/进度模块，以及数据库连接模块 */
export const WORKER_ENTRIES: readonly string[] = [
  'src/owner-api.ts',
  'src/lane-notes.ts',
  'src/outbound-messages.ts',
  'src/task-progress.ts',
  'src/db-connection.ts',
  'owner-end/src/worker.ts',
];

/** 允许出现在依赖图里的 node 内建模块 */
const ALLOWED_BUILTINS = new Set(['node:crypto']);

/** 已知依赖 node 内建模块、不能进入依赖图的第三方包 */
const DENIED_PACKAGES = new Map<string, string>([
  ['undici', '依赖 node:net、node:tls 等内建模块'],
]);

const BUILTIN_NAMES = new Set<string>(builtinModules);

export interface WorkerCompatViolation {
  /** 出问题的文件（相对仓库根；文件不存在的入口则为入口本身） */
  file: string;
  /** 违规的模块说明符 */
  module: string;
  /** 行号，从 1 开始；入口缺失时为 0 */
  line: number;
  /** 从入口到 file 的引入链（相对仓库根，最后一项是 file） */
  chain: string[];
  reason: string;
}

export interface WorkerCompatReport {
  /** 依赖图里所有被解析的源文件（相对仓库根） */
  files: string[];
  /** 依赖图里出现的第三方包名（需人工确认是纯 JS） */
  packages: string[];
  violations: WorkerCompatViolation[];
}

interface ModuleRef {
  /** 模块说明符；动态引用无法取得字面量时为 undefined */
  specifier: string | undefined;
  line: number;
}

function scriptKindOf(file: string): ts.ScriptKind {
  switch (extname(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function literalText(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** 收集文件里运行时会执行的模块引用；跳过 import type / export type。 */
export function collectModuleRefs(file: string, text: string): ModuleRef[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const refs: ModuleRef[] = [];
  const add = (node: ts.Node, specifier: string | undefined): void => {
    refs.push({ specifier, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) add(node, literalText(node.moduleSpecifier));
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier) add(node, literalText(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        add(node, literalText(node.moduleReference.expression));
      }
    } else if (ts.isCallExpression(node) && isDynamicImportOrRequire(node)) {
      add(node, literalText(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

function isDynamicImportOrRequire(node: ts.CallExpression): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  return ts.isIdentifier(node.expression) && node.expression.text === 'require';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier);
}

/** 解析相对路径 import：先按原样找，再补 .ts/.tsx/.js 和 index 文件；.js 后缀按 .ts 源文件找。 */
export function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js')];
  const ext = extname(base);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const stem = base.slice(0, -ext.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  return candidates.find(isFile);
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** 对非相对路径的模块说明符分类：返回违规原因（若违规）和第三方包名（若是包）。 */
export function classifyExternal(specifier: string): { reason?: string; packageName?: string } {
  if (ALLOWED_BUILTINS.has(specifier)) return {};
  if (specifier.startsWith('node:')) {
    return { reason: '禁止的 node 内建模块，Worker 依赖图里只允许 node:crypto' };
  }
  if (specifier === 'bun' || specifier.startsWith('bun:')) {
    return { reason: 'Bun 专有模块，Worker 中不存在' };
  }
  if (BUILTIN_NAMES.has(specifier) || BUILTIN_NAMES.has(specifier.split('/')[0])) {
    return { reason: `裸内建模块名 ${specifier}，Worker 依赖图里只允许 node:crypto` };
  }
  const packageName = packageNameOf(specifier);
  const denied = DENIED_PACKAGES.get(packageName);
  if (denied) return { reason: `第三方包 ${packageName} 不能进入 Worker 依赖图：${denied}`, packageName };
  return { packageName };
}

/**
 * 从入口出发做广度优先遍历，每个文件只解析一次；
 * 因此每条违规的引入链都是从入口到该文件的最短链。
 */
export function checkWorkerCompat(entries: readonly string[] = WORKER_ENTRIES, root: string = REPO_ROOT): WorkerCompatReport {
  const display = (abs: string): string => {
    const rel = relative(root, abs);
    return rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
  };
  // 文件 → 引入它的文件；入口为 null。
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  const violations: WorkerCompatViolation[] = [];
  const packages = new Set<string>();

  const chainOf = (file: string): string[] => {
    const chain: string[] = [];
    let current: string | null | undefined = file;
    while (current) {
      chain.unshift(display(current));
      current = parent.get(current);
    }
    return chain;
  };
  const report = (file: string, ref: ModuleRef, reason: string): void => {
    violations.push({
      file: display(file),
      module: ref.specifier ?? '<非字面量>',
      line: ref.line,
      chain: chainOf(file),
      reason,
    });
  };

  for (const entry of entries) {
    const abs = resolve(root, entry);
    if (parent.has(abs)) continue;
    if (!isFile(abs)) {
      violations.push({ file: entry, module: '<入口>', line: 0, chain: [entry], reason: '入口文件不存在' });
      continue;
    }
    parent.set(abs, null);
    queue.push(abs);
  }

  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    for (const ref of collectModuleRefs(file, readFileSync(file, 'utf8'))) {
      if (ref.specifier === undefined) {
        report(file, ref, '非字面量的动态 import/require，无法静态检查');
        continue;
      }
      if (isRelativeSpecifier(ref.specifier)) {
        const target = resolveRelative(file, ref.specifier);
        if (!target) {
          report(file, ref, '相对路径无法解析，依赖图不完整');
          continue;
        }
        if (!parent.has(target)) {
          parent.set(target, file);
          queue.push(target);
        }
        continue;
      }
      const verdict = classifyExternal(ref.specifier);
      if (verdict.packageName) packages.add(verdict.packageName);
      if (verdict.reason) report(file, ref, verdict.reason);
    }
  }

  return {
    files: queue.map(display),
    packages: [...packages].sort(),
    violations,
  };
}

function formatReport(entries: readonly string[], report: WorkerCompatReport): string {
  const lines = [
    'Worker 兼容性检查',
    `入口：${entries.join('、')}`,
    `依赖文件：${report.files.length} 个；第三方包：${report.packages.join('、') || '无'}`,
  ];
  if (report.violations.length === 0) {
    lines.push('结果：零违规');
    return lines.join('\n');
  }
  lines.push(`结果：发现 ${report.violations.length} 处违规`);
  report.violations.forEach((v, index) => {
    lines.push(`${index + 1}. 文件 ${v.file}${v.line ? `:${v.line}` : ''} → 模块 ${v.module}`);
    lines.push(`   引入链：${v.chain.join(' → ')}`);
    lines.push(`   原因：${v.reason}`);
  });
  return lines.join('\n');
}

if (import.meta.main) {
  const argEntries = process.argv.slice(2);
  const entries = argEntries.length > 0 ? argEntries : WORKER_ENTRIES;
  const report = checkWorkerCompat(entries);
  console.log(formatReport(entries, report));
  process.exit(report.violations.length > 0 ? 1 : 0);
}
