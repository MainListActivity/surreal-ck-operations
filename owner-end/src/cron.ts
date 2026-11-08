/**
 * 定时任务（Worker 的 scheduled 入口，按 cron 表达式分派）：
 * - 每分钟：为在岗员工补齐 agent 身份（ma_hono 的 kind=agent 用户，记入 agent_identity）；
 *   为选了语言但译文缺失或过期的待发消息补译（一次最多 TRANSLATIONS_PER_RUN 条，避免超时）。
 * - 每天一次：笔记整理（consolidateDue，到期才真正运行）；配置了 magpie 时用它做改写，改写失败回退为原文。
 * 任何一步失败只记录，不影响其它步骤。定时任务用自动化令牌（ac=automation）访问数据库。
 */
import type { Surreal } from 'surrealdb';
import { consolidateDue } from '../../src/lane-notes-consolidate.ts';
import { CompanyError } from '../../src/core-errors.ts';
import { OutboundMessageStore, type OutboundMessage } from '../../src/outbound-messages.ts';
import { withSession, type Sessions } from './db.ts';
import type { Config } from './env.ts';
import { inServiceEmployees } from './employees.ts';
import { ensureEmployeeIdentity } from './idp-commands.ts';
import { translateChecked, translationFresh } from './messages.ts';
import { rewriteNotesWith } from './translate.ts';
import type { Row } from './rows.ts';

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
    if (message.lang && !(await translationFresh(message))) pending.push({ ...message, lang: message.lang });
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
    return { identities, translations };
  });
}
