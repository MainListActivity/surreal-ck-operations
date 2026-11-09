import type { ClaimResult, WorktreeAssignment } from '../contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../workforce.ts';
import { latestFindings } from './brief.ts';

export interface PromptEnv { opsRepo: string; sckBin: string; paseoBin: string }

/** comm = 插件 sidecar 已代领任务、凭证不进 agent；否则为旧的凭证文件模式。 */
export interface PromptCtx { comm: boolean; claim?: ClaimResult; worktree?: WorktreeAssignment; commDir?: string; scratchDir?: string }

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

// comm 模式下命令表面不变——sck 走会话内的私有通道，凭证由通道持有，无需出示。
const tool = (inst: EmployeeInst, env: PromptEnv, comm: boolean) => comm
  ? `'${env.sckBin}' call <工具名> '<JSON参数>'`
  : `SCK_EMPLOYEE_CREDENTIAL_FILE='${inst.credentialFile ?? '<见岗位登记>'}' '${env.sckBin}' call <工具名> '<JSON参数>'`;

/** 首次接触不再追加任何入职说明：派工消息与 task.md 已只说做什么、怎么交付。 */
export function onboarding(_inst: EmployeeInst, _env: PromptEnv, _comm = false, _commDir = '$SCK_COMM_DIR'): string {
  return '';
}


/**
 * FV06 recovery read grant wake. The payload is exactly the grant identity: no credential, no task override,
 * no token. The channel holds the grant binding; the employee can only run one login, the four fixed GETs in
 * order and a necessary logout. The source task stays done — this is evidence collection, not execution.
 */

export function wake(inst: EmployeeInst, task: SupervisedTask, env: PromptEnv, firstContact: boolean, ctx?: PromptCtx): string {
  const mode = task.state === 'review' ? '独立验收' : task.row.handover ? '接手续做（前任会话已中断）' : '执行';
  if (ctx?.comm) return briefWake(task, env, ctx);
  const body = `【派工】任务 ${task.id}「${task.title}」需要你${mode}。
1. 领取：${tool(inst, env, false).replace('<工具名>', 'claim_next').replace('<JSON参数>', JSON.stringify({ taskId: task.id }))}
   返回的 history 包含前任进度、交接包、验收退回意见和老板决定，先完整阅读；如需更早记录用 get_task_history；返回 response_too_large 时加 {"pageSize":10}，再用 page.nextCursor 逐页翻页，超长证据用 read_task_text。凭证不交给员工，旧凭证文件模式也没有运维工具；需要账号或生产登录的工作 report_blocker to=owner 说明。${task.row.handover ? `
   返回的 predecessors 列出历任持有员工的 Paseo 会话；交接包只截取了最后几十条日志，需要更早或完整上下文时直接读前任完整时间线：
   '${env.paseoBin}' logs <agentId> --tail 400 --no-color（去掉 --tail 看全部）。` : ''}
2. 按岗位协议完成：执行→submit；验收→review(accept/return)；自己定不了→report_blocker(to=owner)；只有花钱、签约、对外联系、公司方向和项目红线才 report_blocker(to=owner)。
   每完成一个有意义的阶段就 checkpoint（已完成、改动文件、下一步），每个任务最多 6 次——把多个进展合并写，纯保活用 heartbeat；返回 checkpoint_limit 就直接 submit 或 report_blocker。以 claim 返回的登记 worktree 为准；工程仅在授予 code 写权的 task 分支提交，禁止自行 checkout/reset/pull；checkpoint 前先提交。
3. 本轮只做这一项；完成交接后结束本轮，不要空转等待，不创建 agent 或定时器。
若领取返回 already_claimed、no_available_task 或 forbidden，直接结束本轮。`;
  return firstContact ? `${onboarding(inst, env)}\n\n${body}` : body;
}

/**
 * The dispatch message: which file says what to do, how to finish, and the one tool that hands the result in. Nothing
 * else — the requirement is in task.md (staged by the sidecar), the system enforces leases, worktrees and credentials.
 */
function briefWake(task: SupervisedTask, env: PromptEnv, ctx: PromptCtx): string {
  const dir = ctx.commDir ?? '$SCK_COMM_DIR';
  const sck = (name: string, args: string) => `'${env.sckBin}' call ${name} '${args}'`;
  const code = ctx.claim?.worktree?.intent.kind === 'code';
  if (task.state === 'review') {
    return `先查 ${dir}/task.md 的验收标准第 1 条：这一条写的是老板视角的结果，不成立就直接退回，其余各条不用再看；成立后再逐条复验其余标准。代码任务在最终合入提交上核对，不检查生产加载的版本。结论：${sck('review', '{"decision":"accept|return","text":"…","idempotencyKey":"…"}')}`;
  }
  const findings = latestFindings(ctx.claim?.history);
  if (findings) return `修复 ${dir}/${findings.file} 中的问题，在最终提交上按验收标准自验，合入 main 后：${sck('submit', '{"text":"…","idempotencyKey":"…"}')}`;
  const lead = code
    ? `实现 ${dir}/task.md 中的需求，在最终提交上按验收标准逐条自验，合入 main 后：`
    : `实现 ${dir}/task.md 中的需求，按验收标准逐条自验，全部通过后：`;
  return `${lead}${sck('submit', '{"text":"…","idempotencyKey":"…"}')}`;
}
