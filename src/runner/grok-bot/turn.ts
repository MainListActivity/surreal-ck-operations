/**
 * Grok Bot 网页员工通道：Grok 的 bot 没有 API，只能在 grok.com 网页里聊天。每个 bot 是一个常驻 agent
 * （自带云电脑）且只有一条对话，所以这里把一轮公司任务当成「往这条对话发一条带标记的消息，等 bot 回带标记的终稿」：
 *   发送 `[SCK-TASK <标记>]` + 内联的 task.md → 轮询页面直到 bot 不在 Working 且出现 `[SCK-DONE <标记>]` → 取其后的正文。
 * 浏览器经 ego-browser 驱动老板已登录的 grok.com；每步一个短脚本，不长时间占用浏览器。
 * 发送不是幂等的：发送前先看对话里是否已有本轮标记，有就只轮询不重发。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  /** 员工定义的 model：bot 的 UUID（grok.com/bot/<UUID>）。 */
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

const PRELUDE = (botId: string) => `
const BOT = ${JSON.stringify(botId)};
const emit = (r) => { console.log('__RESULT__' + JSON.stringify(r)); };
const space = await taskSpace('sck-grok-bot-' + BOT.slice(0, 8));
const p = (await space.pages())[0] ?? await space.newPage();
await p.goto('https://grok.com/bot/' + BOT);
await p.waitForTimeout(4500);
const read = () => p.evaluate(() => {
  const main = document.querySelector('main') ?? document.body;
  const text = main.innerText || '';
  const working = /(^|\\n)\\s*Working\\s*$/.test(text) || [...main.querySelectorAll('[role=status]')].some(e => /Working/.test(e.innerText || ''));
  const question = [...main.querySelectorAll('button')].some(b => b.innerText.trim() === 'Skip') && [...main.querySelectorAll('button')].some(b => /^Submit/.test(b.innerText.trim()));
  const login = !location.pathname.startsWith('/bot/') || /\\b(Sign in|Log in|Sign up)\\b/.test(document.body.innerText.slice(0, 600)) && !main.querySelector('textarea,[contenteditable=true]');
  return { text, working, question, login };
});
`;

export function stateScript(botId: string, marker: string): string {
  return `${PRELUDE(botId)}
const s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
const TASK = ${JSON.stringify(`[SCK-TASK ${marker}]`)}, DONE = ${JSON.stringify(`[SCK-DONE ${marker}]`)};
const task = s.text.lastIndexOf(TASK);
const doneAt = s.text.lastIndexOf(DONE);
let done = null;
if (task >= 0 && doneAt > task) {
  done = s.text.slice(doneAt + DONE.length)
    .replace(/\\n\\s*Working\\s*$/, '').replace(/(\\n\\s*\\d{1,2}:\\d{2}\\s*[AP]M\\s*)+$/i, '').trim();
}
const after = task >= 0 ? s.text.slice(task) : '';
emit({ ok: true, sent: task >= 0, working: s.working, question: task >= 0 && s.question, done, tail: after.slice(-600) });
`;
}

export function sendScript(botId: string, marker: string, message: string): string {
  return `${PRELUDE(botId)}
const MSG = ${JSON.stringify(message)};
let s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
if (s.text.includes(${JSON.stringify(`[SCK-TASK ${marker}]`)})) { emit({ ok: true, already: true }); process.exit(0); }
if (s.working) { emit({ ok: false, code: 'busy' }); process.exit(0); }
// 输入框是 ProseMirror 的 contenteditable（快照里叫 textfield）；先用 CSS 定位，再退回快照引用。
let target = 'css:main [contenteditable=true][role=textbox][aria-label^="Message"]';
const hasCss = await p.evaluate(() => !!document.querySelector('main [contenteditable=true][role=textbox][aria-label^="Message"]'));
if (!hasCss) {
  const snap = await p.snapshot();
  const ref = snap.split('\\n').find(l => /textfield|textbox/.test(l) && /Message/.test(l) && /ref=/.test(l))?.match(/ref=(\\d+)/)?.[1];
  if (!ref) { emit({ ok: false, code: 'no_input' }); process.exit(0); }
  target = '@' + ref;
}
await p.fill(target, MSG);
await p.waitForTimeout(500);
await p.press(target, 'Enter');
await p.waitForTimeout(3500);
s = await read();
emit({ ok: s.text.includes(${JSON.stringify(`[SCK-TASK ${marker}]`)}), code: 'not_echoed' });
`;
}

