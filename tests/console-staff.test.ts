import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = Date.parse('2026-05-01T10:00:00Z');
const consoleSrc = readFileSync('plugin/server/console.ts', 'utf8');

/** A board shaped as board.snapshot returns it: eng-1 holds a lease, qa-1 is idle, one queued task has no employee yet. */
function boardFixture(): Record<string, unknown> {
  return {
    at: AT,
    scheduler: { at: AT - 4_000, ageMs: 4_000 },
    runner: { state: 'online', id: 'runner-1', host: 'mac', version: '0.3.80', at: AT - 5_000 },
    employees: [
      {
        id: 'eng-1', name: 'eng-1', role: 'engineering', def: 'eng-1', provider: 'codex', model: 'auto:sol', project: 'surreal_ck',
        now: { state: 'leased', taskId: 't1', title: '实现看板接口', phase: 'execute', leaseStartedAt: AT - 600_000, elapsedSeconds: 600,
          leaseExpiresAt: AT + 1_200_000, leaseActive: true, progress: { at: AT - 120_000, action: 'checkpoint', label: '记录进展', summary: '已接好路由' } },
        next: [{ taskId: 't2', title: '写测试', phase: 'execute', position: 2, eligible: false, reason: '排在第 2 位；依赖已解锁，等租约释放' }],
        outbox: [{ messageId: 'm2', taskId: 't2', title: '写测试', step: 'execute', body: '先读 notes.md。完成写测试。',
          workdirPending: true, hold: false, lang: 'zh', editable: true }],
      },
      {
        id: 'qa-1', name: 'qa-1', role: 'qa', provider: 'codex', model: 'auto:sol',
        now: { state: 'idle', idleSeconds: 1800 }, next: [],
        outbox: [{ messageId: 'm3', taskId: 't3', title: '复核任务', step: 'review', body: '<img src=x onerror=1> 复核任务的原文',
          workdirPending: false, hold: true, lang: 'zh', editable: true }],
      },
    ],
    unassigned: [{ taskId: 't4', title: '排队任务', phase: 'execute', position: 1, blocked: false, eligible: true, reason: '排在第 1 位，可接' }],
    recent: [{ at: AT - 60_000, actor: 'eng-1', action: 'checkpoint', label: '记录进展', taskId: 't1', taskTitle: '实现看板接口' }],
  };
}

type Listener = (event: unknown) => unknown;

/**
 * Runs the console's inline script against a small DOM stub. `responses` answers owner commands by path and may be edited between
 * steps; every POST the page makes is recorded in `posted`.
 */
