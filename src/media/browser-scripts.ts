// Provider drivers for the browser media lane. Each builder returns a standalone
// ego-browser script (`ego-browser nodejs -e <script>`): it drives the logged-in
// consumer session (ChatGPT / Gemini / Grok), writes generated media into the
// task's output dir, and prints a single protocol line `__RESULT__{json}`.
// The script never returns page secrets — only file paths and sizes come back.
//
// Failure protocol codes: login_required | limit_reached | failed.
// `login_required` means the human's browser session for that provider expired;
// `limit_reached` means the account-level quota said so in its own words.

interface ScriptArgs {
  kind: 'image' | 'video' | 'notebook';
  prompt: string;
  outDir: string;
  file: string;
  refs: string[];
  seconds?: number;
  timeoutMs: number;
  // notebook lane
  notebookOp?: 'list' | 'create' | 'query' | 'add_source' | 'remove_source' | 'write' | 'recover';
  notebook?: string;   // notebook id (from URL) or title substring
  title?: string;      // source title / new notebook name / remove_source target substring
  text?: string;       // source body for add_source
  chat?: string;       // write op: existing Gemini chat id/url to continue the same conversation
  turn?: number;       // recover op: turn-node index (USER-QUERY position in DOM order)
  model?: string;      // write op: required picker label substring; absent = page default
}

// Shared helpers injected into every provider script.
const HELPERS = /* js */ `
const fs = await import('node:fs');
const path = await import('node:path');
fs.mkdirSync(ARGS.outDir, { recursive: true });
const outPath = path.join(ARGS.outDir, ARGS.file);
const emit = (result) => { console.log('__RESULT__' + JSON.stringify(result)); };
const fail = (code, message) => { emit({ ok: false, code, message: String(message).slice(0, 300) }); process.exit(0); };
const refOf = (snap, re) => snap.match(new RegExp(re + '[^\\\\n]*\\\\[ref=(\\\\d+)\\\\]'))?.[1];
const lastBigImg = () => [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 300).pop();
const saveImg = async (page, dest) => page.evaluate(() => {
  const img = [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 300).pop();
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}).then(data => {
  if (!data) return null;
  fs.writeFileSync(dest, Buffer.from(data.split(',')[1], 'base64'));
  return dest;
});
const saveVideo = async (page, dest, seconds) => {
  // Download button first (original mp4); fall back to captureStream+MediaRecorder (webm realtime).
  const snap = await page.snapshot();
  const dlRef = refOf(snap, 'button "[Dd]ownload');
  if (dlRef) {
    try {
      const wait = page.waitForEvent('download', { timeout: 45000 });
      await page.click('@' + dlRef, { label: 'download generated video' });
      const dl = await wait;
      const tmp = dest + '.dl';
      await dl.saveAs(tmp);
      fs.renameSync(tmp, dest);
      return { path: dest, via: 'download' };
    } catch {}
  }
  const rec = await page.evaluate(async (secs) => {
    const v = [...document.querySelectorAll('video')].pop();
    if (!v) return null;
    const stream = v.captureStream ? v.captureStream() : v.mozCaptureStream?.();
    if (!stream) return null;
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
    const r = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    r.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(res => { r.onstop = res; });
    v.muted = false; v.currentTime = 0;
    await v.play().catch(() => {});
    r.start(250);
    await new Promise(res => setTimeout(res, Math.min((secs || v.duration || 8) * 1000 + 1500, 20000)));
    try { v.pause(); } catch {}
    r.stop();
    await done;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let bin = ''; for (let i = 0; i < bytes.length; i += 65536) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 65536));
    return { b64: btoa(bin), dur: v.duration };
  }, seconds);
  if (!rec?.b64) return null;
  const webm = dest.replace(/\\.mp4$/, '') + '.webm';
  fs.writeFileSync(webm, Buffer.from(rec.b64, 'base64'));
  return { path: webm, via: 'captureStream', dur: rec.dur };
};
const bodyText = (page) => page.evaluate(() => document.body.innerText.slice(-1200));
const hitLimit = (t) => /weekly limit|limit reached|rate limit|quota|try again later|Resets/i.test(t || '');
const loginWall = (t) => /log in|sign in|sign up|couldn't load your account|create account/i.test(t || '');
`;

