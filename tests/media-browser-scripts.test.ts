import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScript, TURN_HELPERS, MODEL_PICKER } from '../src/media/browser-scripts.ts';

// Executable select/extract tests: the SAME in-page code the write/recover ops
// inject into p.evaluate (TURN_HELPERS) is run here via `new Function` against a
// minimal fake DOM, seeded by the desensitized real-DOM fixture captured from
// gemini.google.com/app/298352bc8337e01f (task 4de07b64 evidence). No mock of the
// logic under test — only the DOM itself is faked.

type Attrs = Record<string, string>;
class El {
  readonly tagName: string;
  readonly attrs: Attrs;
  readonly children: El[] = [];
  ownText: string;
  parent: El | null = null;
  hidden = false;
  constructor(tag: string, opts: { text?: string; attrs?: Attrs } = {}) {
    this.tagName = tag.toUpperCase();
    this.ownText = opts.text ?? '';
    this.attrs = { ...opts.attrs };
  }
  add(...kids: El[]): this {
    for (const k of kids) { k.parent = this; this.children.push(k); }
    return this;
  }
  get innerText(): string {
    return [this.ownText, ...this.children.map(c => c.innerText)].filter(s => s.length > 0).join('\n');
  }
  // Input simulation for full-script tests: the fill path assigns innerText and
  // fires events; Send/click handlers mutate the fake DOM between probes.
  set innerText(v: string) { this.ownText = v; }
  onClick?: () => void;
  click(): void { this.onClick?.(); }
  focus(): void {}
  dispatchEvent(): boolean { return true; }
  *walk(): Generator<El> {
    for (const c of this.children) { yield c; yield* c.walk(); }
  }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  getClientRects(): unknown[] { return this.hidden ? [] : [{}]; }
  querySelectorAll(sel: string): El[] {
    const sels = sel.split(',').map(s => s.trim()).filter(Boolean);
    return [...this.walk()].filter(e => sels.some(s => matchSelector(e, s)));
  }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
}

