import { expect, test } from 'bun:test';
import { deliveryBody, sourceHash } from '../src/outbound-delivery.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';

const ORIGINAL = '请先读 notes.md，再提交结果。';

test('sourceHash is a stable 64-character lowercase hex sha256 of the utf8 body', () => {
  expect(sourceHash(ORIGINAL)).toMatch(/^[0-9a-f]{64}$/);
  expect(sourceHash(ORIGINAL)).toBe(sourceHash(ORIGINAL));
  expect(sourceHash(ORIGINAL)).not.toBe(sourceHash(`${ORIGINAL} `));
  expect(sourceHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('deliveryBody sends the translation when lang is set and the hash matches the current source', () => {
  expect(deliveryBody({
    body: ORIGINAL, lang: 'en', translatedText: 'Read notes.md first, then submit.', translatedFromHash: sourceHash(ORIGINAL),
  })).toBe('Read notes.md first, then submit.');
});

test('deliveryBody sends nothing when lang is set but the translation is missing', () => {
  expect(deliveryBody({ body: ORIGINAL, lang: 'en', translatedFromHash: sourceHash(ORIGINAL) })).toBeNull();
  expect(deliveryBody({ body: ORIGINAL, lang: 'en', translatedText: null, translatedFromHash: sourceHash(ORIGINAL) })).toBeNull();
  expect(deliveryBody({ body: ORIGINAL, lang: 'en', translatedText: '  ', translatedFromHash: sourceHash(ORIGINAL) })).toBeNull();
});

test('deliveryBody sends nothing when the translation is stale (hash does not match the source)', () => {
  expect(deliveryBody({
    body: '原文已被老板改过', lang: 'en', translatedText: 'Read notes.md first, then submit.', translatedFromHash: sourceHash(ORIGINAL),
  })).toBeNull();
  expect(deliveryBody({ body: ORIGINAL, lang: 'en', translatedText: 'x', translatedFromHash: null })).toBeNull();
});

test('deliveryBody sends the source text when there is no lang (NONE or empty)', () => {
  expect(deliveryBody({ body: ORIGINAL })).toBe(ORIGINAL);
  expect(deliveryBody({ body: ORIGINAL, lang: null })).toBe(ORIGINAL);
  expect(deliveryBody({ body: ORIGINAL, lang: '' })).toBe(ORIGINAL);
  expect(deliveryBody({ body: ORIGINAL, lang: '', translatedText: 'ignored', translatedFromHash: 'stale' })).toBe(ORIGINAL);
});

/** 内存假库：沿用 role-message-flow.test.ts 的做法，只模拟 prepareSend 用到的几条 SQL。 */
function fakeStore(draft: Record<string, unknown> | undefined, created: Array<Record<string, unknown>> = []) {
  return new OutboundMessageStore({
    query: async (sql: string, vars: Record<string, any>) => {
      if (sql.includes('CREATE outbound_message')) {
        // 模拟库里带有 lang 字段的新建草稿（例如 schema 默认值）。
        const row = { id: { id: 'fresh' }, task: { id: 't1' }, step: vars.step, role: vars.role, body: vars.body,
          state: 'draft', hold: false, created_at: 'now', ...(created[0] ?? {}) };
        return [[row]];
      }
      if (sql.includes('AND step = $step AND state')) return [draft ? [draft] : []];
      if (sql.includes('SELECT executor_role')) return [[{ executor_role: 'engineering', reviewer_role: 'qa', kind: 'task', work_intent: { kind: 'code' } }]];
      return [[]];
    },
  } as never);
}

const base = { id: { id: 'm1' }, task: { id: 't1' }, step: 'execute', role: 'engineering', state: 'draft', hold: false, created_at: 'now' };

test('prepareSend delivers the translation when the draft carries a matching translation', async () => {
  const store = fakeStore({ ...base, body: ORIGINAL, lang: 'en', translated_text: 'Translated.', translated_from_hash: sourceHash(ORIGINAL), translated_at: 'now' });
  const prepared = await store.prepareSend('t1', 'execute', 'e1');
  expect(prepared!.body).toBe('Translated.');
  expect(prepared!.message.sentTo).toBe('e1');
  expect(prepared!.message.translatedText).toBe('Translated.');
});

test('prepareSend returns null when the translation is missing for a translated draft', async () => {
  const store = fakeStore({ ...base, body: ORIGINAL, lang: 'en', translated_from_hash: sourceHash(ORIGINAL) });
  expect(await store.prepareSend('t1', 'execute', 'e1')).toBeNull();
});

test('prepareSend returns null when the translation is stale', async () => {
  const store = fakeStore({ ...base, body: '老板改过的原文', lang: 'en', translated_text: 'Old.', translated_from_hash: sourceHash(ORIGINAL) });
  expect(await store.prepareSend('t1', 'execute', 'e1')).toBeNull();
});

test('prepareSend delivers the source body when the draft has no lang', async () => {
  const store = fakeStore({ ...base, body: ORIGINAL });
  const prepared = await store.prepareSend('t1', 'execute', 'e1');
  expect(prepared!.body).toBe(ORIGINAL);
});

test('prepareSend keeps the held refusal ahead of the translation rule', async () => {
  const store = fakeStore({ ...base, body: ORIGINAL, hold: true, state: 'held' });
  expect(await store.prepareSend('t1', 'execute', 'e1')).toBeNull();
});

test('prepareSend without a draft seeds one; a seeded message with lang and no translation is not delivered', async () => {
  const withLang = fakeStore(undefined, [{ lang: 'en' }]);
  expect(await withLang.prepareSend('t1', 'execute', 'e1')).toBeNull();
  const plain = fakeStore(undefined, [{}]);
  const prepared = await plain.prepareSend('t1', 'execute', 'e1');
  expect(prepared!.body).toContain('合入 main');
  expect(prepared!.message.sentTo).toBe('e1');
});
