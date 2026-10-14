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
  kind: 'image' | 'video';
  prompt: string;
  outDir: string;
  file: string;
  refs: string[];
  seconds?: number;
  timeoutMs: number;
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
  const body = provider === 'gemini' ? gemini() : provider === 'chatgpt' ? chatgpt() : grok();
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
