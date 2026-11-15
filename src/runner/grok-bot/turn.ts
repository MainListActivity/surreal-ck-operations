/**
 * Grok Bot 网页员工通道：Grok 的 bot 没有 API，只能在 grok.com 网页里聊天。每个 bot 是一个常驻 agent
 * （自带云电脑）且只有一条对话，所以这里把一轮公司任务当成「往这条对话发一条带标记的消息，等 bot 回带标记的终稿」：
 *   发送 `[SCK-TASK <标记>]` + 内联的 task.md → 轮询页面直到 bot 不在 Working 且出现 `[SCK-DONE <标记>]` → 取其后的正文。
 * 浏览器经 ego-browser 驱动老板已登录的 grok.com；每步一个短脚本，不长时间占用浏览器。
 * 发送不是幂等的：发送前先看对话里是否已有本轮标记，有就只轮询不重发。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskMaterial } from '../cloud-lane/lane.ts';

export interface GrokBotConfig {
  /** 命令名 → 绝对路径（{"ego-browser": "/Users/<u>/.local/bin/ego-browser"}）。 */
  bin?: Record<string, string>;
  /** 单轮上限（分钟），默认 120。 */
  maxMinutes?: number;
  /** 轮询间隔毫秒，默认 20000。 */
  pollMs?: number;
}

export interface GrokBotInput {
  /** 派工消息原文（指向 task.md / findings）。 */
  prompt: string;
  /** 员工通道目录：task.md、claim.json 都在这里。 */
  commDir: string;
  /** 站点：grok-bot（默认，固定 bot 对话）；muse-web、chatgpt-web、gemini-web 每轮新建一个对话。 */
  site?: WebSite;
  /** 员工定义的 model：grok-bot 为 bot 的 UUID（grok.com/bot/<UUID>）；muse-web 用 default。 */
  model?: string;
  resumeId?: string;
  config?: GrokBotConfig;
}

/** 一次浏览器脚本调用：返回脚本最后一行 `__RESULT__{json}` 的对象；进程失败/无结果返回 undefined。 */
export type Browse = (script: string, timeoutMs: number) => Promise<Record<string, unknown> | undefined>;

export interface GrokBotDeps {
  browse: Browse;
  now(): number;
  sleep(ms: number): Promise<void>;
  progress(status: string): void;
}
export interface GrokBotOutcome { sessionId: string; status: 'success' | 'error'; text: string }

const BLOCKED = '工作结果：受阻';
/** 不在工作中、也没有本轮终稿，持续这么久才认定 bot 停下了。 */
export const IDLE_GIVE_UP_MS = 5 * 60_000;
const BOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVIEW_PREFIX = /^复核结论：(通过|退回)/;

/** 本轮标记：任务 ID 前 8 位 + 本轮 prompt 摘要，同一轮重启得到同一标记（据此不重发），新一轮换标记。 */
export function turnMarker(taskId: string, message: string): string {
  return `${taskId.replace(/[^0-9a-z]/gi, '').slice(0, 8) || 'task'}-${createHash('sha256').update(message).digest('hex').slice(0, 6)}`;
}

/** 发给 bot 的完整消息：不含本轮 SCK-DONE 标记原文，免得把自己发的消息误认成终稿。 */
export function botMessage(marker: string, material: ReturnType<typeof taskMaterial>): string {
  const parts = [`[SCK-TASK ${marker}]`, ''];
  if (material.review) parts.push('这是复核任务：只读复核，不改动任何东西。最终答复首行必须是「复核结论：通过」或「复核结论：退回」，随后逐条给出证据。', '');
  // 正文就是派工消息（老板看到、改过的那条），指向的文件内容附在后面；没有派工消息时退回到整份任务材料。
  if (material.message) parts.push(material.message, '');
  else {
    if (material.answer !== undefined) parts.push('## 上次受阻与老板的答复（按答复接着做）', material.answer.trim(), '');
    if (material.findings !== undefined) parts.push('## 上一轮的退回意见（逐条修复）', material.findings.trim(), '');
    parts.push(material.task.trim(), '');
  }
  parts.push(
    '你读不到公司本机文件、也调不了公司命令；需要的信息都在上面。产物请直接写在最终答复里，或给出可公开访问的链接。',
    '完成后按约定：最后一条消息以「[SCK-DONE 编号]」开头（编号与本条开头的相同），后面是完整最终答复；无法继续时首行写「工作结果：受阻」并说明缺什么。不要提选择题。');
  return parts.join('\n');
}