function matchSelector(el: El, sel: string): boolean {
  let m: RegExpMatchArray | null;
  if ((m = sel.match(/^([a-zA-Z][\w-]*)?\[([\w-]+)([*^$]?)="([^"]*)"\s*(i)?\]$/))) {
    const [, tag, attr, op, val, ci] = m;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    const have = el.attrs[attr];
    if (have === undefined) return false;
    const h = ci ? have.toLowerCase() : have;
    const v = ci ? val.toLowerCase() : val;
    if (op === '*') return h.includes(v);
    if (op === '^') return h.startsWith(v);
    if (op === '$') return h.endsWith(v);
    return h === v;
  }
  if ((m = sel.match(/^([a-zA-Z][\w-]*)?\[([\w-]+)\]$/))) {
    const [, tag, attr] = m;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    return el.attrs[attr] !== undefined;
  }
  if (sel.startsWith('.')) return (el.attrs['class'] ?? '').split(/\s+/).includes(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}

interface FakeDocument { body: El; querySelectorAll(sel: string): El[] }
const docOf = (root: El): FakeDocument => ({ body: root, querySelectorAll: (sel: string) => root.querySelectorAll(sel) });

interface TurnFns {
  chatProbe(base: { users: number; lastUserIdx: number; lastModelIdx: number }): {
    users: number; models: number; lastUserIdx: number; lastModelIdx: number;
    newUser: boolean; newModel: boolean; hasCopy: boolean; stopVisible: boolean;
    hash: string; len: number; text: string; tail: string;
  };
  turnMap(): { turns: Array<{ i: number; role: string; len: number }>; stopVisible: boolean };
  pickReply(turn: number): { err: string; text?: string; idx?: number; hasCopy?: boolean; stopVisible?: boolean; nodes?: number; role?: string };
  responseText(el: El): string;
  replyLooksFake(text: string, prompt: string): boolean;
}
// Load TURN_HELPERS into a Function scope exactly as p.evaluate would inject it.
const helpers = (doc: FakeDocument): TurnFns => {
  const factory = new Function('document', `${TURN_HELPERS}\nreturn { chatProbe, turnMap, pickReply, responseText, replyLooksFake };`);
  return factory(doc) as TurnFns;
};

const userTurn = (text: string, opts: { sr?: boolean } = {}) =>
  new El('user-query', { text: `${opts.sr === false ? '' : 'You said\n'}${text}` })
    .add(new El('button', { attrs: { 'aria-label': 'Copy prompt' } }));
const modelTurn = (text: string, opts: { sr?: boolean; copy?: boolean } = {}) => {
  const content = new El('div', { attrs: { class: 'response-content' }, text: `${opts.sr === false ? '' : 'Gemini said\n'}${text}` });
  const el = new El('model-response').add(content);
  if (opts.copy !== false) el.add(new El('button', { attrs: { 'aria-label': 'Copy' } }));
  return el;
};
const chatOf = (...turns: El[]): FakeDocument => docOf(new El('body').add(...turns));
const baseOf = (probe: { users: number; lastUserIdx: number; lastModelIdx: number }) => ({ users: probe.users, lastUserIdx: probe.lastUserIdx, lastModelIdx: probe.lastModelIdx });

const writeScript = buildScript('notebook', {
  kind: 'notebook', prompt: '这是针对第一卷第07章的返修与精简指令', outDir: '/tmp/o', file: 'ch07-v2.md',
  refs: [], timeoutMs: 480000, notebookOp: 'write', notebook: '梦痕纪元',
  chat: 'https://gemini.google.com/app/298352bc8337e01f',
});

describe('turn attribution fixture (real DOM shape, task 4de07b64)', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/gemini-dom-turns.json', import.meta.url), 'utf8')) as {
    turns: Array<{ i: number; tag: string; srTextPrefix: string; copyLabels: string[]; textLen: number }>;
  };
  const buildDoc = (): FakeDocument => {
    const els = fixture.turns.map(t => {
      const el = new El(t.tag);
      if (t.tag === 'MODEL-RESPONSE') el.add(new El('div', { attrs: { class: 'response-content' }, text: `${t.srTextPrefix}\n${'正'.repeat(t.textLen - t.srTextPrefix.length - 1)}` }));
      else el.ownText = `${t.srTextPrefix}\n${'指'.repeat(t.textLen - t.srTextPrefix.length - 1)}`;
      for (const label of t.copyLabels) el.add(new El('button', { attrs: { 'aria-label': label } }));
      return el;
    });
    return docOf(new El('body').add(...els));
  };

  test('turnMap reproduces the 4 verified turns in DOM order with roles', () => {
    const { turnMap } = helpers(buildDoc());
    expect(turnMap().turns.map(t => [t.i, t.role])).toEqual([[0, 'user'], [1, 'model'], [2, 'user'], [3, 'model']]);
    expect(turnMap().turns[3].len).toBeGreaterThan(8000);
  });

  test('pickReply(2) returns the revision reply; user/model/out-of-range fail closed', () => {
    const { pickReply } = helpers(buildDoc());
    const got = pickReply(2); // i=2 user revision instruction → i=3 model reply
    expect(got.err).toBe('');
    expect(got.idx).toBe(3);
    expect(got.hasCopy).toBe(true);
    expect(got.text!.length).toBeGreaterThan(8000);
    expect(got.text!.startsWith('Gemini said')).toBe(false); // SR label stripped
    expect(pickReply(1).err).toBe('not_user_turn'); // i=1 is a model node
    expect(pickReply(3).err).toBe('not_user_turn'); // i=3 is a model node
    expect(pickReply(9).err).toBe('out_of_range');
  });

  test('write probe on the verified post-send shape attributes to i=3, not i=1', () => {
    const doc = buildDoc();
    const { chatProbe } = helpers(doc);
    const probe = chatProbe({ users: 1, lastUserIdx: 0, lastModelIdx: 1 });
    expect(probe.newUser).toBe(true);
    expect(probe.newModel).toBe(true);
    expect(probe.lastUserIdx).toBe(2);
    expect(probe.lastModelIdx).toBe(3);
    expect(probe.hasCopy).toBe(true);
    expect(probe.stopVisible).toBe(false);
    expect(probe.len).toBeGreaterThan(8000); // the reply, not the 993-char instruction
    expect(probe.text.startsWith('You said')).toBe(false);
  });
});

