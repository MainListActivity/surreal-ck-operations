/**
 * Devin Cloud 网页入口的页面脚本（ego-browser nodejs）与文本解析。
 * DOM 契约：
 * - 首页/会话页的输入框都是 div[role=textbox][aria-label="Prompt"]，发送是 button[aria-label="Send"]（2026-11-16 只读实测）。
 * - Capability 触发按钮：菜单外、innerText 正好是 Fusion/Ultra/Normal/Lite/Free 之一的 button；
 *   弹出层是 [role=menu]，里面 "Capability" 分组下有同名行（2026-11-16 只读实测）。
 * - 选中 Free 后菜单是两层（2026-11-17 负责人真实页面实测）：第一层 Capability 列表仍开；第二层 Free 详情里有
 *   "Free (powered by SWE-2)"、"The plan includes 2 concurrent sessions"、"N/M in use"。Free 项是 role=menuitem。
 *   第一次 Escape 只收详情，列表仍在；第二次才收起列表。
 * - 首页选 Free 用 ego-browser 真实指针点击（page.click，按本次页面里打的 data-sck-* 标记定位）；真实指针选中 Free
 *   已由负责人 2026-11-17 实测确认。推断（未在页面上单独验证）：页内 element.click() 只派发 click 事件、不走指针
 *   按下/抬起，不能当作用户点击；2026-11-17 正式派工的失败签名（按钮停在 Normal、powered=false，Free 行从未被选中）与此一致。
 *   流程（新会话与续轮共用 pickFree）：指针点 Capability（只点唯一的档位名按钮）→ 有界等待可见的 [role=menu]
 *   里恰好一个精确的 Free 行 → 指针点它 → 菜单仍打开时有界回读 Free、powered、N/M in use → 逐层 Escape，
 *   直到可见菜单为 0（最多 4 次，不盲多按）。任何一步不成立都不发送。
 * - 席位文字只在首页 Capability 菜单打开、选中 Free 时出现（收起 Free 详情后消失），所以必须在点选 Free 之后、
 *   菜单仍打开时回读。会话页的 Capability 按钮是 disabled，菜单打不开，读不到席位，续轮因此先到组织首页读席位，再回原会话发送。
 * - 会话地址 https://app.devin.ai/sessions/<32hex>；侧栏 a[href^="/sessions/"] 列出会话。
 * - 会话页转录的发言角色按 2026-11-16 真实只读实测：Devin 回答块是
 *   [data-testid="transcript-agent-message"]，文字在 [data-message-author="devin"]；
 *   用户/自动化消息是 [data-testid="transcript-user-message"]，文字在 [data-message-author="user"]。
 *   工具输出与状态是独立的 [data-testid="transcript-worklog-row"]、PR 卡片等，没有作者属性；
 *   只读核实的一个会话里，worklog 行既不在作者块内，也不在 transcript-agent-message 容器内。
 *   状态行有 "Devin is working"、"Devin is awaiting instructions"、"Devin chose to stop working"、
 *   "blocked on the user"。会话页 Capability 按钮显示该会话的档位（Free）。
 *
 * 终稿只看「本轮收尾约定之后」的 Devin 发言块：用户消息、收尾约定本身的例子、工具输出里的 DONE/PR 都不算。
 * 状态短语只看「最近一次收尾约定之后」的文字：发送前是上一轮之后，发送后是本轮之后；更早轮次残留的状态不算。
 * 找不到作者块时终稿保持 null（不拿整段 main 文本冒充助手回复）。
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
/** 选中 Free 后逐层 Escape 的上限：真实页面两层只需两次，多留余量；仍收不起就受阻、零发送。 */
const FREE_ESC_MAX = 4;
/** 页面内表达式用的可见性判断：有尺寸且未 hidden。 */
const SHOWN_JS = `(e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }`;
/**
 * 页面内表达式：可见的 Capability 菜单里文字恰好是 Free 的行。嵌套时只留最内层，同一行不数两次；
 * 只有恰好一行才算可点。页面内只用 DOM 只读，点击在 Node 侧用 page.click 完成。
 */