function readClaim(commDir: string): { taskId?: string; intent?: string } {
  try {
    const claim = JSON.parse(readFileSync(join(commDir, 'claim.json'), 'utf8')) as { task?: { id?: unknown }; worktree?: { intent?: { kind?: unknown } } };
    return {
      taskId: typeof claim.task?.id === 'string' ? claim.task.id : undefined,
      intent: typeof claim.worktree?.intent?.kind === 'string' ? claim.worktree.intent.kind : undefined,
    };
  } catch { return {}; }
}

// ---- 页面脚本（ego-browser nodejs）。只回状态与终稿文本，不回页面其它内容。 ----

export const WEB_SITES = ['grok-bot', 'muse-web', 'chatgpt-web', 'gemini-web'] as const;
export type WebSite = typeof WEB_SITES[number];
export const isWebSite = (value: unknown): value is WebSite => (WEB_SITES as readonly unknown[]).includes(value);
/** 一个站点里本轮对话的位置：grok 是固定 bot 页；其余站点每轮一个新对话（首轮前为空，发送后记下地址）。 */
export interface WebTarget { site: WebSite; botId?: string; threadUrl?: string }

/**
 * 每个站点一份完整的页面说明。新增站点必须把每一项都写出来：以前按「是不是 grok」二选一，
 * 新站点会悄悄拿到 Muse 的选择器、登录判断和对话地址格式。
 */
interface SiteSpec {
  label: string;
  /** 登录失效时告诉老板去哪个域名重新登录。 */
  loginHint: string;
  input: string;
  /** 没有本轮对话地址时打开的页面。 */
  home(t: WebTarget): string;
  space(t: WebTarget): string;
  /** 页面内表达式：对方还在生成。 */
  working: string;
  /** 页面内表达式：登录墙。 */
  login: string;
  /** 页面就绪还要等到出现的可见元素；空串表示不等。 */
  messageSel: string;
  /** 页面内表达式：读对话文本的根元素。有私人侧栏的站点必须只读对话区，侧栏里的聊天标题不能进入回传的现场文本。 */
  scope: string;
  /** 找终稿元素用的选择器。 */
  doneSel: string;
  /** 每轮新对话的地址格式；固定对话的站点没有。 */
  thread?: RegExp;
  /** 发送前要点的「新建对话」按钮；打开首页就是新对话的站点不需要。 */
  open?: string;
  /** 页面用自己的话说额度用完了（只在对话区文本里找）。 */
  limit?: string;
}

