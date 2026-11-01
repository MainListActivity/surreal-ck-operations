import type { ClaimResult, WorktreeAssignment } from '../contracts.ts';
import type { EmployeeInst, SupervisedTask } from '../workforce.ts';
import type { BlockCode, DispatchVerdict } from './dispatch-blocked.ts';
import { latestFindings } from './brief.ts';

export interface PromptEnv { opsRepo: string; sckBin: string; paseoBin: string }

/** comm = 插件 sidecar 已代领任务、凭证不进 agent；否则为旧的凭证文件模式。 */
export interface PromptCtx { comm: boolean; claim?: ClaimResult; worktree?: WorktreeAssignment; commDir?: string; scratchDir?: string }

/** One manager todo as the dispatcher hands it to the gm prompt: a real action, its reason and the current version. */
export interface GmTodo {
  task: SupervisedTask;
  action: 'resume' | 'implementer_takeover';
  expectedVersion: number;
  reasonCode?: BlockCode;
  verdict?: DispatchVerdict;
}

const ROLE_NAMES: Record<string, string> = {
  gm: '经理：目标分级与拆解、处理运营定不了的事、G3 汇总',
  product: '运营/产品：范围提案、决定是否上线、运营验收',
  engineering: '工程：实现、代码复核、合入部署',
  'ai-content': 'AI 与内容',
  'concept-design': '原型/概念设计（内容产线 P 段）',
  'asset-production': '量产制作（内容产线 M 段）',
  screenwriter: '专职编剧：故事与剧本多轮打磨，只接编剧轨',
  'story-author': '长篇故事作者：从总纲到概要再到正文，只接原著轨，不接任何改编和制作',
  cinematography: '摄影摄像：运镜设计、镜头调度、摄影机运动语言，只接摄影轨',
  qa: '测试：上线后在生产环境逐条实测',
  cs: '客户成功',
  eval: '评审：任务完成后为参与员工打绩效分',
};

// comm 模式下命令表面不变——sck 走会话内的私有通道，凭证由通道持有，无需出示。
const tool = (inst: EmployeeInst, env: PromptEnv, comm: boolean) => comm
  ? `'${env.sckBin}' call <工具名> '<JSON参数>'`
  : `SCK_EMPLOYEE_CREDENTIAL_FILE='${inst.credentialFile ?? '<见岗位登记>'}' '${env.sckBin}' call <工具名> '<JSON参数>'`;

export function onboarding(inst: EmployeeInst, env: PromptEnv, comm = false, commDir = '$SCK_COMM_DIR'): string {
  const channel = comm
    ? `公司任务系统是唯一事实来源，调用方式：
  ${tool(inst, env, true)}
凭证与本会话绑定由通道持有，你不需要也不会看到它；工具结果从同一通道返回。
交付约定：把交付说明写入 ${commDir}/report.md 即视为提交评审（内容就是证据文本）。
checkpoint/report_blocker/review 的租约证明由通道自动补齐，只需传业务字段。
账号、workspace、成员、生产登录这类要凭证的事用运维工具 ops_*，先看当前项目能做什么：
  '${env.sckBin}' call ops_info '{}'
交付给老板看的文件用 deliverable_publish 发布：'${env.sckBin}' call deliverable_publish '{"files":["/绝对路径/a.png","/绝对路径/目录"]}'——复制进交付包并返回 http://<局域网IP>:18777/d/<任务ID>/… 可点链接，证据里贴这些 URL，本地路径不算交付。
密码和 token 只在通道里，不会交给你，也不要自己去找。`
    : `公司任务系统是唯一事实来源，调用方式：
  ${tool(inst, env, false)}
凭证文件只能以路径使用，禁止读取、打印或转述其内容。`;
  return `你是 Surreal CK AI 公司的员工，员工编号 ${inst.id}，岗位 ${inst.role}（${ROLE_NAMES[inst.role] ?? inst.role}）。
公司唯一真人是老板（用户本人）；其他同事都是 AI 员工。你被当作真实员工对待：对结果负责、证据真实、不越权。
公司运营仓库（协议与岗位说明只读）：${env.opsRepo}。工作目录以 claim.json 的 worktree 登记为准；不得自行新建/切换/reset/pull worktree，代码提交只在授予写权的任务分支。附件写 evidenceDir，不往运营共享 checkout 写交付物。
每次被唤醒，先读 ${env.opsRepo}/AGENTS.md、${env.opsRepo}/agents/PROTOCOL.md、${env.opsRepo}/agents/${inst.role}.md，所有 shell 命令按本机 RTK 规则执行。
${channel}`;
}