describe('write lane turn attribution (executable, scenario DOMs)', () => {
  test('the generated write script embeds TURN_HELPERS and never uses page-wide Copy counts', () => {
    expect(writeScript).toContain('user-query, model-response');
    expect(writeScript).toContain('chatProbe');
    expect(writeScript).toContain('gemini-session'); // session marker kept
    expect(writeScript).not.toContain('aria-label*="Copy" i'); // the bug pattern is gone
    expect(writeScript).not.toContain('Copy prompt');
    expect(writeScript).not.toContain('baseCopies');
  });

  test('BUG CASE: only a new Copy prompt arrived — attribution stays false, nothing extracts', () => {
    const doc = chatOf(userTurn('初稿指令'), modelTurn('旧初稿正文'), userTurn('这是针对第一卷第07章的返修与精简指令'));
    const probe = helpers(doc).chatProbe({ users: 1, lastUserIdx: 0, lastModelIdx: 1 });
    expect(probe.newUser).toBe(true);          // our prompt landed…
    expect(probe.newModel).toBe(false);        // …but no model answer after it
    expect(probe.text).toBe('');               // nothing is extracted as a reply
  });

  test('pre-existing reply only (same chat, before our send) is not a new answer', () => {
    const doc = chatOf(userTurn('初稿指令'), modelTurn('旧初稿正文'));
    const { chatProbe } = helpers(doc);
    const probe = chatProbe(baseOf(chatProbe({ users: 0, lastUserIdx: -1, lastModelIdx: -1 })));
    expect(probe.newUser).toBe(false);
    expect(probe.newModel).toBe(false);
  });

  test('new reply still streaming: stop button visible and text hash keeps moving → never ready', () => {
    const streaming = chatOf(
      userTurn('初稿指令'), modelTurn('旧初稿正文'),
      userTurn('返修指令'), modelTurn('半截答复还在生成'),
      new El('button', { attrs: { 'aria-label': 'Stop generating' } }),
    );
    const base = { users: 1, lastUserIdx: 0, lastModelIdx: 1 };
    const p1 = helpers(streaming).chatProbe(base);
    expect(p1.newModel).toBe(true);
    expect(p1.stopVisible).toBe(true); // caller loop must NOT mark ready
    // same shape without the stop button but text still growing → hash differs
    const growing = chatOf(userTurn('初稿指令'), modelTurn('旧初稿正文'), userTurn('返修指令'), modelTurn('半截答复'));
    const grown = chatOf(userTurn('初稿指令'), modelTurn('旧初稿正文'), userTurn('返修指令'), modelTurn('半截答复后面又接了一段'));
    const h1 = helpers(growing).chatProbe(base).hash;
    const h2 = helpers(grown).chatProbe(base).hash;
    expect(h1).not.toBe(h2); // text not stable: caller requires 3 identical reads
    const h3 = helpers(grown).chatProbe(base).hash;
    expect(h3).toBe(h2); // stable once generation finishes
  });

  test('copy action rendered before text settles → only ready once stable', () => {
    const base = { users: 1, lastUserIdx: 0, lastModelIdx: 1 };
    const mk = (body: string) => chatOf(userTurn('u0'), modelTurn('m0'), userTurn('u1'), modelTurn(body));
    const a = helpers(mk('短')).chatProbe(base);
    const b = helpers(mk('短答复写完了')).chatProbe(base);
    expect(a.hasCopy).toBe(true); // button alone is not enough…
    expect(a.hash).not.toBe(b.hash); // …the hash must also stop moving
  });

  test('normal new reply: attributed to the new turn, SR label stripped, prompt not in text', () => {
    const reply = '2089年，地下二十八公里只剩死寂。林深扣紧骨传导耳机，听见自己的心跳。'.repeat(30);
    const doc = chatOf(userTurn('初稿指令'), modelTurn('旧初稿'), userTurn('返修指令'), modelTurn(reply));
    const probe = helpers(doc).chatProbe({ users: 1, lastUserIdx: 0, lastModelIdx: 1 });
    expect(probe.newUser && probe.newModel && probe.hasCopy && !probe.stopVisible).toBe(true);
    expect(probe.text).toBe(reply);
    expect(probe.text.startsWith('Gemini said')).toBe(false);
    expect(probe.text.length).toBe(reply.length);
  });

  test('multi-turn continuation chat: only the response after OUR user turn counts', () => {
    const doc = chatOf(
      userTurn('u0'), modelTurn('m0'), userTurn('u1'), modelTurn('m1'),
      userTurn('返修指令'), modelTurn('本轮新答复'),
    );
    const probe = helpers(doc).chatProbe({ users: 2, lastUserIdx: 2, lastModelIdx: 3 });
    expect(probe.newModel).toBe(true);
    expect(probe.lastModelIdx).toBe(5);
    expect(probe.text).toBe('本轮新答复'); // not m0/m1
  });

  test('thinking-only / no copy action yet → hasCopy false, not ready', () => {
    const doc = chatOf(
      userTurn('u0'), modelTurn('m0'),
      userTurn('返修指令'), modelTurn('思考中…', { copy: false }),
    );
    const probe = helpers(doc).chatProbe({ users: 1, lastUserIdx: 0, lastModelIdx: 1 });
    expect(probe.newModel).toBe(true);
    expect(probe.hasCopy).toBe(false); // generation not finished: caller keeps waiting
  });

  test('selector drift: no turn tags → nothing is attributed, fails closed', () => {
    const root = new El('body').add(
      new El('div', { text: 'You said\n指令' }).add(new El('button', { attrs: { 'aria-label': 'Copy prompt' } })),
      new El('div', { text: '答复' }).add(new El('button', { attrs: { 'aria-label': 'Copy' } })),
    );
    const probe = helpers(docOf(root)).chatProbe({ users: 0, lastUserIdx: -1, lastModelIdx: -1 });
    expect(probe.users).toBe(0);
    expect(probe.newUser).toBe(false);
    expect(probe.newModel).toBe(false); // unknown DOM → timeout/fail, never guess from buttons
  });

  test('replyLooksFake: You-said bubbles and prompt echoes are rejected, never stripped into text', () => {
    const { replyLooksFake } = helpers(chatOf());
    expect(replyLooksFake('You said\n这是针对第一卷第07章的返修与精简指令', '任意prompt')).toBe(true);
    expect(replyLooksFake('  You said 指令', '任意prompt')).toBe(true);
    const prompt = '这是针对第一卷第07章的返修与精简指令';
    expect(replyLooksFake('这是针对第一卷第07章的返修与精简指令', prompt)).toBe(true); // input === output
    expect(replyLooksFake('这是针对第一卷第07章的\n返修与精简指令', prompt)).toBe(true); // whitespace-insensitive echo
    expect(replyLooksFake('2089年，地下二十八公里只剩死寂。', prompt)).toBe(false);
  });
});