const SITES: Record<WebSite, SiteSpec> = {
  'grok-bot': {
    label: 'Grok Bot', loginHint: 'grok.com',
    input: '[contenteditable=true][role=textbox][aria-label^="Message"]',
    home: t => `https://grok.com/bot/${t.botId}`,
    space: t => `sck-grok-bot-${(t.botId ?? '').slice(0, 8)}`,
    // grok：工作中会挂一个有文字的状态（实测「Working」「On its computer」，以后可能还有别的说法）；
    // 空的状态节点和「已复制」之类的提示不算。
    working: `[...document.querySelectorAll('[role=status]')].some(e => { const t = ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).trim(); return !!t && !/^(Copied|Saved|Notifications)/i.test(t); }) || [...document.querySelectorAll('body *')].some(e => e.childElementCount === 0 && (e.innerText || '').trim() === 'Working')`,
    login: `!location.pathname.startsWith('/bot/') || (/\\b(Sign in|Log in|Sign up)\\b/.test(document.body.innerText.slice(0, 600)) && !document.querySelector('[contenteditable=true][role=textbox]'))`,
    // grok：输入框比消息先出现（实测先有约 200 字的页面框架，消息节点随后以 visibility:hidden 挂上、再变可见），
    // 要等到有可见的消息操作按钮；全新、还没有任何消息的对话等满 10 轮后按就绪处理。
    messageSel: 'button[aria-label="More message actions"]',
    scope: 'document.body', doneSel: 'body *',
  },
  'muse-web': {
    label: 'Muse', loginHint: 'muse.ai',
    input: 'textarea[aria-label="Message"]',
    home: () => 'https://muse.ai/', space: () => 'sck-muse-web',
    // muse 有「Stop task」按钮或「is working / typing」状态。
    working: `!!document.querySelector('button[aria-label="Stop task"]') || [...document.querySelectorAll('[role=status]')].some(e => /typing|working/i.test((e.innerText || '') + (e.getAttribute('aria-label') || '')))`,
    login: `/Log in or create an account/.test(document.body.innerText.slice(0, 2000)) || !!document.querySelector('input[autocomplete="username"],input[type="tel"]')`,
    messageSel: '', scope: 'document.body', doneSel: 'body *',
    thread: /^https:\/\/muse\.ai\/thread\/[0-9a-f-]{36}$/,
    // muse：每轮一个新侧聊，不进老板的主对话。
    open: 'button[aria-label="New side chat"]',
  },
  'chatgpt-web': {
    // 2026-11-14 实测（文字任务一轮约 30 秒）：首页即新对话，发出后地址变成 /c/<uuid>；对话在 <main> 里，侧栏在外面。
    label: 'ChatGPT', loginHint: 'chatgpt.com',
    input: 'div.ProseMirror[role=textbox]',
    home: () => 'https://chatgpt.com/', space: () => 'sck-chatgpt-web',
    // 「Stop」按钮在答完后还会留十几秒（实测与「Response complete」并存），所以最后一轮标成 complete 就算停了。
    working: `(() => { const m = document.querySelector('main'); if (!m || !m.querySelector('button[aria-label="Stop"]')) return false; const turns = m.querySelectorAll('[data-talvt-turn-state]'); return !turns.length || turns[turns.length - 1].getAttribute('data-talvt-turn-state') !== 'complete'; })()`,
    login: `!document.querySelector('div.ProseMirror[role=textbox]') && /\\b(Log in|Sign up)\\b/.test(document.body.innerText.slice(0, 1500))`,
    messageSel: '', scope: `document.querySelector('main')`, doneSel: 'main *',
    thread: /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{36}$/,
    limit: String.raw`You(?:’|')ve (?:hit|reached) (?:your|the)[^.\n]{0,80}limit|reached (?:the|your) (?:message|usage) (?:cap|limit)|limit resets`,
  },
  'gemini-web': {
    // 选择器取自写作通道（src/media/browser-scripts.ts）里已在用的 Gemini 页面结构；聊天员工这条路的发送与取回还没有实测过。
    label: 'Gemini', loginHint: 'gemini.google.com',
    input: 'div.ql-editor[role=textbox]',
    home: () => 'https://gemini.google.com/app', space: () => 'sck-gemini-web',
    working: `[...document.querySelectorAll('button')].some(b => /^Stop/i.test(b.getAttribute('aria-label') || '') && b.offsetParent !== null)`,
    login: `!document.querySelector('div.ql-editor[role=textbox]') && /\\bSign in\\b/.test(document.body.innerText.slice(0, 1500))`,
    messageSel: '', scope: `(document.querySelector('chat-window') ?? document.querySelector('main'))`, doneSel: 'model-response, model-response *',
    thread: /^https:\/\/gemini\.google\.com\/app\/[0-9a-f]{8,40}$/,
    limit: String.raw`reached your[^.\n]{0,40}limit|limit resets|try again (?:later|tomorrow)`,
  },
};

function prelude(t: WebTarget): string {
  const spec = SITES[t.site];
  const url = t.threadUrl ?? spec.home(t);
  const space = spec.space(t);
  const { working, login, input: inputSel, messageSel } = spec;
  return `
const emit = (r) => { console.log('__RESULT__' + JSON.stringify(r)); };
const space = await taskSpace(${JSON.stringify(space)});
const p = (await space.pages())[0] ?? await space.newPage();
// 有的站点（Gemini）load 事件 15 秒内等不到，页面其实已可用：导航超时不算失败，后面的就绪判断说了算。
await p.goto(${JSON.stringify(url)}).catch(() => {});
await p.waitForTimeout(3000);
// 页面就绪：输入框在、消息已渲染、对话文本连续两次读数不变才算加载完；半渲染的页面会被误判成「空闲、没发过」。
let ready = false, prevLen = -1;
for (let i = 0; i < 14 && !ready; i++) {
  const r = await p.evaluate(([sel, msg]) => ({ input: !!document.querySelector(sel), messages: !msg || [...document.querySelectorAll(msg)].some(e => e.checkVisibility({ visibilityProperty: true })), len: (document.body.innerText || '').length, loading: /Loading conversation/i.test(document.body.innerText || '') }), [${JSON.stringify(inputSel)}, ${JSON.stringify(messageSel)}]);
  ready = r.input && !r.loading && (r.messages || i >= 10) && r.len > 0 && r.len === prevLen;
  prevLen = r.input ? r.len : -1;
  if (!ready) await p.waitForTimeout(1500);
}
const read = () => p.evaluate(() => {
  const text = (document.querySelector('main') ?? document.body).innerText || '';
  const all = ((${spec.scope}) ?? { innerText: '' }).innerText || '';
  const buttons = [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim());
  const question = buttons.includes('Skip') && buttons.some(b => /^Submit/.test(b));
  return { text, all, url: location.href, working: ${working}, question, login: ${login} };
});
`;
}

