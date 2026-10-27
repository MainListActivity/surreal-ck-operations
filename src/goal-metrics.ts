/**
 * SYS07 AC04 · business metrics with explicit windows, denominators, coverage and unknowns.
 *
 * The input rows are source records the store read; this file only aggregates. It never estimates cost from
 * tokens, weights or durations. Actual cost is `unknown` unless every contributing usage row carries a provider
 * billed amount, and the denominator/coverage that produced that answer is part of the result.
 */
import type { GoalEvidenceKind } from './goal-governance.ts';

export interface GoalMetricsWindow {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  timezone: string;
  cutoffAt: string;
  /** True when the caller supplied the window; false means the default last-30-days window. */
  explicit: boolean;
}

export interface MetricGoalRow {
  id: string;
  title: string;
  tier?: string;
  pipeline?: string;
  state: string;
  createdAt?: number;
  doneAt?: number;
}

export interface MetricTaskRow {
  id: string;
  title: string;
  goalId?: string;
  kind?: string;
  tier?: string;
  pipeline?: string;
  state: string;
  createdAt?: number;
  acceptedAt?: number;
  acceptanceAttempt?: number;
  executorRole?: string;
}

export interface MetricAuditRow {
  taskId: string;
  action: string;
  phase?: string;
  at: number;
  actor?: string;
  /** A channel release/revoke or a system migration is not a human return. */
  mechanical?: boolean;
}

export interface MetricWakeRow {
  taskId: string;
  phase: string;
  episode: string;
  attempt: number;
  at: number;
}

export interface MetricUsageRow {
  taskId: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Only present when the provider billed this request; token counts are not a billed amount. */
  costUsd?: number;
  completed: boolean;
  at: number;
}

export interface MetricEvidenceRow {
  goalId: string;
  kind: GoalEvidenceKind;
  at: number;
}

export interface GoalMetricsSource {
  window: GoalMetricsWindow;
  goals: MetricGoalRow[];
  tasks: MetricTaskRow[];
  audits: MetricAuditRow[];
  wakes: MetricWakeRow[];
  usage: MetricUsageRow[];
  evidence: MetricEvidenceRow[];
}

export interface DurationStats {
  count: number;
  known: number;
  missing: number;
  averageMs?: number;
  medianMs?: number;
}

export interface GoalMetricsView {
  window: {
    from: string; to: string; timezone: string; cutoffAt: string;
    fromMs: number; toMs: number; explicit: boolean;
  };
  definitions: Record<string, string>;
  denominators: {
    goalsDone: number;
    tasksAccepted: number;
    firstPassKnown: number;
    firstPassUnknownLegacy: number;
    blockEvents: number;
    wakeAcquisitions: number;
  };
  cycleTime: {
    goal: DurationStats & { byTier: Record<string, DurationStats>; byPipeline: Record<string, DurationStats> };
    task: DurationStats & { byKind: Record<string, DurationStats> };
  };
  acceptance: {
    firstPass: { passed: number; known: number; rate?: number; unknownLegacy: number; exclusions: string[] };
  };
  blocks: {
    repeatedEpisodes: number;
    episodes: number;
    extraBlocks: number;
    byActor: Record<string, number>;
    samples: Array<{ taskId: string; phase: string; blocks: number; lastAt: string }>;
  };
  wakes: {
    repeatedAcquisitions: number;
    withoutNewProgress: number;
    byTask: Array<{ taskId: string; phase: string; episode: string; acquisitions: number; withoutProgress: number }>;
  };
  usage: {
    tasksAccepted: number;
    tasksWithUsage: number;
    tokens: { input?: number; output?: number; cacheRead?: number };
    cost: { status: 'actual' | 'unknown'; usd?: number; reason?: string; pricedTasks?: number; unpricedTasks?: number };
    byGoal: Array<{
      goalId: string; tasks: number; usageRows: number;
      tokens: { input?: number; output?: number; cacheRead?: number };
      cost: { status: 'actual' | 'unknown'; usd?: number; reason?: string };
    }>;
  };
  events: {
    taskReturns: { real: number; channelRollback: number; total: number };
    leaseEnds: { released: number; revoked: number; total: number };
    systemEvents: number;
  };
  customerEvidence: {
    goalsDone: number;
    goalsWithActivation: number;
    goalsWithAdoption: number;
    missingActivation: string[];
    missingAdoption: string[];
  };
  daySeries: Array<{ day: string; tasksAccepted: number; goalsDone: number; blockEvents: number }>;
  exclusions: string[];
  coverage: { goals: number; tasks: number; audits: number; wakes: number; usage: number; evidence: number };
}

