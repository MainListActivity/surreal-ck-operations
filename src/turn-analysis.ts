/**
 * 完工分析：员工每次交出结果后，读任务卡与这次结果，写下完成情况、还缺什么、建议下一条消息的开头一段和把握。
 *
 * 本版只记录、只展示：不改派工消息，不决定任务流转（流转仍只认首行结论，见 runner/lifecycle.ts 的 workResult）。
 * 模型没有工具；员工的输出是待分析的数据，不能改变这里的规则。把握不只听模型自评：证据被截断时一律记为把握不足。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { requirementOf } from './dispatcher/brief.ts';
import { sha256Hex } from './sha256.ts';

/** 需要分析的结果：提交、复核退回、老板驳回、受阻。通过与老板答复不分析：前者任务已结束，后者是老板自己的话。 */
export const ANALYSIS_ACTIONS = ['submit', 'return', 'owner_reject', 'block'] as const;
/** 交给模型的结果正文上限；更长的截断并记为把握不足。 */
export const ANALYSIS_TEXT_LIMIT = 12_000;
export const ANALYSES_PER_RUN = 2;
const WINDOW_DAYS = 3;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 10 * 60_000;

export interface TurnAnalysisInput {
  /** 这次结果是什么：提交、退回、老板驳回还是受阻。 */
  action: string;
  task: { title: string; requirement: string; resources?: string; acceptance?: string };
  /** 这次结果的原文（可能已截断）。 */
  result: string;
  /** 退回与驳回时：被退回的那次提交，供对照。 */
  submitted?: string;
}

export interface TurnAnalysis {
  /** completed：按验收做完了；partial：做了一部分；blocked：缺前置条件做不下去；rejected：复核或老板不认可。 */
  status: 'completed' | 'partial' | 'blocked' | 'rejected';
  summary: string;
  /** 员工（或返工的执行岗）接下来缺什么：账号、资料、决定、明确的验收口径。没有就是空。 */
  needs: string[];
  /** 建议下一条消息开头的一段：上轮情况、这轮先做什么。 */
  next: string;
  confidence: 'high' | 'low';
}

export type AnalyzeTurn = (input: TurnAnalysisInput) => Promise<unknown>;

/** 校验模型输出：字段齐全、取值在枚举内、长度有界。不合格直接抛错，由调用方记失败。 */
export function turnAnalysis(value: unknown): TurnAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompanyError('invalid', '完工分析结果格式错误');
  const v = value as Record<string, unknown>;
  if (!['completed', 'partial', 'blocked', 'rejected'].includes(String(v.status))) throw new CompanyError('invalid', '完工分析的完成情况无效');
  if (!['high', 'low'].includes(String(v.confidence))) throw new CompanyError('invalid', '完工分析的把握无效');
  const text = (field: string, max: number): string => {
    const raw = v[field];
    if (typeof raw !== 'string' || !raw.trim() || raw.length > max) throw new CompanyError('invalid', `完工分析的 ${field} 须为不超过 ${max} 字符的非空文本`);
    return raw.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  };
  const needs = v.needs ?? [];
  if (!Array.isArray(needs) || needs.length > 5 || needs.some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) {
    throw new CompanyError('invalid', '完工分析的 needs 须为最多 5 条、每条不超过 200 字符的文本');
  }
  return { status: v.status as TurnAnalysis['status'], summary: text('summary', 400), needs: (needs as string[]).map(item => item.trim()),
    next: text('next', 800), confidence: v.confidence as TurnAnalysis['confidence'] };
}

const clip = (text: string): { text: string; cut: boolean } =>
  text.length > ANALYSIS_TEXT_LIMIT ? { text: text.slice(0, ANALYSIS_TEXT_LIMIT), cut: true } : { text, cut: false };

interface AuditRow { id: RecordId; task: RecordId; action: string; evidence: string; at: unknown }

/**
 * 分析最近还没分析过的结果，每轮最多 ANALYSES_PER_RUN 条（与补译共用老板端的一分钟）。先分析没失败过的；失败过的隔 RETRY_MS 再试，
 * 三次后放弃。写库用审计行做键，同一条结果只有一条分析。
 */
