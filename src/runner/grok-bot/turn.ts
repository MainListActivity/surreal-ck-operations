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
  /** 站点：grok-bot（默认，固定 bot 对话）或 muse-web（每轮新建 muse.ai 侧聊）。 */
  site?: 'grok-bot' | 'muse-web';
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
  if (material.findings !== undefined) parts.push('## 上一轮的退回意见（逐条修复）', material.findings.trim(), '');
  parts.push(material.task.trim(), '',
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

export type WebSite = 'grok-bot' | 'muse-web';
/** 一个站点里本轮对话的位置：grok 是固定 bot 页；muse 是本轮专属的侧聊（首轮前为空，发送时新建）。 */
export interface WebTarget { site: WebSite; botId?: string; threadUrl?: string }

const LABEL: Record<WebSite, string> = { 'grok-bot': 'Grok Bot', 'muse-web': 'Muse' };
const LOGIN_HINT: Record<WebSite, string> = { 'grok-bot': 'grok.com', 'muse-web': 'muse.ai' };

function prelude(t: WebTarget): string {
  const url = t.site === 'grok-bot' ? `https://grok.com/bot/${t.botId}` : (t.threadUrl ?? 'https://muse.ai/');
  const space = t.site === 'grok-bot' ? `sck-grok-bot-${(t.botId ?? '').slice(0, 8)}` : 'sck-muse-web';
  // working：grok 主区末尾 Working / status；muse 有「Stop task」按钮或「is working / typing」状态。
  const working = t.site === 'grok-bot'
    ? `[...document.querySelectorAll('[role=status]')].some(e => /Working/.test((e.innerText || '') + (e.getAttribute('aria-label') || ''))) || [...document.querySelectorAll('body *')].some(e => e.childElementCount === 0 && (e.innerText || '').trim() === 'Working')`
    : `!!document.querySelector('button[aria-label="Stop task"]') || [...document.querySelectorAll('[role=status]')].some(e => /typing|working/i.test((e.innerText || '') + (e.getAttribute('aria-label') || '')))`;
  const login = t.site === 'grok-bot'
    ? `!location.pathname.startsWith('/bot/') || (/\\b(Sign in|Log in|Sign up)\\b/.test(document.body.innerText.slice(0, 600)) && !document.querySelector('[contenteditable=true][role=textbox]'))`
    : `/Log in or create an account/.test(document.body.innerText.slice(0, 2000)) || !!document.querySelector('input[autocomplete="username"],input[type="tel"]')`;
  return `
const emit = (r) => { console.log('__RESULT__' + JSON.stringify(r)); };
const space = await taskSpace(${JSON.stringify(space)});
const p = (await space.pages())[0] ?? await space.newPage();
await p.goto(${JSON.stringify(url)});
await p.waitForTimeout(5000);
const read = () => p.evaluate(() => {
  const text = (document.querySelector('main') ?? document.body).innerText || '';
  const all = document.body.innerText || '';
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
  const els = [...document.querySelectorAll('body *')].filter(e => (e.innerText || '').trimStart().startsWith(D));
  if (!els.length) return null;
  const best = els.reduce((a, b) => ((b.innerText || '').length > (a.innerText || '').length ? b : a));
  return (best.innerText || '').trimStart().slice(D.length)
    .replace(/(\\n\\s*(Show (more|less)|\\d{1,2}:\\d{2}(\\s*[AP]M)?)\\s*)+$/i, '').replace(/\\n\\s*Working\\s*$/, '').trim();
}, DONE);
// 终稿只认本轮 DONE 标记（标记含本轮摘要，唯一），不要求本轮任务消息还在页面上：长对话里旧消息会被移出页面。
emit({ ok: true, sent: task >= 0, working: s.working, question: task >= 0 && s.question, done, tail: s.all.slice(task >= 0 ? task : -600).slice(-600) });
`;
}

export function sendScript(t: WebTarget, marker: string, message: string): string {
  const TASK = JSON.stringify(`[SCK-TASK ${marker}]`);
  const input = t.site === 'grok-bot'
    ? `'css:[contenteditable=true][role=textbox][aria-label^="Message"]'`
    : `'css:textarea[aria-label="Message"]'`;
  const open = t.site === 'muse-web' && !t.threadUrl
    // muse：每轮一个新侧聊，不进老板的主对话。
    ? `await p.click('css:button[aria-label="New side chat"]', { label: 'new side chat' });\nawait p.waitForTimeout(3000);\n`
    : '';
  return `${prelude(t)}
const MSG = ${JSON.stringify(message)};
let s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
if (s.all.includes(${TASK})) { emit({ ok: true, already: true, url: s.url }); process.exit(0); }
if (s.working) { emit({ ok: false, code: 'busy' }); process.exit(0); }
${open}const target = ${input};
const found = await p.evaluate((sel) => !!document.querySelector(sel.slice(4)), target);
if (!found) { emit({ ok: false, code: 'no_input' }); process.exit(0); }
await p.fill(target, MSG);
await p.waitForTimeout(500);
await p.press(target, 'Enter');
let url = '';
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(2000);
  s = await read();
  url = s.url;
  if (s.all.includes(${TASK}) && !/\\/thread\\/new$/.test(url)) break;
}
emit({ ok: s.all.includes(${TASK}), code: 'not_echoed', url });
`;
}

const THREAD_URL = /^https:\/\/muse\.ai\/thread\/[0-9a-f-]{36}$/;
function threadFile(commDir: string, marker: string): string { return join(commDir, '.webchat', `${marker}.json`); }
function readThread(commDir: string, marker: string): string | undefined {
  const url = readRecord(commDir, marker).url;
  return typeof url === 'string' && THREAD_URL.test(url) ? url : undefined;
}
function readRecord(commDir: string, marker: string): { url?: unknown; sent?: unknown } {
  try { return JSON.parse(readFileSync(threadFile(commDir, marker), 'utf8')) as { url?: unknown; sent?: unknown }; }
  catch { return {}; }
}
function writeRecord(commDir: string, marker: string, patch: { url?: string; sent?: true }): void {
  mkdirSync(join(commDir, '.webchat'), { recursive: true, mode: 0o700 });
  writeFileSync(threadFile(commDir, marker), JSON.stringify({ ...readRecord(commDir, marker), ...patch }), { mode: 0o600 });
}
function writeThread(commDir: string, marker: string, url: string): void { writeRecord(commDir, marker, { url }); }

/** 一轮网页 agent 执行：确认可接 → 发送（或识别已发送）→ 轮询到终稿/提问/超时。 */
export async function runGrokBotTurn(input: GrokBotInput, deps: GrokBotDeps): Promise<GrokBotOutcome> {
  const site: WebSite = input.site ?? 'grok-bot';
  const label = LABEL[site];
  const botId = (input.model ?? '').trim().toLowerCase();
  const sessionId = input.resumeId ?? (site === 'grok-bot' ? `grok-bot-${botId.slice(0, 8) || 'unset'}` : `muse-web-${crypto.randomUUID()}`);
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
  const target: WebTarget = { site, botId, threadUrl: site === 'muse-web' ? readThread(input.commDir, marker) : undefined };
  const loginFail = () => fail(`${LOGIN_HINT[site]} 未登录或登录已过期（需要老板在 ego-browser 里重新登录 ${LOGIN_HINT[site]}）`);

  // 发送：对方正忙（老板或上一轮在用）就等它空下来；已有本轮标记则不重发。
  // 本地已记下「本轮已发出」时直接去等终稿：bot 对话很长时旧消息可能不在页面上，不能只靠页面判断。
  const alreadySent = readRecord(input.commDir, marker).sent === true;
  if (alreadySent) deps.progress(`${label} 本轮任务已发出（${marker}），继续等待`);
  for (; !alreadySent;) {
    const sent = await deps.browse(sendScript(target, marker, message), 120_000);
    if (site === 'muse-web' && typeof sent?.url === 'string' && THREAD_URL.test(sent.url) && !target.threadUrl) {
      // 先记下侧聊地址再看结果：发出去但回显未确认时，重试回到同一侧聊，不另开新侧聊重复发送。
      target.threadUrl = sent.url;
      writeThread(input.commDir, marker, sent.url);
    }
    if (sent?.ok === true) { writeRecord(input.commDir, marker, { sent: true }); deps.progress(sent.already ? `${label} 已有本轮任务 ${marker}，继续等待` : `已发给 ${label}（${marker}）`); break; }
    if (sent?.code === 'login_required') return loginFail();
    if (sent?.code !== 'busy' && sent?.code !== undefined && sent?.code !== 'not_echoed') return fail(`${label} 发送失败：${String(sent.code)}`);
    if (deps.now() > deadline) return fail(`${label} 在 ${maxMinutes} 分钟内一直没能接收任务（${sent?.code === 'busy' ? '一直在忙' : '发送未成功'}）`);
    deps.progress(sent?.code === 'busy' ? `${label} 正在忙，等待空闲后发送` : `${label} 发送未确认，稍后重试`);
    await deps.sleep(pollMs);
  }

  // 轮询：要求连续两次看到「不在工作中且有同一份终稿」，避免取到还在续写的半截答复。
  let idleWithoutDone = 0, settledDone: string | undefined;
  for (;;) {
    await deps.sleep(pollMs);
    const s = await deps.browse(stateScript(target, marker), 90_000);
    if (s?.code === 'login_required') return loginFail();
    if (s?.ok === true) {
      const working = s.working === true;
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
        idleWithoutDone += 1;
        if (s.question === true) return blocked(`${label} 停下来提问，需要人工回答：${String(s.tail ?? '').slice(-400)}`);
        if (idleWithoutDone >= 6) return blocked(`${label} 已停止但没有按约定给出 SCK-DONE 终稿：${String(s.tail ?? '').slice(-400)}`);
      } else idleWithoutDone = 0;
      deps.progress(working ? `${label} 工作中（${marker}）` : done ? `${label} 已给出终稿，确认中` : `${label} 空闲，等待终稿`);
    }
    if (deps.now() > deadline) return fail(`${label} 单轮超过 ${maxMinutes} 分钟上限（可能仍在工作，标记 ${marker}）`);
  }
}
