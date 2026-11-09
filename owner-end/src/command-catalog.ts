/**
 * 老板端命令目录：每条命令的中文用途与参数说明。员工的 company_cmd_catalog（网关 cmd.catalog 按身份过滤后返回）
 * 与老板端运维页的命令面板共用这一份，改说明只改这里。
 * 纯数据，不引入任何服务端模块：前端会把它打包进页面。参数名与网关 input 的字段一致；可选参数以 ? 标记。
 * tests/command-catalog.test.ts 核对：目录与网关实际可调用的命令一一对应。
 */

export type CommandGroup =
  | '看板与状态'
  | '任务'
  | '决策与消息'
  | '笔记'
  | '路由'
  | '员工与权限'
  | '身份与云端'
  | '数据与审计'
  | '主机与发布'
  | '翻译';

export interface CommandSpec {
  command: string;
  group: CommandGroup;
  /** 一句话中文用途。 */
  title: string;
  /** 参数：必填直接写名字，可选加 ?；没有参数写“无”。 */
  params: string;
  /** 高危：可能改变生产、主机或外部状态，或替老板作决定。员工调用前，老板应确认是否加入保护清单。 */
  risk?: 'high';
  /** 由执行端完成：网关排队为作业，最多等 25 秒，超时返回 pending。 */
  runner?: true;
  /** 只读，不改变状态。 */
  readOnly?: true;
}

type Flags = Pick<CommandSpec, 'risk' | 'runner' | 'readOnly'>;

const c = (command: string, group: CommandGroup, title: string, params: string, flags: Flags = {}): CommandSpec =>
  ({ command, group, title, params, ...flags });

