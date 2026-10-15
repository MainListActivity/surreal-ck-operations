import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildScript, TURN_HELPERS } from '../src/media/browser-scripts.ts';

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