const FREE_ROWS_JS = `(() => {
  const shown = ${SHOWN_JS};
  const rows = [...document.querySelectorAll('[role=menu]')].filter(shown)
    .flatMap(m => [...m.querySelectorAll('div,button,[role=menuitem],[role=menuitemradio],[role=option]')])
    .filter(e => (e.innerText || '').trim() === 'Free');
  return rows.filter(e => !rows.some(o => o !== e && e.contains(o)));
})()`;
/** 页面内表达式：当前可见的 [role=menu] 个数。两层菜单要逐层收起，数到 0 才算收起。 */
const MENUS_JS = `[...document.querySelectorAll('[role=menu]')].filter(${SHOWN_JS}).length`;

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
/** 纯文本版状态判定（与页面内 read() 同规则：取最后出现的状态短语）。 */
export function devinStatus(text: string): DevinStatus {
  const hits: Array<[DevinStatus, number]> = [];
  const at = (re: RegExp, status: DevinStatus) => {
    const g = new RegExp(re.source, 'gi');
    let idx = -1, m: RegExpExecArray | null;
    while ((m = g.exec(text))) idx = m.index;
    if (idx >= 0) hits.push([status, idx]);
  };
  at(/Devin is working/, 'working');
  at(/blocked on the user/, 'blocked');
  at(/Devin is awaiting instructions|Devin chose to stop working/, 'idle');
  hits.sort((a, b) => b[1] - a[1]);
  return hits[0]?.[0] ?? 'unknown';
}

/** 页面内 read() 共用的表达式串：状态、席位、选中档位、本轮标记与终稿。DOM 只在 p.evaluate 里访问。 */
function readBody(marker: string): string {
  return `
const read = () => p.evaluate(() => {
  const mainText = ((document.querySelector('main') ?? document.body).innerText || '');
  const body = document.body.innerText || '';
  const TASK = ${JSON.stringify(`[SCK-ROUND ${marker}]`)}, DONE = ${JSON.stringify(`[SCK-DONE ${marker}]`)};
  const QUOTED = ${JSON.stringify(`「[SCK-DONE ${marker}]」`)}, CONV_OPEN = ${JSON.stringify('「[SCK-DONE ')};
  // 选中 Free 时点的那个按钮（已打标记）优先；没有标记才按档位名找，与点击用的是同一个元素。
  const capButton = document.querySelector('[data-sck-cap-trigger]') || [...document.querySelectorAll('button')].find(e => /^(${CAPS.join('|')})$/.test((e.innerText || '').trim()));
  // 发言人只能按页面给出的角色块判定：Devin 回答是 [data-message-author="devin"]，用户消息是
  // [data-message-author="user"]。工具输出、worklog、PR 卡片没有作者属性，永远不参与终稿判定。
  const blocks = [...document.querySelectorAll('[data-message-author]')]
    .map(e => ({ author: String((e.getAttribute && e.getAttribute('data-message-author')) || '').toLowerCase(), text: (e.innerText || '') }))
    .filter(b => b.author !== '');
  let roundStart = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].author === 'user' && blocks[i].text.includes(TASK)) { roundStart = i; break; }
  }
  // 终稿只从本轮用户消息之后的 Devin 发言块里取，并且只认以收尾标记单独成行开头的那条。
  let done = null;
  if (roundStart >= 0) {
    const agents = blocks.slice(roundStart + 1).filter(b => b.author === 'devin');
    for (let i = agents.length - 1; i >= 0 && done === null; i--) {
      const lines = agents[i].text.split('\\n');
      let first = -1;
      for (let j = 0; j < lines.length; j++) { if (lines[j].trim()) { first = j; break; } }
      if (first >= 0 && lines[first].trim().startsWith(DONE)) {
        done = [lines[first].trim().slice(DONE.length), ...lines.slice(first + 1)]
          .filter(l => !/^(Worked|Thought) for /.test(l.trim()))
          .join('\\n').trim();
      }
    }
  }
  // 状态短语只看「最近一次收尾约定」之后的文字：发送前这条约定属于上一轮（上一轮还在跑时状态就在它之后），
  // 发送后就是本轮之后。更早轮次残留的状态短语不算；页面上一条收尾约定都没有时区域为空，状态 unknown。
  const at = mainText.lastIndexOf(QUOTED);
  const lastConv = mainText.lastIndexOf(CONV_OPEN);
  const region = lastConv >= 0 ? mainText.slice(lastConv) : '';
  const lastAt = (re) => { let idx = -1, m; const g = new RegExp(re.source, 'gi'); while ((m = g.exec(region))) idx = m.index; return idx; };
  const hits = [['working', lastAt(/Devin is working/)], ['blocked', lastAt(/blocked on the user/)], ['idle', lastAt(/Devin is awaiting instructions|Devin chose to stop working/)]]
    .filter(h => h[1] >= 0).sort((a, b) => b[1] - a[1]);
  const seats = (body.match(/(\\d+)\\s*\\/\\s*(\\d+)\\s*in use/i) || []).slice(1, 3).map(Number);
  return {
    url: location.href,
    input: !!document.querySelector(${JSON.stringify(INPUT)}),
    login: location.hostname !== 'app.devin.ai'
      || (!document.querySelector(${JSON.stringify(INPUT)}) && /\\b(Log in|Sign in|Sign up|Get started)\\b/i.test(body.slice(0, 2500))),
    cap: capButton ? (capButton.innerText || '').trim() : null,
    powered: /powered by SWE-2/i.test(body),
    seats: seats.length === 2 ? { used: seats[0], total: seats[1] } : null,
    // 没有作者块就无法可靠区分谁说了什么：标记可见性照报，但终稿保持 null，绝不拿整段 main 文本冒充助手回答。
    source: blocks.length ? 'roles' : 'text-only',
    markerSeen: roundStart >= 0 || (blocks.length === 0 && mainText.includes(TASK)),
    convSeen: roundStart >= 0 ? blocks[roundStart].text.includes(QUOTED) : at >= 0,
    status: hits.length ? hits[0][0] : 'unknown',
    done,
    tail: (region.trim() || mainText).slice(-1500),
  };
});`;
}

