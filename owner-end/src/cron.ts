import { planRequirements } from '../../src/iteration/planning.ts';
import { planRequirementWith } from './iteration-planner.ts';
import { triageFeedback } from '../../src/iteration/triage.ts';
import { classifyFeedbackWith } from './feedback-triage.ts';
import { analyzeTurns } from '../../src/turn-analysis.ts';
import { analyzeTurnWith } from './turn-analyst.ts';
/**
 * 定时任务（Worker 的 scheduled 入口，按 cron 表达式分派）：
 * - 每分钟：为在岗员工补齐 agent 身份（ma_hono 的 kind=agent 用户，记入 agent_identity）；
 *   为选了语言但译文缺失或过期的待发消息补译（一次最多 TRANSLATIONS_PER_RUN 条，避免超时）；
 *   把员工用职能语言写的提交、退回、受阻说明译回老板常用语言（refreshReplyTranslations，同样每次最多 TRANSLATIONS_PER_RUN 条）。
 * - 每天一次：笔记整理（consolidateDue，到期才真正运行）；配置了 magpie 时用它做改写，改写失败回退为原文。
 * 任何一步失败只记录，不影响其它步骤。定时任务用自动化令牌（ac=automation）访问数据库。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { langMatches, ownerLangOf, replyHash, REPLY_ACTIONS } from '../../src/owner-lang.ts';
import { MAX_TRANSLATION } from './translate.ts';
import { consolidateDue } from '../../src/lane-notes-consolidate.ts';
import { CompanyError } from '../../src/core-errors.ts';
import { OutboundMessageStore, type OutboundMessage } from '../../src/outbound-messages.ts';
import { withSession, type Sessions } from './db.ts';
import type { Config } from './env.ts';
import { inServiceEmployees } from './employees.ts';
import { ensureEmployeeIdentity } from './idp-commands.ts';
import { translateChecked, translationFresh } from './messages.ts';
import { rewriteNotesWith } from './translate.ts';
import { keyOf, type Row } from './rows.ts';

/** 每分钟一次：身份同步与补译。 */
export const MINUTE_CRON = '* * * * *';
/** 每天一次：笔记整理。 */
export const DAILY_CRON = '30 19 * * *';
export const TRANSLATIONS_PER_RUN = 5;

export interface IdentitySync {
  linked: number;
  created: number;
  failed: string[];
  skipped?: 'not_configured';
}

export interface TranslationSync {
  translated: number;
  failed: number;
  skipped?: 'not_configured';
}

export interface CronOptions {
  fetch?: typeof fetch;
  now?: Date;
}

const reasonOf = (error: unknown): string => error instanceof CompanyError ? error.message : '服务暂时出错';

/** 为没有 agent 身份的在岗员工开户并记入 agent_identity。已登记的员工不再查询 ma_hono。 */
export async function syncAgentIdentities(cfg: Config, db: Surreal, options: CronOptions = {}): Promise<IdentitySync> {
  if (!cfg.admin || !cfg.idp.tenantId || !cfg.idp.agentEmailDomain) return { linked: 0, created: 0, failed: [], skipped: 'not_configured' };
  const known = new Set<string>();
  const [rows] = await db.query<[Row[]]>('SELECT employee FROM agent_identity;');
  for (const row of rows ?? []) known.add(String(row.employee));
  const result: IdentitySync = { linked: 0, created: 0, failed: [] };
  for (const member of await inServiceEmployees(db)) {
    if (known.has(member.employee)) continue;
    try {
      const identity = await ensureEmployeeIdentity(cfg, db, member.employee, member.name, options.fetch);
      result.linked += 1;
      if (identity.created) result.created += 1;
    } catch (error) {
      console.error('owner-end identity sync failed', member.employee, reasonOf(error));
      result.failed.push(member.employee);
    }
  }
  return result;
}

/** 上次补译失败的时间（毫秒）；从没失败过为 0，排在最前。 */
const failedAtOf = (message: OutboundMessage): number => Date.parse(message.translateFailedAt ?? '') || 0;

/**
 * 选了语言（lang 有值）而译文缺失或过期的未发消息，逐条补译，一次最多 TRANSLATIONS_PER_RUN 条。
 * 译不出的记下失败时间：下一轮先译没失败过的，失败过的按失败时间从早到晚轮流，所以一直译不出的消息只占自己的一份名额。
 */
export async function refreshTranslations(cfg: Config, db: Surreal, options: CronOptions = {}): Promise<TranslationSync> {
  if (!cfg.magpie) return { translated: 0, failed: 0, skipped: 'not_configured' };
  const store = new OutboundMessageStore(db);
  const pending: Array<OutboundMessage & { lang: string }> = [];
  for (const message of await store.list(undefined, false)) {
    if (message.lang && !translationFresh(message)) pending.push({ ...message, lang: message.lang });
  }
  pending.sort((a, b) => failedAtOf(a) - failedAtOf(b));
  const result: TranslationSync = { translated: 0, failed: 0 };
  for (const message of pending.slice(0, TRANSLATIONS_PER_RUN)) {
    try {
      const translated = await translateChecked(cfg, message.body, message.lang, options.fetch);
      await store.setTranslation(message.id, message.lang, translated, message.body, 'cron:translate');
      result.translated += 1;
    } catch (error) {
      console.error('owner-end translation refresh failed', message.id, reasonOf(error));
      await store.markTranslationFailed(message.id);
      result.failed += 1;
    }
  }
  return result;
}

/** 译回只看最近这段时间的员工回报；更早的说明不再补译。 */
export const REPLY_WINDOW_DAYS = 14;
/** 译回失败后隔这么久再试（毫秒），一直译不出的说明不会每分钟都调一次翻译。 */
export const REPLY_RETRY_MS = 30 * 60_000;

