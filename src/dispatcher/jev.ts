/**
 * Thin client for TypeSafe AI's Jev "System One" decision model.
 * One POST carries a state block plus typed questions (choice/score/noul);
 * answers come back with calibrated probabilities and per-answer confidence.
 * The client is injected into the dispatcher so tests can substitute a mock.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface JevQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  /** score: ordered level descriptions (2-10); choice: map of option key -> meaning. */
  criteria?: string[] | Record<string, string | null>;
}

export interface JevAnswer {
  type: 'choice' | 'score' | 'noul';
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
}

export interface JevClient {
  model: string;
  ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult>;
}

export interface JevConfig {
  /** Full endpoint URL; the hosted metered gateway uses a different path but the same payload shape. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export function createJevClient(cfg: JevConfig): JevClient {
  return {
    model: cfg.model,
    async ask(state, questions) {
      const response = await fetch(cfg.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, state, questions }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
      });
      const body = await response.json().catch(() => ({})) as { model?: string; answers?: Record<string, JevAnswer>; error?: { message?: string } };
      if (!response.ok || !body.answers) {
        throw new Error(`jev request failed (${response.status}): ${body.error?.message ?? 'no answers'}`);
      }
      return { model: body.model ?? cfg.model, answers: body.answers };
    },
  };
}

/** Load Jev config from env (falling back to private/service.env); undefined disables the Jev path. */
export function jevFromEnv(env: NodeJS.ProcessEnv = process.env): JevClient | undefined {
  const file = readServiceEnv();
  const get = (name: string) => env[name] || file[name];
  const apiKey = get('JEV_API_KEY') ?? get('TYPESAFE_API_KEY');
  if (!apiKey) return undefined;
  return createJevClient({
    baseUrl: get('JEV_BASE_URL') ?? 'https://api.typesafe.ai/v1/systemone',
    apiKey,
    model: get('JEV_MODEL') ?? 'jev-1.13.0',
  });
}

function readServiceEnv(): Record<string, string> {
  const path = join(
    process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany'),
    'private/service.env');
  const values: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
  } catch { /* no service.env: process.env only */ }
  return values;
}

const SCORE_LEVELS = [
  '1：明显不合格——交付缺失、证据造假或与任务无关',
  '2：低于预期——有产出但不完整/不可信，或严重违反流程纪律',
  '3：合格——完成了要求的核心内容，证据基本可信',
  '4：良好——交付完整、证据充分、流程规范，有小瑕疵',
  '5：优秀——交付超出预期，证据扎实，为后续环节创造了便利',
];

export interface JevScoreAnswers {
  scores: { employee: string; quality: number; evidence: number; discipline: number; timeliness: number; overall: number; confidence: number; probabilities?: Record<string, Record<string, number>> }[];
  /** confidence 最低的一题；全部缺省时按 0 计，触发升级。 */
  minConfidence: number;
  flagged: string[];
  topPerformer?: string;
  raw: Record<string, JevAnswer>;
}

/**
 * Build the single round-trip Jev evaluation for one finished task and parse the answers.
 * participants/metrics/timeline come from collectEvalState().
 */
export function jevEvalQuestions(participants: string[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const [i, emp] of participants.entries()) {
    for (const dim of ['quality', 'evidence', 'discipline', 'timeliness', 'overall'] as const) {
      const dimName = {
        quality: '交付质量：产出是否真的完成了任务要求',
        evidence: '证据可信度：checkpoint/submit/review 的说明是否具体、可复核',
        discipline: '流程纪律：是否及时存进度、按协议操作、是否因中断被收回租约',
        timeliness: '推进效率：从领取到提交的耗时与节奏是否合理',
        overall: '综合评价：把这名员工当作会再次接到同类任务的同事',
      }[dim];
      questions[`p${i}_${dim}`] = {
        type: 'score',
        instructions: `给员工 ${emp} 在本任务中的${dimName}打分`,
        criteria: SCORE_LEVELS,
      };
    }
    questions[`p${i}_flag`] = {
      type: 'noul',
      instructions: `员工 ${emp} 的行为是否需要真人老板关注（造假、严重失职、异常低效等）`,
    };
  }
  if (participants.length > 1) {
    questions.top = {
      type: 'choice',
      instructions: '本轮任务贡献最大或最值得信赖的员工是哪位',
      criteria: Object.fromEntries(participants.map(p => [p, null])),
    };
  }
  return questions;
}

export function parseJevEval(participants: string[], answers: Record<string, JevAnswer>, flagThreshold: number): JevScoreAnswers {
  const scores: JevScoreAnswers['scores'] = [];
  const flagged: string[] = [];
  let minConfidence = 1;
  for (const [i, emp] of participants.entries()) {
    const entry: JevScoreAnswers['scores'][number] = { employee: emp, quality: 0, evidence: 0, discipline: 0, timeliness: 0, overall: 0, confidence: 1 };
    for (const dim of ['quality', 'evidence', 'discipline', 'timeliness', 'overall'] as const) {
      const answer = answers[`p${i}_${dim}`];
      if (answer?.type !== 'score' || typeof answer.score !== 'number') throw new Error(`jev missing score ${`p${i}_${dim}`}`);
      entry[dim] = Math.min(Math.max(answer.score, 1), 5);
      const confidence = answer.confidence ?? 0;
      entry.confidence = Math.min(entry.confidence, confidence);
      minConfidence = Math.min(minConfidence, confidence);
      if (answer.probabilities) (entry.probabilities ??= {})[dim] = answer.probabilities;
    }
    const flag = answers[`p${i}_flag`];
    if (flag?.type === 'noul' && (flag.noul ?? 0) >= flagThreshold) flagged.push(emp);
    scores.push(entry);
  }
  const top = answers.top;
  return { scores, minConfidence: participants.length ? minConfidence : 1, flagged, topPerformer: top?.type === 'choice' ? top.choice : undefined, raw: answers };
}
