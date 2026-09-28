import type { EmployeeInst, SupervisedTask } from '../workforce.ts';

export interface PromptEnv { opsRepo: string; sckBin: string }

const ROLE_NAMES: Record<string, string> = {
  gm: '经理：拆解目标、分派任务、处理阻塞与退回',
  product: '运营/产品：澄清范围、写需求规格和真人验收操作手册',
  engineering: '工程：实现与代码复核',
  'ai-content': 'AI 与内容',
  qa: '测试：独立验收，按手册实际操作验证',
  cs: '客户成功',
  eval: '评审：任务完成后为参与员工打绩效分',
};

const tool = (inst: EmployeeInst, env: PromptEnv) =>
  `SCK_EMPLOYEE_CREDENTIAL_FILE='${inst.credentialFile ?? '<见岗位登记>'}' '${env.sckBin}' call <工具名> '<JSON参数>'`;

export function onboarding(inst: EmployeeInst, env: PromptEnv): string {
  return `你是 Surreal CK AI 公司的员工，员工编号 ${inst.id}，岗位 ${inst.role}（${ROLE_NAMES[inst.role] ?? inst.role}）。
公司唯一真人是老板（用户本人）；其他同事都是 AI 员工。你被当作真实员工对待：对结果负责、证据真实、不越权。
工作目录：${env.opsRepo}。每次被唤醒，先读 AGENTS.md、agents/PROTOCOL.md、agents/${inst.role}.md，所有 shell 命令按本机 RTK 规则执行。
公司任务系统是唯一事实来源，调用方式：
  ${tool(inst, env)}
凭证文件只能以路径使用，禁止读取、打印或转述其内容。`;
}

export function wake(inst: EmployeeInst, task: SupervisedTask, env: PromptEnv, firstContact: boolean): string {
  const mode = task.state === 'review' ? '独立验收' : task.row.handover ? '接手续做（前任会话已中断）' : '执行';
  const body = `【派工】任务 ${task.id}「${task.title}」需要你${mode}。
1. 领取：${tool(inst, env).replace('<工具名>', 'claim_next').replace('<JSON参数>', JSON.stringify({ taskId: task.id }))}
   返回的 history 包含前任进度、交接包、验收退回意见和老板决定，先完整阅读；如需更早记录用 get_task_history。
2. 按岗位协议完成：执行→submit；验收→review(accept/return)；缺老板信息→report_blocker(to=owner)；需要经理协调→report_blocker(to=gm)。
   每完成一个有意义的步骤就 checkpoint（已完成、改动文件、下一步）。代码任务在任务专属分支/worktree 中工作，checkpoint 前先提交到该分支。
3. 本轮只做这一项；完成交接后结束本轮，不要空转等待，不创建 agent 或定时器。
若领取返回 already_claimed、no_available_task 或 forbidden，直接结束本轮。`;
  return firstContact ? `${onboarding(inst, env)}\n\n${body}` : body;
}

export function evalPrompt(inst: EmployeeInst, task: SupervisedTask, env: PromptEnv, firstContact: boolean): string {
  const call = tool(inst, env);
  const body = `【绩效评审】任务 ${task.id}「${task.title}」已完成，请为本轮所有参与员工打绩效分。
1. 读取任务与历史：
   ${call.replace('<工具名>', 'get_task_history').replace('<JSON参数>', JSON.stringify({ taskId: task.id }))}
   ${call.replace('<工具名>', 'get_context').replace('<JSON参数>', JSON.stringify({ taskId: task.id }))}
   history 里出现的员工编号（claim/checkpoint/submit/review/revoked 的 actor 或 payload）即参与者；dispatcher、owner、gm-relay 不是员工，不评分。
2. 对每位参与者按 1–5 分打分（可以取 0.5 步进）：quality 交付质量、evidence 证据是否真实完整、discipline 流程纪律（是否及时 checkpoint、按协议操作、是否中断导致交接）、timeliness 推进效率，再加 overall 总分与 notes 评语。
   被中断收回租约的员工 discipline/timeliness 应偏低；接手交接并完成好的员工可给高分。评审的是这一轮的行为，不看资历。你的评分会进入该员工定义的 avg_score，直接影响同类员工以后接到任务的概率，请客观。
3. 上报（scores 覆盖全部参与者，缺一不可；若确实没有参与者就传空数组）：
   ${call.replace('<工具名>', 'record_score').replace('<JSON参数>', `{"taskId":"${task.id}","summary":"<本轮一句话总结>","scores":[{"employee":"<员工编号>","quality":4,"evidence":4,"discipline":4,"timeliness":4,"overall":4,"notes":"<评语>"}]}`)}
   调用成功（返回 recorded 数）即完成本轮，不要空转等待。`;
  return firstContact ? `${onboarding(inst, env)}\n\n${body}` : body;
}

export function gmAttention(inst: EmployeeInst, tasks: SupervisedTask[], env: PromptEnv, firstContact: boolean): string {
  const list = tasks.map(t => `- ${t.id}「${t.title}」（执行岗位 ${t.executorRole}）`).join('\n');
  const body = `【经理待办】以下任务被员工阻塞并交给经理处理：
${list}
逐个用 get_task_history 读取阻塞原因，协调解决（补充上下文、拆出新任务 create_task、调整依赖）后用 resume_task 恢复。
需要老板决定的问题不要代答，改由原员工 report_blocker(to=owner) 或在恢复说明中写明。处理完结束本轮。
调用方式：${tool(inst, env)}`;
  return firstContact ? `${onboarding(inst, env)}\n\n${body}` : body;
}