/**
 * 脚本模式：测试与执行端据此区分发送/跟进/受理核对/轮询脚本。
 * openPage 在同一个标签页里换地址并等它就绪：续轮要先到组织首页读席位，再回原会话发送。
 */
function prelude(url: string, mode: string): string {
  return `
const MODE = ${JSON.stringify(mode)};
const emit = (r) => { console.log('__RESULT__' + JSON.stringify(r)); };
const space = await taskSpace(${JSON.stringify(DEVIN_SPACE)});
const p = (await space.pages())[0] ?? await space.newPage();
${readBody('__MARKER__')}
let ready = false;
// 输入框在，且正文长度连续两次读数一致，才算就绪。
const waitReady = async () => {
  let ok = false, prevLen = -1;
  for (let i = 0; i < 14 && !ok; i++) {
    const r = await p.evaluate(() => ({ input: !!document.querySelector(${JSON.stringify(INPUT)}), len: (document.body.innerText || '').length }));
    ok = r.input && r.len > 0 && r.len === prevLen;
    prevLen = r.input ? r.len : -1;
    if (!ok) await p.waitForTimeout(1500);
  }
  return ok;
};
const openPage = async (target) => {
  await p.goto(target).catch(() => {});
  await p.waitForTimeout(3000);
  ready = await waitReady();
};
await openPage(${JSON.stringify(url)});
`;
}

/** 会话页核验（续轮）：登录、就绪、档位必须是 Free、没有本轮标记、不在忙。返回 null 表示可以继续。 */
const SESSION_GATE = `
const sessionGate = (x) => {
  if (x.login) return { ok: false, code: 'login_required' };
  if (!ready) return { ok: false, code: 'not_ready' };
  if (x.cap !== 'Free') return { ok: false, code: 'capability', detail: '会话 Capability 显示 ' + String(x.cap) + '，不是 Free' };
  if (x.markerSeen) return { ok: true, already: true, url: x.url, cap: 'Free', seats: x.seats };
  if (x.status === 'working') return { ok: false, code: 'busy' };
  return null;
};`;

/**
 * 组织首页选中 Free 并回读（新会话与续轮共用）。顺序：指针点 Capability（只点唯一的档位名按钮）→ 有界等待可见菜单里
 * 恰好一个 Free 行 → 指针点它 → 菜单仍打开时有界回读（席位文字只在此时出现）→ 逐层 Escape 直到可见菜单为 0。
 * 结果写进 s：picked 表示点到了 Free 行，menuStuck 表示有界次数后仍有菜单挡着，pickWhy 写没点到的原因。门禁据此决定发不发。
 */
