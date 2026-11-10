// 纯数据模块：设计模式不导入数据库、Worker、执行器或凭证模块。
export type Row = Record<string, any>;
export interface Snapshot {
  format: 'sck-owner-design-v1';
  source: 'synthetic' | 'sanitized-production';
  exportedAt: string;
  products: Row[]; requirements: Row[]; feedback: Row[]; tasks: Row[]; agents: Row[]; notes: Row[];
  /** 仅本地设计案例使用：按需求编号给出执行记录（stage、计划与任务编号）。生产快照不含此字段。 */
  executions?: Record<string, Row>;
  /** 仅本地设计案例使用：按产品编号给出产品策略。 */
  policies?: Record<string, Row>;
}
export const requirementStates = ['draft','pending','queued','implementing','release_pending','released','paused','rejected','merged'];
export const policy = () => ({enabled:true, autoRelease:true, feedbackOrigins:['https://example.invalid'], releaseInstructions:'演示：PR 合并后由 GitHub 自动部署',verifyInstructions:'演示：检查页面',rollbackInstructions:'演示：恢复上一版本'});
export function seed(): Snapshot {
  const at = new Date().toISOString();
  return {
    format:'sck-owner-design-v1', source:'synthetic', exportedAt:at,
    products:[{id:'product-1',name:'客户工作台'},{id:'product-2',name:'内容管理产品'},{id:'product-3',name:'新产品（空状态）'}],
    requirements:requirementStates.map((state,i)=>({id:`req-${i+1}`,project:`product-${i%2+1}`,title:['支持按状态筛选需求','移动端反馈入口不易发现','改进长内容阅读体验','统一任务进度展示','增加导出结果提示','优化反馈提交速度','完善跨产品搜索','调整通知频率','归并相似反馈'][i],problem:'用户在不同页面查看进度时，需要重复切换。希望在一个位置看到当前状态和下一步操作。\n这是一段用于评估多行内容布局的示例。',acceptance:'桌面与窄屏均可完成操作；空状态、加载、成功和失败提示清晰。',priority:i%4,revision:i%3+1,state,created_at:at,updated_at:at})),
    tasks:['ready','doing','review','blocked','done','void'].map((state,i)=>({id:`task-${i+1}`,title:['核对需求范围','实现反馈组件','复核移动端交互','等待发布配置','验证上线结果','取消重复任务'][i],state,project:`product-${i%2+1}`,executor_role:i%2?'engineering':'product',reviewer_role:'qa',requirement:'本地示例任务，不会触发 agent。',acceptanceText:'检查页面状态及交互反馈。'})),
    feedback:['new','processing','linked','dismissed','failed'].map((state,i)=>({id:`feedback-${i+1}`,project:`product-${i%2+1}`,state,category:i%2?'feature':'bug',body:{text:['反馈按钮在手机上被遮挡','希望保存最近使用的筛选条件','切换产品后希望保持列表位置','测试留言，无需处理','提交失败时需要明确的重试入口'][i],page:'https://example.invalid/settings',version:'1.2.0',contact:i===2?'designer@example.invalid':''},reason:'演示整理理由：保留问题和可验证的验收条件。',...(state==='linked'?{requirement:'req-2'}:{})})),
    agents:['product','engineering','qa'].map((role,i)=>({employee:`agent-${i+1}`,name:['产品员工','工程员工','验收员工'][i],role,idpUser:`demo-identity-${i+1}`,policy:{disabled:i===2,allow:null,deny:[],lang:i===1?'en':null}})),
    notes:['active','proposed','removed'].map((state,i)=>({id:`note-${i+1}`,lane:i%2?'product':'company',text:['需求确认前补齐验收标准。','移动端交互需要覆盖窄屏布局。','这是一条已移除的历史笔记。'][i],state,pinned:i===0,author:'示例员工',updatedAt:at})),
  };
}
const rows = (v:unknown): Row[] => Array.isArray(v) ? v.filter(x=>x&&typeof x==='object').slice(0,10000) : [];
const choice = (v:unknown, allowed:string[], fallback:string) => allowed.includes(String(v)) ? String(v) : fallback;
/** 严格白名单：自由文本全部替换，真实 ID 统一映射；不导出正文、联系方式、URL、凭证或路径。 */
export function sanitize(raw: Partial<Snapshot>): Snapshot {
  const projects=rows(raw.products), tasks=rows(raw.tasks), reqs=rows(raw.requirements), agents=rows(raw.agents);
  const ids=new Map<string,string>();
  const normalized=(value:unknown)=>String(value&&typeof value==='object'&&'id' in value?(value as Row).id:value).replace(/^[a-z_]+:/,'').replace(/^⟨|⟩$/g,'');
  const map=(kind:string, list:Row[], key='id')=>list.forEach((r,i)=>ids.set(`${kind}:${normalized(r[key])}`,`${kind}-${i+1}`));
  map('product',projects);map('task',tasks);map('req',reqs);map('agent',agents,'employee');map('feedback',rows(raw.feedback));
  const id=(kind:string,value:unknown)=>ids.get(`${kind}:${normalized(value)}`);
  const roles=['product','engineering','qa','owner','research','operations'];
  const result:Snapshot={format:'sck-owner-design-v1',source:'sanitized-production',exportedAt:new Date().toISOString(),
    products:projects.map((p,i)=>({id:id('product',p.id),name:`产品 ${i+1}`})),
    requirements:reqs.map((r,i)=>({id:id('req',r.id),project:id('product',r.project)??'product-1',title:`需求 ${i+1}：改进产品使用体验`,problem:'此处为脱敏后的问题描述。'.repeat(Math.min(12,Math.max(1,Math.ceil(String(r.problem??'').length/20)))),acceptance:'按步骤核对用户可见行为，并记录验证结果。',state:choice(r.state,requirementStates,'pending'),priority:[0,1,2,3].includes(r.priority)?r.priority:2,revision:Number.isSafeInteger(r.revision)&&r.revision>0?r.revision:1,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),...(id('task',r.root_task)?{root_task:id('task',r.root_task)}:{})})),
    tasks:tasks.map((t,i)=>({id:id('task',t.id),title:`执行任务 ${i+1}`,project:id('product',t.project),state:choice(t.state,['ready','doing','review','blocked','done','void'],'ready'),executor_role:choice(t.executor_role,roles,'engineering'),reviewer_role:choice(t.reviewer_role,roles,'qa'),requirement:'已替换的任务说明',acceptanceText:'已替换的验收标准',...(id('task',t.parent)?{parent:id('task',t.parent)}:{})})),
    feedback:rows(raw.feedback).map((f,i)=>({id:id('feedback',f.id),project:id('product',f.project)??'product-1',state:choice(f.state,['new','processing','linked','dismissed','failed'],'new'),category:choice(f.category,['bug','feature','question','noise'],'feature'),body:{text:`用户反馈 ${i+1}：希望改进当前页面的交互体验。`,contact:'',page:'https://example.invalid/feedback',version:'演示版本'},reason:'反馈已脱敏，保留分类和关联状态。',...(id('req',f.requirement)?{requirement:id('req',f.requirement)}:{})})),
    agents:agents.map((a,i)=>({employee:id('agent',a.employee),name:`员工 ${i+1}`,role:choice(a.role,roles,'engineering'),policy:{disabled:a.policy?.disabled===true,allow:null,deny:[],lang:['en','zh','ja'].includes(a.policy?.lang)?a.policy.lang:null}})),
    notes:rows(raw.notes).map((n,i)=>({id:`note-${i+1}`,lane:'company',text:`笔记 ${i+1}：已替换原文，用于评估列表和编辑交互。`,state:choice(n.state,['active','proposed','removed'],'active'),pinned:n.pinned===true,author:'示例员工',updatedAt:new Date().toISOString()})),
  };
  return result;
}
export function parseSnapshot(value:unknown): Snapshot {
  if(!value||typeof value!=='object'||(value as Row).format!=='sck-owner-design-v1')throw Error('快照格式不支持，请使用设计快照导出工具。');
  for(const key of ['products','requirements','feedback','tasks','agents','notes'])if(!Array.isArray((value as Row)[key])||(value as Row)[key].length>10000)throw Error(`快照 ${key} 无效或超过 10000 条。`);
  return sanitize(value as Snapshot);
}

