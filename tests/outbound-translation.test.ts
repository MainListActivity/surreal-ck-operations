import { describe, expect, test } from 'bun:test';
import { CompanyError } from '../src/core-errors.ts';
import { OutboundMessageStore, bodyHash, deliveryOf, effectiveLangOf } from '../src/outbound-messages.ts';

// 译文投递的纯判定与存储层守卫：不连数据库，用一个只认语句形状的假 Surreal 面。
// 真实库上的同一条路径（058 字段、UPDATE 的 WHERE 守卫、员工语言）由 tests/outbound-translation.fork.test.ts 验证。

const ZH = '先读 notes.md，完成任务。';
const JA_TEXT = '先に notes.md を読み、タスクを完了してください。';
const EN_TEXT = 'Read notes.md first, then complete the task.';

describe('原文哈希', () => {
  test('SHA-256 小写十六进制，64 位，同文同哈希', async () => {
    expect(await bodyHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const first = await bodyHash(ZH);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await bodyHash(ZH)).toBe(first);
    expect(await bodyHash(`${ZH} `)).not.toBe(first);
  });
});

describe('投递判定 deliveryOf', () => {
  test('没有消息语言、员工也没有语言：原文照发，与译文无关', async () => {
    expect(await deliveryOf({ body: ZH }, undefined)).toEqual({ ok: true, body: ZH, translated: false });
    expect(await deliveryOf({ body: ZH }, '')).toEqual({ ok: true, body: ZH, translated: false });
    expect(await deliveryOf({ body: ZH, translatedText: JA_TEXT, translatedFromHash: 'x' }, undefined))
      .toEqual({ ok: true, body: ZH, translated: false });
  });

  test('没选过语言的消息跟着员工走：员工没有语言就照发原文，即使消息上残留着别的语言和译文', async () => {
    expect(await deliveryOf({ body: ZH, lang: 'ja', translatedText: JA_TEXT, translatedFromHash: 'x' }, undefined))
      .toEqual({ ok: true, body: ZH, translated: false });
  });

  test('老板选过的语言不随员工走：选了日语但没有译文，即使员工没有语言也等待，不发原文', async () => {
    expect(await deliveryOf({ body: ZH, lang: 'ja', langChosen: true }, undefined))
      .toEqual({ ok: false, reason: 'awaiting_translation' });
  });

  test('ready：语言相同、译文非空、哈希与当前原文一致，发译文', async () => {
    const message = { body: ZH, lang: 'ja', translatedText: JA_TEXT, translatedFromHash: await bodyHash(ZH) };
    expect(await deliveryOf(message, 'ja')).toEqual({ ok: true, body: JA_TEXT, translated: true });
  });

  test('missing：没有译文（或只有空白），等待补译', async () => {
    expect(await deliveryOf({ body: ZH }, 'ja')).toEqual({ ok: false, reason: 'awaiting_translation' });
    expect(await deliveryOf({ body: ZH, lang: 'ja', translatedText: '   ', translatedFromHash: await bodyHash(ZH) }, 'ja'))
      .toEqual({ ok: false, reason: 'awaiting_translation' });
  });

  test('stale：译文是按旧原文做的，哈希不一致，不发', async () => {
    const message = { body: ZH, lang: 'ja', translatedText: JA_TEXT, translatedFromHash: await bodyHash('旧的原文') };
    expect(await deliveryOf(message, 'ja')).toEqual({ ok: false, reason: 'awaiting_translation' });
  });

  test('老板选过的语言优先于员工默认语言；没选过的消息跟着员工走，语言不同即等待补译', async () => {
    expect(await deliveryOf({ body: ZH, lang: 'en', langChosen: true }, 'ja')).toEqual({ ok: false, reason: 'awaiting_translation' });
    expect(await deliveryOf({ body: ZH, lang: 'en' }, 'ja')).toEqual({ ok: false, reason: 'awaiting_translation' });
    expect(await deliveryOf({ body: ZH }, 'ja')).toEqual({ ok: false, reason: 'awaiting_translation' });
    const stale = { body: ZH, lang: 'en', translatedText: EN_TEXT, translatedFromHash: await bodyHash(ZH) };
    expect(await deliveryOf(stale, 'ja')).toEqual({ ok: false, reason: 'awaiting_translation' });
    const chosen = { body: ZH, lang: 'en', langChosen: true, translatedText: EN_TEXT, translatedFromHash: await bodyHash(ZH) };
    expect(await deliveryOf(chosen, 'ja')).toEqual({ ok: true, body: EN_TEXT, translated: true });
  });
});

