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
  notebookOp?: 'list' | 'create' | 'query' | 'add_source';
  notebook?: string;   // notebook id (from URL) or title substring
  title?: string;      // source title / new notebook name
  text?: string;       // source body for add_source
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