// Gemini composer model picker (write op). The lane types prompts into whatever
// model the page has selected — with no picker step every new chat lands on the
// account default (Flash-Lite tier), silently degrading drafting quality. Three
// sync steps so the caller controls pacing: open the pill, scan the menu, then
// verify. The pill lives near the composer and matches whole picker phrases only;
// the search climbs from the composer and stops before body/html and before any
// layer that is, or contains, a sidebar/nav landmark, so sidebar lookalikes never
// enter the candidate set and are never clicked.
// 'Gemini 4' resolves through its 'Argon' tier alias (pill, menu, verification).
// Fail-closed: a missing picker/option aborts the write, never silently
// writes on the wrong model. Exported so tests run the same code on a fake DOM.
export const MODEL_PICKER = /* js */ `
const mNorm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
const mVis = (el) => !!el && (typeof el.offsetParent === 'undefined' || el.offsetParent !== null || (el.getClientRects ? el.getClientRects().length > 0 : true));
// Composer pill matchers: the live label reads 'Open mode picker, currently Argon' —
// match whole picker phrases only ('mode' alone is a substring of 'model', and bare
// '模型' also hits unrelated sidebar entries like 'More options for …模型…'), and
// treat 'Argon' as the tier alias of the 'Gemini 4' request.
const mPickerLabel = /mode picker|model picker|模型选择器/i;
const mTier = /flash|lite|fast|thinking|pro|bard|nano|ultra|opus|sonnet|haiku|model|模型|argon/i;
// Sidebar/nav landmarks. A layer that is one, or contains one, is never searched: the
// Gemini sidenav (bard-sidenav-content) is an ancestor of the composer in the live DOM,
// so its rows must stay out of the candidate set.
const mSide = 'nav, aside, [role="navigation"], [role="complementary"], bard-sidenav, bard-sidenav-content, [class*="sidenav"], [class*="sidebar"], [class*="side-nav"]';
const mIsSide = (el) => /^(nav|aside)$|sidenav|sidebar|side-nav/.test((el.tagName || '').toLowerCase())
  || /navigation|complementary/.test(el.getAttribute('role') || '')
  || /sidenav|sidebar|side-nav/.test(el.getAttribute('class') || '');
// Sidebar conversation rows are labelled 'More options for <title>' and are never a pill.
const mSideRow = (el) => /^more options for/i.test(el.getAttribute('aria-label') || '');
const mPill = () => {
  const box = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(e => mVis(e));
  // Fail closed with no composer. With one, climb its ancestors and stop dead at body/html
  // and at the first layer that is, or holds, a sidebar/nav landmark. The candidate set stays
  // in the composer's own layer: no document/body fallback, no sidebar rows, no clicks on them.
  if (!box) return null;
  let n = box.parentElement || box.parent;
  while (n) {
    const tag = (n.tagName || '').toLowerCase();
    if (tag === 'body' || tag === 'html' || mIsSide(n) || n.querySelector(mSide)) return null;
    const cand = [...n.querySelectorAll('button, [role="button"], mat-select, [role="combobox"]')].filter(e => mVis(e) && !mSideRow(e));
    const hit = cand.find(e => mPickerLabel.test(e.getAttribute('aria-label') || ''))
        || cand.find(e => mTier.test(mNorm(e.innerText)) && mNorm(e.innerText).length <= 40);
    if (hit) return hit;
    n = n.parentElement || n.parent;
  }
  return null;
};
// 'Gemini 4' ships as the 'Argon' tier: pill, menu rows and the post-switch check all
// match through this alias, never by raw substring against the configured name.
const mAlias = (want, text) => {
  const w = mNorm(want).toLowerCase(), t = mNorm(text).toLowerCase();
  return !!w && !!t && (t.includes(w) || (w === 'gemini 4' && t.includes('argon')));
};
const openModelPicker = (want) => {
  const pill = mPill();
  if (!pill) return { err: 'no_picker' };
  const cur = mNorm(pill.innerText) || mNorm(pill.getAttribute('aria-label'));
  if (mAlias(want, cur)) return { ok: true, already: true, selected: cur };
  pill.click();
  return { ok: true, opened: true, before: cur };
};
const pickModelOption = (want) => {
  const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], mat-option, [role="menu"] li, [role="listbox"] li, [role="menu"] button')].filter(mVis);
  const texts = [...new Set(items.map(i => mNorm(i.innerText)).filter(t => t && t.length <= 80))];
  const hit = items.find(i => mAlias(want, mNorm(i.innerText)));
  if (hit) { hit.click(); return { ok: true }; }
  return texts.length ? { err: 'no_match', options: texts.slice(0, 12) } : { err: 'no_menu' };
};
const modelPillText = () => { const pill = mPill(); return pill ? (mNorm(pill.innerText) || mNorm(pill.getAttribute('aria-label'))) : ''; };
const modelPillMatches = (want) => { const pill = mPill(); return !!pill && mAlias(want, mNorm(pill.innerText) || mNorm(pill.getAttribute('aria-label'))); };
`;

// Turn attribution for the Gemini chat surface (write/recover ops). The chat is a
// DOM-ordered list of USER-QUERY / MODEL-RESPONSE custom elements; the model's own
// action bar carries exactly `Copy` while the user bubble carries `Copy prompt` —
// page-wide `aria-label*="Copy"` counts match BOTH, which is how the old write lane
// returned the user's own instruction as the model answer. Everything here keys on
// turn nodes and their own action bars, never on whole-page counts or body tails.
// Exported so tests execute this same code against sanitized DOM fixtures.
export const TURN_HELPERS = /* js */ `
const turnNodes = () => [...document.querySelectorAll('user-query, model-response')];
const turnRole = (el) => el && el.tagName === 'MODEL-RESPONSE' ? 'model' : el && el.tagName === 'USER-QUERY' ? 'user' : 'unknown';
const btnLabel = (b) => ((b.getAttribute('aria-label') || '') + '').trim();
const elVisible = (el) => !!el && !el.hidden && (typeof el.offsetParent === 'undefined' || el.offsetParent !== null || (el.getClientRects ? el.getClientRects().length > 0 : true));
const replyCopyBtn = (el) => [...el.querySelectorAll('button[aria-label]')].find(b => /^copy$/i.test(btnLabel(b)));
const fnv1a = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); };
const stopBtnVisible = () => [...document.querySelectorAll('button')].some(b => /stop/i.test(btnLabel(b)) && elVisible(b));
// MODEL-RESPONSE text: .response-content innerText, minus the screen-reader
// 'Gemini said' label and the action-bar/icon lines around it.
const responseText = (el) => {
  const stop = /^(Thoughts|expand_more|expand_less|keep_pin|copy|thumb_up|thumb_down|save( to note)?|note_add|share|edit|delete|rate response|good response|bad response|more_horiz|Gemini said)\\s*$/i;
  const drop = /^(more_horiz|subdirectory_arrow_right|arrow_forward|\\d+|[。，、；：！？\\.,;:!?]+)\\s*$/i;
  const root = el.querySelector('.response-content') || el;
  const out = [];
  for (const line of (root.innerText || '').split('\\n')) {
    const t = line.trim();
    if (stop.test(t)) { if (out.length === 0) continue; break; }
    if (!drop.test(t)) out.push(line);
  }
  return out.join('\\n').replace(/^\\s*Gemini said\\s*/i, '').trim();
};
// One structural read of the chat vs a pre-submit baseline: a reply counts only
// when a NEW MODEL-RESPONSE sits after the NEW last USER-QUERY.
const chatProbe = (base) => {
  const nodes = turnNodes();
  const users = nodes.filter(n => turnRole(n) === 'user');
  const models = nodes.filter(n => turnRole(n) === 'model');
  const lastUser = users[users.length - 1] || null;
  const lastModel = models[models.length - 1] || null;
  const lastUserIdx = lastUser ? nodes.indexOf(lastUser) : -1;
  const lastModelIdx = lastModel ? nodes.indexOf(lastModel) : -1;
  const newUser = users.length > base.users && lastUserIdx > base.lastUserIdx;
  const newModel = !!lastModel && lastModelIdx > lastUserIdx && lastModelIdx > base.lastModelIdx;
  const text = newModel ? responseText(lastModel) : '';
  return {
    users: users.length, models: models.length, lastUserIdx, lastModelIdx, newUser, newModel,
    hasCopy: newModel && !!replyCopyBtn(lastModel),
    stopVisible: stopBtnVisible(),
    hash: text ? fnv1a(text) : '', len: text.length, text,
    tail: (document.body.innerText || '').slice(-800),
  };
};
// Read-only turn map for recover: caller picks a USER-QUERY index, then pickReply
// takes the MODEL-RESPONSE immediately after it (strict alternating order).
const turnMap = () => ({
  turns: turnNodes().map((n, i) => ({ i, role: turnRole(n), len: (((n.querySelector('.response-content') || n).innerText || '') + '').trim().length })),
  stopVisible: stopBtnVisible(),
});
const pickReply = (turn) => {
  const nodes = turnNodes();
  if (!Number.isInteger(turn) || turn < 0 || turn >= nodes.length) return { err: 'out_of_range', nodes: nodes.length };
  if (turnRole(nodes[turn]) !== 'user') return { err: 'not_user_turn', role: turnRole(nodes[turn]) };
  const m = nodes[turn + 1];
  if (!m || turnRole(m) !== 'model') return { err: 'no_reply' };
  const text = responseText(m);
  return { err: '', text, idx: turn + 1, hasCopy: !!replyCopyBtn(m), stopVisible: stopBtnVisible() };
};
// Extracted text that is a user bubble ('You said …') or echoes the prompt back
// verbatim is not a model answer — fail closed, never write it as the artifact.
const replyLooksFake = (text, prompt) => {
  const squash = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  if (/^you said/i.test(squash(text))) return true;
  const bare = (s) => (s || '').replace(/\\s+/g, '');
  const p = bare(prompt);
  return !!p && bare(text) === p;
};
`;

