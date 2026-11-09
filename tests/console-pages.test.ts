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
      'owner/inbox': { gates: [], questions: [], notices: [] },
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
    // With no saved choice the page must not pin a theme, or the system dark mode never applies.
    expect((document.documentElement as { dataset: Record<string, string> }).dataset.theme).toBeUndefined();
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

/**
 * Runs the console's inline script against a DOM stub. Owner calls are answered from `responses` by path; `status` sets a
 * non-200 status for a path. `click` plays a delegated click and `toggle` a native details toggle, then the page settles.
 */
async function mountConsole(responses: Record<string, unknown>, status: Record<string, number> = {}) {
  const { createConsoleFetch, consoleUrl } = await import('../plugin/server/console.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'console-notes-'));
  const url = consoleUrl(home, () => 'http://console.test');
  const html = await (await createConsoleFetch({ home, company: async () => ({}) } as never)(new Request(url + '/'))).text();
  const body = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const elements = new Map<string, Record<string, unknown>>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', className: '', hidden: false, dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
    return elements.get(id)!;
  };
  const listeners = new Map<string, Array<(event: unknown) => unknown>>();
  const document = { documentElement: element('root'), body: element('body'), getElementById: element,
    addEventListener(type: string, fn: (event: unknown) => unknown) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    querySelector: () => null, querySelectorAll: () => [] };
  const answers: Record<string, unknown> = {
    'api/exchange': { ownerToken: 'fixture' }, 'owner/note.list': { notes: [] }, 'owner/task.list': { tasks: [] },
    'owner/progress': { counts: { done: 0, doing: 0, waiting: 0, blocked: 0, total: 0 }, defects: [], chains: [],
      forecast: { remainingMinutes: 0, basis: 'company', samples: 0, ownerWaiting: 0 } },
    'owner/inbox': { gates: [], questions: [], notices: [] },
    ...responses,
  };
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchStub = async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
    return new Response(JSON.stringify(answers[path] ?? {}), { status: status[path] ?? 200 });
  };
  const windowStub = { addEventListener() {}, matchMedia: () => ({ matches: false }), location: { href: url + '/', search: '', pathname: new URL(url).pathname + '/' } };
  const run = new Function('document', 'fetch', 'window', 'location', 'localStorage', 'matchMedia', 'setInterval', 'setTimeout', body);
  run(document, fetchStub, windowStub, windowStub.location, { getItem: () => null, setItem() {} }, windowStub.matchMedia, () => 0, () => 0);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const settle = async () => { for (let n = 0; n < 50; n++) await tick(); };
  for (let n = 0; n < 50 && element('stat').textContent === ''; n++) await tick();
  await settle();
  const play = async (type: string, event: unknown) => { for (const fn of listeners.get(type) ?? []) await fn(event); await settle(); };
  return {
    element, calls,
    click: (cmd: string) => play('click', { target: { closest: () => ({ dataset: { cmd } }) } }),
    toggle: (id: string, open: boolean) => play('toggle', { target: { dataset: { run: id }, open } }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const LANE = 'surreal_ck:qa';
const merged = {
  id: 'run-1', at: '2026-01-02T03:04:05.000Z', actor: 'system:consolidation', dryRun: false,
  lanes: [{ lane: LANE, active: 4, pinned: 0, merged: 1, agedOut: 1, rewritten: 0, activeAfter: 2 }],
  changes: [
    { note: 'n2', lane: LANE, reason: 'merged', before: { state: 'active', text: '截图要晚于提交' }, after: { state: 'removed', text: '截图要晚于提交' }, mergedInto: 'n1', keptText: '截图证据要晚于最后一次提交' },
    { note: 'n3', lane: LANE, reason: 'aged_out', before: { state: 'active', text: '很旧的经验' }, after: { state: 'removed', text: '很旧的经验' } },
  ],
  undoSkipped: [],
};
const undone = { ...merged, id: 'run-2', undoneAt: '2026-01-03T00:00:00.000Z', undoneBy: 'owner:web',
  undoSkipped: [{ note: 'n9', lane: LANE, reason: 'changed_after_run', text: '老板改过' }] };

test('the notes page lists recorded consolidations with a before and after diff and an undo button', async () => {
  const h = await mountConsole({ 'owner/note.consolidations': { consolidations: [merged] } });
  try {
    await h.click('tab:notes');
    const html = String(h.element('flow-pane').innerHTML);
    expect(html).toContain('最近整理');
    expect(html).toContain('合并 1 条，清理 1 条');
    expect(html).toContain('合并：「截图要晚于提交」 → 并入「截图证据要晚于最后一次提交」');
    expect(html).toContain('清理：「很旧的经验」 → 移出生效');
    expect(html).toContain('data-cmd="note-undo:run-1"');
  } finally { h.cleanup(); }
});

test('undo sends the owner command for that run and reloads; a run already undone offers no button and lists what was skipped', async () => {
  const h = await mountConsole({ 'owner/note.consolidations': { consolidations: [undone, merged] },
    'owner/note.consolidation.undo': { id: 'run-1', undoneAt: '2026-01-03T00:00:00.000Z', restored: 2, skipped: [] } });
  try {
    await h.click('tab:notes');
    const html = String(h.element('flow-pane').innerHTML);
    expect(html).toContain('已撤销');
    expect(html).not.toContain('data-cmd="note-undo:run-2"');
    expect(html).toContain('撤销时跳过 1 条，它们之后又被改过：老板改过');
    const loads = h.calls.filter(call => call.path === 'owner/note.consolidations').length;
    await h.click('note-undo:run-1');
    expect(h.calls.filter(call => call.path === 'owner/note.consolidation.undo')).toEqual([
      { path: 'owner/note.consolidation.undo', body: { command: 'note.consolidation.undo', id: 'run-1' } },
    ]);
    expect(String(h.element('toast').textContent)).toBe('已撤销：恢复 2 条');
    expect(h.calls.filter(call => call.path === 'owner/note.consolidations').length).toBeGreaterThan(loads);
  } finally { h.cleanup(); }
});

test('a refused undo says why, and the record stays in place', async () => {
  const h = await mountConsole({ 'owner/note.consolidations': { consolidations: [merged] },
    'owner/note.consolidation.undo': { error: '这次整理已经撤销过了，不能重复撤销（conflict）' } }, { 'owner/note.consolidation.undo': 409 });
  try {
    await h.click('tab:notes');
    await h.click('note-undo:run-1');
    expect(String(h.element('toast').textContent)).toBe('撤销失败：这次整理已经撤销过了，不能重复撤销（conflict）');
    expect(String(h.element('flow-pane').innerHTML)).toContain('data-cmd="note-undo:run-1"');
  } finally { h.cleanup(); }
});

test('an expanded diff stays expanded when the page redraws every ten seconds', async () => {
  const h = await mountConsole({ 'owner/note.consolidations': { consolidations: [merged] } });
  try {
    await h.click('tab:notes');
    expect(String(h.element('flow-pane').innerHTML)).toContain('<details data-run="run-1">');
    await h.toggle('run-1', true);
    await h.click('refresh');
    expect(String(h.element('flow-pane').innerHTML)).toContain('<details data-run="run-1" open>');
    await h.toggle('run-1', false);
    await h.click('refresh');
    expect(String(h.element('flow-pane').innerHTML)).toContain('<details data-run="run-1">');
  } finally { h.cleanup(); }
});

test('the notes page says when there are no consolidations, and a failed list does not stop the page', async () => {
  const empty = await mountConsole({ 'owner/note.consolidations': { consolidations: [] } });
  try {
    await empty.click('tab:notes');
    expect(String(empty.element('flow-pane').innerHTML)).toContain('还没有整理记录');
  } finally { empty.cleanup(); }
  const failed = await mountConsole({ 'owner/note.consolidations': { error: 'database busy' } }, { 'owner/note.consolidations': 500 });
  try {
    await failed.click('tab:notes');
    expect(String(failed.element('stat').textContent)).toBe('运行中');
    expect(String(failed.element('flow-pane').innerHTML)).toContain('整理记录加载失败：database busy');
  } finally { failed.cleanup(); }
});
