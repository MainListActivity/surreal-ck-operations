import type { CreateTask, GoalTier, TaskKind } from './contracts.ts';

export const GOAL_TIERS: readonly GoalTier[] = ['quick', 'standard', 'program'];
export const PIPELINES = ['software', 'video', 'story'] as const;
export type PipelineId = typeof PIPELINES[number];
export const isPipeline = (value: unknown): value is PipelineId => PIPELINES.includes(value as PipelineId);

type Spec = Pick<CreateTask, 'title' | 'context' | 'executorRole' | 'reviewerRole'> & { kind: Exclude<TaskKind, 'goal'> };

/**
 * 一个目标 = 一个需求 = 一个任务。软件线：engineering 实现+合入发布+生产自验 → qa 按验收标准在生产复验。
 * 内容产线同样「执行岗 → 复核岗」，需要更多步时老板通过 owner 接口加任务并用依赖串起来。
 */
function oneTask(title: string, brief: string, executorRole: Spec['executorRole'], reviewerRole: Spec['reviewerRole']): Spec[] {
  return [{
    title, kind: 'task', executorRole, reviewerRole,
    context: `需求：\n${brief}\n\n验收标准：\n按目标原文在生产逐条验证。`,
  }];
}

export interface TemplateTask extends Spec { ref: string; deps: string[]; requirement?: string; acceptanceText?: string }
export interface GoalTemplate {
  tasks: TemplateTask[];
  anchors: string[];
  refs: { intake?: string; plan?: string; manual?: string; acceptance?: string };
}

export function goalTemplate(_tier: GoalTier, title: string, brief: string, _goalId: string,
  pipeline: PipelineId = 'software', _codeRepoPath?: string): GoalTemplate {
  const roles: Record<PipelineId, [Spec['executorRole'], Spec['reviewerRole']]> = {
    software: ['engineering', 'qa'],
    story: ['story-author', 'qa'],
    video: ['concept-design', 'owner'],
  };
  const [executor, reviewer] = roles[isPipeline(pipeline) ? pipeline : 'software'];
  const [spec] = oneTask(`[目标] ${title} · 交付`, brief, executor, reviewer);
  const task: TemplateTask = { ...spec, ref: 'work', deps: [], requirement: brief,
    acceptanceText: '按目标原文在生产逐条验证；不通过 return 给执行岗。' };
  return { tasks: [task], anchors: ['work'], refs: { plan: 'work', manual: 'work', acceptance: 'work' } };
}

export const TIER_CRITERIA: Record<GoalTier, string> = {
  quick: '单一需求，一个任务即可完成',
  standard: '方向清楚的一个任务；需要更多步时老板加任务并用依赖串起来',
  program: '方向性目标；老板按需求拆成多个任务并用依赖串起来',
};

/** Legacy compatibility: create_delivery still builds its own chain. New goals use goalTemplate (one task). */
export function deliveryChain(title: string, spec: string): Spec[] {
  const head = `需求：\n${spec}`;
  return [
    { title: `${title} · 实现`, kind: 'task', executorRole: 'engineering', reviewerRole: 'qa', context: head },
    { title: `${title} · 验收`, kind: 'task', executorRole: 'qa', reviewerRole: 'owner', context: head },
    { title: `${title} · 发布`, kind: 'deploy', executorRole: 'engineering', reviewerRole: 'qa', context: head },
  ];
}
export function quickChain(title: string, spec: string, _lane: string, _codeRepoPath?: string): Spec[] {
  return deliveryChain(title, spec);
}