describe('生效语言 effectiveLangOf', () => {
  test('老板选过的语言优先于员工默认语言', () => {
    expect(effectiveLangOf({ lang: 'en', langChosen: true }, 'ja')).toBe('en');
  });

  test('没选过的消息跟着员工走：消息上残留的语言不算，取员工默认语言', () => {
    expect(effectiveLangOf({ lang: 'en' }, 'ja')).toBe('ja');
    expect(effectiveLangOf({ lang: 'en' }, undefined)).toBeUndefined();
  });

  test('没有消息语言、老板没选过：取员工默认语言', () => {
    expect(effectiveLangOf({}, 'ja')).toBe('ja');
    expect(effectiveLangOf({ langChosen: false }, 'ja')).toBe('ja');
    expect(effectiveLangOf({}, '')).toBeUndefined();
  });

  test('老板选过（含选原文）：不再套用员工默认语言', () => {
    expect(effectiveLangOf({ langChosen: true }, 'ja')).toBeUndefined();
    expect(effectiveLangOf({ langChosen: true }, undefined)).toBeUndefined();
  });

  test('投递与看板同一判定：选过原文的消息照发原文，即使员工有语言', async () => {
    expect(await deliveryOf({ body: ZH, langChosen: true }, 'ja')).toEqual({ ok: true, body: ZH, translated: false });
  });
});

/** 一行 outbound_message 的形状（store 的 rowView 读这些字段）。 */
const messageRow = (extra: Record<string, unknown> = {}) => ({
  id: { id: 'm1' }, task: { id: 't1' }, step: 'execute', role: 'engineering', body: ZH, state: 'draft', hold: false,
  created_at: 'now', ...extra,
});

interface FakeOptions {
  /** latestDraft 返回的行。 */
  draft?: Record<string, unknown>;
  /** agent_policy 里该员工的语言；缺省即没有语言。 */
  lang?: string;
  /** 译文 UPDATE 是否命中（原文仍与 expectedBody 相同且未发送）。 */
  matches?: boolean;
  /** 消息当前状态（translationRefusal 的 SELECT state）；缺省即消息不存在。 */
  state?: string;
}

/** 只认语句形状的假库；所有写入语句记入 writes，所有语句记入 statements。 */
function fakeDb(opts: FakeOptions = {}) {
  const writes: Array<{ sql: string; vars: Record<string, unknown> }> = [];
  const statements: string[] = [];
  const db = {
    statements,
    writes,
    query: async (sql: string, vars: Record<string, unknown> = {}) => {
      statements.push(sql);
      if (sql.includes('SELECT lang FROM agent_policy')) return [opts.lang ? [{ lang: opts.lang }] : []];
      if (sql.includes("AND step = $step AND state != 'sent' ORDER BY created_at DESC LIMIT 1")) return [opts.draft ? [opts.draft] : []];
      if (sql.includes('SELECT executor_role')) return [[{ executor_role: 'engineering', reviewer_role: 'qa', kind: 'task' }]];
      if (sql.includes("state = 'sent' ORDER BY created_at DESC")) return [[]];
      if (sql.includes('UPDATE $msg SET lang')) {
        writes.push({ sql, vars });
        return [opts.matches ? [messageRow({ lang: vars.lang, translated_text: vars.text, translated_from_hash: vars.hash, translated_at: 'now' })] : []];
      }
      if (sql.includes('SELECT state FROM $msg')) return [opts.state === undefined ? [] : [{ state: opts.state }]];
      if (sql.includes('CREATE outbound_message')) {
        writes.push({ sql, vars });
        return [[messageRow({ step: vars.step, role: vars.role, body: vars.body })]];
      }
      if (/\b(UPDATE|CREATE)\b/.test(sql)) writes.push({ sql, vars });
      return [[]];
    },
  };
  return db;
}