// The runtime script: ARGS is interpolated by browser.ts as a JSON literal.
export function buildScript(provider: string, a: ScriptArgs): string {
  const prelude = `const ARGS = ${JSON.stringify(a)};\n${HELPERS}\nconst providerSpace = 'sck-media-${provider}';\nconst task = await taskSpace(providerSpace);\nconst existing = await task.pages();\nconst p = existing[0] ?? await task.newPage();\n`;
  const body = provider === 'notebook' ? notebook() : provider === 'gemini' ? gemini() : provider === 'chatgpt' ? chatgpt() : grok();
  return prelude + body + `\n`;
}

function gemini(): string {
  return /* js */ `
await p.goto('https://gemini.google.com/app');
await p.waitForTimeout(3500);
let snap = await p.snapshot();
let body = await bodyText(p);
if (loginWall(body)) { fail('login_required', 'gemini.google.com 需要重新登录'); }
if (ARGS.kind === 'video') {
  const toolsRef = refOf(snap, 'Upload & tools');
  if (toolsRef) { await p.click('@' + toolsRef, { label: 'open tools' }); await p.waitForTimeout(900); snap = await p.snapshot();
    const vidRef = refOf(snap, 'Create video'); if (vidRef) await p.click('@' + vidRef, { label: 'video mode' }).catch(() => {});
    await p.waitForTimeout(600);
  }
}
if (ARGS.refs.length) {
  snap = await p.snapshot();
  const upRef = refOf(snap, 'Upload & tools');
  if (upRef) {
    const chooser = p.waitForFileChooser({ timeout: 12000 });
    await p.click('@' + upRef, { label: 'upload refs' }); await p.waitForTimeout(800);
    snap = await p.snapshot();
    const filesRef = refOf(snap, 'Upload files');
    if (filesRef) { await p.click('@' + filesRef, { label: 'choose files' }); }
    const ch = await chooser.catch(() => null);
    if (ch) { await ch.setFiles(ARGS.refs); await p.waitForTimeout(3500); }
  }
}
snap = await p.snapshot();
const tbRef = refOf(snap, 'textfield "Enter a prompt');
if (!tbRef) { fail('failed', '找不到 Gemini 输入框'); }
await p.fill('@' + tbRef, ARGS.prompt + (ARGS.kind === 'video' ? '' : ' IMPORTANT: if the request asks for transparent background, produce a real alpha-channel PNG.'));
await p.waitForTimeout(600);
snap = await p.snapshot();
const sendRef = refOf(snap, 'Send message');
if (sendRef) await p.click('@' + sendRef, { label: 'send' }).catch(() => p.press('@' + tbRef, 'Enter'));
else await p.press('@' + tbRef, 'Enter');
const t0 = Date.now();
let found = null;
while (Date.now() - t0 < ARGS.timeoutMs) {
  const probe = await p.evaluate(() => ({
    big: [...document.querySelectorAll('img')].filter(i => i.src.startsWith('blob:') && i.naturalWidth > 300).length,
    vids: [...document.querySelectorAll('video')].filter(v => v.src && v.src.startsWith('http')).length,
    tail: document.body.innerText.slice(-900),
  }));
  if (hitLimit(probe.tail)) { fail('limit_reached', 'Gemini 配额/限流：' + probe.tail.slice(-200)); }
  if (loginWall(probe.tail)) { fail('login_required', 'Gemini 会话失效'); }
  found = ARGS.kind === 'video' ? probe.vids : probe.big;
  if (found) break;
  await p.waitForTimeout(4000);
}
if (!found) { fail('failed', '等待生成结果超时'); }
const saved = ARGS.kind === 'video' ? await saveVideo(p, outPath, ARGS.seconds) : await saveImg(p, outPath);
if (!saved) { fail('failed', '结果提取失败'); }
const st = fs.statSync(saved.path ?? saved);
emit({ ok: true, file: (saved.path ?? saved), bytes: st.size, via: saved.via ?? 'canvas' });
`;
}