/** 本地设计案例的统一前缀。界面与数据中都可见，避免被误认为生产记录。 */
export const DESIGN_TAG = '【设计案例】';

/**
 * 在快照之上追加明确标注的本地设计案例，覆盖生产快照缺少的状态：长内容、多条记录、空产品、规划失败、执行受阻、
 * 待确认、实施中、待发布（三种阶段）、已上线、已暂停、已拒绝、已归并。不修改传入的快照。
 */
export function withDesignCases(base: Snapshot, now = Date.now()): Snapshot {
  const data: Snapshot = structuredClone(base);
  const T = DESIGN_TAG;
  // 只补已有业务岗位的设计案例，不按参考图虚构构建或部署岗位。
  for (const [role, name] of [['product','产品员工'],['engineering','工程员工'],['qa','验收员工']]) {
    if (!data.agents.some(a => a.role === role && !a.policy?.disabled)) data.agents.push({
      employee: `design-agent-${role}`, name: `${T}${name}`, role, policy: {disabled:false,allow:null,deny:[],lang:null},
    });
  }
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const A = 'design-workspace', B = 'design-content', E = 'design-empty';
  data.products.push({ id: A, name: `${T}客户工作台` }, { id: B, name: `${T}内容平台` }, { id: E, name: `${T}新产品（暂无需求）` });
  const longProblem = [
    '客户成功团队反馈：客户在工作台里查看订单、工单和账单时，需要在三个页面之间反复切换，每次切换都会丢失筛选条件。',
    '高频用户（每天处理 50 单以上）平均每单多花 40 秒，周一上午高峰时段经常有人在群里问“刚才那个筛选怎么又没了”。',
    '',
    '希望做到：',
    '1. 在一个页面里按客户聚合查看订单、工单、账单的最新状态；',
    '2. 筛选条件在页面之间保持，刷新后仍然保留；',
    '3. 移动端也能完成最常见的三个操作：查看状态、催办、备注。',
    '',
    '这是一段用于检验长文本排版的本地设计案例，内容为虚构，不对应任何真实客户。',
  ].join('\n');
  const acceptance6 = [
    '按客户聚合后，订单、工单、账单三类记录在同一页面展示，且各自显示最新状态',
    '在任一列表设置筛选后切换页面，再返回时筛选条件保持不变',
    '刷新浏览器后筛选条件仍然保留，清除筛选按钮可一键恢复默认',
    '390px 宽的手机上可以完成查看状态、催办、备注三个操作，按钮不被遮挡',
    '列表在 1000 条记录时首屏 2 秒内可交互',
    '空状态、加载、失败重试三种状态都有明确提示',
  ].join('\n');
  const req = (i: number, project: string, state: string, title: string, extra: Row = {}): Row => ({
    id: `design-req-${i}`, project, state, title: `${T}${title}`,
    problem: extra.problem ?? `${title}。这是用于预览界面状态的本地虚构内容。`,
    acceptance: extra.acceptance ?? '主要流程在桌面与窄屏均可完成\n加载、空状态、成功与失败提示清晰',
    priority: extra.priority ?? 2, revision: extra.revision ?? 1,
    created_at: ago(60 * 24 * (i + 2)), updated_at: ago(extra.updatedMinutes ?? i * 37),
    ...(['queued', 'implementing', 'release_pending', 'released', 'paused'].includes(state) ? { approved_revision: extra.revision ?? 1 } : {}),
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['problem', 'acceptance', 'priority', 'revision', 'updatedMinutes'].includes(k))),
  });
  const reqs: Row[] = [
    req(1, A, 'pending', '客户工作台把订单、工单和账单合并到一个视图，并在页面之间保持筛选条件，减少高频用户每天的重复切换', { problem: longProblem, acceptance: acceptance6, priority: 1, revision: 3, updatedMinutes: 12 }),
    req(2, A, 'draft', '移动端反馈入口被底部导航遮挡', { acceptance: '', priority: 2, updatedMinutes: 30 }),
    req(3, B, 'pending', '导出失败时没有任何提示', { priority: 0, updatedMinutes: 5 }),
    req(4, A, 'queued', '账单页支持按开票状态筛选', { planning_error: '规划失败：模型返回的计划缺少可验收的步骤，已重试 3 次（本地模拟）', updatedMinutes: 45 }),
    req(5, B, 'queued', '文章编辑器自动保存草稿', { updatedMinutes: 3 }),
    req(6, A, 'implementing', '工单列表支持批量指派', { revision: 2, priority: 1, root_task: 'design-task-6-1', updatedMinutes: 8 }),
    req(7, B, 'implementing', '素材库上传大文件时显示进度', { root_task: 'design-task-7-1', updatedMinutes: 20 }),
    req(8, A, 'release_pending', '客户详情页显示最近 30 天的联系记录', { root_task: 'design-task-8-1', updatedMinutes: 15 }),
    req(9, B, 'release_pending', '评论区支持按热度排序', { root_task: 'design-task-9-1', updatedMinutes: 50 }),
    req(10, B, 'release_pending', '首页推荐位支持定时上下线', { root_task: 'design-task-10-1', updatedMinutes: 70 }),
    req(11, A, 'released', '登录页支持记住上次使用的账号', { root_task: 'design-task-11-1', updatedMinutes: 60 * 26 }),
    req(12, B, 'released', '文章列表加载速度优化', { root_task: 'design-task-12-1', updatedMinutes: 60 * 50 }),
    req(13, A, 'paused', '通知中心按类型分组', { paused_from: 'implementing', root_task: 'design-task-13-1', updatedMinutes: 90 }),
    req(14, B, 'rejected', '首页增加天气组件', { priority: 3, updatedMinutes: 60 * 72 }),
    req(15, A, 'merged', '订单页也希望保留筛选条件', { priority: 2, updatedMinutes: 60 * 30 }),
    req(16, A, 'pending', '设置页的保存按钮在长表单底部不易发现', { priority: 3, updatedMinutes: 140 }),
  ];
  data.requirements.push(...reqs);

  const task = (id: string, title: string, state: string, executor = 'engineering', reviewer = 'qa', extra: Row = {}): Row => ({
    id, title: `${T}${title}`, state, executor_role: executor, reviewer_role: reviewer, project: extra.project ?? A,
    requirement: extra.requirement ?? `${title}。本地设计案例任务，不会触发任何员工。`,
    acceptanceText: extra.acceptanceText ?? '按需求的验收标准逐条核对，并附上截图或录屏。',
    ...(extra.parent ? { parent: extra.parent } : {}),
  });
  const plan = (titles: string[]) => ({ steps: titles.map(t => ({ title: t, context: `${t}（本地设计案例计划）`, acceptance: '满足对应的验收标准条目' })) });
  const execs: Record<string, Row> = {};
  const add = (reqId: string, stage: string, note: string, tasks: Row[], extra: Row = {}) => {
    data.tasks.push(...tasks);
    execs[reqId] = { execution: { stage, note, ...extra }, plan: plan(tasks.map(t => String(t.title).replace(T, ''))), tasks: tasks.map(t => t.id) };
  };
  add('design-req-6', 'running', '任务 design-task-6-3：doing', [
    task('design-task-6-1', '梳理批量指派的交互方案', 'done', 'product', 'qa'),
    task('design-task-6-2', '实现批量选择与指派接口', 'done'),
    task('design-task-6-3', '实现批量指派界面', 'doing'),
    task('design-task-6-4', '回归验收工单列表', 'ready', 'qa', 'product'),
  ]);
  add('design-req-7', 'blocked', '任务 design-task-7-2：blocked。对象存储的分片上传配额不足，需要老板确认是否扩容（本地模拟）', [
    task('design-task-7-1', '设计上传进度条', 'done', 'concept-design', 'product', { project: B }),
    task('design-task-7-2', '接入分片上传', 'blocked', 'engineering', 'qa', { project: B }),
    task('design-task-7-3', '大文件上传验收', 'planned', 'qa', 'engineering', { project: B }),
  ]);
  add('design-req-8', 'verifying', '【本地模拟】独立复核通过，工程员工正在合并 PR 并核验 GitHub 自动部署', [
    task('design-task-8-1', '联系记录接口', 'done'),
    task('design-task-8-2', '客户详情页展示', 'done'),
    task('design-task-8-3', '合并 PR 与上线核验', 'doing'),
  ]);
  add('design-req-9', 'blocked', '【本地模拟】GitHub 必需检查失败，已停止合并，工程员工正在处理', [
    task('design-task-9-1', '热度排序算法', 'done', 'engineering', 'qa', { project: B }),
    task('design-task-9-2', '排序切换界面', 'blocked', 'engineering', 'qa', { project: B }),
  ]);
  add('design-req-10', 'awaiting_evidence', '等待同一提交的 GitHub 生产部署证据或独立 QA 线上验收', [
    task('design-task-10-1', '定时上下线配置', 'done', 'engineering', 'qa', { project: B }),
    task('design-task-10-2', '核验 GitHub 自动部署与线上效果', 'review', 'engineering', 'qa', { project: B }),
  ]);
  add('design-req-11', 'released', '部署证据、独立复核与上线回归均已完成', [
    task('design-task-11-1', '记住账号功能', 'done'),
    task('design-task-11-2', '登录页验收', 'done', 'qa', 'product'),
    task('design-task-11-3', '合并 PR 与上线核验', 'done'),
  ], { released_sha: 'a1b2c3d' });
  add('design-req-12', 'released', '部署证据、独立复核与上线回归均已完成', [
    task('design-task-12-1', '列表分页与缓存', 'done', 'engineering', 'qa', { project: B }),
    task('design-task-12-2', '性能回归', 'done', 'qa', 'engineering', { project: B }),
  ], { released_sha: '9f8e7d6' });
  add('design-req-13', 'running', '已暂停：当前步骤完成后不再推进', [
    task('design-task-13-1', '通知分组方案', 'done', 'product', 'qa'),
    task('design-task-13-2', '分组展示实现', 'ready'),
  ]);
  data.executions = { ...(data.executions ?? {}), ...execs };

  const fb = (i: number, project: string, state: string, text: string, extra: Row = {}): Row => ({
    id: `design-feedback-${i}`, project, state, category: extra.category ?? 'feature',
    body: { text: `${T}${text}`, page: 'https://example.invalid/app', version: '2.4.0', contact: extra.contact ?? '' },
    ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.requirement ? { requirement: extra.requirement } : {}), ...(extra.last_error ? { last_error: extra.last_error } : {}),
  });
  data.feedback.push(
    fb(1, A, 'linked', '每天要在订单、工单、账单之间来回切换，筛选条件每次都没了。我们团队一天要处理上百单，这个问题真的很影响效率。能不能做一个按客户汇总的页面？另外手机上也经常要看状态，现在手机上按钮太小了，经常点错。这是一条用于检验长反馈原文排版的虚构内容。', { reason: '多位用户反映同一问题，归入「客户工作台合并视图」需求', requirement: 'design-req-1', category: 'feature', contact: 'designer@example.invalid' }),
    fb(2, A, 'linked', '切换页面后筛选条件丢失', { reason: '与第 1 条反馈属于同一问题', requirement: 'design-req-1', category: 'bug' }),
    fb(3, A, 'linked', '工单太多时一个个指派很慢', { reason: '形成「工单批量指派」需求', requirement: 'design-req-6' }),
    fb(4, A, 'new', '希望账单可以导出成表格', { category: 'feature' }),
    fb(5, A, 'processing', '客户详情页加载有点慢', { category: 'bug' }),
    fb(6, A, 'failed', '提交后页面一直转圈', { category: 'bug', last_error: '整理服务超时，可以重新整理（本地模拟）' }),
    fb(7, A, 'dismissed', '测试一下反馈功能', { category: 'noise', reason: '测试留言，无需处理' }),
    fb(8, B, 'linked', '导出失败的时候什么提示都没有，不知道要不要重试', { reason: '形成「导出失败提示」需求', requirement: 'design-req-3', category: 'bug' }),
    fb(9, B, 'new', '希望评论可以按时间倒序', { category: 'feature' }),
  );

  data.policies = {
    ...(data.policies ?? {}),
    [A]: { enabled: true, autoRelease: true, feedbackOrigins: ['https://app.example.invalid'], releaseInstructions: '合并到 main 后由发布流水线部署到生产环境；先灰度 10% 流量，观察 30 分钟。', verifyInstructions: '打开客户详情页，核对最近 30 天联系记录与后台一致；检查错误率看板无上升。', rollbackInstructions: '在发布流水线回滚到上一版本，并关闭对应功能开关。' },
    [B]: { enabled: true, autoRelease: true, feedbackOrigins: [], releaseInstructions: '', verifyInstructions: '', rollbackInstructions: '' },
    [E]: { enabled: false, autoRelease: true, feedbackOrigins: [], releaseInstructions: '', verifyInstructions: '', rollbackInstructions: '' },
  };
  return data;
}