describe('OutboundMessageStore.setTranslation', () => {
  test('空译文直接拒绝，不读写库', async () => {
    const db = fakeDb();
    const store = new OutboundMessageStore(db as never);
    await expect(store.setTranslation('m1', 'ja', '   ', ZH, 'owner:test')).rejects.toThrow('translation must not be empty');
    expect(db.statements).toEqual([]);
  });

  test('写入译文：哈希取自被译的原文，不改 edited_by 与 edited_at', async () => {
    const db = fakeDb({ matches: true });
    const store = new OutboundMessageStore(db as never);
    const saved = await store.setTranslation('m1', 'ja', JA_TEXT, ZH, 'owner:test');
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.vars).toMatchObject({ lang: 'ja', text: JA_TEXT, hash: await bodyHash(ZH), expectedBody: ZH });
    expect(db.writes[0]!.sql).toContain("WHERE state != 'sent' AND body = $expectedBody");
    expect(db.writes[0]!.sql).not.toContain('edited_by');
    expect(db.writes[0]!.sql).not.toContain('edited_at');
    expect(saved).toMatchObject({ lang: 'ja', translatedText: JA_TEXT, translatedFromHash: await bodyHash(ZH) });
    expect(saved.editedBy).toBeUndefined();
  });

  test('原文已变（消息存在且未发）：conflict，提示重新译', async () => {
    const db = fakeDb({ matches: false, state: 'draft' });
    const error = await new OutboundMessageStore(db as never).setTranslation('m1', 'ja', JA_TEXT, '旧原文', 'owner:test').catch(e => e) as CompanyError;
    expect(error).toBeInstanceOf(CompanyError);
    expect(error.code).toBe('conflict');
    expect(error.message).toBe('conflict: body changed, translate again');
  });

  test('已发送：conflict 且提示已发送', async () => {
    const db = fakeDb({ matches: false, state: 'sent' });
    const error = await new OutboundMessageStore(db as never).setTranslation('m1', 'ja', JA_TEXT, ZH, 'owner:test').catch(e => e) as CompanyError;
    expect(error.code).toBe('conflict');
    expect(error.message).toBe('conflict: message already sent');
  });

  test('消息不存在：not_found', async () => {
    const db = fakeDb({ matches: false });
    const error = await new OutboundMessageStore(db as never).setTranslation('m1', 'ja', JA_TEXT, ZH, 'owner:test').catch(e => e) as CompanyError;
    expect(error.code).toBe('not_found');
  });
});