function chatgpt(): string {
  return /* js */ `
await p.goto('https://chatgpt.com/');
await p.waitForTimeout(4000);
let body = await bodyText(p);
if (/couldn't load your account/i.test(body)) { await p.reload(); await p.waitForTimeout(4000); body = await bodyText(p); }
if (loginWall(body)) { fail('login_required', 'chatgpt.com 需要重新登录'); }
let snap = await p.snapshot();
if (ARGS.refs.length) {
  const addRef = refOf(snap, 'Add files and more');
  if (addRef) {
    const chooser = p.waitForFileChooser({ timeout: 12000 });
    await p.click('@' + addRef, { label: 'attach' }); await p.waitForTimeout(900);
    snap = await p.snapshot();
    const upRef = refOf(snap, 'Upload from computer');
    if (upRef) await p.click('@' + upRef, { label: 'upload' }).catch(() => {});
    const ch = await chooser.catch(() => null);
    if (ch) { await ch.setFiles(ARGS.refs); await p.waitForTimeout(3000); }
    snap = await p.snapshot();
  }
}
const tbRef = refOf(snap, 'Ask ChatGPT');
if (!tbRef) { fail('failed', '找不到 ChatGPT 输入框'); }
await p.fill('@' + tbRef, ARGS.prompt + ' Respond with the generated image only.');
await p.waitForTimeout(600);
snap = await p.snapshot();
const sendRef = refOf(snap, 'button "Send"|aria-label="Send"');
if (sendRef) await p.click('@' + sendRef, { label: 'send' }).catch(() => p.press('@' + tbRef, 'Enter'));
else await p.press('@' + tbRef, 'Enter');
const base = await p.evaluate(() => [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 300).length);
const t0 = Date.now();
let ok = false;
while (Date.now() - t0 < ARGS.timeoutMs) {
  const probe = await p.evaluate(() => ({
    n: [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 300).length,
    busy: !!document.querySelector('button[aria-label*="Stop" i]'),
    tail: document.body.innerText.slice(-900),
  }));
  if (hitLimit(probe.tail)) { fail('limit_reached', 'ChatGPT 限流：' + probe.tail.slice(-200)); }
  if (/aren't available|can't generate|unable to (create|generate)|temporary chat/i.test(probe.tail)) { fail('failed', probe.tail.slice(-200)); }
  if (probe.n > base && !probe.busy) { ok = true; break; }
  await p.waitForTimeout(4000);
}
if (!ok) { fail('failed', '等待生成结果超时'); }
const saved = await saveImg(p, outPath);
if (!saved) { fail('failed', '结果提取失败'); }
const st = fs.statSync(saved);
emit({ ok: true, file: saved, bytes: st.size, via: 'canvas' });
`;
}

