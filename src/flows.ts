import { createHash } from 'node:crypto';
import type { AcceptanceCriterion, CreateTask, GoalTier, TaskKind, WorkIntent } from './contracts.ts';
import { baselineAcceptanceCriteria, defaultAcceptanceCriteria } from './acceptance.ts';

export const GOAL_TIERS: readonly GoalTier[] = ['quick', 'standard', 'program'];
export const PIPELINES = ['software', 'video', 'story'] as const;
export type PipelineId = typeof PIPELINES[number];
export const isPipeline = (value: unknown): value is PipelineId => PIPELINES.includes(value as PipelineId);

type Spec = Pick<CreateTask, 'title' | 'context' | 'executorRole' | 'reviewerRole' | 'acceptanceCriteria' | 'workIntent' | 'codeRepoPath'> & { kind: Exclude<TaskKind, 'goal'> };

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

export interface TemplateTask extends Spec {
  ref: string; deps: string[]; requirement?: string; acceptanceText?: string;
  discipline?: string; workIntent?: WorkIntent; codeRepoPath?: string; acceptanceCriteria?: AcceptanceCriterion[];
}
export interface GoalTemplate {
  tasks: TemplateTask[];
  anchors: string[];
  refs: { intake?: string; plan?: string; manual?: string; acceptance?: string };
}

export function goalTemplate(_tier: GoalTier, title: string, brief: string, goalId: string,
  pipeline: PipelineId = 'software', codeRepoPath?: string): GoalTemplate {
  const line = isPipeline(pipeline) ? pipeline : 'software';
  const roles: Record<PipelineId, [Spec['executorRole'], Spec['reviewerRole']]> = {
    software: ['engineering', 'qa'],
    story: ['story-author', 'qa'],
    video: ['concept-design', 'owner'],
  };
  const [executor, reviewer] = roles[line];
  const software = line === 'software';
  const lane = `delivery-${createHash('sha256').update(goalId).digest('hex').slice(0, 8)}`;
  const workIntent: WorkIntent | undefined = software ? { kind: 'code', lane } : undefined;
  const discipline = line === 'story' ? '原著' : undefined;
  // The server-owned deploy baseline is what a gated goal task must carry: triage bypasses createTaskRecord, so
  // the default deploy set (AC-1/AC-2) would leave the baseline ids unrecordable and the task impossible to submit.
  const acceptanceCriteria = software ? baselineAcceptanceCriteria('deploy') : undefined;
  const [spec] = oneTask(`[目标] ${title} · 交付`, brief, executor, reviewer);
  const task: TemplateTask = {
    ...spec, ref: 'work', deps: [], requirement: brief,
    acceptanceText: '按目标原文在生产逐条验证；不通过 return 给执行岗。',
    ...(discipline ? { discipline } : {}),
    ...(workIntent ? { workIntent } : {}),
    ...(codeRepoPath ? { codeRepoPath } : {}),
    ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
    ...(software ? { kind: 'deploy' as const } : {}),
  };
  return { tasks: [task], anchors: ['work'], refs: { plan: 'work', manual: 'work', acceptance: 'work' } };
}

export const TIER_CRITERIA: Record<GoalTier, string> = {
  quick: '单一需求，一个任务即可完成',
  standard: '方向清楚的一个任务；需要更多步时老板加任务并用依赖串起来',
  program: '方向性目标；老板按需求拆成多个任务并用依赖串起来',
};

/**
 * Legacy compatibility: create_delivery still builds the original three legs (实现 → 上线申请 → 合入部署与生产实测).
 * New goals never use it: goalTemplate is one task. Text routes escalation to the owner only; the manager post is gone.
 */
const AUTHORITY = '决策边界：能在公司内决定的事不找老板。技术方案与拆分由执行岗与复核岗商定，是否上线由运营定；只有花钱/充值、签约、对外联系、公司方向和项目红线才 report_blocker to=owner，并写明已查过哪些来源。';
const OPS_HINT = '你不持有任何凭证：测试账号、workspace、成员、生产登录一律用运维工具 ops_*（sck call ops_info \'{}\' 看当前项目能做什么）；运维工具没有的能力用 report_blocker to=owner 说明要补什么工具。';

function chainHead(title: string, spec: string): string {
  return `交付项：${title}\n需求与验收标准：\n${spec}\n\n项目环境（仓库、发布方式、生产地址、红线）见 claim.json 的 project。${OPS_HINT}\n`;
}

export function deliveryChain(title: string, spec: string): Spec[] {
  const head = chainHead(title, spec);
  return [
    {
      title: `${title} · 实现`, kind: 'task', executorRole: 'engineering', reviewerRole: 'engineering',
      acceptanceCriteria: defaultAcceptanceCriteria('implement'),
      context: `${head}
你是工程。按 claim.json.worktree 的登记路径、分支与写权实现：树和分支由调度按任务或所属线（worktree.lane）分配，同一线的任务共用一棵树和一个分支，接手时在现有提交上继续，不另开分支；已有未合入 PR 就追加提交。仅在 intent=code 的登记分支提交，不自行新建/checkout/reset/pull，遵守该仓库 AGENTS 与技能；附件写 evidence 目录。
完成标准：测试通过，推送分支并创建 PR（不要合入）。
submit 证据：PR 链接、分支、提交 SHA、测试命令与结果、数据库迁移类型（无 / 只新增结构 / 改写或删除已有数据）、需要的新环境变量或主机准备。
验收者是另一位工程师：读 diff、跑测试；不通过就 return 并写明问题。`,
    },
    {
      title: `${title} · 上线申请`, kind: 'release', executorRole: 'engineering', reviewerRole: 'product',
      acceptanceCriteria: defaultAcceptanceCriteria('release'),
      context: `${head}
你是工程。前置任务的 PR 已通过代码复核。提交上线申请：PR 链接与提交、改动摘要、影响面、数据库迁移类型、新环境变量或主机准备、回滚方式、生产验证要点。
验收者是运营，由运营决定是否上线（调度器用 Jev 判断，高置信安全时自动批准）。运营 accept = 同意上线；return = 暂不上线并写明需要补什么。
运营：只在触碰 project.redLines 或需要花钱、对外联系时 report_blocker to=owner，其余自己决定。
${AUTHORITY}`,
    },
    {
      title: `${title} · 合入部署与生产实测`, kind: 'deploy', executorRole: 'engineering', reviewerRole: 'qa',
      acceptanceCriteria: defaultAcceptanceCriteria('deploy'),
      context: `${head}
你是工程。上线申请已批准。按 project.release 发布：合入 PR、确认发布完成、并核对生产运行的就是该提交（health、版本或页面）。
发布失败或自动回滚：先按 project.rollback 恢复生产，再修复后重新发布；修不好就 report_blocker to=owner。
submit 证据：合入提交、CI 运行链接与结论、生产健康检查结果。
验收者 qa：在生产环境按上面的验收标准逐条实测。测试账号、workspace、登录用运维工具（ops_login、ops_workspace_ensure、ops_browser_login 等）；你拿不到也不需要密码或 token，证据里只写账号别名和 workspace slug。
accept 证据逐条写：入口链接 → 操作 → 实际结果（截图路径或响应摘要）。任何一条不通过就 return 给工程。`,
    },
  ];
}

export function quickChain(title: string, spec: string, _lane: string, _codeRepoPath?: string): Spec[] {
  return deliveryChain(title, spec);
}