describe('recover lane (executable)', () => {
  const chat = () => chatOf(userTurn('初稿指令'), modelTurn('v1 初稿正文'), userTurn('返修指令'), modelTurn('v2 返修订稿'));
  test('turnMap lists nodes for the caller to pick an explicit user turn', () => {
    const map = helpers(chat()).turnMap();
    expect(map.turns.map(t => t.role)).toEqual(['user', 'model', 'user', 'model']);
  });
  test('pickReply extracts the reply after the chosen user turn; strict pairing fails closed', () => {
    const { pickReply } = helpers(chat());
    expect(pickReply(0).text).toBe('v1 初稿正文');
    expect(pickReply(2).text).toBe('v2 返修订稿');
    expect(pickReply(0).idx).toBe(1);
    expect(pickReply(3).err).toBe('not_user_turn');
    expect(pickReply(1).err).toBe('not_user_turn');
    expect(pickReply(4).err).toBe('out_of_range');
    // user turn with no following reply → fail, do not fall back to an older reply
    expect(helpers(chatOf(userTurn('u0'), modelTurn('m0'), userTurn('发了还没回'))).pickReply(2).err).toBe('no_reply');
    expect(helpers(chatOf(userTurn('u0'), modelTurn('m0'), userTurn('发了还没回'))).pickReply(0).err).toBe('');
  });
  test('recover script navigates the authorized chat and contains no prompt-send path', () => {
    const script = buildScript('notebook', {
      kind: 'notebook', prompt: '', outDir: '/tmp/o', file: 'r.md', refs: [], timeoutMs: 480000,
      notebookOp: 'recover', chat: 'https://gemini.google.com/app/298352bc8337e01f', turn: 2,
    });
    expect(script).toContain('"notebookOp":"recover"');
    expect(script).toContain('gemini.google.com/app/');
    const recoverBlock = script.slice(script.indexOf("ARGS.notebookOp === 'recover'"), script.indexOf('const nbId'));
    expect(recoverBlock).not.toContain('contenteditable'); // never fills an input
    expect(recoverBlock).not.toContain('ARGS.prompt');
    expect(recoverBlock).not.toContain('keyboard.press');
  });
});

