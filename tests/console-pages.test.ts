import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { relayShellCss } from '../plugin/shared/relay-shell.ts';

const consoleSrc = readFileSync('plugin/server/console.ts', 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(consoleSrc)?.[1] ?? '';

function ownerCommands(): Set<string> {
  const cmds = new Set<string>();
  for (const file of ['src/owner-api.ts', 'plugin/server/owner-api.ts']) {
    for (const m of readFileSync(file, 'utf8').matchAll(/case '([a-z][a-z0-9._]*)'/g)) cmds.add(m[1]);
  }
  return cmds;
}

test('console inline script compiles', () => {
  expect(script.length).toBeGreaterThan(1000);
  expect(() => new Function(script)).not.toThrow();
});

test('every console api() call names an owner command — all writes go through the owner prefix', () => {
  const allowed = ownerCommands();
  const called = new Set<string>();
  for (const m of script.matchAll(/api\('([a-z0-9._-]+)'/g)) called.add(m[1]);
  expect(called.size).toBeGreaterThan(10);
  for (const name of called) expect(allowed.has(name)).toBe(true);
});

test('the console actually loads: every name its load path calls exists at runtime', async () => {
  const { createConsoleFetch, consoleUrl } = await import('../plugin/server/console.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'console-load-'));
  try {
    const url = consoleUrl(home, () => 'http://console.test');
    const html = await (await createConsoleFetch({ home, company: async () => ({}) } as never)(new Request(url + '/'))).text();
    const body = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const elements = new Map<string, Record<string, unknown>>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', className: '', hidden: false, dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
      return elements.get(id)!;
    };
    const document = { documentElement: element('root'), body: element('body'), getElementById: element, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
    // Real shapes: task.list carries record IDs, progress carries bare IDs; the page has to join them.
    const progress = { counts: { done: 1, doing: 0, waiting: 0, blocked: 0, total: 1 }, defects: [],
      forecast: { remainingMinutes: 0, basis: 'company', samples: 1, ownerWaiting: 0 },
      chains: [{ root: 'r1', title: '链一', taskIds: ['r1'], defects: [], counts: { done: 1, doing: 0, waiting: 0, blocked: 0, total: 1 }, forecast: { remainingMinutes: 0, basis: 'chain', samples: 1, ownerWaiting: 0 } }] };
    const responses: Record<string, unknown> = { 'api/exchange': { ownerToken: 'fixture' }, 'owner/progress': progress,
      'owner/inbox': { gates: [], questions: [], notices: [], upgrades: { current: { version: '9.9.9', sha: 'a'.repeat(40) }, items: [] } },
      'owner/task.list': { tasks: [{ id: 'task:⟨r1⟩', title: '链一', state: 'done', executor_role: 'product', reviewer_role: 'qa' }] } };
    const fetchStub = async (path: string) => new Response(JSON.stringify(responses[path] ?? {}), { status: 200 });
    const windowStub = { addEventListener() {}, matchMedia: () => ({ matches: false }), location: { href: url + '/', search: '', pathname: new URL(url).pathname + '/' } };
    const run = new Function('document', 'fetch', 'window', 'location', 'localStorage', 'matchMedia', 'setInterval', 'setTimeout', body);
    run(document, fetchStub, windowStub, windowStub.location, { getItem: () => null, setItem() {} }, windowStub.matchMedia, () => 0, () => 0);
    for (let n = 0; n < 50 && element('stat').textContent === ''; n++) await new Promise(resolve => setImmediate(resolve));
    for (let n = 0; n < 50; n++) await new Promise(resolve => setImmediate(resolve));
    expect(String(element('stat').textContent)).toBe('运行中');
    expect(String(element('flow-pane').innerHTML)).toContain('目标进度');
    expect(String(element('flow-pane').innerHTML)).toContain('已完成 · 1 个任务');
    // AC3: the sidebar shows the installed release, never a literal.
    expect(String(element('release-ver').textContent)).toBe('控制面 · v9.9.9');
    // AC4: the theme switch is never an empty icon-only button.
    expect(String(element('theme-btn').innerHTML)).toContain('theme-label');
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('console ships the shared design tokens, a labelled theme switch and a styled .small button', () => {
  // AC1: colours/sizes come from the shared token file; the shell CSS only re-exports them as variables.
  expect(relayShellCss).toContain('--relay-bg:#0e0f12');
  expect(relayShellCss).toContain('--relay-fs-12:12px');
  expect(relayShellCss).toContain('--relay-r-9:9px');
  expect(relayShellCss).toContain('--relay-sp-8:8px');
  // AC4: the route-table button's `.small` class is defined, and both theme buttons carry text.
  expect(relayShellCss).toContain('.small{');
  expect(relayShellCss).toContain('.theme-label');
  expect(consoleSrc).toContain('class="icon-button theme-toggle"');
  expect(consoleSrc).toContain('theme-label">深色');
  // AC3: no hard-coded release number remains in the console source.
  expect(consoleSrc).not.toContain('v0.3.79');
});
