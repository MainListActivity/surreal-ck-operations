/**
 * Devin Cloud 网页入口的页面脚本（ego-browser nodejs）与文本解析。
 * DOM 契约按 2026-11-16 只读实测：
 * - 首页/会话页的输入框都是 div[role=textbox][aria-label="Prompt"]，发送是 button[aria-label="Send"]。
 * - Capability 触发按钮：innerText 正好是 Fusion/Ultra/Normal/Lite/Free 之一的 button；
 *   弹出层是 [role=menu]，里面 "Capability" 分组下有同名行；选中 Free 后页面出现
 *   "Free (powered by SWE-2)"、"The plan includes 2 concurrent sessions"、"N/M in use"。
 * - 会话地址 https://app.devin.ai/sessions/<32hex>；侧栏 a[href^="/sessions/"] 列出会话。
 * - 会话页转录里发言人行是 "Devin:"、"<用户名>:"、"Automation:"；状态行有
 *   "Devin is working"、"Devin is awaiting instructions"、"Devin chose to stop working"、
 *   "blocked on the user"。会话页 Capability 按钮显示该会话的档位（Free）。
 * 发送不是幂等的：按下 Send 前打印 __PRESSED__，脚本中途死掉时执行端知道「可能已发出」，绝不重发，
 * 而是回会话列表/原会话按本轮标记核对是否已受理。
 */

/** Devin 组织首页（公司 org；可用环境变量 SCK_DEVIN_HOME 覆盖）。 */
export const DEVIN_HOME = 'https://app.devin.ai/org/mainlistactivity';
export const DEVIN_SESSION_RE = /^https:\/\/app\.devin\.ai\/sessions\/[0-9a-f-]{8,}/i;
export const DEVIN_SPACE = 'sck-devin-cloud';
const INPUT = 'div[role=textbox][aria-label="Prompt"]';
const SEND = 'button[aria-label="Send"]';
/** 按下发送前打印的标记行（与 grok-bot 通道同值，egoBrowse 据此报 pressed）。 */
export const PRESSED = '__PRESSED__';
/** Capability 档位名：触发按钮与菜单行都按精确文本匹配。 */
const CAPS = ['Fusion', 'Ultra', 'Normal', 'Lite', 'Free'];

export interface DevinSeats { used: number; total: number }
/** "The plan includes 2 concurrent sessions / 1/2 in use" 这类席位文字 → 用量。 */
export function parseSeats(text: string): DevinSeats | undefined {
  const m = /(\d+)\s*\/\s*(\d+)\s*in use/i.exec(text);
  if (!m) return undefined;
  const used = Number(m[1]), total = Number(m[2]);
  return Number.isFinite(used) && Number.isFinite(total) && total > 0 ? { used, total } : undefined;
}

/** 会话状态：working 还在干活；blocked 停下来等用户；idle 一轮结束；unknown 读不出。 */
export type DevinStatus = 'working' | 'idle' | 'blocked' | 'unknown';
export function devinStatus(text: string): DevinStatus {
  if (/Devin is working/i.test(text)) return 'working';
  if (/blocked on the user/i.test(text)) return 'blocked';
  if (/Devin is awaiting instructions|Devin chose to stop working/i.test(text)) return 'idle';
  return 'unknown';
}

