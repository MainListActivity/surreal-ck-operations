import type { CreateTask, GoalTier, TaskKind } from './contracts.ts';

export const GOAL_TIERS: readonly GoalTier[] = ['quick', 'standard', 'program'];

type Spec = Pick<CreateTask, 'title' | 'context' | 'executorRole' | 'reviewerRole'> & { kind: Exclude<TaskKind, 'goal'> };

const AUTHORITY = '决策边界：能在公司内决定的事不找老板。技术方案与拆分由经理定，是否上线由运营定，运营定不了交经理；只有花钱/充值、签约、对外联系、公司方向和项目红线才 report_blocker to=owner，并写明已查过哪些来源。';

/** 实现 → 上线申请 → 合入部署与生产实测. Used by standard/program plans via the create_delivery tool. */
export function deliveryChain(title: string, spec: string): Spec[] {
  const head = `交付项：${title}\n需求与验收标准：\n${spec}\n\n项目环境（仓库、发布方式、生产地址、红线）与已下发凭证见 claim 返回的 project 和 secrets；缺的凭证用 get_secret 领取。\n`;
  return [
    {
      title: `${title} · 实现`, kind: 'task', executorRole: 'engineering', reviewerRole: 'engineering',
      context: `${head}
你是工程。在 project.repoPath 仓库、任务专属分支 task/<本任务 id 前 8 位> 的独立 worktree 中实现，遵守该仓库的 AGENTS 与技能。
完成标准：测试通过，推送分支并创建 PR（不要合入）。
submit 证据：PR 链接、分支、提交 SHA、测试命令与结果、数据库迁移类型（无 / 只新增结构 / 改写或删除已有数据）、需要的新环境变量或主机准备。
验收者是另一位工程师：读 diff、跑测试、确认 PR 的 CI 通过；不通过就 return 并写明问题。`,
    },
    {
      title: `${title} · 上线申请`, kind: 'release', executorRole: 'engineering', reviewerRole: 'product',
      context: `${head}
你是工程。前置任务的 PR 已通过代码复核。提交上线申请：PR 链接与提交、改动摘要、影响面、数据库迁移类型、新环境变量或主机准备、回滚方式、生产验证要点。
验收者是运营，由运营决定是否上线（调度器用 Jev 判断，高置信安全时自动批准）。运营 accept = 同意上线；return = 暂不上线并写明需要补什么。
运营：只在触碰 project.redLines 或需要花钱、对外联系时 report_blocker to=gm，其余自己决定。
${AUTHORITY}`,
    },
    {
      title: `${title} · 合入部署与生产实测`, kind: 'deploy', executorRole: 'engineering', reviewerRole: 'qa',
      context: `${head}
你是工程。上线申请已批准。按 project.release 发布：合入 PR、等待 CI 发布完成、确认生产运行的就是该提交（health、版本或页面）。
发布失败或自动回滚：先按 project.rollback 恢复生产，再修复后重新发布；修不好就 report_blocker to=gm。
submit 证据：合入提交、CI 运行链接与结论、生产健康检查结果。
验收者 qa：在生产环境按上面的验收标准逐条实测。可领取的凭证已随 claim 下发在 secrets 字段（缺的才用 get_secret），凭证不写入任何证据。
accept 证据逐条写：入口链接 → 操作 → 实际结果（截图路径或响应摘要）。任何一条不通过就 return 给工程。`,
    },
  ];
}

/**
 * quick 目标的合并交付链：实现+上线申请合一（工程交活时一并写上线申请，运营/Jev 决定是否上线）
 * → 合入部署与生产实测。比标准链少一轮复核与派工；quick 即小改动，不再走独立的工程互审。
 */
export function quickChain(title: string, spec: string): Spec[] {
  const head = `交付项：${title}\n需求与验收标准：\n${spec}\n\n项目环境（仓库、发布方式、生产地址、红线）与已下发凭证见 claim 返回的 project 和 secrets；缺的凭证用 get_secret 领取。\n`;
  return [
    {
      title: `${title} · 实现与上线申请`, kind: 'release', executorRole: 'engineering', reviewerRole: 'product',
      context: `${head}
你是工程。在 project.repoPath 仓库、任务专属分支 task/<本任务 id 前 8 位> 的独立 worktree 中实现，遵守该仓库的 AGENTS 与技能。
完成标准：测试通过，推送分支并创建 PR（不要合入）。
本任务是实现与上线申请合一，submit 证据要同时包含：PR 链接、分支、提交 SHA、测试命令与结果、改动摘要、影响面、数据库迁移类型（无 / 只新增结构 / 改写或删除已有数据）、需要的新环境变量或主机准备、回滚方式、生产验证要点。
验收者是运营，由运营决定是否上线（调度器可能先用 Jev 判断，高置信安全时自动批准）。accept = 同意上线；return = 需要补什么写明。
运营：复核证据与 PR、CI 是否通过、迁移类型与红线；只在触碰 project.redLines 或需要花钱、对外联系时 report_blocker to=gm，其余自己决定。
${AUTHORITY}`,
    },
    deliveryChain(title, spec)[2],
  ];
}