export function stateScript(t: WebTarget, marker: string): string {
  return `${prelude(t)}
const s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
if (!ready) { emit({ ok: false, code: 'not_ready' }); process.exit(0); }
const TASK = ${JSON.stringify(`[SCK-TASK ${marker}]`)}, DONE = ${JSON.stringify(`[SCK-DONE ${marker}]`)};
const task = s.all.lastIndexOf(TASK);
// 长回复会被折叠成「Show more」：先展开含本轮 DONE 标记的消息，再取终稿。
const expanded = await p.evaluate((D) => {
  let n = 0;
  for (const b of document.querySelectorAll('button')) {
    if ((b.innerText || '').trim() !== 'Show more') continue;
    let x = b.parentElement;
    for (let i = 0; i < 6 && x; i++, x = x.parentElement) if ((x.innerText || '').includes(D)) { b.click(); n++; break; }
  }
  return n;
}, DONE);
if (expanded) await p.waitForTimeout(1500);
// 终稿：以本轮 DONE 标记开头的最大元素（整条消息气泡），去掉末尾时间戳和展开/收起按钮字样。
const done = await p.evaluate((D) => {
  const els = [...document.querySelectorAll(${JSON.stringify(SITES[t.site].doneSel)})].filter(e => (e.innerText || '').trimStart().startsWith(D));
  if (!els.length) return null;
  const best = els.reduce((a, b) => ((b.innerText || '').length > (a.innerText || '').length ? b : a));
  return (best.innerText || '').trimStart().slice(D.length)
    .replace(/(\\n\\s*(Show (more|less)|\\d{1,2}:\\d{2}(\\s*[AP]M)?)\\s*)+$/i, '').replace(/\\n\\s*Working\\s*$/, '').trim();
}, DONE);
// 页面用自己的话说额度用完了：只看本轮任务消息之后的对话文本，且还没有终稿。
const LIMIT = ${JSON.stringify(SITES[t.site].limit ?? '')};
if (LIMIT && !done && task >= 0 && new RegExp(LIMIT, 'i').test(s.all.slice(-600))) { emit({ ok: false, code: 'limit_reached', tail: s.all.slice(-300) }); process.exit(0); }
// 终稿只认本轮 DONE 标记（标记含本轮摘要，唯一），不要求本轮任务消息还在页面上：长对话里旧消息会被移出页面。
emit({ ok: true, sent: task >= 0, working: s.working, question: task >= 0 && s.question, done, tail: s.all.slice(task >= 0 ? task : -600).slice(-600) });
`;
}

export function sendScript(t: WebTarget, marker: string, message: string): string {
  const TASK = JSON.stringify(`[SCK-TASK ${marker}]`);
  const spec = SITES[t.site];
  const input = JSON.stringify(spec.input);
  const open = spec.open && !t.threadUrl
    ? `await p.click('css:${spec.open}', { label: 'new chat' });\nawait p.waitForTimeout(3000);\n`
    : '';
  // 每轮新对话的站点：等地址变成对话地址再算发出，执行端据此记下本轮对话在哪。
  const THREAD = JSON.stringify(spec.thread?.source ?? '');
  return `${prelude(t)}
const MSG = ${JSON.stringify(message)};
let s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
if (!ready) { emit({ ok: false, code: 'not_ready' }); process.exit(0); }
if (s.all.includes(${TASK})) { emit({ ok: true, already: true, url: s.url }); process.exit(0); }
if (s.working) { emit({ ok: false, code: 'busy' }); process.exit(0); }
${open}const target = 'css:' + ${input};
const found = await p.evaluate((sel) => !!document.querySelector(sel.slice(4)), target);
if (!found) { emit({ ok: false, code: 'no_input' }); process.exit(0); }
await p.fill(target, MSG);
await p.waitForTimeout(500);
// 按下发送前先打标：脚本之后若超时或崩溃，执行端据此知道「可能已发出」，不再重发。
console.log('${PRESSED}');
await p.press(target, 'Enter');
let url = '';
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(2000);
  s = await read();
  url = s.url;
  if (s.all.includes(${TASK}) && (!${THREAD} || new RegExp(${THREAD}).test(url))) break;
}
emit({ ok: s.all.includes(${TASK}), code: 'not_echoed', url });
`;
}

