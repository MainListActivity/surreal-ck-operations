import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// src/board.ts runs inside the Cloudflare Worker, where no Node built-in exists. The board source names no Node built-in at all, and
// neither does any module it loads at runtime: the walk follows value imports through the whole graph. Type-only imports are erased
// before the Worker runs, so they are not followed (but the board source itself is checked with them included).
const SRC = resolve(import.meta.dir, '..', 'src');
const ENTRY = join(SRC, 'board.ts');
const BUILTIN = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](node:[^'"]*|fs|os|path|child_process|crypto|net|tls|http|https|url|util|events|stream|zlib|buffer|worker_threads|process)['"]/g;
const RELATIVE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const TYPE_ONLY = /^\s*(?:import|export)\s+type\s[^;]*?from\s+['"][^'"]+['"];?/gm;

/** A relative import's file: TypeScript, or a JSON data file (which has no imports of its own). */
function moduleOf(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && (candidate.endsWith('.ts') || candidate.endsWith('.json'))) return candidate;
  }
  return undefined;
}

test('the modules src/board.ts loads at runtime reach no Node built-in module', () => {
  const seen = new Set<string>();
  const queue = [ENTRY];
  const builtins: string[] = [];
  const unresolved: string[] = [];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) continue;
    const runtime = readFileSync(file, 'utf8').replace(TYPE_ONLY, '');
    for (const match of runtime.matchAll(BUILTIN)) builtins.push(`${file.slice(SRC.length + 1)}: ${match[1]}`);
    for (const match of runtime.matchAll(RELATIVE)) {
      const next = moduleOf(file, match[1]!);
      if (next) queue.push(next); else unresolved.push(`${file.slice(SRC.length + 1)}: ${match[1]}`);
    }
  }
  expect(unresolved).toEqual([]);
  expect(builtins).toEqual([]);
  // The walk really reaches the modules the board depends on, so an empty result is not an empty walk.
  const reached = [...seen].map(file => file.slice(SRC.length + 1));
  expect(reached).toEqual(expect.arrayContaining(['board.ts', 'dispatcher/brief.ts', 'handover-window.ts', 'outbound-render.ts']));
});

test('src/board.ts itself names no Node built-in, type-only imports included', () => {
  const text = readFileSync(ENTRY, 'utf8');
  expect([...text.matchAll(BUILTIN)].map(match => match[1])).toEqual([]);
  expect(text).not.toMatch(/\bprocess\.|\bBuffer\b|\bnode:/);
});