export const COMMAND_CATALOG: readonly CommandSpec[] = [
  c('status', '看板与状态', '公司状态摘要（任务数、是否暂停、草稿数）', '无', { readOnly: true }),
  c('progress', '看板与状态', '公司进度概览', '无', { readOnly: true }),
  c('brief', '看板与状态', '老板简报', '无', { readOnly: true }),
  c('board.snapshot', '看板与状态', '老板看板快照（线、卡片与待发消息）', 'now?', { readOnly: true }),
  c('cmd.catalog', '看板与状态', '列出可调用的命令（员工只看到自己能用的）', '无', { readOnly: true }),

  c('task.list', '任务', '最近 300 个任务', '无', { readOnly: true }),
  c('task.detail', '任务', '任务详情、审计记录与消息', 'taskId', { readOnly: true }),
  c('task.plan', '任务', '任务所在的整条链（父子任务与消息）', 'taskId', { readOnly: true }),
  c('task.cost', '任务', '任务成本；不带 taskId 时看近期成本', 'taskId?, days?', { readOnly: true }),
  c('task.create', '任务', '新建任务（由执行端签发）', 'title, requirement, acceptanceText, type?, executorRole?, reviewerRole?, parent?, project?, tag?, discipline?, codeRepoPath?, workIntent?, acceptanceCriteria?, hold?', { runner: true }),
  c('task.update', '任务', '修改任务的标题、需求或验收文本', 'taskId, title?, requirement?, acceptanceText?'),
  c('task.reassign', '任务', '改派执行或复核角色', 'taskId, executorRole?, reviewerRole?, note'),
  c('task.revoke', '任务', '终止在途执行（收回当前租约）', 'taskId, note?'),
  c('task.void', '任务', '作废任务', 'taskId, note'),
  c('task.delete', '任务', '删除（退役）任务', 'taskId, note'),
  c('task.pause', '任务', '暂停全部派工', '无'),
  c('task.resume', '任务', '恢复派工', '无'),

  c('decide', '决策与消息', '对任务作决定（decision 为 approve、reject 或 reply）', 'taskId, decision, note?', { risk: 'high' }),
  c('approve', '决策与消息', '通过（验收或决定）', 'taskId, note?', { risk: 'high' }),
  c('reject', '决策与消息', '驳回', 'taskId, note', { risk: 'high' }),
  c('reply', '决策与消息', '回复任务', 'taskId, note'),
  c('inbox', '决策与消息', '老板收件箱（待决定与提示）', '无', { readOnly: true }),
  c('notice.list', '决策与消息', '未处理的提示', '无', { readOnly: true }),
  c('notice.resolve', '决策与消息', '标记提示已处理', 'key'),
  c('instruct', '决策与消息', '向员工下达老板指示', 'text', { risk: 'high' }),
  c('direction.add', '决策与消息', '记入公司方向', 'text', { risk: 'high' }),
  c('message.list', '决策与消息', '待发消息（可按任务筛选）', 'taskId?, includeSent?', { readOnly: true }),
  c('message.records', '决策与消息', '已发送消息记录', '无', { readOnly: true }),
  c('message.edit', '决策与消息', '修改待发消息的正文', 'messageId, body'),
  c('message.edit_rendered', '决策与消息', '按员工看到的样子修改待发消息', 'messageId, employeeId, rendered'),
  c('message.hold', '决策与消息', '暂存待发消息', 'messageId'),
  c('message.release', '决策与消息', '放行待发消息（取消暂存）', 'messageId', { risk: 'high' }),
  c('message.send', '决策与消息', '放行消息，由调度器下一轮派工', 'messageId', { risk: 'high' }),

  c('note.list', '笔记', '列出笔记（可按线筛选）', 'lane?', { readOnly: true }),
  c('note.preview', '笔记', '预览某条线的笔记正文', 'lane', { readOnly: true }),
  c('note.add', '笔记', '添加笔记', 'lane, text, pinned?, proposed?'),
  c('note.edit', '笔记', '修改笔记', 'noteId, text'),
  c('note.pin', '笔记', '置顶或取消置顶', 'noteId, pinned'),
  c('note.activate', '笔记', '启用待定笔记', 'noteId'),
  c('note.remove', '笔记', '删除笔记', 'noteId'),
  c('note.consolidate', '笔记', '合并整理笔记（dryRun 只预览）', 'lane?, dryRun?'),
  c('note.consolidations', '笔记', '整理记录', 'limit?', { readOnly: true }),
  c('note.consolidation.undo', '笔记', '撤销一次整理', 'id'),

  c('route.list', '路由', '任务路由（任务类型）列表', '无', { readOnly: true }),
  c('route.save', '路由', '新增或修改任务路由', 'type, label, executorRole, reviewerRole, code?, executeBody?, reviewBody?, next?, hold?', { risk: 'high' }),
  c('route.disable', '路由', '停用任务路由', 'type', { risk: 'high' }),

  c('agent.list', '员工与权限', '员工列表', '无', { readOnly: true }),
  c('agent.policy.list', '员工与权限', '员工策略列表', '无', { readOnly: true }),
  c('agent.policy.set', '员工与权限', '设置员工策略（停用、允许、禁止、语言）', 'agent, disabled?, allow?, deny?, lang?'),
  c('guard.list', '员工与权限', '保护清单与锁定说明', '无', { readOnly: true }),
  c('guard.protect', '员工与权限', '把命令加入保护清单（ownerOnly 缺省为仅老板可调用）', 'command, ownerOnly?'),
  c('guard.set', '员工与权限', '同 guard.protect（别名）', 'command, ownerOnly?'),
  c('guard.unprotect', '员工与权限', '移出保护清单', 'command'),
  c('def.list', '员工与权限', '员工定义（能力）列表', '无', { readOnly: true }),
  c('def.ensure', '员工与权限', '新建或修改员工定义', 'id, role, provider, model, thinking?, maxInstances?, priority?, weight?, enabled?'),
  c('def.enable', '员工与权限', '启用员工定义', 'id'),
  c('def.disable', '员工与权限', '停用员工定义', 'id, reason?'),
  c('session.policy', '员工与权限', '读取或设置会话策略（reuse 或 oneshot）', 'policy?'),

  c('idp.status', '身份与云端', '身份服务状态', '无', { readOnly: true }),
  c('idp.user.list_agents', '身份与云端', '员工身份用户列表', '无', { readOnly: true }),
  c('idp.tenant.create', '身份与云端', '开通身份租户', 'slug, displayName', { risk: 'high' }),
  c('idp.client.ensure', '身份与云端', '确保客户端存在（按角色）', 'role, clientName?, ttlSeconds?', { risk: 'high' }),
  c('idp.client.create', '身份与云端', '新建客户端（按角色）', 'role, clientName?, ttlSeconds?', { risk: 'high' }),
  c('idp.client.reset', '身份与云端', '重置客户端', 'clientId', { risk: 'high' }),
  c('idp.client.reset_secret', '身份与云端', '重置客户端密钥', 'clientId', { risk: 'high' }),
  c('idp.client.claims.set', '身份与云端', '设置客户端的角色声明', 'clientId, role', { risk: 'high' }),
  c('idp.request', '身份与云端', '调用身份服务管理接口（path 以 /admin/ 开头）', 'method, path, body?', { risk: 'high' }),
  c('agent.identity.ensure', '身份与云端', '确保员工身份用户存在', 'employee, displayName?'),
  c('agent.create', '身份与云端', '同 agent.identity.ensure（别名）', 'employee, displayName?'),
  c('cf.api', '身份与云端', '调用 Cloudflare 接口（path 以 /accounts/<账号>/ 开头）', 'method, path, body?', { risk: 'high' }),

  c('db.read', '数据与审计', '只读查询（单条 SELECT）', 'sql, vars?', { readOnly: true }),
  c('db.write', '数据与审计', '任意写入（SurrealQL）', 'sql, vars?', { risk: 'high' }),
  c('ops.job.list', '数据与审计', '执行端作业列表', 'state?, limit?', { readOnly: true }),
  c('ops.job.get', '数据与审计', '执行端作业详情', 'id', { readOnly: true }),
  c('audit.list', '数据与审计', '审计记录（可按员工、任务、命令筛选）', 'limit?, agent?, task?, command?', { readOnly: true }),

  c('host.exec', '主机与发布', '在主机上执行命令（以受限用户身份）', 'host, command, timeoutSec?', { risk: 'high', runner: true }),

  c('translate.preview', '翻译', '预览译文', 'lang, text', { readOnly: true }),
  c('translate.message', '翻译', '为待发消息补译（lang 为 null 时清除）', 'messageId, lang'),
];