// ---------------------------------------------------------------------------
// Full generated-script runs: the COMPLETE string produced by buildScript() is
// executed against a stub page/process/console — same harness shape as the
// deploy-QA negative fixture (task 42314024 qa/recover-negative.ts) that caught
// recover returning ok on unfinished replies. Only the browser DOM, waits and
// process.exit are faked; file writes are real, into a temp dir, so a wrong
// success path would visibly clobber the sentinel artifact.
// bun lacks InputEvent/location globals — polyfill for the in-page code.
(globalThis as Record<string, unknown>).InputEvent ??= class extends Event {
  constructor(t: string, i?: EventInit) { super(t, i); }
};

interface ScriptRun {
  ok?: boolean; code?: string; message?: string; file?: string; sha256?: string;
  source?: string; turns?: Array<{ i: number; role: string; len: number }>;
  url?: string; text?: string; bytes?: number;
  nav: string[]; pickReads: number;
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

async function runScript(script: string, body: El, opts: { onPick?: (reads: number) => void; pathname?: string } = {}): Promise<ScriptRun> {
  const doc = { body, querySelectorAll: (s: string) => body.querySelectorAll(s) };
  const nav: string[] = [];
  const logs: string[] = [];
  let pickReads = 0;
  const page = {
    goto: async (u: string) => { nav.push(u); },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    evaluate: async (fn: (...a: never[]) => unknown, arg?: unknown) => {
      const src = fn.toString();
      if (src.includes('return pickReply(turn)')) { pickReads += 1; opts.onPick?.(pickReads); }
      return new Function('document', 'location', 'arg', 'return (' + src + ')(arg)')(
        doc, { pathname: opts.pathname ?? '/app/deadbeef123456' }, arg);
    },
  };
  const taskSpace = async () => ({ pages: async () => [page], newPage: async () => page });
  const processStub = { exit: () => { throw new Error('FIXTURE_EXIT'); } };
  try {
    await new AsyncFunction('taskSpace', 'process', 'console', script)(
      taskSpace, processStub, { log: (s: string) => logs.push(s) });
  } catch (e) {
    if ((e as Error).message !== 'FIXTURE_EXIT') throw e;
  }
  const line = logs.filter(s => s.startsWith('__RESULT__')).pop();
  return { ...(line ? JSON.parse(line.slice('__RESULT__'.length)) : {}), nav, pickReads };
}

const recoverScript = (outDir: string, turn?: number) => buildScript('notebook', {
  kind: 'notebook', prompt: '', outDir, file: 'candidate.md', refs: [], timeoutMs: 480000,
  notebookOp: 'recover', chat: '298352bc8337e01f', turn,
});

describe('full generated scripts (page-stub executable)', () => {
  const SENTINEL = 'PREVIOUS_VALID_ARTIFACT';
  const seed = (outDir: string) => { writeFileSync(join(outDir, 'candidate.md'), SENTINEL); };
  const preserved = (outDir: string) => readFileSync(join(outDir, 'candidate.md'), 'utf8') === SENTINEL;

  test('recover map mode (no turn): emits turn map, writes nothing, never picks', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'sck-recmap-'));
    const body = new El('body').add(userTurn('初稿指令'), modelTurn('v1 正文'), userTurn('返修指令'), modelTurn('v2 正文'));
    const r = await runScript(recoverScript(outDir), body);
    expect(r.ok).toBe(true);
    expect(r.turns!.map(t => t.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(r.pickReads).toBe(0);
    expect(existsSync(join(outDir, 'candidate.md'))).toBe(false); // map mode must not write
    expect(r.nav).toEqual(['https://gemini.google.com/app/298352bc8337e01f']);
  });

  test('recover QA-negative: no Copy action + thoughts-only text → fails, sentinel preserved', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'sck-recneg1-'));
    seed(outDir);
    const model = new El('model-response', { text: 'Thoughts\n正在分析问题，暂时尚未产出最终模型回复。' });
    const body = new El('body').add(userTurn('QA fixture prompt'), model);
    const r = await runScript(recoverScript(outDir, 0), body);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Copy'); // completion marker missing → fail closed
    expect(r.pickReads).toBe(1);
    expect(preserved(outDir)).toBe(true);
  });

  test('recover QA-negative: Stop appears on the stability re-read → fails, sentinel preserved', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'sck-recneg2-'));
    seed(outDir);
    const body = new El('body').add(userTurn('QA fixture prompt'), modelTurn('这是用于测试的固定最终答复，长度足够。'));
    const r = await runScript(recoverScript(outDir, 0), body, {
      onPick: reads => { if (reads === 2) body.add(new El('button', { attrs: { 'aria-label': 'Stop generating' } })); },
    });
    expect(r.ok).toBe(false);
    expect(r.pickReads).toBe(2);
    expect(preserved(outDir)).toBe(true);
  });

  test('recover positive: finished reply → atomic write, provenance + sha256', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'sck-recpos-'));
    seed(outDir);
    const reply = '这是用于测试的固定最终答复，长度足够。';
    const body = new El('body').add(userTurn('QA fixture prompt'), modelTurn(reply));
    const r = await runScript(recoverScript(outDir, 0), body);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('gemini:298352bc8337e01f#i1');
    expect(r.sha256).toBeTruthy();
    expect(preserved(outDir)).toBe(false); // a genuinely finished reply MAY replace the candidate
    const written = readFileSync(join(outDir, 'candidate.md'), 'utf8');
    expect(written).toContain(reply);
    expect(written).toContain('recovered i1');
  });

  test('recover fails closed: model node picked / no reply after user turn', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'sck-recbad-'));
    seed(outDir);
    const body = new El('body').add(userTurn('u0'), modelTurn('m0 答复内容足够长'), userTurn('发了还没回'));
    const notUser = await runScript(recoverScript(outDir, 1), body);
    expect(notUser.ok).toBe(false);
    expect(notUser.message).toContain('不是用户轮次');
    const noReply = await runScript(recoverScript(outDir, 2), body);
    expect(noReply.ok).toBe(false);
    expect(noReply.message).toContain('没有模型答复');
    expect(preserved(outDir)).toBe(true);
  });

  const geminiShell = () => {
    const input = new El('div', { attrs: { contenteditable: 'true', 'aria-label': 'Enter a prompt for Gemini' } });
    const send = new El('button', { attrs: { 'aria-label': 'Send' } });
    const body = new El('body').add(input, send);
    return { body, send };
  };
  const NB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  test('write full script: new MODEL-RESPONSE after our USER-QUERY → ok + sha256 + session marker', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'sck-wrpos-'));
    const reply = '2089年，地下二十八公里只剩死寂。林深扣紧骨传导耳机，听见自己的心跳。';
    const { body, send } = geminiShell();
    send.onClick = () => body.add(userTurn('这是针对第一卷第07章的返修与精简指令'), modelTurn(reply));
    const script = buildScript('notebook', {
      kind: 'notebook', prompt: '这是针对第一卷第07章的返修与精简指令', outDir, file: 'candidate.md',
      refs: [], timeoutMs: 480000, notebookOp: 'write', notebook: NB_ID,
    });
    const r = await runScript(script, body);
    expect(r.ok).toBe(true);
    expect(r.sha256).toBeTruthy();
    expect(r.url).toBe('https://gemini.google.com/app/deadbeef123456');
    const written = readFileSync(join(outDir, 'candidate.md'), 'utf8');
    expect(written).toContain(reply);
    expect(written).toContain('gemini-session: https://gemini.google.com/app/deadbeef123456');
  });

  test('write full script: only our USER-QUERY lands (Copy prompt, no reply) → timeout fail, artifact untouched', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'sck-wrneg-'));
    seed(outDir);
    const { body, send } = geminiShell();
    send.onClick = () => body.add(userTurn('这是针对第一卷第07章的返修与精简指令')); // Copy prompt only — the original bug surface
    const script = buildScript('notebook', {
      kind: 'notebook', prompt: '这是针对第一卷第07章的返修与精简指令', outDir, file: 'candidate.md',
      refs: [], timeoutMs: 31000, notebookOp: 'write', notebook: NB_ID, // 1s poll window → fast timeout
    });
    const r = await runScript(script, body);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('不自动重发');
    expect(preserved(outDir)).toBe(true);
  }, 20000);
});

