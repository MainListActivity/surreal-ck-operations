import {rankingLayers} from "../shared/ranking-layers.ts";
import {DEFAULT_POLICY,WEIGHT_LABELS,BILLING_LABELS} from './vendor/src/model-routing/weights.ts';
import { rankingHealthMetric, rankingTrendDetail, rankingRuleLabel } from "../shared/ranking-trends.ts";
import { relayShellCss, relayIcon } from "../shared/relay-shell.ts";

/** Browser counterpart of the owner's Figma layout; data is supplied by the shared ranking API. */
export const rankingPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模型排序 · 公司审核台</title><style>${relayShellCss}</style></head><body><div class="shell">
<aside class="sidebar">
<a class="brand" href="./" title="返回公司审核台"><span class="brand-mark"><i></i><i></i></span><span><strong>Relay</strong><small>Operations</small></span></a>
<p class="nav-label">管理工作区</p>
<nav class="main-nav">
<button onclick="location.href='./#todo'">${relayIcon("inbox")}<span>待办</span></button>
<button onclick="location.href='./#goals'">${relayIcon("target")}<span>目标</span></button>
<button onclick="location.href='./#docs'">${relayIcon("book")}<span>手册</span></button>
<button class="active">${relayIcon("layers")}<span>模型排序</span></button>
<button onclick="location.href='./#gm'">${relayIcon("send")}<span>给经理留言</span></button>
</nav>
<div class="sidebar-footer"><div class="operator"><span class="avatar">ML</span><span><strong>老板</strong><small>公司审核台</small></span></div></div>
</aside>
<div class="main-area">
<header class="topbar">
<div class="breadcrumb"><span>公司审核台</span><b>/</b><strong>模型排序</strong></div>
<div class="top-actions"><button class="icon-button" id="theme-btn" onclick="toggleTheme()" aria-label="切换主题"></button></div>
</header>
<main class="content">
<header class="page-title"><div><p class="kicker">ROUTING CONSOLE</p><h1>模型排序</h1><p class="page-copy">Haiku、Sonnet 按规则自动排序；Opus 的成员、顺序和组内配置由你在 Magpie 手动维护。</p></div><div class="sync-state"><span class="sync-dot"></span><div><strong id="sync-title">正在加载</strong><span id="sync-time">等待同步</span></div></div></header>
<div class="workspace"><aside class="settings-panel"><div class="section-heading"><span class="step">01</span><div><h2>排序规则</h2><p>固定规则，无模型调用费用</p></div></div><div class="field-label">当前生效规则</div><p id="rule" style="font-size:12px;line-height:1.8;white-space:pre-wrap;margin:0"></p><p class="field-help">固定分层内使用加权分；修改后自动预览，保存前不影响线上。</p><div id="policy-editor"></div><button id="default-weights" class="pin-button">恢复默认权重</button><button id="refresh-observations" class="pin-button">更新观测</button><p id="preview-status" class="field-help" role="status"></p><label class="field-label" for="refresh">刷新间隔</label><div class="select-wrap"><select id="refresh"><option value="2">2 分钟</option><option value="5" selected>5 分钟（默认）</option><option value="10">10 分钟</option></select></div><button id="save-rule" class="save-button" disabled><span id="save-label" style="font-size:13px">保存排序设置</span><span id="save-arrow">→</span></button><p id="save-message" class="field-help" role="status"></p><div class="last-refresh"><span>最近刷新</span><time id="last-refresh">尚未刷新</time><p>到期后由下一次员工请求触发后台刷新。</p></div><p id="error" class="error-message" role="alert"></p></aside>
<section class="results-panel"><div class="section-heading results-heading"><span class="step">02</span><div><h2>模型优先级</h2><p id="ranking-mode">依据当前规则生成的实时排序</p></div><span id="updated" class="updated"></span></div><div class="tabs" id="group-tabs" role="tablist" aria-label="模型组"></div><div class="group-summary"><div><h2 id="models-heading">Haiku 模型</h2><p>手动置顶独立第一层；其余模型中，新模型优先试用，再按能力档、免费/套餐积分/未知/额外付费分层，再比较综合分。</p></div><span id="model-count" class="model-count">加载中</span></div><div class="ranking-layer-guide"><strong>先比较分层，再比较层内分</strong><p>①手动置顶独立第一层 → ②其余模型按安全状态 → 新模型试用 → AA能力档 → 计费类型 → 层内分降序</p><p>手动置顶不再细分层，按置顶先后排列；其余模型的安全状态、试用状态、能力档、计费类型都相同，才是同一层。AA档在同一安全状态内从最高分开始逐档划分；每层下方列出实际范围和依据。</p><p id="layer-source">以下分层来自最近成功排序快照；跨层即使分数更高，也不会提前。</p></div><p id="legacy" class="field-help"></p><p id="pin-message" class="field-help" role="status"></p><div id="model-list" class="model-list"></div><p id="attempt-budget" class="field-help"></p><p id="snapshot" class="field-help"></p><details class="request-details"><summary>历史 JEV 请求（已停用）</summary><pre id="request-json"></pre></details></section></div>
</main></div></div><script>
const store={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}}};
function prefTheme(){try{return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){return 'light'}}
function renderThemeBtn(){const b=document.getElementById('theme-btn');if(b)b.innerHTML='<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'+((store.get('relay-theme')||prefTheme())==='light'?'<path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/>':'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>')+'</svg>'}
function toggleTheme(){const next=(store.get('relay-theme')||prefTheme())==='light'?'dark':'light';store.set('relay-theme',next);document.documentElement.dataset.theme=next;renderThemeBtn()}
{const st=store.get('relay-theme');if(st)document.documentElement.dataset.theme=st}
renderThemeBtn();
const $=id=>document.getElementById(id);
const defaults=${JSON.stringify(DEFAULT_POLICY)},weightLabels=${JSON.stringify(WEIGHT_LABELS)},billingLabels=${JSON.stringify(BILLING_LABELS)};
let policy=null,preview=null,previewPending=false,previewTimer,previewSequence=0,policyDirty=false;
const copy=v=>JSON.parse(JSON.stringify(v));
function editor(){if(!policy)return;
 $('policy-editor').innerHTML='<p class="field-help">总分 = 各项加权得分之和 ÷ 权重之和。未知指标不加分；展开模型可修正计费分类。</p>'+Object.entries(weightLabels).map(([key,label])=>'<label style="display:flex;align-items:center;justify-content:space-between;margin:8px 0">'+label+'<input data-weight="'+key+'" type="number" min="0" max="100" value="'+policy.weights[key]+'" style="width:70px;padding:8px;background:transparent;color:inherit;border:1px solid var(--border);border-radius:8px"></label>').join('')+'<label style="display:flex;justify-content:space-between">AA 能力档宽度<input id="band-width" type="number" min="0" max="10" step="0.1" value="'+policy.bandWidth+'" style="width:70px;background:transparent;color:inherit"></label>';
 $('policy-editor').querySelectorAll('[data-weight]').forEach(e=>e.oninput=()=>{policy.weights[e.dataset.weight]=Number(e.value);changePolicy();});
 $('band-width').oninput=e=>{policy.bandWidth=Number(e.target.value);changePolicy();};
}
function changePolicy(){dirty=true;policyDirty=true;preview=null;previewPending=true;++previewSequence;clearTimeout(previewTimer);$('preview-status').textContent='正在计算预览，未保存…';draw();previewTimer=setTimeout(()=>runPreview(false),500);}
async function runPreview(refresh){
 const sequence=++previewSequence,body={policy:copy(policy),refresh};previewPending=true;
 try{const r=await fetch('api/model-ranking/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(sequence!==previewSequence)return;if(!r.ok)throw Error(j.error||'预览失败');preview=j;$('preview-status').textContent='预览（未保存），观测 '+new Date(j.at).toLocaleString();}
 catch(e){if(sequence===previewSequence){preview=null;$('preview-status').textContent=e.message+'；线上未变更';}}
 finally{if(sequence===previewSequence){previewPending=false;draw();}}
}
$('default-weights').onclick=()=>{policy={...policy,bandWidth:defaults.bandWidth,weights:{...defaults.weights}};editor();changePolicy();};
$('refresh-observations').onclick=()=>{if(!policy)return;dirty=true;policyDirty=true;clearTimeout(previewTimer);preview=null;draw();runPreview(true);};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,n=1)=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(n):'未知';
let state=null,group='sck-haiku',expanded=null,dirty=false,saving=false,pinning=false,readSequence=0,saveTimer;
const api=async(body)=>{const r=await fetch('api/model-ranking',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});const j=await r.json();if(!r.ok)throw Error(j.error||'读取失败');return j;};
const trendDetail=${rankingTrendDetail.toString()};
const layerSections=${rankingLayers.toString()};
const ruleLabel=${rankingRuleLabel.toString()};
const healthMetric=${rankingHealthMetric.toString()};
function metrics(row){return [
 ['层内分',num(row.decision?.score,2),row.pinned?'手动置顶按先后排列，分数仅供参考':row.previousRank?'线上第 '+row.previousRank+' 名':'仅在固定层内比较'],
 ['排序依据',row.decision?.reason??'等待规则排序','不调用 JEV；首 token 置后阈值20秒'],
 ['AA 智能分',num(row.aaScore),(row.aaRank===undefined?'暂无排名':'全榜第 '+row.aaRank+' 名')+' · '+trendDetail(row.trends?.aaScore)],
 ['生成速度',row.tokensPerSecond===undefined?'未知':num(row.tokensPerSecond,0)+' tok/s',trendDetail(row.trends?.tokensPerSecond)],
 ['首 token 延迟',row.ttftMs===undefined?'未知':num(row.ttftMs/1000,2)+' 秒',(row.tailReason?row.tailReason+' · ':'')+trendDetail(row.trends?.ttftMs)],
 ['临期额度',row.urgency?row.urgency.amount+row.urgency.unit+' · '+row.urgency.requests+'/5条':'无有效临期额度',row.urgency?row.urgency.reason+'；截止 '+row.urgency.expiresAt:'仅使用明确期限与新鲜额度读数'],
 ['剩余额度',quota(row),trendDetail(row.trends?.remainingPct)],
 ['请求稳定性',row.stabilityPct===undefined?'未知':num(row.stabilityPct)+'%','错误率趋势：'+trendDetail(row.trends?.errorRate)],
 ['路由尝试',healthMetric(row.health,row.pinned).value,healthMetric(row.health,row.pinned).detail],
 ['缓存命中率',row.trends?.cacheHitRate?.current===undefined?'未知':num(row.trends.cacheHitRate.current*100)+'%',trendDetail(row.trends?.cacheHitRate)],
 ['样本权重',num(row.performanceSamples,2),trendDetail(row.trends?.performanceScore)]
 ];}