describe('OutboundMessageStore.prepareSend 与员工语言', () => {
  test('没有员工语言：发原文，与改动前一致', async () => {
    const db = fakeDb({ draft: messageRow({ body: ZH }) });
    const prepared = await new OutboundMessageStore(db as never).prepareSend('t1', 'execute', 'e1');
    expect(prepared!.body).toBe(ZH);
    expect(prepared!.message).toMatchObject({ id: 'm1', body: ZH, sentTo: 'e1' });
  });

  test('员工有语言但没有译文：返回 null；只把员工语言写到消息上，hold 与状态都不变', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow() });
    expect(await new OutboundMessageStore(db as never).prepareSend('t1', 'execute', 'e1')).toBeNull();
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.sql).toContain('SET lang = $lang, translated_text = NONE, translated_from_hash = NONE');
    expect(db.writes[0]!.sql).toContain("WHERE state != 'sent' AND lang_chosen != true");
    expect(db.writes[0]!.vars).toMatchObject({ lang: 'ja' });
  });

  test('员工有语言且译文就绪：返回译文，返回的 message 保持原行', async () => {
    const hash = await bodyHash(ZH);
    const db = fakeDb({ lang: 'ja', draft: messageRow({ lang: 'ja', translated_text: JA_TEXT, translated_from_hash: hash }) });
    const prepared = await new OutboundMessageStore(db as never).prepareSend('t1', 'execute', 'e1');
    expect(prepared!.body).toBe(JA_TEXT);
    expect(prepared!.message.body).toBe(ZH);
    expect(prepared!.message.state).toBe('draft');
    expect(db.writes).toEqual([]);
  });

  test('员工有语言，原文已改（译文过期）：返回 null', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow({ body: '改过的原文', lang: 'ja', translated_text: JA_TEXT, translated_from_hash: await bodyHash(ZH) }) });
    expect(await new OutboundMessageStore(db as never).prepareSend('t1', 'execute', 'e1')).toBeNull();
  });

  test('被老板保留的消息仍返回 null（与语言无关）', async () => {
    const hash = await bodyHash(ZH);
    const db = fakeDb({ draft: messageRow({ hold: true, state: 'held', lang: 'ja', translated_text: JA_TEXT, translated_from_hash: hash }) });
    expect(await new OutboundMessageStore(db as never).prepareSend('t1', 'execute', 'e1')).toBeNull();
  });

  test('没有草稿、员工无语言：即时生成的模板照发', async () => {
    const db = fakeDb();
    const prepared = await new OutboundMessageStore(db as never).prepareSend('t1', 'execute', 'e1');
    expect(prepared).not.toBeNull();
    expect(prepared!.body.length).toBeGreaterThan(0);
  });
});

describe('OutboundMessageStore.awaitingTranslation：等待译文与老板放行分开判定', () => {
  test('员工没有语言：不等待译文（原文照发）', async () => {
    const db = fakeDb({ draft: messageRow() });
    expect(await new OutboundMessageStore(db as never).awaitingTranslation('t1', 'execute', 'e1')).toBe(false);
    expect(db.writes).toEqual([]);
  });

  test('员工有语言但没有译文：等待译文，且只读', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow() });
    expect(await new OutboundMessageStore(db as never).awaitingTranslation('t1', 'execute', 'e1')).toBe(true);
    expect(db.writes).toEqual([]);
  });

  test('员工有语言且译文就绪：不等待', async () => {
    const hash = await bodyHash(ZH);
    const db = fakeDb({ lang: 'ja', draft: messageRow({ lang: 'ja', translated_text: JA_TEXT, translated_from_hash: hash }) });
    expect(await new OutboundMessageStore(db as never).awaitingTranslation('t1', 'execute', 'e1')).toBe(false);
  });

  test('原文已改、译文过期：仍等待译文', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow({ body: '改过的原文', lang: 'ja', translated_text: JA_TEXT, translated_from_hash: await bodyHash(ZH) }) });
    expect(await new OutboundMessageStore(db as never).awaitingTranslation('t1', 'execute', 'e1')).toBe(true);
  });

  test('老板保留的消息：不算等待译文（那是放行问题，走 hold 通知）', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow({ hold: true, state: 'held' }) });
    expect(await new OutboundMessageStore(db as never).awaitingTranslation('t1', 'execute', 'e1')).toBe(false);
    expect(await new OutboundMessageStore(db as never).isHeld('t1', 'execute')).toBe(true);
  });

  test('有语言但还没有草稿：等待译文（新草稿不会带译文），不写库', async () => {
    const db = fakeDb({ lang: 'ja' });
    expect(await new OutboundMessageStore(db as never).awaitingTranslation('t1', 'execute', 'e1')).toBe(true);
    expect(db.writes).toEqual([]);
  });

  test('等待译文时 prepareSend 仍返回 null，除写入员工语言外不改消息', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow() });
    expect(await new OutboundMessageStore(db as never).prepareSend('t1', 'execute', 'e1')).toBeNull();
    expect(db.writes.every(write => write.sql.includes('SET lang = $lang'))).toBe(true);
  });
});