/** 发送脚本按下 Enter 前打印的标记行：脚本中途失败时据此判断消息可能已发出。 */
export const PRESSED = '__PRESSED__';
function threadFile(commDir: string, marker: string): string { return join(commDir, '.webchat', `${marker}.json`); }
function readThread(commDir: string, marker: string, site: WebSite): string | undefined {
  const url = readRecord(commDir, marker).url;
  return typeof url === 'string' && SITES[site].thread?.test(url) ? url : undefined;
}
function readRecord(commDir: string, marker: string): { url?: unknown; sent?: unknown; attempt?: unknown } {
  try { return JSON.parse(readFileSync(threadFile(commDir, marker), 'utf8')) as { url?: unknown; sent?: unknown; attempt?: unknown }; }
  catch { return {}; }
}
function writeRecord(commDir: string, marker: string, patch: { url?: string; sent?: true; attempt?: boolean }): void {
  mkdirSync(join(commDir, '.webchat'), { recursive: true, mode: 0o700 });
  writeFileSync(threadFile(commDir, marker), JSON.stringify({ ...readRecord(commDir, marker), ...patch }), { mode: 0o600 });
}
function writeThread(commDir: string, marker: string, url: string): void { writeRecord(commDir, marker, { url }); }

/** 一轮网页 agent 执行：确认可接 → 发送（或识别已发送）→ 轮询到终稿/提问/超时。 */
export async function runGrokBotTurn(input: GrokBotInput, deps: GrokBotDeps): Promise<GrokBotOutcome> {
  const site: WebSite = input.site ?? 'grok-bot';
  const spec = SITES[site];
  const label = spec.label;
  const botId = (input.model ?? '').trim().toLowerCase();
  const sessionId = input.resumeId ?? (site === 'grok-bot' ? `grok-bot-${botId.slice(0, 8) || 'unset'}` : `${site}-${crypto.randomUUID()}`);
  const fail = (text: string): GrokBotOutcome => ({ sessionId, status: 'error', text });
  const blocked = (text: string): GrokBotOutcome => ({ sessionId, status: 'success', text: `${BLOCKED}：${text}` });
  if (site === 'grok-bot' && !BOT_ID.test(botId)) return fail('grok-bot 员工定义的 model 必须是 bot 的 UUID（grok.com/bot/<UUID>）');

  const claim = readClaim(input.commDir);
  // 网页 agent 读不到本机工作树，也没有接入公司的 GitHub：代码改动任务不接。
  if (claim.intent === 'code') return blocked(`${label} 网页通道不承接代码改动任务（读不到任务工作树，也没有接入公司的 GitHub）。`);

  const material = taskMaterial(input.commDir, input.prompt);
  const marker = turnMarker(claim.taskId ?? input.commDir, `${input.prompt}\n${material.task}\n${material.findings ?? ''}`);
  const message = botMessage(marker, material);
  const pollMs = input.config?.pollMs ?? 20_000;
  const maxMinutes = input.config?.maxMinutes ?? 120;
  const deadline = deps.now() + maxMinutes * 60_000;
  const target: WebTarget = { site, botId, threadUrl: spec.thread ? readThread(input.commDir, marker, site) : undefined };
  const loginFail = () => fail(`${spec.loginHint} 未登录或登录已过期（需要老板在 ego-browser 里重新登录 ${spec.loginHint}）`);

  // 发送：对方正忙（老板或上一轮在用）就等它空下来；已有本轮标记则不重发。
  // 最多发一次：按下发送前先在本地记「已尝试」，之后无论回显是否确认、脚本是否中途失败、执行端是否重启，
  // 都只等终稿不再发（老板的 bot 里出现重复任务比一轮受阻更糟）。真没发出去时等不到终稿，按受阻收尾。
  const record = readRecord(input.commDir, marker);
  const alreadySent = record.sent === true || record.attempt === true;
  if (alreadySent) deps.progress(`${label} 本轮任务已发出（${marker}），继续等待`);
  for (; !alreadySent;) {
    writeRecord(input.commDir, marker, { attempt: true });
    const sent = await deps.browse(sendScript(target, marker, message), 120_000);
    // 没按下发送（对方忙、页面未就绪、没登录、找不到输入框、浏览器没跑起来）才撤销「已尝试」。
    const pressed = sent?.ok === true || sent?.code === 'not_echoed' || sent?.code === 'pressed';
    if (!pressed) writeRecord(input.commDir, marker, { attempt: false });
    if (spec.thread && typeof sent?.url === 'string' && spec.thread.test(sent.url) && !target.threadUrl) {
      // 先记下侧聊地址再看结果：发出去但回显未确认时，重试回到同一侧聊，不另开新侧聊重复发送。
      target.threadUrl = sent.url;
      writeThread(input.commDir, marker, sent.url);
    }
    if (sent?.ok === true) { writeRecord(input.commDir, marker, { sent: true }); deps.progress(sent.already ? `${label} 已有本轮任务 ${marker}，继续等待` : `已发给 ${label}（${marker}）`); break; }
    if (pressed) { deps.progress(`${label} 已按下发送但未确认回显（${marker}），不重发，等待终稿`); break; }
    if (sent?.code === 'login_required') return loginFail();
    if (sent?.code !== 'busy' && sent?.code !== 'not_ready' && sent?.code !== undefined) return fail(`${label} 发送失败：${String(sent.code)}`);
    // bot 一直在忙（老板在用它）是外部情况，不算通道故障：按受阻收尾，不累计编制的异常次数。
    if (deps.now() > deadline) return sent?.code === 'busy'
      ? blocked(`${label} 在 ${maxMinutes} 分钟内一直在忙（可能在处理老板的事），本轮任务没有发出，空闲后可直接恢复本任务`)
      : fail(`${label} 在 ${maxMinutes} 分钟内页面一直没准备好或浏览器不可用`);
    deps.progress(sent?.code === 'busy' ? `${label} 正在忙，等待空闲后发送` : `${label} 页面未就绪，稍后重试`);
    await deps.sleep(pollMs);
  }

  // 轮询：要求连续两次看到「不在工作中且有同一份终稿」，避免取到还在续写的半截答复。
  let idleSince: number | undefined, settledDone: string | undefined, lastWorking = false, lastTail = '';
  for (;;) {
    await deps.sleep(pollMs);
    const s = await deps.browse(stateScript(target, marker), 90_000);
    if (s?.code === 'login_required') return loginFail();
    // 页面自己说额度用完了：按失败收尾，文案里带 usage limit，执行端据此给这条通道记额度冷却（quota-failure.ts），不再往里派。
    if (s?.code === 'limit_reached') return fail(`${label} 网页版额度已用完（usage limit）。页面提示：${String(s.tail ?? '').slice(-200)}`);
    if (s?.ok === true) {
      const working = s.working === true;
      lastWorking = working; lastTail = String(s.tail ?? '');
      const done = typeof s.done === 'string' && s.done.trim() ? s.done.trim() : undefined;
      if (!working && done) {
        if (settledDone === done) {
          if (material.review && !REVIEW_PREFIX.test(done)) return fail(`${label} 复核答复首行不是「复核结论：通过/退回」，按协议不计为复核结果`);
          // 「工作结果：受阻」开头的终稿也是成功回合：执行端按受阻收尾，不记供应商故障。
          return { sessionId, status: 'success', text: done };
        }
        settledDone = done;
      } else settledDone = undefined;
      if (!working && !done) {
        idleSince ??= deps.now();
        if (s.question === true) return blocked(`${label} 停下来提问，需要人工回答：${String(s.tail ?? '').slice(-400)}`);
        // 多步工作的 bot 会在步骤之间短暂空闲：连续空闲满 IDLE_GIVE_UP_MS 仍没有终稿才按受阻收尾。
        if (deps.now() - idleSince >= IDLE_GIVE_UP_MS) return blocked(`${label} 已停止但没有按约定给出 SCK-DONE 终稿：${String(s.tail ?? '').slice(-400)}`);
      } else idleSince = undefined;
      deps.progress(working ? `${label} 工作中（${marker}）` : done ? `${label} 已给出终稿，确认中` : `${label} 空闲，等待终稿`);
    }
    // 已发出但超时：bot 可能还在做或卡住了。按受阻收尾并带回现场，恢复本任务时只等终稿、不会重发。
    if (deps.now() > deadline) return blocked(`${label} 单轮超过 ${maxMinutes} 分钟上限仍未给出终稿（标记 ${marker}，${lastWorking ? '页面仍显示工作中' : '页面空闲'}）。现场：${lastTail.slice(-300)}`);
  }
}
