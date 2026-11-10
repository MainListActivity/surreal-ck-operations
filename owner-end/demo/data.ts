// 纯数据模块：设计模式不导入数据库、Worker、执行器或凭证模块。
export type Row = Record<string, any>;
export interface Snapshot {
  format: 'sck-owner-design-v1';
  source: 'synthetic' | 'sanitized-production';
  exportedAt: string;
  products: Row[]; requirements: Row[]; feedback: Row[]; tasks: Row[]; agents: Row[]; notes: Row[];
}
export const requirementStates = ['draft','pending','queued','implementing','release_pending','released','paused','rejected','merged'];
export const policy = () => ({enabled:true, autoRelease:false, feedbackOrigins:['https://example.invalid'], releaseInstructions:'演示：模拟发布',verifyInstructions:'演示：检查页面',rollbackInstructions:'演示：恢复上一版本'});
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