export function dayKey(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function stats(values: number[], total: number): DurationStats {
  if (!values.length) return { count: total, known: 0, missing: total };
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 ? ordered[mid]! : Math.round((ordered[mid - 1]! + ordered[mid]!) / 2);
  return {
    count: total, known: values.length, missing: total - values.length,
    averageMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    medianMs: median,
  };
}

function groupStats<K extends string>(rows: Array<{ key: K; duration?: number }>, totalByKey: Map<K, number>): Record<K, DurationStats> {
  const grouped = new Map<K, number[]>();
  for (const row of rows) {
    if (row.duration === undefined) continue;
    const list = grouped.get(row.key) ?? [];
    list.push(row.duration);
    grouped.set(row.key, list);
  }
  return Object.fromEntries([...totalByKey.entries()].map(([key, total]) => [key, stats(grouped.get(key) ?? [], total)])) as Record<K, DurationStats>;
}

const RESET_ACTIONS = new Set(['resume', 'released', 'revoked', 'dependency_unlocked', 'dispatch_unblocked', 'accept', 'owner_approve']);
const PROGRESS_ACTIONS = new Set(['checkpoint', 'submit', 'accept', 'owner_approve', 'dependency_unlocked']);

export function computeGoalMetrics(source: GoalMetricsSource): GoalMetricsView {
  const { window } = source;
  const inWindow = (at: number) => at >= window.fromMs && at < window.toMs;
  const tasks = source.tasks.filter(task => task.acceptedAt !== undefined && inWindow(task.acceptedAt));
  const goals = source.goals.filter(goal => goal.doneAt !== undefined && inWindow(goal.doneAt));
  const taskById = new Map(source.tasks.map(task => [task.id, task]));
  const goalById = new Map(source.goals.map(goal => [goal.id, goal]));

  const taskDurations = tasks.map(task => ({
    key: (task.kind ?? 'task') as string,
    duration: task.createdAt !== undefined && task.acceptedAt !== undefined ? Math.max(0, task.acceptedAt - task.createdAt) : undefined,
  }));
  const taskTotals = new Map<string, number>();
  for (const task of tasks) taskTotals.set(task.kind ?? 'task', (taskTotals.get(task.kind ?? 'task') ?? 0) + 1);
  const goalDurations = goals.map(goal => ({
    key: goal.tier ?? 'unknown',
    duration: goal.createdAt !== undefined && goal.doneAt !== undefined ? Math.max(0, goal.doneAt - goal.createdAt) : undefined,
  }));
  const goalTotals = new Map<string, number>();
  for (const goal of goals) goalTotals.set(goal.tier ?? 'unknown', (goalTotals.get(goal.tier ?? 'unknown') ?? 0) + 1);
  const pipelineRows = goals.map(goal => ({
    key: goal.pipeline ?? 'software',
    duration: goal.createdAt !== undefined && goal.doneAt !== undefined ? Math.max(0, goal.doneAt - goal.createdAt) : undefined,
  }));
  const pipelineTotals = new Map<string, number>();
  for (const goal of goals) pipelineTotals.set(goal.pipeline ?? 'software', (pipelineTotals.get(goal.pipeline ?? 'software') ?? 0) + 1);

  const firstPassKnown = tasks.filter(task => task.acceptanceAttempt !== undefined);
  const firstPass = firstPassKnown.filter(task => (task.acceptanceAttempt ?? 0) <= 1).length;
  const legacyUnknown = tasks.length - firstPassKnown.length;
  const acceptanceExclusions = [
    ...(legacyUnknown ? [`${legacyUnknown} 个任务无 acceptance_attempt（SYS02 前遗留），不计入首验分母`] : []),
  ];

  // A block episode is one task+phase segment. Progress/reset actions close the segment, so two blocks separated
  // by a real resume are one repeated episode, not two unrelated first blocks.
  const blocks = source.audits.filter(item => inWindow(item.at) && item.action === 'block');
  const auditByTask = new Map<string, MetricAuditRow[]>();
  for (const item of source.audits) {
    if (!inWindow(item.at)) continue;
    const list = auditByTask.get(item.taskId) ?? [];
    list.push(item);
    auditByTask.set(item.taskId, list);
  }
  const episodeCounts = new Map<string, { taskId: string; phase: string; blocks: number; lastAt: number }>();
  for (const [taskId, rows] of auditByTask) {
    const ordered = [...rows].sort((a, b) => a.at - b.at);
    let phase = 'execute';
    let key = `${taskId}|${phase}`;
    let count = 0;
    const flush = () => {
      if (!count) return;
      const current = episodeCounts.get(key);
      episodeCounts.set(key, { taskId, phase, blocks: (current?.blocks ?? 0) + count,
        lastAt: Math.max(current?.lastAt ?? 0, ordered.filter(item => item.action === 'block').at(-1)?.at ?? 0) });
      count = 0;
    };
    for (const item of ordered) {
      if (item.phase) phase = item.phase;
      if (item.action === 'block') { key = `${taskId}|${phase}`; count++; }
      else if (RESET_ACTIONS.has(item.action)) flush();
    }
    flush();
  }
  const repeatedEpisodes = [...episodeCounts.values()].filter(item => item.blocks > 1);
  const blockByActor: Record<string, number> = {};
  for (const item of blocks) blockByActor[item.actor ?? 'unknown'] = (blockByActor[item.actor ?? 'unknown'] ?? 0) + 1;

  const wakes = source.wakes.filter(item => inWindow(item.at));
  const wakeGroups = new Map<string, MetricWakeRow[]>();
  for (const wake of wakes) {
    const key = `${wake.taskId}|${wake.phase}|${wake.episode}`;
    const list = wakeGroups.get(key) ?? [];
    list.push(wake);
    wakeGroups.set(key, list);
  }
  const wakeByTask: GoalMetricsView['wakes']['byTask'] = [];
  let withoutProgress = 0;
  for (const [key, rows] of wakeGroups) {
    const ordered = [...rows].sort((a, b) => a.at - b.at);
    let noProgress = 0;
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      const progressed = (auditByTask.get(current.taskId) ?? [])
        .some(item => item.at > previous.at && item.at <= current.at && PROGRESS_ACTIONS.has(item.action));
      if (!progressed && current.attempt > 1) noProgress++;
    }
    if (noProgress) {
      withoutProgress += noProgress;
      const [taskId, phase, episode] = key.split('|') as [string, string, string];
      wakeByTask.push({ taskId, phase, episode, acquisitions: ordered.length, withoutProgress: noProgress });
    }
  }
  wakeByTask.sort((a, b) => b.withoutProgress - a.withoutProgress || a.taskId.localeCompare(b.taskId));

  const acceptedIds = new Set(tasks.map(task => task.id));
  const usageRows = source.usage.filter(row => row.completed && acceptedIds.has(row.taskId));
  const tasksWithUsage = new Set(usageRows.map(row => row.taskId)).size;
  const sum = (pick: (row: MetricUsageRow) => number | undefined) => {
    const values = usageRows.map(pick).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const input = sum(row => row.inputTokens);
  const output = sum(row => row.outputTokens);
  const cacheRead = sum(row => row.cacheReadTokens);
  const priced = usageRows.filter(row => typeof row.costUsd === 'number' && Number.isFinite(row.costUsd));
  const unpriced = usageRows.length - priced.length;
  const cost: GoalMetricsView['usage']['cost'] = usageRows.length > 0 && unpriced === 0
    ? { status: 'actual', usd: priced.reduce((total, row) => total + row.costUsd!, 0), pricedTasks: tasksWithUsage }
    : { status: 'unknown', reason: usageRows.length
        ? 'provider billing is not joined to task usage; token counts are not cost'
        : 'no provider usage rows for the accepted tasks', pricedTasks: priced.length ? tasksWithUsage : 0, unpricedTasks: unpriced };
  const rowsByGoal = new Map<string, MetricUsageRow[]>();
  for (const row of usageRows) {
    const goalId = taskById.get(row.taskId)?.goalId ?? 'unassigned';
    const list = rowsByGoal.get(goalId) ?? [];
    list.push(row);
    rowsByGoal.set(goalId, list);
  }
  const sumRows = (rows: MetricUsageRow[], pick: (row: MetricUsageRow) => number | undefined) => {
    const values = rows.map(pick).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const usageByGoal: GoalMetricsView['usage']['byGoal'] = [...rowsByGoal.entries()].map(([goalId, rows]) => {
    const pricedRows = rows.filter(row => typeof row.costUsd === 'number' && Number.isFinite(row.costUsd));
    const inputTokens = sumRows(rows, row => row.inputTokens);
    const outputTokens = sumRows(rows, row => row.outputTokens);
    const cacheReadTokens = sumRows(rows, row => row.cacheReadTokens);
    return {
      goalId, tasks: new Set(rows.map(row => row.taskId)).size, usageRows: rows.length,
      tokens: { ...(inputTokens === undefined ? {} : { input: inputTokens }),
        ...(outputTokens === undefined ? {} : { output: outputTokens }),
        ...(cacheReadTokens === undefined ? {} : { cacheRead: cacheReadTokens }) },
      cost: pricedRows.length === rows.length && rows.length > 0
        ? { status: 'actual' as const, usd: pricedRows.reduce((total, row) => total + row.costUsd!, 0) }
        : { status: 'unknown' as const, reason: rows.length
            ? '部分或全部 provider 用量未带实际计费，不能按 token 推算成本'
            : '该目标在窗口内没有可归因用量' },
    };
  }).sort((a, b) => a.goalId.localeCompare(b.goalId));

  const events = {
    taskReturns: {
      real: source.audits.filter(item => inWindow(item.at) && item.action === 'return' && !item.mechanical).length,
      channelRollback: source.audits.filter(item => inWindow(item.at) && item.action === 'return' && item.mechanical).length,
      total: source.audits.filter(item => inWindow(item.at) && item.action === 'return').length,
    },
    leaseEnds: {
      released: source.audits.filter(item => inWindow(item.at) && item.action === 'released').length,
      revoked: source.audits.filter(item => inWindow(item.at) && item.action === 'revoked').length,
      total: source.audits.filter(item => inWindow(item.at) && (item.action === 'released' || item.action === 'revoked')).length,
    },
    systemEvents: source.audits.filter(item => inWindow(item.at) && (item.actor ?? '').startsWith('system:')).length,
  };

  const doneGoalIds = goals.map(goal => goal.id);
  const activation = new Set(source.evidence.filter(row => inWindow(row.at) && row.kind === 'customer_activation').map(row => row.goalId));
  const adoption = new Set(source.evidence.filter(row => inWindow(row.at) && row.kind === 'customer_adoption').map(row => row.goalId));

  const dayMap = new Map<string, { tasksAccepted: number; goalsDone: number; blockEvents: number }>();
  const addDay = (ms: number, field: 'tasksAccepted' | 'goalsDone' | 'blockEvents') => {
    const key = dayKey(ms, window.timezone);
    const row = dayMap.get(key) ?? { tasksAccepted: 0, goalsDone: 0, blockEvents: 0 };
    row[field]++;
    dayMap.set(key, row);
  };
  for (const task of tasks) addDay(task.acceptedAt!, 'tasksAccepted');
  for (const goal of goals) addDay(goal.doneAt!, 'goalsDone');
  for (const block of blocks) addDay(block.at, 'blockEvents');

  const exclusions = [
    ...(tasks.length < source.tasks.filter(task => task.acceptedAt !== undefined).length
      ? ['窗口外验收的任务不计入本轮周期与首验统计'] : []),
    ...acceptanceExclusions,
    ...(usageRows.length === 0 ? ['没有可归因到验收任务的 provider usage，成本记为 unknown'] : []),
    '通道 release/revoke 与系统迁移事件不计入人工 return；指标按 audit action 白名单取数',
  ];

  return {
    window: { ...window },
    definitions: {
      goalCycle: '目标 created_at → done_at（仅窗口内完成的目标；缺 done_at 的历史目标记 unknown）',
      taskCycle: '任务 created_at → 真实 accept/owner_approve 审计时间（窗口内验收）',
      firstPass: '任务 acceptance_attempt<=1 视为首次通过；无 attempt 的 SYS02 前遗留不计入分母',
      blockEpisode: '同一 task+phase 的连续 block 段；resume/release/revoke/dependency_unlocked/dispatch_unblocked/accept 关闭一段',
      repeatedWake: '同一 task+phase+episode 的第 2 次及以后 manager_wake_acquired；区间内无 checkpoint/submit/accept 记为无新增可验证进展',
      usage: 'model_execution 的可归因 token；只有每行都带 provider 实际计费才给实际成本，否则 unknown',
      window: '左闭右开 [from,to)，按 timezone 分日；cutoffAt 是数据库读取时刻',
    },
    denominators: {
      goalsDone: goals.length, tasksAccepted: tasks.length,
      firstPassKnown: firstPassKnown.length, firstPassUnknownLegacy: legacyUnknown,
      blockEvents: blocks.length, wakeAcquisitions: wakes.length,
    },
    cycleTime: {
      goal: {
        ...stats(goals.map(goal => goal.createdAt !== undefined && goal.doneAt !== undefined
          ? Math.max(0, goal.doneAt - goal.createdAt) : undefined).filter((value): value is number => value !== undefined), goals.length),
        byTier: groupStats(goalDurations, goalTotals),
        byPipeline: groupStats(pipelineRows, pipelineTotals),
      },
      task: {
        ...stats(taskDurations.map(item => item.duration).filter((value): value is number => value !== undefined), tasks.length),
        byKind: groupStats(taskDurations, taskTotals),
      },
    },
    acceptance: {
      firstPass: {
        passed: firstPass, known: firstPassKnown.length,
        ...(firstPassKnown.length ? { rate: Math.round((firstPass / firstPassKnown.length) * 10000) / 10000 } : {}),
        unknownLegacy: legacyUnknown, exclusions: acceptanceExclusions,
      },
    },
    blocks: {
      repeatedEpisodes: repeatedEpisodes.length,
      episodes: episodeCounts.size,
      extraBlocks: repeatedEpisodes.reduce((total, episode) => total + episode.blocks - 1, 0),
      byActor: blockByActor,
      samples: repeatedEpisodes.sort((a, b) => b.blocks - a.blocks || a.taskId.localeCompare(b.taskId)).slice(0, 10)
        .map(item => ({ taskId: item.taskId, phase: item.phase, blocks: item.blocks, lastAt: new Date(item.lastAt).toISOString() })),
    },
    wakes: {
      repeatedAcquisitions: Math.max(0, wakes.length - wakeGroups.size),
      withoutNewProgress: withoutProgress,
      byTask: wakeByTask.slice(0, 20),
    },
    usage: {
      tasksAccepted: tasks.length, tasksWithUsage,
      tokens: { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }),
        ...(cacheRead === undefined ? {} : { cacheRead }) },
      cost, byGoal: usageByGoal,
    },
    events,
    customerEvidence: {
      goalsDone: doneGoalIds.length,
      goalsWithActivation: doneGoalIds.filter(id => activation.has(id)).length,
      goalsWithAdoption: doneGoalIds.filter(id => adoption.has(id)).length,
      missingActivation: doneGoalIds.filter(id => !activation.has(id)).map(id => goalById.get(id)?.title ?? id).sort(),
      missingAdoption: doneGoalIds.filter(id => !adoption.has(id)).map(id => goalById.get(id)?.title ?? id).sort(),
    },
    daySeries: [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, row]) => ({ day, ...row })),
    exclusions,
    coverage: { goals: source.goals.length, tasks: source.tasks.length, audits: source.audits.length,
      wakes: source.wakes.length, usage: source.usage.length, evidence: source.evidence.length },
  };
}