const PICK_FREE = `
const markCap = () => p.evaluate(() => {
  document.querySelectorAll('[data-sck-cap-trigger]').forEach(e => e.removeAttribute('data-sck-cap-trigger'));
  const caps = [...document.querySelectorAll('button')].filter(e => /^(${CAPS.join('|')})$/.test((e.innerText || '').trim()) && !e.closest('[role=menu]'));
  if (caps.length === 1) caps[0].setAttribute('data-sck-cap-trigger', '1');
  return caps.length;
});
const markFree = () => p.evaluate(() => {
  document.querySelectorAll('[data-sck-free-row]').forEach(e => e.removeAttribute('data-sck-free-row'));
  const rows = ${FREE_ROWS_JS};
  if (rows.length === 1) rows[0].setAttribute('data-sck-free-row', '1');
  return rows.length;
});
const menuCount = () => p.evaluate(() => ${MENUS_JS});
const pickFree = async () => {
  const caps = await markCap();
  let rows = 0;
  if (caps === 1) {
    await p.click('loc=css:[data-sck-cap-trigger]', { label: 'open capability menu' });
    for (let i = 0; i < 10 && rows !== 1; i++) {
      if (i) await p.waitForTimeout(500);
      rows = await markFree();
    }
  }
  if (rows === 1) {
    await p.click('loc=css:[data-sck-free-row]', { label: 'pick free capability' });
    s = await read();
    for (let i = 0; i < 6 && !(s.cap === 'Free' && s.powered && s.seats); i++) { await p.waitForTimeout(500); s = await read(); }
  } else s = await read();
  s.picked = rows === 1;
  if (caps === 1) {
    // 选中 Free 后是两层：第一次 Escape 只收详情，第二次才收列表。只在可见菜单仍在时按一次，按完等 DOM 更新
    // （菜单数变了或超时）再数；数到 0 即停，不盲多按。有界次数后仍有菜单挡着，判为收不起。
    let open = await menuCount();
    for (let i = 0; i < ${FREE_ESC_MAX} && open > 0; i++) {
      await p.keyboard.press('Escape');
      for (let j = 0; j < 6; j++) {
        await p.waitForTimeout(300);
        const now = await menuCount();
        if (now !== open) { open = now; break; }
      }
    }
    s.menuStuck = open > 0;
  }
  s.pickWhy = caps !== 1 ? (caps === 0 ? '页面上找不到唯一的 Capability 按钮' : '页面上有 ' + caps + ' 个档位名按钮，无法确定哪个是 Capability')
    : rows === 0 ? '点开 Capability 后菜单里没有可见的 Free 行'
    : rows > 1 ? '菜单里有 ' + rows + ' 个 Free 行，无法确定' : '';
};`;

/** 组织首页核验（新会话与续轮共用）：点到了 Free 行、选中 Free 且 powered、读得到席位、未满。都不通过就不碰发送按钮。 */
const HOME_GATE = `
const homeGate = (x) => {
  if (x.login) return { ok: false, code: 'login_required' };
  if (!ready) return { ok: false, code: 'not_ready' };
  if (x.menuStuck) return { ok: false, code: 'capability', detail: 'Capability 菜单按 Escape 后仍挡着页面，未发送' };
  if (!x.picked || x.cap !== 'Free' || !x.powered) return { ok: false, code: 'capability', detail: 'Capability 未能确认选中 Free（' + (x.pickWhy || '按钮=' + String(x.cap) + '，powered=' + String(x.powered)) + '）' };
  if (!x.seats) return { ok: false, code: 'capability', detail: '页面读不到 Free 席位计数，无法核验容量' };
  if (x.seats.used >= x.seats.total) return { ok: false, code: 'quota_full', seats: x.seats.used + '/' + x.seats.total, cap: 'Free' };
  return null;
};`;

function withMarker(script: string, marker: string): string {
  return script.replaceAll('__MARKER__', marker);
}

/** 打开会话页读状态：登录、本轮标记、工作状态、席位与 SCK-DONE 终稿（只取本轮收尾约定之后的文字）。 */
export function devinSessionScript(sessionUrl: string, marker: string): string {
  return withMarker(`${prelude(sessionUrl, 'session')}
const s = await read();
if (s.login) { emit({ ok: false, code: 'login_required' }); process.exit(0); }
if (!ready) { emit({ ok: false, code: 'not_ready' }); process.exit(0); }
emit({ ok: true, url: s.url, cap: s.cap, seats: s.seats, source: s.source, markerSeen: s.markerSeen, convSeen: s.convSeen, status: s.status, done: s.done, tail: s.tail });
`, marker);
}