function notebook(): string {
  return /* js */ `
const HOME = 'https://notebook.google.com/';
// Resolve ARGS.notebook: full id → direct URL; otherwise title substring scan on the home table.
const openNotebook = async () => {
  if (/^[0-9a-f-]{36}$/i.test(ARGS.notebook || '')) {
    await p.goto(HOME + 'notebook/' + ARGS.notebook);
    await p.waitForTimeout(5000);
    return ARGS.notebook;
  }
  await p.goto(HOME);
  try { await p.waitForLoadState('load'); } catch {}
  await p.waitForTimeout(4500);
  const hit = await p.evaluate(({ q }) => {
    const a = [...document.querySelectorAll('a[href^="/notebook/"]')].find(x => (x.innerText || '').includes(q));
    return a ? { href: a.getAttribute('href'), title: (a.innerText || '').trim() } : null;
  }, { q: ARGS.notebook });
  if (!hit) { fail('failed', '找不到笔记本（按标题匹配）：' + ARGS.notebook); }
  await p.goto('https://notebook.google.com' + hit.href);
  await p.waitForTimeout(5000);
  return hit.href.split('/').pop();
};

if (ARGS.notebookOp === 'list') {
  await p.goto(HOME);
  try { await p.waitForLoadState('load'); } catch {}
  await p.waitForTimeout(4500);
  const rows = await p.evaluate(() => [...document.querySelectorAll('a[href^="/notebook/"]')].map(a => {
    const tr = a.closest('tr');
    const cells = tr ? [...tr.querySelectorAll('td')].map(c => (c.innerText || '').trim()) : [];
    return { id: (a.getAttribute('href') || '').split('/').pop(), title: (a.innerText || '').trim(), sources: cells.find(c => /Sources?$/.test(c)) || undefined, created: cells.find(c => /20\\d\\d/.test(c)) || undefined };
  }));
  emit({ ok: true, notebooks: rows });
  process.exit(0);
}

if (ARGS.notebookOp === 'create') {
  await p.goto(HOME);
  try { await p.waitForLoadState('load'); } catch {}
  await p.waitForTimeout(4000);
  const made = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /New notebook/i.test(b.innerText || b.getAttribute('aria-label') || ''));
    if (btn) { btn.click(); return true; } return false;
  });
  if (!made) { fail('failed', '找不到 New notebook 按钮'); }
  await p.waitForTimeout(6000);
  const id = await p.evaluate(() => (location.pathname.match(/notebook\\/([0-9a-f-]+)/i) || [])[1] || '');
  // Rename: the title is a visible text input ("Untitled notebook"). Programmatic
  // value setting does not persist — real keystrokes + Enter are required.
  if (ARGS.title) {
    let focused = false;
    const focusDeadline = Date.now() + 20000;
    while (!focused && Date.now() < focusDeadline) {
      focused = await p.evaluate(() => {
        const tb = [...document.querySelectorAll('input[type="text"],input:not([type])')]
          .find(e => e.offsetParent !== null && !/search|select/i.test(e.getAttribute('aria-label') || e.placeholder || ''));
        if (!tb) return false;
        tb.focus(); tb.select();
        return true;
      });
      if (!focused) await p.waitForTimeout(2000);
    }
    if (focused) {
      await p.keyboard.type(ARGS.title);
      await p.keyboard.press('Enter');
    }
    await p.waitForTimeout(2500);
    const finalTitle = await p.evaluate(() =>
      ([...document.querySelectorAll('input[type="text"],input:not([type])')]
        .find(e => e.offsetParent !== null && !/search|select/i.test(e.getAttribute('aria-label') || e.placeholder || '')) || {}).value
      || ([...document.querySelectorAll('h2')].find(h => !/^(Sources|Studio)$/i.test(h.innerText || '')) || {}).innerText || '');
    emit({ ok: true, notebook: { id, title: (finalTitle || '').trim() || ARGS.title }, url: 'https://notebook.google.com/notebook/' + id });
    process.exit(0);
  }
  emit({ ok: true, notebook: { id, title: ARGS.title }, url: 'https://notebook.google.com/notebook/' + id });
  process.exit(0);
}

if (ARGS.notebookOp === 'recover') {
  // Read-only retrieval of an existing model reply: authorized chat + explicit
  // user turn. Never types or sends a prompt. Emits provenance + sha256 so the
  // recovered artifact stays auditable (same source rules as a live write).
  const chatIdIn = ((ARGS.chat || '').match(/app\\/([0-9a-f]+)/i) || [])[1]
    || (/^[0-9a-f]{6,}$/i.test(ARGS.chat || '') ? ARGS.chat : '');
  if (!chatIdIn) { fail('failed', 'recover 需要既有 Gemini 会话的 chat id 或 url'); }
  try { await p.goto('https://gemini.google.com/app/' + chatIdIn); } catch {}
  try { await p.waitForLoadState('load'); } catch {}
  await p.waitForTimeout(5000);
  const gBody = await bodyText(p);
  if (loginWall(gBody)) { fail('login_required', 'gemini.google.com 需要重新登录'); }
  const chatUrl0 = 'https://gemini.google.com/app/' + chatIdIn;
  if (ARGS.turn === undefined || ARGS.turn === null) {
    const map = await p.evaluate(() => {
${TURN_HELPERS}
      return turnMap();
    });
    emit({ ok: true, url: chatUrl0, turns: map.turns, stopVisible: map.stopVisible });
    process.exit(0);
  }
  const pick = await p.evaluate(({ turn }) => {
${TURN_HELPERS}
    return pickReply(turn);
  }, { turn: ARGS.turn });
  if (pick.err === 'out_of_range') { fail('failed', '轮次序号越界（当前 ' + pick.nodes + ' 个节点；先不带 turn 调用查看轮次地图）'); }
  if (pick.err === 'not_user_turn') { fail('failed', '节点 ' + ARGS.turn + ' 不是用户轮次（role=' + pick.role + '）'); }
  if (pick.err === 'no_reply') { fail('failed', '该用户轮次之后没有模型答复'); }
  if (pick.stopVisible) { fail('failed', '答复仍在生成中，稍后再取'); }
  // Completion marker: a finished reply carries its own exact 'Copy' action.
  // Thoughts-only / still-generating nodes have none — fail closed, never
  // overwrite the previous valid artifact with partial content.
  if (!pick.hasCopy) { fail('failed', '答复未见完成标记（无 Copy 动作），可能仍在生成，稍后再取'); }
  if (!pick.text || pick.text.length < 10) { fail('failed', '答复提取为空'); }
  await p.waitForTimeout(3000);
  const again = await p.evaluate(({ turn }) => {
${TURN_HELPERS}
    return pickReply(turn);
  }, { turn: ARGS.turn });
  if (again.err || again.text !== pick.text) { fail('failed', '答复文本未稳定，未取回'); }
  // Generation may (re)start between reads: the re-read must still show the
  // reply as finished — no visible Stop, own Copy action still present.
  if (again.stopVisible || !again.hasCopy) { fail('failed', '复读时答复仍在生成，未取回'); }
  const fake = await p.evaluate(({ text }) => {
${TURN_HELPERS}
    return replyLooksFake(text, '');
  }, { text: pick.text });
  if (fake) { fail('failed', '取回的是用户轮文本，不是模型答复'); }
  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, pick.text + '\\n\\n<!-- gemini-session: ' + chatUrl0 + ' recovered i' + pick.idx + ' -->\\n');
  fs.renameSync(tmp, outPath);
  const crypto = await import('node:crypto');
  emit({ ok: true, file: outPath, bytes: fs.statSync(outPath).size, url: chatUrl0, text: pick.text.slice(0, 30000), source: 'gemini:' + chatIdIn + '#i' + pick.idx, sha256: crypto.createHash('sha256').update(pick.text).digest('hex') });
  process.exit(0);
}

const nbId = await openNotebook();
await p.waitForTimeout(2000);
const body0 = await bodyText(p);
if (loginWall(body0)) { fail('login_required', 'notebook.google.com 需要重新登录'); }

if (ARGS.notebookOp === 'add_source') {
  // baseline source count so "inserted" is detected as +1, not "any sources exist"
  const srcBase = await p.evaluate(() => Number((document.body.innerText.match(/(\\d+) sources?/i) || [0, 0])[1]) || document.querySelectorAll('input[type="checkbox"]').length);
  let snap = await p.snapshot();
  let addRef = refOf(snap, 'Add sources');
  if (!addRef) {
    const clicked = await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /Add sources/i.test(b.innerText || b.getAttribute('aria-label') || ''));
      if (btn) { btn.click(); return true; } return false;
    });
    if (!clicked) { fail('failed', '找不到 Add sources'); }
  } else {
    await p.click('@' + addRef, { label: 'add sources' }).catch(async () => {
      await p.evaluate(() => [...document.querySelectorAll('button')].find(b => /Add sources/i.test(b.innerText || ''))?.click());
    });
  }
  await p.waitForTimeout(1500);
  const pasted = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Copied text/i.test(b.innerText || ''));
    if (btn) { btn.click(); return true; } return false;
  });
  if (!pasted) { fail('failed', 'source 面板里没有 Copied text 选项'); }
  let filled = false;
  const fd = Date.now() + 20000;
  while (!filled && Date.now() < fd) {
    filled = await p.evaluate((arg) => {
      const ta = [...document.querySelectorAll('textarea')].find(t => /Paste text here/i.test(t.placeholder || '') && t.offsetParent !== null)
        || [...document.querySelectorAll('dialog textarea')].pop();
      if (!ta) return false;
      ta.focus();
      ta.value = arg.text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, { text: ARGS.text });
    if (!filled) await p.waitForTimeout(1500);
  }
  if (!filled) { fail('failed', '找不到粘贴文本框'); }
  await p.waitForTimeout(600);
  const inserted = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /^Insert$/i.test((b.innerText || '').trim()));
    if (btn) { btn.click(); return true; } return false;
  });
  if (!inserted) { fail('failed', '找不到 Insert 按钮'); }
  // wait for the source row to appear (count > baseline)
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 45000) {
    const n = await p.evaluate(() => Number((document.body.innerText.match(/(\\d+) sources?/i) || [0, 0])[1]) || 0);
    if (n > srcBase) { ok = true; break; }
    await p.waitForTimeout(2000);
  }
  if (!ok) { fail('failed', '源插入后未出现在列表'); }
  emit({ ok: true, notebook: nbId, title: ARGS.title });
  process.exit(0);
}

if (ARGS.notebookOp === 'remove_source') {
  // Sources cannot be edited in place; volume consolidation relies on remove+re-add.
  const target = ARGS.title || '';
  let removedAny = false;
  for (let round = 0; round < 20; round++) {
    const label = await p.evaluate(({ q }) => {
      const cb = [...document.querySelectorAll('input[type="checkbox"]')].find(c => {
        const l = c.getAttribute('aria-label') || '';
        return /^Select /.test(l) && !/all sources|chat sources/i.test(l) && l.toLowerCase().includes(q.toLowerCase());
      });
      if (!cb) return null;
      const l = cb.getAttribute('aria-label');
      let row = cb;
      for (let i = 0; i < 8 && row; i++) { if (row.querySelectorAll && row.querySelectorAll('button').length) break; row = row.parentElement; }
      [...row.querySelectorAll('button')].find(b => /^More$/i.test(b.getAttribute('aria-label') || ''))?.click();
      return l;
    }, { q: target });
    if (!label) break;
    await p.waitForTimeout(1000);
    const clicked = await p.evaluate(() => {
      const mi = [...document.querySelectorAll('[role="menuitem"],button')].find(b => /Remove note|Remove source|delete/i.test(b.innerText || ''));
      if (!mi) return false;
      mi.click(); return true;
    });
    if (!clicked) { fail('failed', '源菜单里没有 Remove 项'); }
    await p.waitForTimeout(1200);
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /^(Remove|Delete|删除|确认)$/i.test((b.innerText || '').trim()));
      btn?.click();
    });
    await p.waitForTimeout(2000);
    removedAny = true;
  }
  if (!removedAny) { fail('failed', '找不到要删除的源：' + target); }
  emit({ ok: true, notebook: nbId, title: target });
  process.exit(0);
}

if (ARGS.notebookOp === 'write') {
  // Draft inside the Gemini shell: gemini.google.com/notebook/<id> spawns a
  // persistent Gemini chat grounded on this notebook's sources. ARGS.chat
  // continues an existing conversation (one chapter = one session).
  const chatIdIn = ((ARGS.chat || '').match(/app\\/([0-9a-f]+)/i) || [])[1]
    || (/^[0-9a-f]{6,}$/i.test(ARGS.chat || '') ? ARGS.chat : '');
  try { await p.goto(chatIdIn ? 'https://gemini.google.com/app/' + chatIdIn : 'https://gemini.google.com/notebook/' + nbId); } catch {}
  try { await p.waitForLoadState('load'); } catch {}
  await p.waitForTimeout(5000);
  const gBody = await bodyText(p);
  if (loginWall(gBody)) { fail('login_required', 'gemini.google.com 需要重新登录'); }
  // Model is asserted BEFORE the prompt goes in: a write on the wrong tier is
  // worse than no write. Unavailable = abort, never a silent Flash-Lite draft.
  let pickedModel = '';
  if ((ARGS.model || '').trim()) {
    const want = ARGS.model.trim();
    let st = { err: 'no_picker' };
    const pd = Date.now() + 20000;
    while (Date.now() < pd) {
      st = await p.evaluate(({ want }) => {
${MODEL_PICKER}
        return openModelPicker(want);
      }, { want });
      if (st.err !== 'no_picker') break;
      await p.waitForTimeout(2500);
    }
    if (st.err === 'no_picker') { fail('model_unavailable', '找不到 Gemini 模型选择器，拒绝在未确认模型的情况下写作。禁止降级写作：稍后重试，持续不可用则 report_blocker(to=gm) 上报缺口'); }
    if (st.already) { pickedModel = st.selected; }
    else {
      let opt = { err: 'no_menu' };
      const od = Date.now() + 12000;
      while (Date.now() < od) {
        opt = await p.evaluate(({ want }) => {
${MODEL_PICKER}
          return pickModelOption(want);
        }, { want });
        if (opt.err !== 'no_menu') break;
        await p.waitForTimeout(800);
      }
      if (opt.err === 'no_match') { fail('model_unavailable', '模型 "' + want + '" 在选择器里不可用，当前可选：' + (opt.options || []).join('、') + '。多为配额耗尽自动降档，禁止用低档模型写作：稍后重试，持续不可用则 report_blocker(to=gm) 上报缺口'); }
      if (opt.err === 'no_menu') { fail('model_unavailable', '模型选择器菜单未能打开，拒绝在未确认模型的情况下写作。禁止降级写作：稍后重试，持续不可用则 report_blocker(to=gm) 上报缺口'); }
      await p.waitForTimeout(800);
      pickedModel = await p.evaluate(() => {
${MODEL_PICKER}
        return modelPillText();
      });
      // Post-switch check shares the alias: pill 'Argon' satisfies want 'Gemini 4'.
      const okModel = await p.evaluate(({ want }) => {
${MODEL_PICKER}
        return modelPillMatches(want);
      }, { want });
      if (!okModel) {
        fail('model_unavailable', '模型切换未生效：选择器显示 "' + pickedModel + '"，期望 "' + want + '"（或其可用别名，如 Gemini 4 → Argon）。多为配额耗尽自动降档，禁止用低档模型写作：稍后重试，持续不可用则 report_blocker(to=gm) 上报缺口');
      }
    }
  }
  let sent = false;
  const sendDeadline = Date.now() + 30000;
  while (!sent && Date.now() < sendDeadline) {
    sent = await p.evaluate(({ prompt }) => {
      const tb = [...document.querySelectorAll('[contenteditable="true"], textarea')]
        .find(e => e.offsetParent !== null && /prompt|Gemini|question/i.test(e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.innerText || ''))
        || [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(e => e.offsetParent !== null).pop();
      if (!tb) return false;
      tb.focus();
      if (tb.tagName === 'TEXTAREA') { tb.value = prompt; tb.dispatchEvent(new Event('input', { bubbles: true })); }
      else { tb.innerText = prompt; tb.dispatchEvent(new InputEvent('input', { bubbles: true })); }
      return true;
    }, { prompt: ARGS.prompt });
    if (!sent) await p.waitForTimeout(2000);
  }
  if (!sent) { fail('failed', '找不到 Gemini 输入框'); }
  await p.waitForTimeout(500);
  // Baseline BEFORE submitting: which turns already exist. The new answer must
  // be a NEW MODEL-RESPONSE after the NEW last USER-QUERY — page copy counts,
  // body-tail text, older replies and our own prompt bubble never count.
  const baseProbe = await p.evaluate(() => {
${TURN_HELPERS}
    const nodes = turnNodes();
    const users = nodes.filter(n => turnRole(n) === 'user');
    const models = nodes.filter(n => turnRole(n) === 'model');
    return { users: users.length, lastUserIdx: users.length ? nodes.indexOf(users[users.length - 1]) : -1, lastModelIdx: models.length ? nodes.indexOf(models[models.length - 1]) : -1 };
  });
  const submitted = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /^(Submit|Send)$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
    if (btn) { btn.click(); return true; } return false;
  });
  if (!submitted) await p.keyboard.press('Enter');
  // Ready = new attributed MODEL-RESPONSE with its own Copy action rendered, no
  // visible Stop, and identical text hash on three consecutive reads (~6s).
  const w0 = Date.now();
  let ready = false;
  let stableReads = 0;
  let lastHash = '';
  let lastText = '';
  while (Date.now() - w0 < ARGS.timeoutMs - 30000) {
    const probe = await p.evaluate(({ base }) => {
${TURN_HELPERS}
      return chatProbe(base);
    }, { base: baseProbe });
    if (hitLimit(probe.tail)) { fail('limit_reached', 'Gemini 配额/限流：' + probe.tail.slice(-200)); }
    if (loginWall(probe.tail)) { fail('login_required', 'Gemini 会话失效'); }
    if (probe.newUser && probe.newModel && probe.hasCopy && !probe.stopVisible && probe.len >= 10) {
      if (probe.hash === lastHash) { stableReads += 1; } else { stableReads = 0; lastHash = probe.hash; }
      lastText = probe.text;
      if (stableReads >= 2) { ready = true; break; }
    } else { stableReads = 0; lastHash = ''; }
    await p.waitForTimeout(3000);
  }
  // The prompt may already be on the page — never auto-resend; point at recover.
  if (!ready) { fail('failed', '等待 Gemini 本轮答复超时：prompt 可能已发送（不自动重发；检查会话后可重试，或用 notebook_recover 只读取回既有答复）'); }
  const fake = await p.evaluate(({ text, prompt }) => {
${TURN_HELPERS}
    return replyLooksFake(text, prompt);
  }, { text: lastText, prompt: ARGS.prompt });
  if (fake) { fail('failed', '取回内容不是模型答复（用户轮文本或与 prompt 相同）'); }
  const chatId = await p.evaluate(() => (location.pathname.match(/app\\/([0-9a-f]+)/i) || [])[1] || '');
  const chatUrl = chatId ? 'https://gemini.google.com/app/' + chatId : '';
  // Confirmed reply only: candidate file then atomic rename — a failed run never
  // clobbers the previous valid artifact. Session marker kept for continuation.
  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, lastText + '\\n\\n<!-- gemini-session: ' + (chatUrl || 'unknown') + ' -->\\n');
  fs.renameSync(tmp, outPath);
  const crypto = await import('node:crypto');
  emit({ ok: true, file: outPath, bytes: fs.statSync(outPath).size, notebook: nbId, text: lastText.slice(0, 30000), url: chatUrl || undefined, model: pickedModel || undefined, sha256: crypto.createHash('sha256').update(lastText).digest('hex') });
  process.exit(0);
}

if (ARGS.notebookOp === 'query') {
// notebook_query — fill via evaluate (snapshot refs for the query textarea vary by layout)
const baseline = await p.evaluate(() => document.querySelectorAll('button[aria-label*="Copy model response" i]').length);
let filled = false;
const fillDeadline = Date.now() + 30000;
while (!filled && Date.now() < fillDeadline) {
  filled = await p.evaluate((arg) => {
    const ta = [...document.querySelectorAll('textarea')].find(t => /Ask a question|create something|向来源提问/i.test(t.placeholder || '') && t.offsetParent !== null)
      || [...document.querySelectorAll('textarea')].filter(t => t.offsetParent !== null).pop();
    if (!ta) return false;
    ta.focus();
    ta.value = arg.prompt;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, { prompt: ARGS.prompt });
  if (!filled) await p.waitForTimeout(2000);
}
if (!filled) { fail('failed', '找不到 Query box（笔记本可能没加载完）'); }
await p.waitForTimeout(800);
const sent = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => /Submit|Send/i.test(b.getAttribute('aria-label') || '') || /^arrow_forward$/.test((b.innerText || '').trim()));
  if (btn && !btn.disabled) { btn.click(); return true; }
  return false;
});
if (!sent) {
  await p.evaluate(() => {
    const ta = [...document.querySelectorAll('textarea')].find(t => /Ask a question|create something/i.test(t.placeholder || '') && t.offsetParent !== null);
    if (ta) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}
const t0 = Date.now();
let ready = false;
let lastLen = -1; let stable = 0;
while (Date.now() - t0 < ARGS.timeoutMs) {
  const probe = await p.evaluate((arg) => {
    const copies = document.querySelectorAll('button[aria-label*="Copy model response" i]').length;
    const tail = document.body.innerText.slice(-800);
    return { copies: copies > arg.base, n: copies, tail };
  }, { base: baseline });
  if (hitLimit(probe.tail)) { fail('limit_reached', 'NotebookLM 限流：' + probe.tail.slice(-200)); }
  if (probe.copies) {
    // streaming may continue after the copy button appears; require the response text to settle
    const len = probe.tail.length;
    if (len === lastLen) { stable += 1; if (stable >= 3) { ready = true; break; } } else { stable = 0; lastLen = len; }
  }
  await p.waitForTimeout(3000);
}
if (!ready) { fail('failed', '等待 NotebookLM 回复超时'); }
let text = await p.evaluate(async () => {
  const copies = [...document.querySelectorAll('button[aria-label*="Copy model response" i]')];
  const btn = copies[copies.length - 1];
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 800));
  try { return await navigator.clipboard.readText(); } catch { return null; }
});
if (!text || text.trim().length < 10) {
  // DOM fallback: walk up from the last copy button to the message container,
  // take innerText before the action bar, strip citation-number-only lines.
  text = await p.evaluate(() => {
    const copies = [...document.querySelectorAll('button[aria-label*="Copy model response" i]')];
    const btn = copies[copies.length - 1];
    if (!btn) return null;
    const stop = /^(Thoughts|expand_more|expand_less|keep_pin|copy|thumb_up|thumb_down|save( to note)?|save message|note_add|share|edit|delete|rate response|good response|bad response)\s*$/i;
    const drop = /^(more_horiz|subdirectory_arrow_right|arrow_forward|\\d+|[。，、；：！？\\.,;:!?]+)\s*$/i;
    const clean = (el) => {
      const out = [];
      for (const line of el.innerText.split('\\n')) {
        const t = line.trim();
        if (stop.test(t)) {
          if (out.length === 0) continue;   // Thoughts header sits above the response text
          break;                          // action bar reached: everything below is chrome/suggestions
        }
        if (!drop.test(t)) out.push(line);
      }
      return out.join('\\n').trim();
    };
    // Climb until an ancestor yields real text — the button's first >30-char
    // ancestor can be mat-card-actions which contains only icon labels.
    let n = btn;
    for (let i = 0; i < 10 && n; i++) {
      const txt = clean(n);
      if (txt.length >= 10) return txt;
      n = n.parentElement;
    }
    return null;
  });
}
if (!text || text.trim().length < 10) { fail('failed', '回复提取失败'); }
fs.writeFileSync(outPath, text.trim() + '\\n');
// Return the answer inline too so callers can use query as a lookup path
// without reading the evidence file. Cap the payload; file keeps full text.
emit({ ok: true, file: outPath, bytes: fs.statSync(outPath).size, notebook: nbId, text: text.trim().slice(0, 30000) });
}
`;
}