/** 一轮 Grok Bot 执行：确认可接 → 发送（或识别已发送）→ 轮询到终稿/提问/超时。 */
export async function runGrokBotTurn(input: GrokBotInput, deps: GrokBotDeps): Promise<GrokBotOutcome> {
  const botId = (input.model ?? '').trim().toLowerCase();
  const sessionId = input.resumeId ?? `grok-bot-${botId.slice(0, 8) || 'unset'}`;
  const fail = (text: string): GrokBotOutcome => ({ sessionId, status: 'error', text });
  const blocked = (text: string): GrokBotOutcome => ({ sessionId, status: 'success', text: `${BLOCKED}：${text}` });
  if (!BOT_ID.test(botId)) return fail('grok-bot 员工定义的 model 必须是 bot 的 UUID（grok.com/bot/<UUID>）');

  const claim = readClaim(input.commDir);
  // bot 没有接公司的 GitHub，也碰不到本机工作树：代码改动任务不接。
  if (claim.intent === 'code') return blocked('Grok Bot 网页通道不承接代码改动任务（bot 读不到任务工作树，也没有接入公司的 GitHub）。');

  const material = taskMaterial(input.commDir, input.prompt);
  const marker = turnMarker(claim.taskId ?? input.commDir, `${input.prompt}\n${material.task}\n${material.findings ?? ''}`);
  const message = botMessage(marker, material);
  const pollMs = input.config?.pollMs ?? 20_000;
  const maxMinutes = input.config?.maxMinutes ?? 120;
  const deadline = deps.now() + maxMinutes * 60_000;

  // 发送：bot 正忙（老板或上一轮在用）就等它空下来；已有本轮标记则不重发。
  for (;;) {
    const sent = await deps.browse(sendScript(botId, marker, message), 90_000);
    if (sent?.ok === true) { deps.progress(sent.already ? `Grok Bot 已有本轮任务 ${marker}，继续等待` : `已发给 Grok Bot（${marker}）`); break; }
    if (sent?.code === 'login_required') return fail('grok.com 未登录或登录已过期（需要老板在 ego-browser 里重新登录 grok.com）');
    if (sent?.code !== 'busy' && sent?.code !== undefined && sent?.code !== 'not_echoed') return fail(`Grok Bot 发送失败：${String(sent.code)}`);
    if (deps.now() > deadline) return fail(`Grok Bot 在 ${maxMinutes} 分钟内一直没能接收任务（${sent?.code === 'busy' ? 'bot 一直在忙' : '发送未成功'}）`);
    deps.progress(sent?.code === 'busy' ? 'Grok Bot 正在忙，等待空闲后发送' : 'Grok Bot 发送未确认，稍后重试');
    await deps.sleep(pollMs);
  }

  // 轮询：要求连续两次看到「不在 Working 且有终稿」，避免取到 bot 还在续写的半截答复。
  let idleWithoutDone = 0, settledDone: string | undefined;
  for (;;) {
    await deps.sleep(pollMs);
    const s = await deps.browse(stateScript(botId, marker), 90_000);
    if (s?.code === 'login_required') return fail('grok.com 登录已过期（需要老板在 ego-browser 里重新登录 grok.com）');
    if (s?.ok === true) {
      const working = s.working === true;
      const done = typeof s.done === 'string' && s.done.trim() ? s.done.trim() : undefined;
      if (!working && done) {
        if (settledDone === done) {
          if (material.review && !REVIEW_PREFIX.test(done)) return fail('Grok Bot 复核答复首行不是「复核结论：通过/退回」，按协议不计为复核结果');
          // 「工作结果：受阻」开头的终稿也是成功回合：执行端按受阻收尾，不记供应商故障。
          return { sessionId, status: 'success', text: done };
        }
        settledDone = done;
      } else settledDone = undefined;
      if (!working && !done) {
        idleWithoutDone += 1;
        if (s.question === true) return blocked(`Grok Bot 停下来提问，需要人工回答：${String(s.tail ?? '').slice(-400)}`);
        if (idleWithoutDone >= 6) return blocked(`Grok Bot 已停止但没有按约定给出 SCK-DONE 终稿：${String(s.tail ?? '').slice(-400)}`);
      } else idleWithoutDone = 0;
      deps.progress(working ? `Grok Bot 工作中（${marker}）` : done ? 'Grok Bot 已给出终稿，确认中' : 'Grok Bot 空闲，等待终稿');
    }
    if (deps.now() > deadline) return fail(`Grok Bot 单轮超过 ${maxMinutes} 分钟上限（bot 可能仍在工作，标记 ${marker}）`);
  }
}