describe('model picker (Gemini composer pill)', () => {
  const pickers = (doc: FakeDocument): { openModelPicker: (w: string) => Record<string, unknown>;
    pickModelOption: (w: string) => Record<string, unknown>; modelPillText: () => string;
    modelPillMatches: (w: string) => boolean } =>
    new Function('document', `${MODEL_PICKER}\nreturn { openModelPicker, pickModelOption, modelPillText, modelPillMatches };`)(doc) as never;

  // Composer: textarea + a 'Flash-Lite' pill; clicking opens mat-option rows.
  const shellOf = (pillLabel = 'Flash-Lite') => {
    const menu: El[] = [];
    const pill = new El('button', { text: pillLabel, attrs: { 'aria-label': 'Model selector' } });
    const mkOpt = (label: string) => {
      const o = new El('mat-option', { text: label, attrs: { role: 'option' } });
      o.onClick = () => { pill.ownText = label; };
      return o;
    };
    for (const l of ['Flash-Lite', 'Fast', 'Gemini 3 Pro']) menu.push(mkOpt(l));
    const root = new El('body');
    const form = new El('form').add(new El('textarea', { attrs: { 'aria-label': 'Ask Gemini' } }), pill);
    root.add(form);
    pill.onClick = () => menu.forEach(m => root.add(m));
    return { root, doc: docOf(root) };
  };

  test('requested tier gets picked, verified against the pill', () => {
    const { doc } = shellOf();
    const p = pickers(doc);
    expect(p.openModelPicker('pro')).toMatchObject({ ok: true, opened: true });
    expect(p.pickModelOption('pro')).toMatchObject({ ok: true });
    expect(p.modelPillText()).toBe('Gemini 3 Pro');
  });
  test('already-on model short-circuits without opening the menu', () => {
    const { doc } = shellOf('Gemini 3 Pro');
    expect(pickers(doc).openModelPicker('pro')).toMatchObject({ ok: true, already: true, selected: 'Gemini 3 Pro' });
  });
  test('missing option fails closed and lists what the menu actually offers', () => {
    const { doc } = shellOf();
    const p = pickers(doc);
    p.openModelPicker('gemini9');
    const r = p.pickModelOption('gemini9');
    expect(r.err).toBe('no_match');
    expect((r.options as string[]).join(' ')).toContain('Gemini 3 Pro');
  });
  test('no picker element → no_picker', () => {
    const doc = docOf(new El('body').add(new El('div', { text: 'plain page' })));
    expect(pickers(doc).openModelPicker('pro').err).toBe('no_picker');
  });
  // 现场形状（任务 a6513276，2026-10-18）：作曲区药丸 aria-label 'Open mode picker,
  // currently <tier>'、inner 显示当前档位；侧边栏有 'More options for …模型方案' 干扰项；
  // 菜单真实五选项。want 'Gemini 4' 经 argon 别名命中 4 Argon，不点侧边栏、不点 Thinking/Flash。
  const liveShell = (tier = 'Flash-Lite') => {
    const menu: El[] = [];
    const pill = new El('button', { text: tier, attrs: { 'aria-label': `Open mode picker, currently ${tier}` } });
    const sidebar = new El('button', { attrs: { 'aria-label': 'More options for Cloudflare Worker 部署模型方案' } });
    const mkOpt = (label: string) => {
      const o = new El('mat-option', { text: label, attrs: { role: 'option' } });
      o.onClick = () => { pill.ownText = label; };
      return o;
    };
    for (const l of ['3.5 Flash-Lite Fastest answers', '3.8 Flash All-around help', '3.1 Pro Advanced reasoning', '4 Argon Complex tasks', 'Thinking level']) menu.push(mkOpt(l));
    const root = new El('body');
    const form = new El('form').add(new El('textarea', { attrs: { 'aria-label': 'Ask Gemini' } }), pill);
    root.add(form, sidebar);
    pill.onClick = () => menu.forEach(m => root.add(m));
    return { doc: docOf(root), pill };
  };
  test('live composer shape: the pill next to the composer is found, the sidebar lookalike is ignored', () => {
    const { doc, pill } = liveShell();
    const p = pickers(doc);
    expect(p.openModelPicker('Gemini 4')).toMatchObject({ ok: true, opened: true, before: 'Flash-Lite' });
    expect(p.modelPillText()).toBe('Flash-Lite');
    expect(p.modelPillMatches('gemini 4')).toBe(false);
    expect(pill.onClick).toBeDefined();
  });
  test('live menu: pickModelOption(Gemini 4) selects 4 Argon Complex tasks via the alias, not Thinking level or Flash', () => {
    const { doc } = liveShell();
    const p = pickers(doc);
    p.openModelPicker('Gemini 4');
    expect(p.pickModelOption('Gemini 4')).toMatchObject({ ok: true });
    expect(p.modelPillText()).toBe('4 Argon Complex tasks');
    expect(p.modelPillMatches('Gemini 4')).toBe(true);
  });
  test('live alias: pill already Argon → already without opening the menu; lowercase want matches too', () => {
    const { doc } = liveShell('Argon');
    const p = pickers(doc);
    expect(p.openModelPicker('Gemini 4')).toMatchObject({ ok: true, already: true, selected: 'Argon' });
    expect(p.modelPillMatches('gemini 4')).toBe(true);
  });
  test('fail closed: an unavailable want opens but matches nothing, verification rejects (no alias wash)', () => {
    const { doc } = liveShell();
    const p = pickers(doc);
    expect(p.openModelPicker('gemini9')).toMatchObject({ ok: true, opened: true });
    expect(p.pickModelOption('gemini9')).toMatchObject({ err: 'no_match' });
    expect(p.modelPillMatches('gemini9')).toBe(false);
  });
});