async function openConsole(responses: Record<string, unknown>) {
  const { createConsoleFetch, consoleUrl } = await import('../plugin/server/console.ts');
  const home = mkdtempSync(join(tmpdir(), 'console-staff-'));
  const url = consoleUrl(home, () => 'http://console.test');
  const html = await (await createConsoleFetch({ home, company: async () => ({}) } as never)(new Request(url + '/'))).text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const elements = new Map<string, Record<string, unknown>>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, { textContent: '', innerHTML: '', value: '', className: '', hidden: false, dataset: {}, style: {},
        classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
    }
    return elements.get(id)!;
  };
  const listeners: Record<string, Listener[]> = {};
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const document = {
    documentElement: element('root'), body: element('body'), activeElement: undefined as unknown,
    getElementById: element, addEventListener(type: string, fn: Listener) { (listeners[type] ??= []).push(fn); },
    querySelector: () => null, querySelectorAll: () => [],
  };
  const fetchStub = async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST' && path.startsWith('owner/')) posted.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(responses[path] ?? {}), { status: 200 });
  };
  const windowStub = { addEventListener() {}, matchMedia: () => ({ matches: false }),
    location: { href: url + '/', search: '', pathname: new URL(url).pathname + '/' } };
  new Function('document', 'fetch', 'window', 'location', 'localStorage', 'matchMedia', 'setInterval', 'setTimeout', script)(
    document, fetchStub, windowStub, windowStub.location, { getItem: () => null, setItem() {} }, windowStub.matchMedia, () => 0, () => 0);
  const settle = async () => { for (let n = 0; n < 100; n++) await new Promise(resolve => setImmediate(resolve)); };
  const fire = async (type: string, event: unknown) => { for (const fn of listeners[type] ?? []) await fn(event); await settle(); };
  /** Clicks an element whose data-cmd is `cmd`; `dataset` carries the element's other data-* fields. */
  const click = (cmd: string, dataset: Record<string, string> = {}) =>
    fire('click', { target: { closest: () => ({ dataset: { cmd, ...dataset } }) } });
  await settle();
  return { element, document, posted, fire, click, settle, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('员工页：执行端状态在顶部；每人一张卡，展示现在、接下来与待发消息原文', async () => {
  const c = await openConsole({ 'api/exchange': { ownerToken: 'fixture' }, 'owner/board.snapshot': boardFixture() });
  try {
    await c.click('tab:staff');
    const pane = String(c.element('flow-pane').innerHTML);
    expect(pane).toContain('执行端在线 · 心跳 5 秒前 · v0.3.80');
    expect(pane).toContain('调度器 4 秒前更新');
    expect(pane.match(/class="decision-card staff-card"/g)).toHaveLength(2);
    // eng-1 holds a lease: the task, its phase, the time used and the last checkpoint.
    expect(pane).toContain('<strong>实现看板接口</strong> · 执行');
    expect(pane).toContain('执行中');
    expect(pane).toContain('已用 10 分钟');
    expect(pane).toContain('最近进展：记录进展 · 2 分钟前 · 已接好路由');
    // qa-1 has no task and has been idle for half an hour.
    expect(pane).toContain('空闲 30 分钟');
    expect(pane).toContain('当前没有领取任务');
    // A next row names its place and the reason the scheduler gave.
    expect(pane).toContain('写测试（执行）· 排在第 2 位；依赖已解锁，等租约释放');
    // The outbox shows the rendered text in an editable box; the workdir hint shows while the path is still pending.
    expect(pane).toContain('<textarea id="ob-m2" data-edit="m2">先读 notes.md。完成写测试。</textarea>');
    expect(pane).toContain('领取任务后会追加工作目录行');
    // A held message says so and offers release.
    expect(pane).toContain('待你放行');
    expect(pane).toContain('data-cmd="release-msg:m3">放行</button>');
    // Message text is shown as text, never as markup.
    expect(pane).toContain('&lt;img src=x onerror=1&gt; 复核任务的原文');
    expect(pane).not.toContain('<img src=x');
    // Unassigned queue and recent activity.
    expect(pane).toContain('排在第 1 位，可接');
    expect(String(c.element('drawer').innerHTML)).toContain('最近动态');
    expect(String(c.element('drawer').innerHTML)).toContain('实现看板接口');
    expect(String(c.element('crumb').textContent)).toBe('员工');
  } finally { c.cleanup(); }
});

test('员工页：保存修改把编辑后的原文交给 message.edit_rendered；放行与需要放行发出对应命令', async () => {
  const c = await openConsole({ 'api/exchange': { ownerToken: 'fixture' }, 'owner/board.snapshot': boardFixture() });
  try {
    await c.click('tab:staff');
    c.element('ob-m2')!.value = '先读 notes.md。完成写测试。\n补充：先跑 bun test。';
    await c.click('staff-save', { msg: 'm2', emp: 'eng-1' });
    expect(c.posted).toContainEqual({ path: 'owner/message.edit_rendered',
      body: { command: 'message.edit_rendered', messageId: 'm2', employeeId: 'eng-1', rendered: '先读 notes.md。完成写测试。\n补充：先跑 bun test。' } });
    await c.click('release-msg:m3');
    expect(c.posted).toContainEqual({ path: 'owner/message.release', body: { command: 'message.release', messageId: 'm3' } });
    await c.click('staff-hold:m2');
    expect(c.posted).toContainEqual({ path: 'owner/message.hold', body: { command: 'message.hold', messageId: 'm2' } });
  } finally { c.cleanup(); }
});

test('员工页：编辑中不重绘，未保存的原文在刷新后保留', async () => {
  const responses: Record<string, unknown> = { 'api/exchange': { ownerToken: 'fixture' }, 'owner/board.snapshot': boardFixture() };
  const c = await openConsole(responses);
  try {
    await c.click('tab:staff');
    await c.fire('input', { target: { dataset: { edit: 'm2' }, value: '改了一半的原文' } });
    c.document.activeElement = { dataset: { edit: 'm2' } };
    responses['owner/board.snapshot'] = { ...boardFixture(), runner: { state: 'offline', at: AT - 900_000 } };
    await c.click('refresh');
    // While the owner types in a message, the page keeps what it shows.
    expect(String(c.element('flow-pane').innerHTML)).toContain('执行端在线');
    c.document.activeElement = undefined;
    await c.click('refresh');
    const pane = String(c.element('flow-pane').innerHTML);
    expect(pane).toContain('执行端离线 · 心跳 15 分钟前');
    expect(pane).toContain('<textarea id="ob-m2" data-edit="m2">改了一半的原文</textarea>');
  } finally { c.cleanup(); }
});

test('员工页：看板读取失败与执行端未知时如实显示', async () => {
  const responses: Record<string, unknown> = { 'api/exchange': { ownerToken: 'fixture' }, 'owner/board.snapshot': { error: 'owner board down' } };
  const c = await openConsole(responses);
  try {
    await c.click('tab:staff');
    expect(String(c.element('flow-pane').innerHTML)).toContain('看板读取失败：owner board down');
    responses['owner/board.snapshot'] = { at: AT, employees: [], unassigned: [], recent: [] };
    await c.click('refresh');
    const pane = String(c.element('flow-pane').innerHTML);
    expect(pane).toContain('执行端未知');
    expect(pane).toContain('还没有在岗员工');
    expect(pane).toContain('调度器还没有写出排队');
  } finally { c.cleanup(); }
});

test('控制台待发消息不计已完成或已作废任务的草稿', async () => {
  const c = await openConsole({
    'api/exchange': { ownerToken: 'fixture' },
    'owner/task.list': { tasks: [
      { id: 'task:⟨open1⟩', title: '开放任务', state: 'doing', executor_role: 'engineering', reviewer_role: 'qa' },
      { id: 'task:⟨done1⟩', title: '已完成任务', state: 'done', executor_role: 'engineering', reviewer_role: 'qa' },
    ] },
    'owner/message.list': { messages: [
      { id: 'm-open', taskId: 'open1', step: 'execute', role: 'engineering', body: '开放任务的原文', state: 'draft', hold: false },
      { id: 'm-done', taskId: 'done1', step: 'execute', role: 'engineering', body: '已完成任务的原文', state: 'draft', hold: false },
      { id: 'm-sent', taskId: 'open1', step: 'review', role: 'qa', body: '已发出的原文', state: 'sent', hold: false },
      // Outside the 300-row task list: not known to be closed, so it still counts.
      { id: 'm-old', taskId: 'old1', step: 'execute', role: 'engineering', body: '列表外任务的原文', state: 'draft', hold: false },
    ] },
  });
  try {
    const drawer = String(c.element('drawer').innerHTML);
    expect(drawer).toContain('待发消息 2');
    expect(drawer).toContain('开放任务的原文');
    expect(drawer).toContain('列表外任务的原文');
    expect(drawer).not.toContain('已完成任务的原文');
    expect(drawer).not.toContain('已发出的原文');
  } finally { c.cleanup(); }
});

test('控制台导航有员工页，员工页只调用老板接口的已有命令', () => {
  expect(consoleSrc).toContain('<button data-t="staff" data-cmd="tab:staff">');
  for (const name of ['board.snapshot', 'message.edit_rendered']) expect(consoleSrc).toContain(`api('${name}'`);
});