/**
 * 续轮：在原会话里发下一条消息。会话页的 Capability 按钮是 disabled、菜单打不开，读不到席位，
 * 所以先看原会话（Free、没有本轮标记、不在忙），再到组织首页选中 Free 读席位（同新会话的标准），
 * 最后回原会话核验一次才按下发送。会话忙回 busy；席位满回 quota_full；核验不过回 capability；都不碰发送按钮。
 */
export function devinFollowScript(sessionUrl: string, marker: string, message: string, home: string = DEVIN_HOME): string {
  return withMarker(`${prelude(sessionUrl, 'follow')}
const MSG = ${JSON.stringify(message)};
${SESSION_GATE}
${PICK_FREE}
${HOME_GATE}
let s = await read();
const firstStop = sessionGate(s);
if (firstStop) { emit(firstStop); process.exit(0); }
await openPage(${JSON.stringify(home)});
await pickFree();
const homeStop = homeGate(s);
if (homeStop) { emit(homeStop); process.exit(0); }
const pre = s.seats;
await openPage(${JSON.stringify(sessionUrl)});
s = await read();
const againStop = sessionGate(s);
if (againStop) { emit(againStop); process.exit(0); }
const target = 'loc=css:' + ${JSON.stringify(INPUT)};
await p.fill(target, MSG);
await p.waitForTimeout(500);
console.log('${PRESSED}');
await p.click('loc=css:' + ${JSON.stringify(SEND)}, { label: 'send message' });
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(2000);
  s = await read();
  if (s.markerSeen) break;
}
emit(s.markerSeen ? { ok: true, url: s.url, cap: 'Free', seats: pre, echoed: true } : { ok: false, code: 'not_echoed', url: s.url, cap: 'Free', seats: pre });
`, marker);
}

/**
 * 新会话：先按标记查会话列表（中断后已发出的不再重发），再核验 Free 与席位，然后才发送。
 * 席位满回 quota_full；档位无法确认回 capability；两者都不会碰发送按钮。
 * 回执语义：ok 且带会话地址 = 已受理（转录里看到本轮标记）；not_echoed/pressed = 已按下发送但未受理证据，执行端只核对不重发。
 */
export function devinSendScript(home: string, marker: string, message: string): string {
  return withMarker(`${prelude(home, 'send')}
const MSG = ${JSON.stringify(message)};
${PICK_FREE}
${HOME_GATE}
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
if (found) { emit({ ok: true, recovered: found, cap: 'Free' }); process.exit(0); }
// 选中 Free 并在菜单打开时回读席位，然后核验；都不过就不碰发送按钮。
await pickFree();
const stop = homeGate(s);
if (stop) { emit(stop); process.exit(0); }
const pre = s.seats;
const target = 'loc=css:' + ${JSON.stringify(INPUT)};
await p.fill(target, MSG);
await p.waitForTimeout(500);
console.log('${PRESSED}');
await p.click('loc=css:' + ${JSON.stringify(SEND)}, { label: 'send message' });
let url = '';
for (let i = 0; i < 15; i++) {
  await p.waitForTimeout(2000);
  s = await read();
  url = s.url;
  if (${DEVIN_SESSION_RE}.test(url) && s.markerSeen) break;
}
const onSession = ${DEVIN_SESSION_RE}.test(url);
if (onSession && s.markerSeen) emit({ ok: true, url, cap: 'Free', seats: pre, echoed: true });
else if (onSession) emit({ ok: false, code: 'not_echoed', url, cap: 'Free', seats: pre });
else emit({ ok: false, code: 'pressed', cap: 'Free', seats: pre });
`, marker);
}

/**
 * 已按下发送但受理未确认时的核对：会话列表里按本轮标记找，找不到再逐个打开最近几条会话看转录。
 * 只读、绝不发送。列表可能截断，所以「没找到」只是未受理证据不足，执行端据此受阻交人工核对，不重发。
 */
export function devinRecoverScript(home: string, marker: string, probe = 6): string {
  return withMarker(`${prelude(home, 'recover')}
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
emit({ ok: true, found: null, listed: links.length, probed: Math.min(links.length, ${probe}) });
`, marker);
}