/** 页面内 read() 共用的表达式串：状态、席位、选中档位、本轮标记与终稿。DOM 只在 p.evaluate 里访问。 */
function readBody(marker: string): string {
  return `
const read = () => p.evaluate(() => {
  const mainText = ((document.querySelector('main') ?? document.body).innerText || '');
  const body = document.body.innerText || '';
  const TASK = ${JSON.stringify(`[SCK-ROUND ${marker}]`)}, DONE = ${JSON.stringify(`[SCK-DONE ${marker}]`)};
  const capButton = [...document.querySelectorAll('button')].find(e => /^(${CAPS.join('|')})$/.test((e.innerText || '').trim()));
  let done = null;
  const d = mainText.lastIndexOf(DONE);
  if (d >= 0) {
    done = mainText.slice(d + DONE.length)
      .split(/\\n/).filter(l => !/^(Worked|Thought) for |^Devin (is|chose|s)|^Automation:|^Ask Devin|^Computer$|^Free$/.test(l.trim()))
      .join('\\n').trim();
  }
  const seats = (body.match(/(\\d+)\\s*\\/\\s*(\\d+)\\s*in use/i) || []).slice(1, 3).map(Number);
  return {
    url: location.href,
    input: !!document.querySelector(${JSON.stringify(INPUT)}),
    login: location.hostname !== 'app.devin.ai'
      || (!document.querySelector(${JSON.stringify(INPUT)}) && /\\b(Log in|Sign in|Sign up|Get started)\\b/i.test(body.slice(0, 2500))),
    cap: capButton ? (capButton.innerText || '').trim() : null,
    powered: /powered by SWE-2/i.test(body),
    seats: seats.length === 2 ? { used: seats[0], total: seats[1] } : null,
    markerSeen: mainText.includes(TASK),
    status: /Devin is working/i.test(mainText) ? 'working'
      : /blocked on the user/i.test(mainText) ? 'blocked'
      : /Devin is awaiting instructions|Devin chose to stop working/i.test(mainText) ? 'idle' : 'unknown',
    done,
    tail: mainText.slice(-1500),
  };
});`;
}

function prelude(url: string): string {
  return `
const emit = (r) => { console.log('__RESULT__' + JSON.stringify(r)); };
const space = await taskSpace(${JSON.stringify(DEVIN_SPACE)});
const p = (await space.pages())[0] ?? await space.newPage();
await p.goto(${JSON.stringify(url)}).catch(() => {});
await p.waitForTimeout(3000);
${readBody('__MARKER__')}
let ready = false, prevLen = -1;
for (let i = 0; i < 14 && !ready; i++) {
  const r = await p.evaluate(() => ({ input: !!document.querySelector(${JSON.stringify(INPUT)}), len: (document.body.innerText || '').length }));
  ready = r.input && r.len > 0 && r.len === prevLen;
  prevLen = r.input ? r.len : -1;
  if (!ready) await p.waitForTimeout(1500);
}
`;
}

function withMarker(script: string, marker: string): string {
  return script.replaceAll('__MARKER__', marker);
}

/** 打开会话页读状态：登录、本轮标记、工作状态与 SCK-DONE 终稿。 */
export function devinSessionScript(sessionUrl: string, marker: string): string {
  return withMarker(`${prelude(sessionUrl)}
const s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
if (!ready) { emit({ ok: false, code: 'not_ready' }); process.exit(0); }
emit({ ok: true, url: s.url, cap: s.cap, markerSeen: s.markerSeen, status: s.status, done: s.done, tail: s.tail });
`, marker);
}

/** 续轮：在原会话里发下一条消息；会话正忙时回 busy，由执行端等待空闲后重试。 */
export function devinFollowScript(sessionUrl: string, marker: string, message: string): string {
  return withMarker(`${prelude(sessionUrl)}
const MSG = ${JSON.stringify(message)};
let s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
if (!ready) { emit({ ok: false, code: 'not_ready' }); process.exit(0); }
if (s.cap !== 'Free') { emit({ ok: false, code: 'capability', detail: '会话 Capability 显示 ' + String(s.cap) + '，不是 Free' }); process.exit(0); }
if (s.markerSeen) { emit({ ok: true, already: true, url: s.url }); process.exit(0); }
if (s.status === 'working') { emit({ ok: false, code: 'busy' }); process.exit(0); }
const target = 'css:' + ${JSON.stringify(INPUT)};
await p.fill(target, MSG);
await p.waitForTimeout(500);
console.log('${PRESSED}');
await p.click('css:' + ${JSON.stringify(SEND)}, { label: 'send message' });
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(2000);
  s = await read();
  if (s.markerSeen) break;
}
emit({ ok: s.markerSeen, code: s.markerSeen ? undefined : 'not_echoed', url: s.url });
`, marker);
}

/**
 * 新会话：先按标记查会话列表（中断后已发出的不再重发），再核验 Free 与席位，然后才发送。
 * 席位满回 quota_full；档位无法确认回 capability；两者都不会碰发送按钮。
 */
