import { describe, expect, test } from 'bun:test';

import { CompanyError } from '../../src/core-errors.ts';
import { bodyHash, deliveryOf, effectiveLangOf, type OutboundMessage } from '../../src/outbound-messages.ts';
import {
  keepsPlaceholders,
  translateChecked,
  translateMessage,
  translatePreview,
  translationFresh,
  type MessageStoreLike,
} from '../src/messages.ts';
import { json, scriptedFetch, testConfig } from './_support.ts';

const MAGPIE_ENV = {
  MAGPIE_BASE_URL: 'https://magpie.test.invalid/v1',
  MAGPIE_MODEL: 'm',
  MAGPIE_API_KEY: 'k',
};
const CHAT_URL = 'https://magpie.test.invalid/v1/chat/completions';

const chatReply = (content: unknown): Response => json({ choices: [{ message: { content } }] });

/** 捕获 CompanyError；其它错误原样抛出，使测试失败。 */
async function errorOf(run: () => Promise<unknown>): Promise<CompanyError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CompanyError) return error;
    throw error;
  }
  throw new Error('expected a CompanyError');
}

function message(extra: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: 'm1',
    taskId: 't1',
    step: 'execute',
    role: 'dev',
    body: '请确认 {taskId} 的验收',
    state: 'draft',
    hold: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/**
 * 测试替身（test double）：内存里的消息存储，只实现 translateMessage 用到的 get / setLanguage / setTranslation，
 * 语义与 src/outbound-messages.ts 中的 OutboundMessageStore 一致（选语言即作废旧译文并记 langChosen；
 * 译文以译过的原文为守卫，原文已改或已发送则拒绝）。calls 记录每次调用，供断言顺序与参数。
 */
class MemoryMessageStore implements MessageStoreLike {
  readonly calls: Array<{ op: 'get' | 'setLanguage' | 'setTranslation'; args: unknown[] }> = [];
  private readonly rows = new Map<string, OutboundMessage>();

  constructor(...messages: OutboundMessage[]) {
    for (const row of messages) this.rows.set(row.id, { ...row });
  }

  async get(messageId: string): Promise<OutboundMessage | undefined> {
    this.calls.push({ op: 'get', args: [messageId] });
    const row = this.rows.get(messageId);
    return row ? { ...row } : undefined;
  }

  async setLanguage(messageId: string, lang: string | undefined): Promise<OutboundMessage> {
    this.calls.push({ op: 'setLanguage', args: [messageId, lang] });
    const row = this.rows.get(messageId);
    if (!row) throw new CompanyError('not_found', 'message not found');
    if (row.state === 'sent') throw new CompanyError('conflict', 'sent message is locked');
    const next: OutboundMessage = {
      ...row,
      lang,
      langChosen: true,
      translatedText: undefined,
      translatedFromHash: undefined,
      translatedAt: undefined,
    };
    this.rows.set(messageId, next);
    return { ...next };
  }

  async setTranslation(messageId: string, lang: string, translatedText: string, expectedBody: string, actor: string): Promise<OutboundMessage> {
    this.calls.push({ op: 'setTranslation', args: [messageId, lang, translatedText, expectedBody, actor] });
    const row = this.rows.get(messageId);
    if (!row) throw new CompanyError('not_found', 'message not found');
    if (row.state === 'sent') throw new CompanyError('conflict', 'conflict: message already sent');
    if (row.body !== expectedBody) throw new CompanyError('conflict', 'conflict: body changed, translate again');
    const next: OutboundMessage = {
      ...row,
      lang,
      translatedText,
      translatedFromHash: await bodyHash(expectedBody),
      translatedAt: '2026-01-01T00:00:01.000Z',
    };
    this.rows.set(messageId, next);
    return { ...next };
  }

  /** 模拟老板改原文：只改 body，不动译文与 translatedFromHash（与真实的 edit 一致）。 */
  editBody(messageId: string, body: string): void {
    const row = this.rows.get(messageId);
    if (!row) throw new Error(`no message ${messageId}`);
    this.rows.set(messageId, { ...row, body, editedBy: 'owner', editedAt: '2026-01-01T00:00:02.000Z' });
  }

  /** 直接读出当前行（不记入 calls），用于断言存储状态。 */
  peek(messageId: string): OutboundMessage {
    const row = this.rows.get(messageId);
    if (!row) throw new Error(`no message ${messageId}`);
    return { ...row };
  }
}

describe('译文新鲜度 translationFresh', () => {
  test('有译文且译文时的原文哈希与现在的原文一致，则新鲜', async () => {
    const body = '请确认 {taskId} 的验收';
    const fresh = await translationFresh({ body, translatedText: 'Please confirm {taskId}', translatedFromHash: await bodyHash(body) });
    expect(fresh).toBe(true);
  });

  test('原文被改后哈希不一致，译文过期', async () => {
    const translatedFromHash = await bodyHash('请确认 {taskId} 的验收');
    const fresh = await translationFresh({ body: '请确认 {taskId} 的验收（改）', translatedText: 'Please confirm {taskId}', translatedFromHash });
    expect(fresh).toBe(false);
  });

  test('缺少译文文本（或只有空白）不新鲜', async () => {
    const body = '请确认 {taskId} 的验收';
    const translatedFromHash = await bodyHash(body);
    expect(await translationFresh({ body, translatedFromHash })).toBe(false);
    expect(await translationFresh({ body, translatedText: '   ', translatedFromHash })).toBe(false);
  });

  test('没有语言的消息也没有译文：translationFresh 不看语言，结果为不新鲜；“无需译文”由定时任务在语言为空时直接跳过', async () => {
    // translationFresh 只看译文与哈希。refreshTranslations 先判断 message.lang，无语言的消息根本不会进入这里。
    expect(await translationFresh({ body: '原文' })).toBe(false);
  });
});

describe('占位标记 keepsPlaceholders', () => {
  test('原文没有占位标记时，任何译文都保留了占位标记', () => {
    expect(keepsPlaceholders('请今天完成验收', 'Finish acceptance today')).toBe(true);
  });

  test('原文有 {taskId}、sck call、task.md，译文全部保留则为 true', () => {
    const source = '请阅读 task.md，运行 sck call，任务 {taskId}';
    expect(keepsPlaceholders(source, 'Read task.md, run sck call, task {taskId}')).toBe(true);
  });

  test('译文丢了 {taskId} 则为 false', () => {
    expect(keepsPlaceholders('任务 {taskId} 完成', 'Task completed')).toBe(false);
  });

  test('译文丢了 sck call 则为 false', () => {
    expect(keepsPlaceholders('请运行 sck call 提交', 'Please submit')).toBe(false);
  });

  test('译文丢了 task.md 则为 false', () => {
    expect(keepsPlaceholders('请更新 task.md', 'Please update the file')).toBe(false);
  });
});

describe('translateChecked 译文调用', () => {
  const SOURCE = '请阅读 task.md，运行 sck call，任务 {taskId}';

  test('译文保留占位标记时返回去首尾空白后的译文，并按约定发出请求', async () => {
    const { fetch, requests } = scriptedFetch([
      () => chatReply('  Read task.md, run sck call, task {taskId}\n'),
    ]);
    const text = await translateChecked(testConfig(MAGPIE_ENV), SOURCE, 'en', fetch);

    expect(text).toBe('Read task.md, run sck call, task {taskId}');
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(CHAT_URL);
    expect(request.headers.get('authorization')).toBe('Bearer k');
    const body = (await request.json()) as { model: string; temperature: number; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe('m');
    expect(body.temperature).toBe(0);
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).toContain('en');
    expect(body.messages[1]).toEqual({ role: 'user', content: SOURCE });
  });

  test('译文丢了占位标记时抛 upstream_error（不写库，由调用方决定）', async () => {
    const { fetch, requests } = scriptedFetch([() => chatReply('Read the file and continue')]);
    const error = await errorOf(() => translateChecked(testConfig(MAGPIE_ENV), SOURCE, 'en', fetch));
    expect(error.code).toBe('upstream_error');
    expect(requests.map((r) => r.url)).toEqual([CHAT_URL]);
  });

  test('上游返回 500 时抛 upstream_error', async () => {
    const { fetch, requests } = scriptedFetch([() => json({ error: 'boom' }, 500)]);
    const error = await errorOf(() => translateChecked(testConfig(MAGPIE_ENV), '请确认验收', 'en', fetch));
    expect(error.code).toBe('upstream_error');
    expect(requests[0]!.url).toBe(CHAT_URL);
  });

  test('上游返回非 JSON 正文时抛 upstream_error', async () => {
    const { fetch } = scriptedFetch([() => new Response('<html>gateway</html>', { status: 200 })]);
    const error = await errorOf(() => translateChecked(testConfig(MAGPIE_ENV), '请确认验收', 'en', fetch));
    expect(error.code).toBe('upstream_error');
  });

  test('上游返回空内容（只有空白）时抛 upstream_error', async () => {
    const { fetch } = scriptedFetch([() => chatReply('   ')]);
    const error = await errorOf(() => translateChecked(testConfig(MAGPIE_ENV), '请确认验收', 'en', fetch));
    expect(error.code).toBe('upstream_error');
  });

  test('网络不可达（fetch 抛错）时抛 upstream_error', async () => {
    const { fetch } = scriptedFetch([]);
    const error = await errorOf(() => translateChecked(testConfig(MAGPIE_ENV), '请确认验收', 'en', fetch));
    expect(error.code).toBe('upstream_error');
  });
});

describe('translatePreview 译文预览', () => {
  test('空白文本抛 invalid，且不发起请求', async () => {
    const { fetch, requests } = scriptedFetch([]);
    const error = await errorOf(() => translatePreview(testConfig(MAGPIE_ENV), { lang: 'en', text: '   ' }, fetch));
    expect(error.code).toBe('invalid');
    expect(requests).toHaveLength(0);
  });

  test('文本超过 MAX_TRANSLATION（20000）抛 invalid，且不发起请求', async () => {
    const { fetch, requests } = scriptedFetch([]);
    const error = await errorOf(() => translatePreview(testConfig(MAGPIE_ENV), { lang: 'en', text: 'a'.repeat(20_001) }, fetch));
    expect(error.code).toBe('invalid');
    expect(requests).toHaveLength(0);
  });

  test('不合法的语言代码抛 invalid，且不发起请求', async () => {
    for (const lang of ['english', 'e', 'zh_TW', '', undefined]) {
      const { fetch, requests } = scriptedFetch([]);
      const error = await errorOf(() => translatePreview(testConfig(MAGPIE_ENV), { lang, text: '请确认' }, fetch));
      expect(error.code).toBe('invalid');
      expect(requests).toHaveLength(0);
    }
  });

  test('合法输入返回译文与语言，且只发起一次请求（不落库，不接受 db）', async () => {
    const { fetch, requests } = scriptedFetch([() => chatReply('Please confirm acceptance')]);
    const result = await translatePreview(testConfig(MAGPIE_ENV), { lang: 'zh-TW', text: '请确认验收' }, fetch);
    expect(result).toEqual({ lang: 'zh-TW', text: 'Please confirm acceptance' });
    expect(requests.map((r) => r.url)).toEqual([CHAT_URL]);
  });
});

describe('translateMessage 为消息选语言并保存译文', () => {
  test('lang 为 null 时调用 setLanguage(id, undefined)，不译文、不发请求', async () => {
    const store = new MemoryMessageStore(message({ lang: 'en', langChosen: true }));
    const { fetch, requests } = scriptedFetch([]);
    const result = await translateMessage(store, testConfig(MAGPIE_ENV), { messageId: 'm1', lang: null }, 'owner', fetch);

    expect(store.calls).toEqual([{ op: 'setLanguage', args: ['m1', undefined] }]);
    expect(result.lang).toBeUndefined();
    expect(result.langChosen).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test('消息不存在时抛 not_found，且不发请求', async () => {
    const store = new MemoryMessageStore();
    const { fetch, requests } = scriptedFetch([]);
    const error = await errorOf(() => translateMessage(store, testConfig(MAGPIE_ENV), { messageId: 'nope', lang: 'en' }, 'owner', fetch));
    expect(error.code).toBe('not_found');
    expect(requests).toHaveLength(0);
  });

  test('消息已发送（state 为 sent）时抛 conflict，且不发请求', async () => {
    const store = new MemoryMessageStore(message({ state: 'sent' }));
    const { fetch, requests } = scriptedFetch([]);
    const error = await errorOf(() => translateMessage(store, testConfig(MAGPIE_ENV), { messageId: 'm1', lang: 'en' }, 'owner', fetch));
    expect(error.code).toBe('conflict');
    expect(requests).toHaveLength(0);
  });

  test('正常路径：先 setLanguage(id, lang)，再 setTranslation(id, lang, 译文, 原文, actor)，返回 setTranslation 的结果', async () => {
    const source = '请确认 {taskId} 的验收';
    const store = new MemoryMessageStore(message({ body: source }));
    const { fetch } = scriptedFetch([() => chatReply('Please confirm acceptance of {taskId}')]);
    const result = await translateMessage(store, testConfig(MAGPIE_ENV), { messageId: 'm1', lang: 'en' }, 'owner', fetch);

    expect(store.calls.map((c) => c.op)).toEqual(['get', 'setLanguage', 'setTranslation']);
    expect(store.calls[1]!.args).toEqual(['m1', 'en']);
    expect(store.calls[2]!.args).toEqual(['m1', 'en', 'Please confirm acceptance of {taskId}', source, 'owner']);
    expect(result.lang).toBe('en');
    expect(result.translatedText).toBe('Please confirm acceptance of {taskId}');
    expect(result.translatedFromHash).toBe(await bodyHash(source));
  });

  test('译文失败（上游 500）时不写库：不调用 setLanguage 与 setTranslation', async () => {
    const store = new MemoryMessageStore(message());
    const { fetch } = scriptedFetch([() => json({}, 500)]);
    const error = await errorOf(() => translateMessage(store, testConfig(MAGPIE_ENV), { messageId: 'm1', lang: 'en' }, 'owner', fetch));
    expect(error.code).toBe('upstream_error');
    expect(store.calls.map((c) => c.op)).toEqual(['get']);
  });

  test('译文丢了占位标记时不写库', async () => {
    const store = new MemoryMessageStore(message({ body: '请运行 sck call' }));
    const { fetch } = scriptedFetch([() => chatReply('Please run it')]);
    const error = await errorOf(() => translateMessage(store, testConfig(MAGPIE_ENV), { messageId: 'm1', lang: 'en' }, 'owner', fetch));
    expect(error.code).toBe('upstream_error');
    expect(store.calls.map((c) => c.op)).toEqual(['get']);
  });
});

describe('投递语义：真实的 bodyHash、deliveryOf、effectiveLangOf 与内存存储配合', () => {
  const SOURCE = '请确认 {taskId} 的验收';

  test('选了 en 但还没有译文：deliveryOf 为 awaiting_translation，不发原文', async () => {
    const store = new MemoryMessageStore(message({ body: SOURCE }));
    await store.setLanguage('m1', 'en');
    const row = store.peek('m1');

    expect(effectiveLangOf(row, undefined)).toBe('en');
    expect(await deliveryOf(row, undefined)).toEqual({ ok: false, reason: 'awaiting_translation' });
  });

  test('translateMessage 完成后：deliveryOf 返回译文（translated=true）；原文被改后译文作废，再次等待补译', async () => {
    const store = new MemoryMessageStore(message({ body: SOURCE }));
    await store.setLanguage('m1', 'en');
    const { fetch } = scriptedFetch([() => chatReply('Please confirm acceptance for {taskId}')]);
    await translateMessage(store, testConfig(MAGPIE_ENV), { messageId: 'm1', lang: 'en' }, 'owner', fetch);

    expect(await deliveryOf(store.peek('m1'), undefined)).toEqual({
      ok: true,
      body: 'Please confirm acceptance for {taskId}',
      translated: true,
    });

    // 老板改了原文：旧译文仍在，但哈希不再匹配，必须等待补译。
    store.editBody('m1', '请确认 {taskId} 的验收，并附上测试结果');
    const edited = store.peek('m1');
    expect(edited.translatedText).toBe('Please confirm acceptance for {taskId}');
    expect(await deliveryOf(edited, undefined)).toEqual({ ok: false, reason: 'awaiting_translation' });
  });

  test('没有语言且老板未选过语言，员工默认语言 ja 生效：等待 ja 译文；老板清除选择（setLanguage(undefined)）后投递原文', async () => {
    const store = new MemoryMessageStore(message({ body: SOURCE }));
    const employeeLang = 'ja';

    const before = store.peek('m1');
    expect(effectiveLangOf(before, employeeLang)).toBe('ja');
    expect(await deliveryOf(before, employeeLang)).toEqual({ ok: false, reason: 'awaiting_translation' });

    // 老板选“原文”（lang 为 null），记下 langChosen，之后不再套用员工默认语言。
    const { fetch, requests } = scriptedFetch([]);
    await translateMessage(store, testConfig(MAGPIE_ENV), { messageId: 'm1', lang: null }, 'owner', fetch);
    expect(requests).toHaveLength(0);

    const after = store.peek('m1');
    expect(after.langChosen).toBe(true);
    expect(effectiveLangOf(after, employeeLang)).toBeUndefined();
    expect(await deliveryOf(after, employeeLang)).toEqual({ ok: true, body: SOURCE, translated: false });
  });

  test('没有语言也没有员工默认语言：原文直接投递（translated=false）', async () => {
    const store = new MemoryMessageStore(message({ body: SOURCE }));
    expect(await deliveryOf(store.peek('m1'), undefined)).toEqual({ ok: true, body: SOURCE, translated: false });
  });
});