function quota(row){return row.accounts?.length?row.accounts.map((a,i)=>(row.accounts.length>1?'#'+(i+1)+' ':'')+(a.remainingPct===undefined?'未知':num(a.remainingPct)+'%')).join(' · '):'未知';}
function selected(){const tables=policyDirty?(preview?.tables||[]):state?.tables||[];return tables.find(t=>t.group===group)||tables[0];}
function draw(){
 $('layer-source').textContent=policyDirty?'以下分层来自当前预览；保存前不影响线上。':'以下分层来自最近成功排序快照；跨层即使分数更高，也不会提前。';
 $('ranking-mode').textContent=policyDirty?'配置预览 · 尚未应用线上':'依据当前规则生成的实时排序';
 const tables=policyDirty?(preview?.tables||[]):state?.tables||[],table=selected();
 $('group-tabs').innerHTML=['sck-haiku','sck-sonnet','sck-opus'].flatMap(id=>{const t=tables.find(t=>t.group===id);if(!t)return [];return '<button role="tab" data-group="'+id+'" aria-selected="'+(table?.group===id)+'" class="tab '+(table?.group===id?'active':'')+'">'+id.slice(4).replace(/^./,x=>x.toUpperCase())+'<span>'+t.rows.length+'</span></button>';}).join('');
 $('group-tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{group=b.dataset.group;expanded=null;draw();});
 $('models-heading').textContent=table?table.group.slice(4).replace(/^./,x=>x.toUpperCase())+' 模型':'模型';
 $('model-count').textContent=(table?.rows.length||0)+' 个成员';
 $('updated').textContent=table?.at?'更新于 '+new Date(table.at).toLocaleTimeString():'';
 const attempt=state?.attempts?.[table?.group];
 $('attempt-budget').textContent=attempt?'最近刷新尝试：'+new Date(attempt.at).toLocaleString()+' · '+attempt.status+' · '+attempt.modelCount+' 个评分模型 · '+attempt.encoding+' · 共享 '+attempt.stateBytes+'/'+attempt.limits.stateBytes+' 字节 · 请求 '+attempt.requestBytes+'/'+attempt.limits.requestBytes+' 字节':'';
 $('snapshot').textContent=table?.at?(table.scored?'最近成功排序：':'历史请求数据：')+new Date(table.at).toLocaleString()+' · 本轮规则：'+(table.rules||'未记录'):'';
 $('legacy').textContent=table&&!table.scored?'等待下一次请求触发规则排序。':'';
 const starts=new Map(table?layerSections(table).map(layer=>[layer.start,layer]):[]);
 $('model-list').innerHTML=table?.rows.map((r,i)=>{
  const short=r.model.replace(/^remote-magpie\\//,''),slash=short.lastIndexOf('/'),open=expanded===r.model;
  const layer=starts.get(i);
  const header=layer?'<section class="ranking-layer" aria-label="'+esc(layer.title)+'"><h3>'+esc(layer.title)+'</h3><p class="layer-range">第'+(layer.start+1)+'–'+(layer.end+1)+'名 · 本段'+layer.count+'个模型'+(layer.total!==layer.count?' / 本层共'+layer.total+'个':'')+'</p><p>'+esc(layer.abilitySummary)+'</p><details><summary>这一层如何形成</summary><p>'+esc(layer.ability)+'</p><p>'+esc(layer.explanation)+'</p><p><strong>'+esc(layer.comparison)+'</strong></p></details></section>':'';
  const score=r.decision?.score===undefined?ruleLabel(r):num(r.decision.score,1);
  const stat=(cls,label,value)=>'<div class="row-stat '+cls+'"><span>'+label+'</span><strong>'+esc(value)+'</strong></div>';
  return header+'<article class="model-row '+(open?'expanded':'')+'"><div class="model-row-header"><button class="model-row-main" data-index="'+i+'" aria-expanded="'+open+'" aria-label="'+esc('第 '+(i+1)+' 名 '+r.model)+'"><span class="rank">#'+(i+1)+'</span><div class="model-primary"><div class="model-name-row"><h3 title="'+esc(r.model)+'">'+esc(short.slice(slash+1))+'</h3>'+(i===0&&r.decision&&!r.decision.tail?'<span class="tag">推荐</span>':'')+'</div><p>'+esc(short.slice(0,slash))+' · '+(r.ttftMs===undefined?'TTFT ?':num(r.ttftMs/1000,2)+'s')+'</p></div>'+stat('intelligence','智能分',num(r.aaScore))+stat('speed','速度',r.tokensPerSecond===undefined?'未知':num(r.tokensPerSecond,0)+' tok/s')+stat('quota','额度',quota(r))+'<div class="score"><span>'+(r.pinned?'置顶':r.decision?.tail?'置后':r.decision?.urgent?'临期优先':r.decision?.coldStart?'试用':'层内分')+'</span><strong title="'+esc(r.decision?.reason??'等待规则排序')+'">'+score+'</strong></div><span class="chevron">'+(open?'−':'+')+'</span></button><button class="pin-button" data-pin="'+i+'" '+(pinning||policyDirty?'disabled':'')+' aria-pressed="'+!!r.pinned+'" aria-label="'+esc((r.pinned?'取消置顶 ':'置顶 ')+r.model)+'">'+(r.pinned?'取消置顶':'置顶')+'</button></div>'+(open?'<div class="row-details"><div class="model-path" title="'+esc(r.model)+'">'+esc(r.model)+'</div><div class="metrics">'+metrics(r).map(([label,value,detail])=>'<div><span>'+label+'</span><strong>'+esc(value)+'</strong><small>'+esc(detail)+'</small></div>').join('')+'</div>'+Object.entries(r.decision?.contributions||{}).map(([key,v])=>'<p class="field-help">'+esc(weightLabels[key])+': '+(v.value===undefined?'未知（不加分）':num(v.value*100,1)+'%')+' × '+v.weight+' → +'+num(v.points,2)+'</p>').join('')+'<label class="field-label">计费分类<select data-billing="'+i+'">'+Object.entries({auto:'自动',...billingLabels}).map(([kind,label])=>'<option value="'+kind+'" '+((policy?.billingOverrides[r.model]||'auto')===kind?'selected':'')+'>'+label+'</option>').join('')+'</select></label>'+(r.previousRank?'<p class="field-help">线上第 '+r.previousRank+' 名 → 预览第 '+(i+1)+' 名</p>':'')+(r.performanceScore===undefined?'':'<p class="mobile-performance">历史绩效 '+num(r.performanceScore,2)+' / 5</p>')+'</div>':'')+'</article>';
 }).join('')||'<p class="empty-state">尚无分组成员。</p>';
 $('model-list').querySelectorAll('.model-row-main').forEach(b=>b.onclick=()=>{const id=table.rows[Number(b.dataset.index)].model;expanded=expanded===id?null:id;draw();});
 $('model-list').querySelectorAll('[data-billing]').forEach(e=>e.onchange=()=>{const id=table.rows[Number(e.dataset.billing)].model;if(e.value==='auto')delete policy.billingOverrides[id];else policy.billingOverrides[id]=e.value;changePolicy();});
 $('model-list').querySelectorAll('[data-pin]').forEach(b=>b.onclick=async()=>{
  if(pinning)return;const row=table.rows[Number(b.dataset.pin)],targetGroup=table.group;
  pinning=true;$('pin-message').textContent='';draw();
  try{const response=await fetch('api/model-ranking/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({group:targetGroup,model:row.model,pinned:!row.pinned})});const result=await response.json();if(!response.ok)throw Error(result.error||'保存失败');$('pin-message').textContent=row.pinned?'已取消置顶，恢复自动分层。':'已置顶到独立第一层，状态异常仍保留提示。';}
  catch(e){$('pin-message').textContent='置顶更新未完成：'+e.message;}
  finally{pinning=false;await load();draw();}
 });
}
async function load(){
 const sequence=++readSequence;
 try{const next=await api();if(sequence!==readSequence)return;state=next;$('rule').textContent=state.rules;if(!dirty){policy=copy(state.policy||defaults);editor();$('refresh').value=state.refreshMinutes;}
  $('last-refresh').textContent=state.at?new Date(state.at).toLocaleString():'尚未刷新';
  $('sync-title').textContent=state.error?'同步异常':!state.configured?'尚未配置':'运行正常';
  $('sync-time').textContent=state.at?new Date(state.at).toLocaleString():'等待首次刷新';
  $('error').textContent=state.error||(!state.configured?'规则排序尚未初始化。':'');
  $('request-json').textContent=JSON.stringify(state.requests||[],null,2);$('save-rule').disabled=saving;draw();
 }catch(e){if(sequence===readSequence){$('sync-title').textContent='读取失败';$('error').textContent=e.message;}}
}
$('refresh').onchange=()=>{dirty=true;};
$('save-rule').onclick=async()=>{
 if(saving)return;saving=true;++readSequence;
 const body={rules:state.rules,refreshMinutes:Number($('refresh').value),policy:copy(policy)};const policyKey=JSON.stringify(policy);
 clearTimeout(saveTimer);$('save-rule').classList.remove('saved');$('save-arrow').textContent='→';
 $('save-rule').disabled=true;$('save-label').textContent='保存中…';$('save-message').textContent='';
 try{await api(body);if(Number($('refresh').value)===body.refreshMinutes&&JSON.stringify(policy)===policyKey){dirty=false;policyDirty=false;preview=null;++previewSequence;clearTimeout(previewTimer);$('preview-status').textContent='';}
  $('save-message').textContent='已保存，下次员工请求到达时刷新排序。';$('save-rule').classList.add('saved');$('save-label').textContent='已保存设置';$('save-arrow').textContent='✓';saveTimer=setTimeout(()=>{$('save-rule').classList.remove('saved');$('save-label').textContent='保存排序设置';$('save-arrow').textContent='→';},2200);await load();
 }catch(e){$('save-message').textContent='保存失败：'+e.message;}
 finally{saving=false;$('save-rule').disabled=false;if(!$('save-rule').classList.contains('saved'))$('save-label').textContent='保存排序设置';}
};
load();setInterval(load,15000);
</script></body></html>`;
