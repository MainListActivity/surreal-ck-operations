import { useCallback, useEffect, useState, useRef } from 'preact/hooks';
import type { ProductPolicy, Requirement } from '../../../../src/iteration/requirements.ts';
import { runCommand, outcomeText } from '../api.ts';
import { FeedbackPanel, ExecutionPanel } from './RequirementDetails.tsx';
import { Panel, Empty } from '../common.tsx';

const STATES: Record<string,string> = {draft:'待整理',pending:'待确认',queued:'已确认待规划',implementing:'实施中',release_pending:'待发布',released:'已上线',paused:'已暂停',rejected:'已拒绝',merged:'已归并'};
interface Product {id:string;name:string}
const EMPTY_POLICY:ProductPolicy={enabled:true,autoRelease:false,feedbackOrigins:[],releaseInstructions:'',verifyInstructions:'',rollbackInstructions:''};
interface Draft {title:string;problem:string;acceptance:string;priority:number}
const EMPTY:Draft={title:'',problem:'',acceptance:'',priority:2};
const draftOf=(r:Requirement):Draft=>({title:r.title,problem:r.problem,acceptance:r.acceptance,priority:r.priority});

export function RequirementsPage({onDirtyChange}:{onDirtyChange?:(dirty:boolean)=>void}){
  const generation=useRef(0);
  const [policyLoaded,setPolicyLoaded]=useState(false);
  const [products,setProducts]=useState<Product[]>([]),[project,setProject]=useState('');
  const [items,setItems]=useState<Requirement[]>([]),[offset,setOffset]=useState(0),[selected,setSelected]=useState<Requirement>();
  const [draft,setDraft]=useState<Draft>(EMPTY),[editing,setEditing]=useState(false);
  const [policy,setPolicy]=useState<ProductPolicy>(),[settings,setSettings]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{void runCommand<{products:Product[]}>('product.iteration.list').then(out=>{if(out.kind==='ok')setProducts(out.result.products);else setError(outcomeText(out,''));}).catch(()=>setError('产品列表读取失败'));},[]);
  const load=useCallback(async()=>{
    const current=++generation.current;
    const out=await runCommand<{requirements:Requirement[]}>('requirement.list',{...(project?{project}:{}),offset});
    if(current!==generation.current)return;
    if(out.kind==='ok')setItems(out.result.requirements);else setError(outcomeText(out,''));
  },[project,offset]);
  useEffect(()=>{let active=true;setSelected(previous=>previous?.project===project?previous:undefined);setEditing(previous=>selected?.project===project?previous:false);setPolicy(undefined);setPolicyLoaded(false);setSettings(false);setError('');
    void load().catch(()=>active&&setError('需求列表读取失败'));
    if(project)void runCommand<{policy:ProductPolicy|null}>('product.iteration.get',{project}).then(out=>{if(!active)return;if(out.kind==='ok'){setPolicy(out.result.policy??undefined);setPolicyLoaded(true);}else setError(outcomeText(out,''));}).catch(()=>active&&setError('配置读取失败'));
    return()=>{active=false;generation.current++;};
  },[load,project]);
  const act=async(command:string,input:Record<string,unknown>,message:string)=>{
    setBusy(true);setError('');setNotice('');
    try{const out=await runCommand<{requirement?:Requirement}> (command,input);if(out.kind!=='ok'){setError(outcomeText(out,''));return false;}
      setNotice(message);if(out.result.requirement){setSelected(out.result.requirement);setDraft(draftOf(out.result.requirement));}await load();return true;
    }catch{setError('操作失败，请刷新核对后再重试');return false;}finally{setBusy(false);}
  };
  const dirty=editing&&(selected?JSON.stringify(draft)!==JSON.stringify(draftOf(selected)):JSON.stringify(draft)!==JSON.stringify(EMPTY));
  useEffect(()=>{const protect=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[dirty]);
  useEffect(()=>{onDirtyChange?.(dirty);},[dirty,onDirtyChange]);
  const editable=!selected||['draft','pending','rejected'].includes(selected.state);
  return <div class="page">
    <Panel title="需求池" hint="先整理问题和验收标准；只有确认开工后才会进入执行流程。">
      <label>产品<select value={project} disabled={busy||dirty} onChange={e=>{setProject(e.currentTarget.value);setOffset(0);setItems([]);setNotice('');}}><option value="">全部产品</option>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {!project?<button disabled={busy||dirty} onClick={()=>void load().catch(()=>setError('刷新失败'))}>刷新全部需求</button>:null}
      {!products.length?<Empty>请先登记产品项目，再录入需求。</Empty>:null}
      {project?<div class="actions"><button disabled={busy||dirty} onClick={()=>{setSelected(undefined);setDraft(EMPTY);setEditing(true);}}>新建需求</button><button disabled={busy||!policyLoaded} onClick={()=>setSettings(!settings)}>产品反馈与发布设置</button><button disabled={busy||dirty} onClick={()=>{if(selected)void act('requirement.get',{id:selected.id},'需求进度已刷新');else void load().catch(()=>setError('刷新失败'));}}>刷新需求与进度</button></div>:null}
      {error?<p role="alert" class="notice err">{error}</p>:null}{notice?<p role="status" class="notice">{notice}</p>:null}
      {project&&settings?<PolicyEditor key={project+JSON.stringify(policy)} initial={policy??EMPTY_POLICY} busy={busy} save={async value=>{if(await act('product.iteration.configure',{project,...value},'产品配置已保存')){setPolicy(value);setSettings(false);}}}/>:null}
    </Panel>
    <Panel title={project?'产品需求':'全部产品需求'}>
      {items.length?<table><thead><tr><th>产品</th><th>需求</th><th>状态</th><th>优先级</th><th>修订</th></tr></thead><tbody>{items.map(r=><tr key={r.id}><td>{products.find(p=>p.id===r.project)?.name??r.project}</td><td><button disabled={busy||dirty} onClick={()=>{setSelected(r);setDraft(draftOf(r));setEditing(true);setNotice('');if(project!==r.project){setProject(r.project);setOffset(0);}}}>{r.title}</button></td><td>{STATES[r.state]??r.state}</td><td>P{r.priority}</td><td>{r.revision}</td></tr>)}</tbody></table>:<Empty>当前页没有需求。</Empty>}
      <div class="actions"><button disabled={busy||dirty||offset===0} onClick={()=>setOffset(Math.max(0,offset-100))}>上一页</button><span>第 {offset/100+1} 页</span><button disabled={busy||dirty||items.length<100} onClick={()=>setOffset(offset+100)}>下一页</button></div>
    </Panel>
    {project&&editing?<Panel title={selected?'需求详情':'新建需求'}>
      <form onSubmit={e=>{e.preventDefault();void act(selected?'requirement.edit':'requirement.create',{project,...draft,...(selected?{id:selected.id,revision:selected.revision}:{})},'需求已保存，尚未开工');}}>
        <label>标题<input required maxLength={200} disabled={!editable||busy} value={draft.title} onInput={e=>setDraft({...draft,title:e.currentTarget.value})}/></label>
        <label>要解决的问题<textarea required maxLength={6000} disabled={!editable||busy} value={draft.problem} onInput={e=>setDraft({...draft,problem:e.currentTarget.value})}/></label>
        <label>验收标准<textarea maxLength={3000} disabled={!editable||busy} value={draft.acceptance} onInput={e=>setDraft({...draft,acceptance:e.currentTarget.value})}/></label>
        <label>优先级<select disabled={!editable||busy} value={draft.priority} onChange={e=>setDraft({...draft,priority:Number(e.currentTarget.value)})}>{[0,1,2,3].map(p=><option value={p}>P{p}</option>)}</select></label>
        {editable?<button type="submit" disabled={busy}>保存需求</button>:<p class="hint">已确认的修订保持不变，执行以确认快照为准。</p>}
      </form>
      {dirty?<button disabled={busy} onClick={()=>setDraft(selected?draftOf(selected):EMPTY)}>放弃未保存修改</button>:null}
      {selected&&['draft','pending'].includes(selected.state)?<div>
        <p>{policy?.autoRelease?'满足验收和产品发布策略后，允许自动上线。':'完成交付后等待老板放行发布。'}</p>
        {!policy?.enabled?<p class="hint">请先在产品设置中启用迭代。</p>:null}
        {dirty?<p class="hint">请先保存修改，再确认开工。</p>:null}
        <button class="primary" disabled={busy||dirty||!policy?.enabled||!selected.acceptance.trim()} onClick={()=>void act('requirement.approve',{id:selected.id,revision:selected.revision,expectedPolicy:policy},'已确认开工，等待规划任务。').then(async ok=>{if(ok){const out=await runCommand<{requirement:Requirement}>('requirement.get',{id:selected.id});if(out.kind==='ok')setSelected(out.result.requirement);}}).catch(()=>setError('状态刷新失败，请重新读取需求'))}>确认并开始实施</button>
      </div>:null}
      {selected?<ExecutionPanel key={selected.id+selected.state} requirement={selected} busy={busy} policy={policy} act={act}/>:null}
      {selected?.root_task?<p>规划任务：{selected.root_task} · <a href="#tasks">查看任务</a></p>:null}
    </Panel>:null}
    {project?<FeedbackPanel key={project} project={project}/>:null}
  </div>;
}
function PolicyEditor({initial,busy,save}:{initial:ProductPolicy;busy:boolean;save:(p:ProductPolicy)=>Promise<void>}){
  const [value,setValue]=useState(initial),[origins,setOrigins]=useState(initial.feedbackOrigins.join('\n'));
  return <form onSubmit={e=>{e.preventDefault();void save({...value,feedbackOrigins:origins.split('\n').map(s=>s.trim()).filter(Boolean)});}}>
    <p class="hint">发布策略只影响后续确认，已确认需求保留原授权快照。停用产品会停止新的自动整理和后续任务推进。</p>
    <label><input type="checkbox" checked={value.enabled} disabled={busy} onChange={e=>setValue({...value,enabled:e.currentTarget.checked})}/>启用该产品的迭代流程</label>
    <label>允许嵌入反馈入口的站点（每行一个 HTTPS 来源）<textarea value={origins} disabled={busy} onInput={e=>setOrigins(e.currentTarget.value)}/></label>
    <label><input type="checkbox" checked={value.autoRelease} disabled={busy} onChange={e=>setValue({...value,autoRelease:e.currentTarget.checked})}/>验收通过后自动发布</label>
    {(['releaseInstructions','verifyInstructions','rollbackInstructions'] as const).map((field,i)=><label>{['发布流程','上线验证方法','回退流程'][i]}<textarea maxLength={2000} required={value.autoRelease} value={value[field]} disabled={busy} onInput={e=>setValue({...value,[field]:e.currentTarget.value})}/></label>)}
    <button disabled={busy} type="submit">保存产品设置</button>
  </form>;
}