export async function analyzeTurns(db: Surreal, analyze: AnalyzeTurn, now = Date.now()): Promise<{ analyzed: number; failed: number }> {
  const result = { analyzed: 0, failed: 0 };
  const [audits] = await db.query<[AuditRow[]]>(
    `SELECT id, task, action, evidence, at FROM audit WHERE at > time::now() - ${WINDOW_DAYS}d AND action IN $actions
      AND type::is_string(evidence) AND evidence != '' ORDER BY at DESC LIMIT 60;`, { actions: [...ANALYSIS_ACTIONS] });
  // 【通道回滚】是执行端自己的记录，不是员工的工作结果。
  const candidates = (audits ?? []).filter(row => !row.evidence.startsWith('【通道回滚】'));
  if (!candidates.length) return result;
  const [done] = await db.query<[Array<{ source: RecordId; summary?: string; attempts?: number; failed_at?: unknown }>]>(
    'SELECT source, summary, attempts, failed_at FROM turn_analysis WHERE source IN $ids;', { ids: candidates.map(row => row.id) });
  const prior = new Map((done ?? []).map(row => [String(row.source.id), row]));
  const failedAt = (row: AuditRow) => { const at = prior.get(String(row.id.id))?.failed_at; return at ? new Date(at as string).getTime() || 0 : 0; };
  const pending = candidates.filter(row => {
    const seen = prior.get(String(row.id.id));
    return !seen || (!seen.summary && (seen.attempts ?? 0) < MAX_ATTEMPTS && failedAt(row) < now - RETRY_MS);
  }).sort((a, b) => failedAt(a) - failedAt(b)).slice(0, ANALYSES_PER_RUN);
  for (const row of pending) {
    const rid = new RecordId('turn_analysis', String(row.id.id));
    const hash = sha256Hex(row.evidence);
    try {
      const [tasks] = await db.query<[Array<{ title?: string; context?: string; requirement?: string; resources?: string; acceptance_text?: string; state?: string }>]>(
        'SELECT title, context, requirement, resources, acceptance_text, state FROM $task;', { task: row.task });
      const task = tasks?.[0];
      if (!task || task.state === 'void') {
        // 任务已作废：不花模型额度，记一条放弃，之后不再选中。
        await db.query('UPSERT $rid SET source = $source, task = $task, action = $action, source_hash = $hash, attempts = $max, failed_at = time::now(), at = time::now();',
          { rid, source: row.id, task: row.task, action: row.action, hash, max: MAX_ATTEMPTS });
        continue;
      }
      const shown = clip(row.evidence);
      let submitted: { text: string; cut: boolean } | undefined;
      if (row.action === 'return' || row.action === 'owner_reject') {
        const [subs] = await db.query<[Array<{ evidence?: string; at: unknown }>]>(
          "SELECT evidence, at FROM audit WHERE task = $task AND action IN ['submit', 'owner_submit'] AND at < $at ORDER BY at DESC LIMIT 1;", { task: row.task, at: row.at });
        if (typeof subs?.[0]?.evidence === 'string' && subs[0].evidence) submitted = clip(subs[0].evidence);
      }
      const parsed = turnAnalysis(await analyze({
        action: row.action,
        task: { title: String(task.title ?? ''), requirement: clip(task.requirement?.trim() || requirementOf(task.context ?? '')).text,
          ...(task.resources ? { resources: task.resources } : {}), ...(task.acceptance_text ? { acceptance: clip(task.acceptance_text).text } : {}) },
        result: shown.text, ...(submitted ? { submitted: submitted.text } : {}),
      }));
      // 把握不只听模型自评：它没看全的结果，一律按把握不足。
      const lowReason = shown.cut || submitted?.cut ? '结果原文过长，模型只看了前一部分' : undefined;
      await db.query(`UPSERT $rid SET source = $source, task = $task, action = $action, source_hash = $hash, status = $status, summary = $summary,
        needs = $needs, next = $next, confidence = $confidence, low_reason = $low_reason, failed_at = NONE, at = time::now();`,
        { rid, source: row.id, task: row.task, action: row.action, hash, status: parsed.status, summary: parsed.summary, needs: parsed.needs,
          next: parsed.next, confidence: lowReason ? 'low' : parsed.confidence, low_reason: lowReason });
      result.analyzed++;
    } catch {
      // 只记失败与次数；模型正文与员工输出不进日志。
      await db.query('UPSERT $rid SET source = $source, task = $task, action = $action, source_hash = $hash, attempts = (attempts ?? 0) + 1, failed_at = time::now(), at = time::now();',
        { rid, source: row.id, task: row.task, action: row.action, hash }).catch(() => undefined);
      result.failed++;
    }
  }
  return result;
}

export interface TurnAnalysisView extends TurnAnalysis { lowReason?: string; at: string }

/** 一批审计行的分析（审计编号 → 分析）；只返回已经有结论的。 */
export async function turnAnalysesOf(db: Surreal, audits: ReadonlyArray<{ id?: unknown }>): Promise<Record<string, TurnAnalysisView>> {
  const ids = audits.map(row => row.id).filter((id): id is RecordId => id instanceof RecordId);
  if (!ids.length) return {};
  const [rows] = await db.query<[Array<Record<string, unknown>>]>(
    'SELECT source, status, summary, needs, next, confidence, low_reason, at FROM turn_analysis WHERE source IN $ids AND summary != NONE;', { ids });
  return Object.fromEntries((rows ?? []).map(row => [String((row.source as RecordId).id), {
    status: row.status as TurnAnalysis['status'], summary: String(row.summary), needs: Array.isArray(row.needs) ? row.needs.map(String) : [],
    next: String(row.next ?? ''), confidence: row.confidence === 'high' ? 'high' as const : 'low' as const,
    ...(typeof row.low_reason === 'string' ? { lowReason: row.low_reason } : {}),
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at ?? ''),
  }]));
}