function grok(): string {
  return /* js */ `
await p.goto(ARGS.kind === 'video' ? 'https://grok.com/imagine' : 'https://grok.com/');
await p.waitForTimeout(4000);
let body = await bodyText(p);
if (loginWall(body)) { fail('login_required', 'grok.com 需要重新登录'); }
let snap = await p.snapshot();
let tbRef = refOf(snap, 'Ask Grok anything|Type to imagine');
if (ARGS.kind === 'video') {
  const vRef = refOf(snap, 'radiobutton "Video"|aria-label="Video"');
  if (vRef) { await p.click('@' + vRef, { label: 'video mode' }); await p.waitForTimeout(700); snap = await p.snapshot(); tbRef = refOf(snap, 'Type to imagine|Ask Grok'); }
}
if (!tbRef) { fail('failed', '找不到 Grok 输入框'); }
await p.fill('@' + tbRef, ARGS.prompt);
await p.waitForTimeout(500);
snap = await p.snapshot();
const sendRef = refOf(snap, 'Submit');
if (sendRef) await p.click('@' + sendRef, { label: 'submit' }).catch(() => p.press('@' + tbRef, 'Enter'));
else await p.press('@' + tbRef, 'Enter');
const t0 = Date.now();
let found = null;
while (Date.now() - t0 < ARGS.timeoutMs) {
  const probe = await p.evaluate(() => ({
    big: [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 300 && !i.src.includes('cookielaw')).length,
    vids: [...document.querySelectorAll('video')].filter(v => (v.src || v.currentSrc || '').length).length,
    tail: document.body.innerText.slice(-900),
  }));
  if (hitLimit(probe.tail)) { fail('limit_reached', 'Grok 配额/限流：' + probe.tail.slice(-200)); }
  found = ARGS.kind === 'video' ? probe.vids : probe.big;
  if (found) break;
  await p.waitForTimeout(4000);
}
if (!found) { fail('failed', '等待生成结果超时'); }
const saved = ARGS.kind === 'video' ? await saveVideo(p, outPath, ARGS.seconds) : await saveImg(p, outPath);
if (!saved) { fail('failed', '结果提取失败'); }
const st = fs.statSync(saved.path ?? saved);
emit({ ok: true, file: (saved.path ?? saved), bytes: st.size, via: saved.via ?? 'canvas' });
`;
}
