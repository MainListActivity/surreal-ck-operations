import type { ClaimResult, WorktreeAssignment } from '../contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../workforce.ts';
import { latestFindings } from './brief.ts';

export interface PromptEnv { opsRepo: string; sckBin: string; paseoBin: string }

/** The sidecar has claimed the task for the instance; the credential never reaches the agent. */
export interface PromptCtx { claim?: ClaimResult; worktree?: WorktreeAssignment; commDir?: string; scratchDir?: string }

const ROLE_NAMES: Record<string, string> = {
  product: '运营/产品：范围提案、决定是否上线、运营验收',
  engineering: '工程：实现、代码复核、合入部署',
  'ai-content': 'AI 与内容',
  'concept-design': '原型/概念设计（内容产线 P 段）',
  'asset-production': '量产制作（内容产线 M 段）',
  screenwriter: '专职编剧：故事与剧本多轮打磨，只接编剧轨',
  'story-author': '长篇故事作者：从总纲到概要再到正文，只接原著轨，不接任何改编和制作',
  cinematography: '摄影摄像：运镜设计、镜头调度、摄影机运动语言，只接摄影轨',
  qa: '测试：先查老板视角结果，再在最终合入提交上逐条复验',
  cs: '客户成功',
};

// sck 走会话内的私有通道，凭证由通道持有，无需出示。
const tool = (env: PromptEnv) => `'${env.sckBin}' call <工具名> '<JSON参数>'`;

/** 首次接触不再追加任何入职说明：派工消息与 task.md 已只说做什么、怎么交付。 */
export function onboarding(): string {
  return '';
}


/**
 * FV06 recovery read grant wake. The payload is exactly the grant identity: no credential, no task override,
 * no token. The channel holds the grant binding; the employee can only run one login, the four fixed GETs in
 * order and a necessary logout. The source task stays done — this is evidence collection, not execution.
 */

export function wake(_inst: EmployeeInst, task: SupervisedTask, env: PromptEnv, _firstContact: boolean, ctx: PromptCtx = {}): string {
  return briefWake(task, env, ctx);
}

/**
 * The dispatch message: which file says what to do, how to finish, and the one tool that hands the result in. Nothing
 * else — the requirement is in task.md (staged by the sidecar), the system enforces leases, worktrees and credentials.
 */
function briefWake(task: SupervisedTask, env: PromptEnv, ctx: PromptCtx): string {
  const dir = ctx.commDir ?? '$SCK_COMM_DIR';
  const finish = '完成后直接给出最终答复，包含工作结果、验证证据和产物位置，然后结束本轮；执行端自动保存并推进。遇到前置缺口首行写“工作结果：受阻”。';
  if (task.state === 'review') return `先查 ${dir}/task.md 的验收标准第 1 条，再按要求独立复验。最终答复首行写“复核结论：通过”或“复核结论：退回”，给出逐条证据并结束本轮。`;
  const findings = latestFindings(ctx.claim?.history);
  if (findings) return `修复 ${dir}/${findings.file} 中的问题，按验收标准自验。${finish}`;
  return `实现 ${dir}/task.md 中的需求，按验收标准逐条自验。${finish}`;
}