/**
 * 员工回报译回老板语言（067 reply_translation）：员工所属职能设了语言、且与老板常用语言不同时，
 * 把它最近的提交、退回、受阻说明译成老板语言。已译且原文未变的跳过；失败记下时间，先译没失败过的，失败过的隔 REPLY_RETRY_MS 再试。
 */
export async function refreshReplyTranslations(cfg: Config, db: Surreal, options: CronOptions = {}): Promise<TranslationSync> {
  if (!cfg.magpie) return { translated: 0, failed: 0, skipped: 'not_configured' };
  const ownerLang = await ownerLangOf(db);
  const [policies] = await db.query<[Row[]]>('SELECT agent, lang FROM agent_policy WHERE lang != NONE;');
  const foreign = new Set((policies ?? []).filter((row) => typeof row.lang === 'string' && !langMatches(row.lang, ownerLang)).map((row) => String(row.agent)));
  const result: TranslationSync = { translated: 0, failed: 0 };
  if (!foreign.size) return result;
  const [audits] = await db.query<[Row[]]>(
    `SELECT id, actor, evidence, at FROM audit WHERE at > time::now() - ${REPLY_WINDOW_DAYS}d AND action IN $actions
      AND type::is_string(evidence) AND evidence != '' ORDER BY at DESC LIMIT 200;`, { actions: [...REPLY_ACTIONS] });
  if (!audits?.length) return result;
  const actors = [...new Set(audits.map((row) => keyOf(row.actor)))];
  const [employees] = await db.query<[Row[]]>('SELECT id, role FROM employee WHERE id IN $ids;',
    { ids: actors.map((actor) => new RecordId('employee', actor)) });
  const roleOf = new Map((employees ?? []).map((row) => [keyOf(row.id), String(row.role ?? '')]));
  const candidates = audits.filter((row) => foreign.has(roleOf.get(keyOf(row.actor)) ?? '') && String(row.evidence).length <= MAX_TRANSLATION);
  if (!candidates.length) return result;
  const [done] = await db.query<[Row[]]>('SELECT source, source_hash, text, failed_at FROM reply_translation WHERE source IN $ids AND lang = $lang;',
    { ids: candidates.map((row) => row.id), lang: ownerLang });
  const existing = new Map((done ?? []).map((row) => [keyOf(row.source), row]));
  const pending: Array<{ row: Row; hash: string; failedAt: number }> = [];
  for (const row of candidates) {
    const hash = await replyHash(String(row.evidence));
    const prior = existing.get(keyOf(row.id));
    if (prior && prior.source_hash === hash && typeof prior.text === 'string' && prior.text) continue;
    pending.push({ row, hash, failedAt: prior?.source_hash === hash ? Date.parse(String(prior.failed_at ?? '')) || 0 : 0 });
  }
  pending.sort((a, b) => a.failedAt - b.failedAt);
  const retryBefore = (options.now ?? new Date()).getTime() - REPLY_RETRY_MS;
  for (const { row, hash } of pending.filter((item) => item.failedAt < retryBefore).slice(0, TRANSLATIONS_PER_RUN)) {
    const rid = new RecordId('reply_translation', `${keyOf(row.id)}:${ownerLang}`);
    try {
      const text = await translateChecked(cfg, String(row.evidence), ownerLang, options.fetch);
      await db.query('UPSERT $rid SET source = $source, lang = $lang, source_hash = $hash, text = $text, failed_at = NONE, at = time::now();',
        { rid, source: row.id, lang: ownerLang, hash, text });
      result.translated += 1;
    } catch (error) {
      console.error('owner-end reply translation failed', keyOf(row.id), reasonOf(error));
      await db.query('UPSERT $rid SET source = $source, lang = $lang, source_hash = $hash, failed_at = time::now(), at = time::now();',
        { rid, source: row.id, lang: ownerLang, hash }).catch(() => undefined);
      result.failed += 1;
    }
  }
  return result;
}

/** 按 cron 表达式执行一轮定时任务，返回可记录的摘要。 */
export async function runScheduled(cfg: Config, sessions: Sessions, cron: string, options: CronOptions = {}): Promise<unknown> {
  const now = options.now ?? new Date();
  return withSession(await sessions.automation(), async (db) => {
    if (cron === DAILY_CRON) {
      const rewrite = cfg.magpie ? rewriteNotesWith(cfg.magpie, options.fetch) : undefined;
      const run = await consolidateDue(db, { now, actor: 'cron:consolidate', rewrite });
      return { consolidated: run ? (run.id ?? 'no-change') : 'not-due' };
    }
    const identities = await syncAgentIdentities(cfg, db, options);
    const translations = await refreshTranslations(cfg, db, options);
    const replies = await refreshReplyTranslations(cfg, db, options).catch((error) => {
      console.error('owner-end reply translations failed', reasonOf(error));
      return { failed: true };
    });
    const feedback = cfg.magpie
      ? await triageFeedback(db, classifyFeedbackWith(cfg.magpie, options.fetch), now.getTime()).catch(() => ({ failed: true }))
      : { skipped: 'not_configured' };
    const planning = cfg.magpie ? await planRequirements(db, planRequirementWith(cfg.magpie, options.fetch), now.getTime()).catch(() => ({ failed: true })) : { skipped: 'not_configured' };
    // 完工分析排在最后：补译和规划先用这一分钟，分析每轮最多两条，只记录不改消息。
    const analyses = cfg.magpie ? await analyzeTurns(db, analyzeTurnWith(cfg.magpie, options.fetch), now.getTime()).catch(() => ({ failed: true })) : { skipped: 'not_configured' };
    return { identities, translations, replies, feedback, planning, analyses };
  });
}
