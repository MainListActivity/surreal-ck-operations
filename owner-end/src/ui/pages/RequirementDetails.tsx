import { useEffect, useState } from 'preact/hooks';
import type { FeedbackView } from '../../../../src/iteration/inspection.ts';
import type { ProductPolicy, Requirement } from '../../../../src/iteration/requirements.ts';
import { runCommand, outcomeText } from '../api.ts';
import { Panel, Empty } from '../common.tsx';

const feedbackStates:Record<string,string>={new:'待整理',processing:'整理中',linked:'已形成需求',dismissed:'已忽略',failed:'整理失败'};
export function FeedbackPanel({project}:{project:string}) {
  const [rows,setRows]=useState<FeedbackView[]>([]),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;setBusy(true);void runCommand<{feedback:FeedbackView[]}>('feedback.list',{project,offset}).then(out=>{
    if(!active)return;if(out.kind==='ok'){setRows(out.result.feedback);setError('');}else setError(outcomeText(out,''));
  }).catch(()=>active&&setError('反馈读取失败')).finally(()=>active&&setBusy(false));return()=>{active=false;};},[project,offset,refresh]);
  return <Panel title="用户反馈" hint="保留用户原文；整理结果不会自动开工。误判为忽略的反馈可以重新整理。">
    <button disabled={busy} onClick={()=>setRefresh(refresh+1)}>刷新反馈</button>
    <p class="hint">产品嵌入方式：</p><pre>{`<script src="${location.origin}/feedback-widget.js" defer></script>\n<sck-feedback product="${project}" endpoint="${location.origin}"></sck-feedback>`}</pre>
    {error?<p role="alert">{error}</p>:null}
    {!rows.length?<Empty>当前页没有反馈。</Empty>:rows.map(row=><article key={row.id}>
      <h3>{feedbackStates[row.state]??row.state} · {row.category??'未分类'}</h3>
      <p style={{whiteSpace:'pre-wrap'}}>{row.body.text}</p>
      <p class="hint">页面：{row.body.page||'未提供'} · 版本：{row.body.version||'未提供'}</p>
      {row.body.contact?<details><summary>用户自愿留下的联系方式</summary><p>{row.body.contact}</p></details>:null}
      {row.reason?<p>整理理由：{row.reason}</p>:null}
      {row.requirement?<p>关联需求：{row.requirement}</p>:null}{row.last_error?<p>{row.last_error}</p>:null}
      {['failed','dismissed'].includes(row.state)?<button disabled={busy} onClick={()=>{setBusy(true);void runCommand('feedback.retry',{id:row.id}).then(out=>{if(out.kind==='ok')setRefresh(refresh+1);else setError(outcomeText(out,''));}).catch(()=>setError('重试失败')).finally(()=>setBusy(false));}}>重新整理</button>:null}
    </article>)}
    <div class="actions"><button disabled={busy||!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页反馈</button><span>第 {offset/50+1} 页</span><button disabled={busy||rows.length<50} onClick={()=>setOffset(offset+50)}>下一页反馈</button></div>
  </Panel>;
}
interface Details { execution:{stage:string;note?:string;released_sha?:string}|null; plan:{steps:Array<{title:string;context:string;acceptance:string}>}|null;tasks:Array<{id:unknown;title:string;state:string}> }
export function ExecutionPanel({requirement:r,busy,policy,act}:{requirement:Requirement;busy:boolean;policy?:ProductPolicy;act:(command:string,input:Record<string,unknown>,message:string)=>Promise<boolean>}){
  const [details,setDetails]=useState<Details>(),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{let active=true;void runCommand<Details>('requirement.execution',{id:r.id}).then(out=>{if(!active)return;if(out.kind==='ok')setDetails(out.result);else setError(outcomeText(out,''));}).catch(()=>active&&setError('执行进度读取失败'));return()=>{active=false;};},[r.id,refresh]);
  const control=(action:string)=>void act('requirement.control',{id:r.id,revision:r.revision,action},'需求状态已更新');
  return <section>
    <h3>执行与发布</h3><button disabled={busy} onClick={()=>setRefresh(refresh+1)}>刷新执行进度</button>
    {error?<p role="alert">{error}</p>:null}{r.planning_error?<p>{r.planning_error}</p>:null}{r.execution_error?<p>{r.execution_error}</p>:null}
    {details?.execution?<p>{details.execution.note}{details.execution.released_sha?` · 发布提交 ${details.execution.released_sha}`:''}</p>:<p class="hint">尚未建立执行任务。</p>}
    {details?.plan?<details><summary>查看 agent 拆解的计划</summary><ol>{details.plan.steps.map(s=><li><strong>{s.title}</strong><p>{s.context}</p><p>验收：{s.acceptance}</p></li>)}</ol></details>:null}
    {details?.tasks.length?<ul>{details.tasks.map(task=><li>{task.title} · {task.state} · <a href="#tasks">查看执行任务</a></li>)}</ul>:null}
    {['draft','pending'].includes(r.state)?<button disabled={busy} onClick={()=>control('reject')}>拒绝该需求</button>:null}
    {r.state==='queued'&&r.planning_error?<button disabled={busy} onClick={()=>control('retry')}>重试规划</button>:null}
    {['queued','implementing','release_pending'].includes(r.state)?<div><button disabled={busy} onClick={()=>control('pause')}>暂停后续推进</button><p class="hint">已派出的任务继续按现有租约执行；暂停阻止后续步骤，不能撤销已发起的部署。</p></div>:null}
    {r.state==='paused'?<button disabled={busy} onClick={()=>control('resume')}>恢复推进</button>:null}
    {r.state==='release_pending'&&details?.execution?.stage==='awaiting_release'?<div>
      <h4>本次发布确认</h4><p style={{whiteSpace:'pre-wrap'}}>发布：{policy?.releaseInstructions||'未配置'}<br/>验证：{policy?.verifyInstructions||'未配置'}<br/>回退：{policy?.rollbackInstructions||'未配置'}</p>
      <button disabled={busy||!policy?.enabled||!policy.releaseInstructions||!policy.verifyInstructions||!policy.rollbackInstructions} onClick={()=>void act('requirement.release',{id:r.id,revision:r.revision,expectedPolicy:policy},'已批准本修订按当前产品策略发布').then(()=>setRefresh(refresh+1))}>确认按以上策略发布</button>
    </div>:null}
  </section>;
}