describe('OutboundMessageStore.alignLanguage：派工前把语言对齐到员工默认语言', () => {
  test('消息还没有语言、员工有语言：写入员工语言，并清掉旧译文', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow({ translated_text: JA_TEXT, translated_from_hash: 'x' }) });
    await new OutboundMessageStore(db as never).alignLanguage('t1', 'execute', 'e1');
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.sql).toContain('SET lang = $lang, translated_text = NONE, translated_from_hash = NONE');
    expect(db.writes[0]!.sql).toContain("WHERE state != 'sent' AND lang_chosen != true");
    expect(db.writes[0]!.vars).toMatchObject({ lang: 'ja' });
  });

  test('员工换了语言：旧语言的译文清掉，改成新员工的语言', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow({ lang: 'en', translated_text: EN_TEXT, translated_from_hash: await bodyHash(ZH) }) });
    await new OutboundMessageStore(db as never).alignLanguage('t1', 'execute', 'e1');
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.vars).toMatchObject({ lang: 'ja' });
  });

  test('已经对齐：只读，不写库', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow({ lang: 'ja', translated_text: JA_TEXT, translated_from_hash: await bodyHash(ZH) }) });
    await new OutboundMessageStore(db as never).alignLanguage('t1', 'execute', 'e1');
    expect(db.writes).toEqual([]);
  });

  test('老板选过语言的消息：不改，即使员工语言不同', async () => {
    const db = fakeDb({ lang: 'ja', draft: messageRow({ lang: 'en', lang_chosen: true, translated_text: EN_TEXT }) });
    await new OutboundMessageStore(db as never).alignLanguage('t1', 'execute', 'e1');
    expect(db.writes).toEqual([]);
  });

  test('员工没有语言：清掉消息上残留的语言与译文，回到原文', async () => {
    const db = fakeDb({ draft: messageRow({ lang: 'en', translated_text: EN_TEXT, translated_from_hash: 'x' }) });
    await new OutboundMessageStore(db as never).alignLanguage('t1', 'execute', 'e1');
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.sql).toContain('SET lang = NONE, translated_text = NONE, translated_from_hash = NONE');
    expect(db.writes[0]!.vars).not.toHaveProperty('lang');
  });

  test('没有草稿：先补一条（模板），再对齐语言', async () => {
    const db = fakeDb({ lang: 'ja' });
    await new OutboundMessageStore(db as never).alignLanguage('t1', 'execute', 'e1');
    expect(db.statements.some(sql => sql.includes('CREATE outbound_message'))).toBe(true);
    expect(db.writes.some(write => write.sql.includes('SET lang = $lang'))).toBe(true);
  });
});

describe('OutboundMessageStore.awaitingTranslation：没有员工（新员工没有默认语言）', () => {
  test('消息只是跟着员工走的语言：新员工没有语言，不等待', async () => {
    const db = fakeDb({ draft: messageRow({ lang: 'ja' }) });
    expect(await new OutboundMessageStore(db as never).awaitingTranslation('t1', 'execute', undefined)).toBe(false);
  });

  test('老板选过语言但没有译文：即使新员工没有语言也等待', async () => {
    const db = fakeDb({ draft: messageRow({ lang: 'ja', lang_chosen: true }) });
    expect(await new OutboundMessageStore(db as never).awaitingTranslation('t1', 'execute', undefined)).toBe(true);
    expect(db.writes).toEqual([]);
  });
});

describe('行映射：译文字段', () => {
  test('rowView 带出 lang / translated_text / translated_from_hash / translated_at；缺省为 undefined', async () => {
    const withTranslation = messageRow({ lang: 'ja', translated_text: JA_TEXT, translated_from_hash: 'abc', translated_at: '2026-01-01T00:00:00Z' });
    const plain = messageRow({ id: { id: 'm2' } });
    const store = new OutboundMessageStore({ query: async () => [[withTranslation, plain]] } as never);
    const [first, second] = await store.list('t1');
    expect(first).toMatchObject({ lang: 'ja', translatedText: JA_TEXT, translatedFromHash: 'abc', translatedAt: '2026-01-01T00:00:00Z' });
    expect(second!.lang).toBeUndefined();
    expect(second!.translatedText).toBeUndefined();
    expect(second!.translatedFromHash).toBeUndefined();
    expect(second!.translatedAt).toBeUndefined();
  });
});