export function devinSendScript(home: string, marker: string, message: string): string {
  return withMarker(`${prelude(home)}
const MSG = ${JSON.stringify(message)};
let s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
if (!ready) { emit({ ok: false, code: 'not_ready' }); process.exit(0); }
const TASK = ${JSON.stringify(`[SCK-ROUND ${marker}]`)};
// 已受理核对的快路：侧栏会话标题带本轮标记（首条消息首行就是标记）。
const found = await p.evaluate((T) => {
  for (const a of document.querySelectorAll('a[href^="/sessions/"]')) {
    if ((a.innerText || '').includes(T)) return a.href;
  }
  return null;
}, TASK);
if (found) { emit({ ok: true, recovered: found }); process.exit(0); }
// 选中 Free：触发按钮不是 Free 时打开 Capability 菜单点 Free 行，然后回读页面文字核验。
if (s.cap !== 'Free') {
  await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /^(Fusion|Ultra|Normal|Lite|Free)$/.test((e.innerText || '').trim())); if (b) b.click(); });
  await p.waitForTimeout(1200);
  await p.evaluate(() => {
    const menu = document.querySelector('[role=menu]');
    const row = menu && [...menu.querySelectorAll('div,button,[role=menuitemradio],[role=option]')].find(e => (e.innerText || '').trim() === 'Free');
    if (row) row.click();
  });
  await p.waitForTimeout(1500);
  s = await read();
}
if (s.cap !== 'Free' || !s.powered) { emit({ ok: false, code: 'capability', detail: 'Capability 未能确认选中 Free（按钮=' + String(s.cap) + '，powered=' + String(s.powered) + '）' }); process.exit(0); }
if (!s.seats) { emit({ ok: false, code: 'capability', detail: '页面读不到 Free 席位计数，无法审计容量' }); process.exit(0); }
if (s.seats.used >= s.seats.total) { emit({ ok: false, code: 'quota_full', seats: s.seats.used + '/' + s.seats.total }); process.exit(0); }
const target = 'css:' + ${JSON.stringify(INPUT)};
await p.fill(target, MSG);
await p.waitForTimeout(500);
console.log('${PRESSED}');
await p.click('css:' + ${JSON.stringify(SEND)}, { label: 'send message' });
let url = '';
for (let i = 0; i < 15; i++) {
  await p.waitForTimeout(2000);
  s = await read();
  url = s.url;
  if (${DEVIN_SESSION_RE}.test(url) && s.markerSeen) break;
}
emit(${DEVIN_SESSION_RE}.test(url) ? { ok: true, url, echoed: s.markerSeen } : { ok: false, code: 'pressed', url });
`, marker);
}

/**
 * 已按下发送但会话地址丢失时的受理核对：会话列表里按本轮标记找，找不到再逐个打开
 * 最近几条会话看转录里有没有标记。只在「可能已发出」后使用，绝不发送。
 */
export function devinRecoverScript(home: string, marker: string, probe = 6): string {
  return withMarker(`${prelude(home)}
const TASK = ${JSON.stringify(`[SCK-ROUND ${marker}]`)};
let s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
if (!ready) { emit({ ok: false, code: 'not_ready' }); process.exit(0); }
const links = await p.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/sessions/"]')].map(a => a.href).filter(Boolean))]);
const hit = await p.evaluate((T) => {
  for (const a of document.querySelectorAll('a[href^="/sessions/"]')) {
    if ((a.innerText || '').includes(T)) return a.href;
  }
  return null;
}, TASK);
if (hit) { emit({ ok: true, found: hit }); process.exit(0); }
for (const url of links.slice(0, ${probe})) {
  await p.goto(url).catch(() => {});
  await p.waitForTimeout(3000);
  const seen = await p.evaluate((T) => ((document.querySelector('main') ?? document.body).innerText || '').includes(T), TASK);
  if (seen) { emit({ ok: true, found: url }); process.exit(0); }
}
emit({ ok: true, found: null, probed: Math.min(links.length, ${probe}) });
`, marker);
}