describe('generated scripts parse (template-escape regression)', () => {
  // A broken escape (e.g. '\n' written into a single-quoted JS string) is a
  // SyntaxError at parse time — build every op and parse it like nodejs -e would.
  const parse = (script: string) => () => new Function('taskSpace', 'return (async () => {\n' + script + '\n})');
  const nb = (extra: Record<string, unknown>) => buildScript('notebook', {
    kind: 'notebook', prompt: '一段足够长的写作指令', outDir: '/tmp/o', file: 'a.md', refs: [], timeoutMs: 480000, ...extra,
  });
  test('every notebook op generates a parseable script', () => {
    for (const script of [
      nb({ notebookOp: 'list' }),
      nb({ notebookOp: 'create', title: '作品名' }),
      nb({ notebookOp: 'query', notebook: '梦痕纪元' }),
      nb({ notebookOp: 'add_source', notebook: '梦痕纪元', title: 'v01', text: '正文' }),
      nb({ notebookOp: 'remove_source', notebook: '梦痕纪元', title: 'v01' }),
      nb({ notebookOp: 'write', notebook: '梦痕纪元' }),
      nb({ notebookOp: 'write', notebook: '梦痕纪元', chat: 'https://gemini.google.com/app/298352bc8337e01f' }),
      nb({ notebookOp: 'write', notebook: '梦痕纪元', model: 'pro' }),
      nb({ notebookOp: 'recover', chat: '298352bc8337e01f' }),
      nb({ notebookOp: 'recover', chat: '298352bc8337e01f', turn: 2 }),
    ]) expect(parse(script)).not.toThrow();
  });
  test('image/video provider scripts still parse', () => {
    for (const provider of ['gemini', 'chatgpt', 'grok']) {
      expect(parse(buildScript(provider, { kind: 'image', prompt: 'p', outDir: '/tmp/o', file: 'a.png', refs: [], timeoutMs: 300000 }))).not.toThrow();
      expect(parse(buildScript(provider, { kind: 'video', prompt: 'p', outDir: '/tmp/o', file: 'a.mp4', refs: [], seconds: 6, timeoutMs: 420000 }))).not.toThrow();
    }
  });
});