export function wake(inst: EmployeeInst, task: SupervisedTask, env: PromptEnv, firstContact: boolean, ctx?: PromptCtx): string {
  const mode = task.state === 'review' ? '独立验收' : task.row.handover ? '接手续做（前任会话已中断）' : '执行';
  if (ctx?.comm) return briefWake(task, env, ctx);
  const body = `【派工】任务 ${task.id}「${task.title}」需要你${mode}。
1. 领取：${tool(inst, env, false).replace('<工具名>', 'claim_next').replace('<JSON参数>', JSON.stringify({ taskId: task.id }))}
   返回的 history 包含前任进度、交接包、验收退回意见和老板决定，先完整阅读；如需更早记录用 get_task_history；返回 response_too_large 时加 {"pageSize":10}，再用 page.nextCursor 逐页翻页，超长证据用 read_task_text。凭证不交给员工，旧凭证文件模式也没有运维工具；需要账号或生产登录的工作 report_blocker to=gm 说明。${task.row.handover ? `
   返回的 predecessors 列出历任持有员工的 Paseo 会话；交接包只截取了最后几十条日志，需要更早或完整上下文时直接读前任完整时间线：
   '${env.paseoBin}' logs <agentId> --tail 400 --no-color（去掉 --tail 看全部）。` : ''}
2. 按岗位协议完成：执行→submit；验收→review(accept/return)；自己定不了→report_blocker(to=gm)；只有花钱、签约、对外联系、公司方向和项目红线才 report_blocker(to=owner)。
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
  const tree = ctx.claim?.worktree ?? ctx.worktree;
  const sck = (name: string, args: string) => `'${env.sckBin}' call ${name} '${args}'`;
  const lines = [`【派工】任务 ${task.id}`];
  if (tree) lines.push(`工作目录：${tree.worktreePath}${tree.branch ? `（分支 ${tree.branch}）` : ''}`);
  if (task.state === 'review') {
    lines.push(`按 ${dir}/task.md 复核交付。`,
      `结论用 ${sck('review', '{"decision":"accept|return","text":"…","idempotencyKey":"…"}')} 写入；return 时逐条写明问题与复现方式。`);
    return lines.join('\n');
  }
  const findings = latestFindings(ctx.claim?.history);
  lines.push(findings ? `修复 ${dir}/${findings.file} 中记录的问题（需求见 ${dir}/task.md）。` : `完成 ${dir}/task.md 中的需求。`);
  lines.push(tree?.intent.kind === 'code' ? '完成必要自测，提交并推送。' : '完成必要自查。');
  lines.push(`将结果与发布材料用 ${sck('submit', '{"text":"…","idempotencyKey":"…"}')} 写入。`);
  return lines.join('\n');
}

export function evalPrompt(inst: EmployeeInst, task: SupervisedTask, env: PromptEnv, firstContact: boolean, ctx?: PromptCtx): string {
  const call = tool(inst, env, ctx?.comm ?? false);
  const workspace = ctx?.worktree ? `只读登记工作区：${ctx.worktree.worktreePath}；mode=${ctx.worktree.mode}；branch=${ctx.worktree.branch}。${ctx.worktree.discipline}\n` : '';
  const body = `${workspace}【绩效评审】任务 ${task.id}「${task.title}」已完成，请为本轮所有参与员工打绩效分。
1. 读取任务与历史：
   ${call.replace('<工具名>', 'get_task_history').replace('<JSON参数>', JSON.stringify({ taskId: task.id }))}
   ${call.replace('<工具名>', 'get_context').replace('<JSON参数>', JSON.stringify({ taskId: task.id }))}
   若 get_task_history 返回 response_too_large，给同一参数加 {"pageSize":10}，再把返回的 page.nextCursor 作为 cursor 逐页读取，直到 page.hasMore 为 false；任务正文或超长证据用 read_task_text 分段读取。
   get_context 带 taskId 只读该任务，答复不含公司块（companyIncluded 为 false）；若返回 response_too_large，任务正文用 read_task_text 分段读取。需要公司方向、目标与项目时，按答复中的 companyRead 字段，用 {"scope":"company","pageSize":25} 分页读取，逐页用 page.nextCursor 作为 cursor 续读，直到 page.hasMore 为 false；不要为此改用 includeCompany。
   history 里出现的员工编号（claim/checkpoint/submit/review/revoked 的 actor 或 payload）即参与者；dispatcher、owner、gm-relay 不是员工，不评分。
   ${call.replace('<工具名>', 'get_model_evidence').replace('<JSON参数>', JSON.stringify({ taskId: task.id }))}
   ${call.replace('<工具名>', 'get_task_cost').replace('<JSON参数>', JSON.stringify({ taskId: task.id }))}
   返回本任务的 token、金额（USD）、模型耗时与从建单到验收的总时长，按员工拆分。
   get_model_evidence 返回每位参与者实际用过的模型集合（每个模型的调用次数、fence、阶段与首末时间），按 fence/phase 关联完整提交与退回历史；modelScores 须恰好覆盖该员工的集合。record_score 报错会直接写明缺哪些模型、哪个模型不属于该员工，照着改一次即可；禁止用 record_score 反复试探模型名，证据读不到就 report_blocker。任务最终验收后结算，返工中不结算。为每个实际参与模型提供 modelScores:[{model,overall,notes}]，区分返工责任和修复贡献；基础设施故障不扣模型质量，不按请求次数分配质量。同一模型整轮只记一次。
2. 先给任务本身的 complexity（1–5：1 是改一行、查一个事实；3 是一个模块内的完整改动；5 是跨模块、需要设计与多轮验证），按任务正文与实际改动判断，不按耗时或成本反推。
   再对每位参与者按 1–5 分打分（可以取 0.5 步进）：quality 交付质量、evidence 证据是否真实完整、discipline 流程纪律（是否及时 checkpoint、按协议操作、是否中断导致交接）、timeliness 推进效率，再加 overall 总分与 notes 评语。
   系统会在你的 overall 之上按规则校准：退回、租约收回、系统检查退回的提交各有扣分，作者还会按同复杂度任务的成本与时长中位数加减分；你看到的成本只用来评价效率，不要重复扣同一件事。被中断收回租约的员工 discipline/timeliness 应偏低；接手交接并完成好的员工可给高分。评审的是这一轮的行为，不看资历。你的评分会进入该员工定义的 avg_score，直接影响同类员工以后接到任务的概率，请客观。
3. 上报（scores 覆盖全部参与者，缺一不可；若确实没有参与者就传空数组）：
   ${call.replace('<工具名>', 'record_score').replace('<JSON参数>', `{"taskId":"${task.id}","summary":"<本轮一句话总结>","complexity":3,"scores":[{"employee":"<员工编号>","quality":4,"evidence":4,"discipline":4,"timeliness":4,"overall":4,"notes":"<评语>"}]}`)}
   调用成功（返回 recorded 数）即完成本轮，不要空转等待。`;
  return firstContact ? `${onboarding(inst, env, ctx?.comm ?? false, ctx?.commDir)}\n\n${body}` : body;
}

export function gmAttention(inst: EmployeeInst, todos: GmTodo[], env: PromptEnv, firstContact: boolean, ctx?: PromptCtx): string {
  const call = tool(inst, env, ctx?.comm ?? false);
  const list = todos.map(todo => {
    const task = todo.task;
    const reason = todo.verdict?.reasons.find(reason => reason.code === todo.reasonCode) ?? todo.verdict?.reasons[0];
    const detail = reason ? `原因：${reason.text}；依据：${reason.basis}；自 ${todo.verdict?.since ?? '未知'}；版本 v${todo.expectedVersion}。` : `版本 v${todo.expectedVersion}。`;
    const head = `- ${task.id}「${task.title}」（执行岗位 ${task.executorRole}${task.discipline ? `/${task.discipline}` : ''}）`;
    if (todo.action === 'implementer_takeover') {
      const dry = call.replace('<工具名>', 'contributor_dryrun').replace('<JSON参数>', JSON.stringify({ taskIds: [task.id] }));
      const take = call.replace('<工具名>', 'implementer_takeover').replace('<JSON参数>', JSON.stringify({ taskId: task.id, toEmployee: '<在岗工程员工>', expectedVersion: todo.expectedVersion, reason: '<接手原因>', idempotencyKey: '<唯一串>' }));
      const note = todo.reasonCode === 'implementer_unavailable'
        ? '系统会继续自动重试；你也可以提前核对并指定负责人。'
        : todo.reasonCode === 'implementer_quota'
          ? '额度恢复时间以任务卡或通知为准，未知时不得编造；不要换账号、换模型或降低额度门槛。可等待恢复，也可现在接手。'
          : '这是 ready 任务，不要调用 resume_task。';
      return `${head}\n  动作：先只读核对 ${dry}；再由你在在岗工程员工中选一名非作者、非复核人，调用 ${take}。${note}${detail}`;
    }
    return `${head}\n  动作：读 get_task_history，按阻塞原因协调（补充上下文、拆任务、调整依赖）后用 resume_task 恢复。${detail}`;
  }).join('\n');
  const workspace = ctx?.worktree ? `只读登记工作区：${ctx.worktree.worktreePath}；${ctx.worktree.discipline}\n` : '';
  const body = `${workspace}【经理待办】以下任务需要经理动作。经理动作通知不等于经理实际派工；ready 或在办无人的工程任务用 implementer_takeover，状态 blocked 的任务才用 resume_task。
${list}
逐个用 get_task_history 读取阻塞原因（返回 response_too_large 时加 pageSize，按 page.nextCursor 翻页），协调解决（补充上下文、拆出新任务 create_task、调整依赖）后用 resume_task 恢复。
你有决定权：技术方案、拆分、上线（运营定不了时）、查得到的事实都由你决定并写进恢复说明，不要转给老板。
只有花钱、签约、对外联系、公司方向和项目红线才让原员工 report_blocker(to=owner)，并写明你已查过哪些来源。处理完结束本轮。
调用方式：${call}`;
  return firstContact ? `${onboarding(inst, env, ctx?.comm ?? false, ctx?.commDir)}\n\n${body}` : body;
}

export function gmTriage(inst: EmployeeInst, goals: Array<{ id: string; title: string; brief: string }>, env: PromptEnv, firstContact: boolean, ctx?: PromptCtx): string {
  const list = goals.map(g => `- goal=${g.id}「${g.title}」\n  ${g.brief.slice(0, 600).replace(/\n/g, '\n  ')}`).join('\n');
  const workspace = ctx?.worktree ? `只读登记工作区：${ctx.worktree.worktreePath}；${ctx.worktree.discipline}\n` : '';
  const body = `${workspace}【目标分级】以下老板目标还没有选定流程（Jev 没有把握或未配置）：
${list}
逐个判断并调用 triage_goal({goalId, tier, reason})：
- quick：单一仓库内范围明确的小改动或缺陷修复。流程是 实现 → 上线申请 → 合入部署与生产实测 → 运营验收，完成即记录结果，不通知老板。
- standard：方向清楚但需要多个交付项；你来拆解，运营验收后交老板 G3。
- program：方向性大目标；运营先写范围提案，再由你拆解，最后老板 G3。
拿不准时选更轻的一级。处理完结束本轮。
调用方式：${tool(inst, env, ctx?.comm ?? false)}`;
  return firstContact ? `${onboarding(inst, env, ctx?.comm ?? false, ctx?.commDir)}\n\n${body}` : body;
}