function productAcceptance(goalId: string, head: string, final: boolean): Spec {
  return {
    title: '运营验收', kind: 'task', executorRole: 'product', reviewerRole: 'gm',
    context: `${head}
你是运营。本目标的开发、上线和 qa 生产实测已完成。对照老板原始输入和 qa 的实测记录确认结果符合预期，需要时自己在生产上操作一遍。
写《验收记录》到 deliverables/${goalId}/acceptance.md，全文作为 submit 证据：交付了什么、生产入口链接、验收步骤（打开哪里 → 用什么账号 → 点什么 → 应看到什么）、qa 实测结论、已知限制、回滚方式。
不符合预期：用 create_delivery 或 create_task（带 goalId="${goalId}"）创建返工，本任务会自动等待返工完成，然后结束本轮。
${final ? '本目标是小开发任务：经理确认后目标即完成并记录结果，不通知老板。' : '经理确认后进入 G3，由老板最终验收。'}`,
  };
}

function plan(goalId: string, head: string, afterScope: boolean): Spec {
  return {
    title: '任务拆解与分派', kind: 'task', executorRole: 'gm', reviewerRole: 'product',
    context: `${head}
你是经理。${afterScope ? '先读依赖任务里运营的《范围提案》。' : ''}把目标拆成可独立交付的任务，全部带 goalId="${goalId}"：
- 每个代码改动用 create_delivery（自动生成 实现 → 上线申请 → 合入部署与生产实测，上线由运营决定、qa 在生产实测）。
- 非代码工作用 create_task，执行者与验收者不同岗位；小需求不要拉 ai-content、cs 参与。
submit 证据：任务清单（id、标题、执行/验收岗位、依赖）。运营验收和 G3 会自动等待全部任务完成。
${AUTHORITY}`,
  };
}

function finalGate(head: string): Spec {
  return {
    title: 'G3 老板最终验收', kind: 'gate', executorRole: 'gm', reviewerRole: 'owner',
    context: `${head}
你是经理。运营验收已完成，交付已在生产上线。写《G3 最终验收》，格式固定，全文作为 submit 证据：
1. 一句话结论：做完了什么。
2. 已上线的提交与生产入口链接。
3. 老板验收步骤：打开哪里 → 用什么账号 → 点什么 → 应看到什么（逐条）。
4. qa 生产实测与运营验收结论（证据所在任务）。
5. 已知限制与回滚方式。
不要请老板决定是否部署，交付已经上线。老板驳回时，按意见用 create_delivery / create_task（带 goalId）返工，然后结束本轮；G3 会自动等待返工完成。`,
  };
}

export interface TemplateTask extends Spec { ref: string; deps: string[] }
export interface GoalTemplate {
  tasks: TemplateTask[];
  anchors: string[];
  refs: { intake?: string; plan?: string; manual: string; acceptance: string };
}

/** Task graph for a triaged goal. Refs are local names; the caller maps them to record ids. */
export function goalTemplate(tier: GoalTier, title: string, brief: string, goalId: string): GoalTemplate {
  const head = `所属目标：${title}（goal=${goalId}，级别 ${tier}）\n老板原始输入：\n${brief}\n`;
  if (tier === 'quick') {
    const chain = quickChain(title, brief).map((spec, i) => ({ ...spec, ref: `d${i}`, deps: i ? [`d${i - 1}`] : [] }));
    return {
      tasks: [...chain, { ...productAcceptance(goalId, head, true), ref: 'manual', deps: [chain.at(-1)!.ref] }],
      anchors: ['manual'], refs: { manual: 'manual', acceptance: 'manual' },
    };
  }
  const tasks: TemplateTask[] = [];
  if (tier === 'program') {
    tasks.push({
      ref: 'intake', deps: [], title: '范围提案', kind: 'task', executorRole: 'product', reviewerRole: 'gm',
      context: `${head}
你是运营。老板给的是方向性目标。写《范围提案》到 deliverables/${goalId}/scope.md，全文作为 submit 证据：目标用户与场景、最小可用版本功能（按优先级）、明确不做、依赖与风险、成本假设。
范围由你决定、经理复核，不送老板审批。只有需要花钱、签约、对外联系或方向取舍时才 report_blocker to=gm。
${AUTHORITY}`,
    });
  }
  tasks.push({ ...plan(goalId, head, tier === 'program'), ref: 'plan', deps: tier === 'program' ? ['intake'] : [] });
  tasks.push({ ...productAcceptance(goalId, head, false), ref: 'manual', deps: ['plan'] });
  tasks.push({ ...finalGate(head), ref: 'acceptance', deps: ['manual'] });
  return {
    tasks, anchors: ['manual', 'acceptance'],
    refs: { intake: tier === 'program' ? 'intake' : undefined, plan: 'plan', manual: 'manual', acceptance: 'acceptance' },
  };
}

export const TIER_CRITERIA: Record<GoalTier, string> = {
  quick: '单一仓库内范围明确的小改动或缺陷修复，一条合并交付链（实现+上线申请→部署与生产实测）即可完成',
  standard: '方向清楚但需要多个交付项或跨模块协作，需要经理拆解',
  program: '方向性、范围宽泛的大目标（例如做一个新产品），需要先做范围提案再拆解',
};
