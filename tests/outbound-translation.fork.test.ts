import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { CompanyError } from '../src/core-errors.ts';
import { OutboundMessageStore } from '../src/outbound-messages.ts';
import { sourceHash } from '../src/outbound-delivery.ts';

// 译文投递在真实公司 fork 上的验证：058 字段与约束、UPDATE 的原文守卫、员工语言与投递。隔离的内存库，自己起停。
// 与 tests/outbound-translation.test.ts 的假库用例互补：这里的 conflict 与 null 来自真实的 SurrealQL。
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'isolated-outbound-translation-test-only';
setDefaultTimeout(120_000);

async function startFork(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `outbound-translation-${name}-`));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD,
    '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: ROOT_PASSWORD,
    namespace: `isolated_translation_${name.replaceAll('-', '_')}`, database: 'control_plane' });
  const close = async () => { await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); };
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true);
    await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db);
    const gm = await new LocalEnrollmentAdmin(db).enroll('fixture-owner-translation', 'owner', ['execute', 'review', 'manage']);
    return { db, surreal: db.db, core, gm, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The statement must be refused: returns the error it failed with, and fails when the statement succeeds. */
async function rejected(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeDefined();
  return String(error);
}

/** The unsent messages of one task, newest last, as the store lists them. */
const unsentOf = async (store: OutboundMessageStore, taskId: string) => (await store.list(taskId, false));

run('058 字段与约束在真实库上生效：ops_job 与 agent_identity 的断言、ops_audit 摘要上限', async () => {
  const w = await startFork('schema');
  try {
    const job = { command: 'board.snapshot', input: '{}', actor_kind: 'owner', actor: 'owner:web' };
    await w.surreal.query('CREATE ops_job CONTENT $row;', { row: { ...job, state: 'queued' } });
    await rejected(w.surreal.query('CREATE ops_job CONTENT $row;', { row: { ...job, state: 'bogus' } }));
    await rejected(w.surreal.query('CREATE ops_job CONTENT $row;', { row: { ...job, state: 'queued', actor_kind: 'robot' } }));

    await w.surreal.query("CREATE agent_identity CONTENT { employee: 'emp-a', idp_user: 'idp-a' };");
    await rejected(w.surreal.query("CREATE agent_identity CONTENT { employee: 'emp-a', idp_user: 'idp-b' };"));
    await rejected(w.surreal.query("CREATE agent_identity CONTENT { employee: 'emp-b', idp_user: 'idp-a' };"));

    const audit = { actor_kind: 'owner', actor: 'owner:web', command: 'brief', args_digest: 'sha256:0', outcome: 'ok' };
    await w.surreal.query('CREATE ops_audit CONTENT $row;', { row: { ...audit, summary: 'a'.repeat(500) } });
    await rejected(w.surreal.query('CREATE ops_audit CONTENT $row;', { row: { ...audit, summary: 'a'.repeat(501) } }));
  } finally {
    await w.close();
  }
});

run('译文投递：未译不发（不改 hold 与状态）、译后发译文、原文改动即过期、冲突与不存在、员工无语言照常', async () => {
  const w = await startFork('delivery');
  try {
    const task = await w.core.createTask(w.gm, { title: '译文投递任务', context: '合成数据：仅用于译文回归测试',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'translation-create-1' });
    const store = new OutboundMessageStore(w.surreal);
    await store.createTaskDrafts(task.id, 'engineering', 'qa', false);
    const execute = (await unsentOf(store, task.id)).find(message => message.step === 'execute')!;
    const review = (await unsentOf(store, task.id)).find(message => message.step === 'review')!;
    expect(execute).toBeDefined();
    expect(review).toBeDefined();

    // 员工 emp-ja 的语言是日语；没有译文时不发，hold 与状态都不变。
    await w.surreal.query("CREATE agent_policy CONTENT { agent: 'emp-ja', lang: 'ja', updated_by: 'owner:test' };");
    expect(await store.prepareSend(task.id, 'execute', 'emp-ja')).toBeNull();
    const untouched = (await unsentOf(store, task.id)).find(message => message.id === execute.id)!;
    expect(untouched).toMatchObject({ state: 'draft', hold: false, body: execute.body });

    // 保存译文：哈希取自被译的原文，不算老板编辑。
    const saved = await store.setTranslation(execute.id, 'ja', 'JA 执行说明', execute.body, 'owner:test');
    expect(saved).toMatchObject({ lang: 'ja', translatedText: 'JA 执行说明', translatedFromHash: sourceHash(execute.body) });
    expect(saved.editedBy).toBeUndefined();

    // 译文就绪：日语员工拿到译文；原文照旧保存在行里。
    const prepared = await store.prepareSend(task.id, 'execute', 'emp-ja');
    expect(prepared!.body).toBe('JA 执行说明');
    expect(prepared!.message.body).toBe(execute.body);

    // 语言不同的员工：日语译文不发给英语员工；无语言员工照发原文。
    await w.surreal.query("CREATE agent_policy CONTENT { agent: 'emp-en', lang: 'en', updated_by: 'owner:test' };");
    expect(await store.prepareSend(task.id, 'execute', 'emp-en')).toBeNull();
    expect((await store.prepareSend(task.id, 'review', 'emp-none'))!.body).toBe(review.body);

    // 老板改了原文：译文按旧哈希过期，投递回到等待补译；译文守卫用旧原文即冲突。
    await store.edit(execute.id, '改过的执行说明', 'owner:test');
    expect(await store.prepareSend(task.id, 'execute', 'emp-ja')).toBeNull();
    await expect(store.setTranslation(execute.id, 'ja', '旧译文', execute.body, 'owner:test')).rejects.toThrow('body changed, translate again');
    const again = await store.setTranslation(execute.id, 'ja', 'JA 改后的执行说明', '改过的执行说明', 'owner:test');
    expect(again.translatedFromHash).toBe(sourceHash('改过的执行说明'));
    expect((await store.prepareSend(task.id, 'execute', 'emp-ja'))!.body).toBe('JA 改后的执行说明');

    // 空译文与不存在的消息。
    await expect(store.setTranslation(execute.id, 'ja', '  ', '改过的执行说明', 'owner:test')).rejects.toThrow('translation must not be empty');
    const missing = await store.setTranslation('no-such-message', 'ja', 'x', 'y', 'owner:test').catch(error => error as CompanyError);
    expect(missing).toBeInstanceOf(CompanyError);
    expect((missing as CompanyError).code).toBe('not_found');

    // 已发送的消息不能再译：发送后 setTranslation 返回 conflict，且提示已发送。
    await store.markSent(execute.id, 'emp-ja', 'JA 改后的执行说明');
    const sent = await store.setTranslation(execute.id, 'ja', 'JA 再译', '改过的执行说明', 'owner:test').catch(error => error as CompanyError);
    expect((sent as CompanyError).code).toBe('conflict');
    expect((sent as CompanyError).message).toBe('conflict: message already sent');
    expect((await store.get(execute.id))!.state).toBe('sent');
  } finally {
    await w.close();
  }
});

run('等待译文与老板放行分开：真实库上 awaitingTranslation 只读，hold 不算等待译文，译文就绪后不再等待', async () => {
  const w = await startFork('awaiting');
  try {
    const task = await w.core.createTask(w.gm, { title: '等待译文判定任务', context: '合成数据：仅用于等待译文判定回归测试',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'translation-create-awaiting' });
    const store = new OutboundMessageStore(w.surreal);
    await store.createTaskDrafts(task.id, 'engineering', 'qa', false);
    const execute = (await unsentOf(store, task.id)).find(message => message.step === 'execute')!;
    await w.surreal.query("CREATE agent_policy CONTENT { agent: 'emp-ja', lang: 'ja', updated_by: 'owner:test' };");

    // 没有译文：等待译文，不是老板放行；判定本身不写库。
    const before = JSON.stringify(await store.get(execute.id));
    expect(await store.awaitingTranslation(task.id, 'execute', 'emp-ja')).toBe(true);
    expect(await store.isHeld(task.id, 'execute')).toBe(false);
    expect(JSON.stringify(await store.get(execute.id))).toBe(before);

    // 老板保留：不算等待译文，hold 仍由 isHeld 报告。
    await store.setHold(execute.id, true, 'owner:test');
    expect(await store.awaitingTranslation(task.id, 'execute', 'emp-ja')).toBe(false);
    expect(await store.isHeld(task.id, 'execute')).toBe(true);
    await store.setHold(execute.id, false, 'owner:test');

    // 译文就绪：不再等待。
    await store.setTranslation(execute.id, 'ja', 'JA 执行说明', execute.body, 'owner:test');
    expect(await store.awaitingTranslation(task.id, 'execute', 'emp-ja')).toBe(false);
    expect(await store.awaitingTranslation(task.id, 'execute', 'emp-none')).toBe(false);
  } finally {
    await w.close();
  }
});

run('译文按哈希判定：同一原文的两次译文，只有最后一次的哈希有效', async () => {
  const w = await startFork('hash');
  try {
    const task = await w.core.createTask(w.gm, { title: '哈希判定任务', context: '合成数据：仅用于译文哈希回归测试',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'translation-create-hash' });
    const store = new OutboundMessageStore(w.surreal);
    await store.createTaskDrafts(task.id, 'engineering', 'qa', false);
    const execute = (await unsentOf(store, task.id)).find(message => message.step === 'execute')!;
    await w.surreal.query("CREATE agent_policy CONTENT { agent: 'emp-ja', lang: 'ja', updated_by: 'owner:test' };");
    await store.setTranslation(execute.id, 'ja', '第一版', execute.body, 'owner:test');
    await store.setTranslation(execute.id, 'ja', '第二版', execute.body, 'owner:test');
    const row = (await store.get(execute.id))!;
    expect(row.translatedText).toBe('第二版');
    expect(row.translatedFromHash).toBe(sourceHash(execute.body));
    expect((await store.prepareSend(task.id, 'execute', 'emp-ja'))!.body).toBe('第二版');
  } finally {
    await w.close();
  }
});

run('补译失败的时间：真实库上记下 translate_failed_at 并读回为 ISO 字符串，已发送的消息不再记', async () => {
  const w = await startFork('translate-failed');
  try {
    const task = await w.core.createTask(w.gm, { title: '补译失败时间任务', context: '合成数据：仅用于补译失败时间回归测试',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'translation-create-failed' });
    const store = new OutboundMessageStore(w.surreal);
    await store.createTaskDrafts(task.id, 'engineering', 'qa', false);
    const execute = (await unsentOf(store, task.id)).find(message => message.step === 'execute')!;
    const review = (await unsentOf(store, task.id)).find(message => message.step === 'review')!;
    expect(execute.translateFailedAt).toBeUndefined();

    await store.markTranslationFailed(execute.id);
    const failedAt = (await store.get(execute.id))!.translateFailedAt;
    expect(failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Date.parse(failedAt!)).toBeGreaterThan(0);

    // 已发送的消息不再记录补译失败。
    await store.markSent(review.id, 'emp-ja', review.body);
    await store.markTranslationFailed(review.id);
    expect((await store.get(review.id))!.translateFailedAt).toBeUndefined();
  } finally {
    await w.close();
  }
});

run('派工前对齐语言：真实库上消息跟着收件员工走，改派清掉旧译文，老板选过的语言不被覆盖，新员工等待老板选的译文', async () => {
  const w = await startFork('align');
  try {
    const task = await w.core.createTask(w.gm, { title: '语言对齐任务', context: '合成数据：仅用于派工前语言对齐回归测试',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: 'translation-create-align' });
    const store = new OutboundMessageStore(w.surreal);
    await store.createTaskDrafts(task.id, 'engineering', 'qa', false);
    const execute = (await unsentOf(store, task.id)).find(message => message.step === 'execute')!;
    const current = async () => (await store.get(execute.id))!;
    await w.surreal.query("CREATE agent_policy CONTENT { agent: 'emp-ja', lang: 'ja', updated_by: 'owner:test' };");
    await w.surreal.query("CREATE agent_policy CONTENT { agent: 'emp-en', lang: 'en', updated_by: 'owner:test' };");

    // 派工前对齐：消息跟着收件员工的语言走，译文就绪前等待。
    await store.alignLanguage(task.id, 'execute', 'emp-ja');
    expect(await current()).toMatchObject({ lang: 'ja' });
    expect(await store.awaitingTranslation(task.id, 'execute', 'emp-ja')).toBe(true);
    await store.setTranslation(execute.id, 'ja', 'JA 执行说明', execute.body, 'owner:test');

    // 已经对齐则只读：译文保留。
    await store.alignLanguage(task.id, 'execute', 'emp-ja');
    expect((await current()).translatedText).toBe('JA 执行说明');

    // 改派给英语员工：语言换成英文，日语译文清掉。
    await store.alignLanguage(task.id, 'execute', 'emp-en');
    expect(await current()).toMatchObject({ lang: 'en' });
    expect((await current()).translatedText).toBeUndefined();
    expect((await current()).translatedFromHash).toBeUndefined();

    // 新员工没有语言：语言清掉，投递回原文，不等待。
    await store.alignLanguage(task.id, 'execute', 'emp-none');
    expect((await current()).lang).toBeUndefined();
    expect(await store.awaitingTranslation(task.id, 'execute', 'emp-none')).toBe(false);

    // 老板选过的语言优先：对齐不覆盖；没有译文时，新员工（无默认语言）也等待。
    await store.setLanguage(execute.id, 'ja');
    await store.alignLanguage(task.id, 'execute', 'emp-en');
    expect(await current()).toMatchObject({ lang: 'ja', langChosen: true });
    expect(await store.awaitingTranslation(task.id, 'execute', undefined)).toBe(true);
    expect(await store.prepareSend(task.id, 'execute', 'emp-none')).toBeNull();
  } finally {
    await w.close();
  }
});
