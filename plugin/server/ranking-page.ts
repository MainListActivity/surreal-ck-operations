import { rankingHealthMetric, rankingTrendDetail, rankingRuleLabel } from "../shared/ranking-trends.ts";
import { relayDesignCss } from "../shared/relay-design.ts";

/** Browser counterpart of the owner's Figma layout; data is supplied by the shared ranking API. */
export const rankingPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模型排序 · 公司审核台</title><style>${relayDesignCss}</style></head><body><main class="app-shell">
<header class="topbar"><a class="brand" href="./" title="返回公司审核台"><span class="brand-mark">M</span><span>Model Relay</span></a><div class="preview-badge"><span class="pulse"></span>实时数据</div></header>
<div class="page"><section class="hero"><div><p class="eyebrow">ROUTING CONSOLE</p><h1>模型排序</h1><p class="hero-copy">Haiku、Sonnet 按规则自动排序；Opus 的成员、顺序和组内配置由你在 Magpie 手动维护。</p></div><div class="sync-state"><span class="sync-dot"></span><div><strong id="sync-title">正在加载</strong><span id="sync-time">等待同步</span></div></div></section>
<div class="workspace"><aside class="settings-panel"><div class="section-heading"><span class="step">01</span><div><h2>排序规则</h2><p>固定规则，无模型调用费用</p></div></div><label class="field-label" for="rule">当前生效规则</label><textarea readonly id="rule" maxlength="8000" placeholder="例如：智能程度和速度综合优先"></textarea><p class="field-help">规则由代码执行；这里只设置刷新间隔。旧自然语言规则已停用。</p><label class="field-label" for="refresh">刷新间隔</label><div class="select-wrap"><select id="refresh"><option value="2">2 分钟</option><option value="5" selected>5 分钟（默认）</option><option value="10">10 分钟</option></select></div><button id="save-rule" class="save-button" disabled><span id="save-label" style="font-size:13px">保存刷新间隔</span><span id="save-arrow">→</span></button><p id="save-message" class="field-help" role="status"></p><div class="last-refresh"><span>最近刷新</span><time id="last-refresh">尚未刷新</time><p>到期后由下一次员工请求触发后台刷新。</p></div><p id="error" class="error-message" role="alert"></p></aside>
<section class="results-panel"><div class="section-heading results-heading"><span class="step">02</span><div><h2>模型优先级</h2><p>依据当前规则生成的实时排序</p></div><span id="updated" class="updated"></span></div><div class="tabs" id="group-tabs" role="tablist" aria-label="模型组"></div><div class="group-summary"><div><h2 id="models-heading">Haiku 模型</h2><p>先执行故障、额度和20秒限制，再按订阅、能力档、首 token 延迟排序；置顶不能越过限制。</p></div><span id="model-count" class="model-count">加载中</span></div><p id="legacy" class="field-help"></p><p id="pin-message" class="field-help" role="status"></p><div id="model-list" class="model-list"></div><p id="attempt-budget" class="field-help"></p><p id="snapshot" class="field-help"></p><details class="request-details"><summary>历史 JEV 请求（已停用）</summary><pre id="request-json"></pre></details></section></div></div></main><script>const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,n=1)=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(n):'未知';
let state=null,group='sck-haiku',expanded=null,dirty=false,saving=false,pinning=false,readSequence=0,saveTimer;
const api=async(body)=>{const r=await fetch('api/model-ranking',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});const j=await r.json();if(!r.ok)throw Error(j.error||'读取失败');return j;};
const trendDetail=${rankingTrendDetail.toString()};
const ruleLabel=${rankingRuleLabel.toString()};
const healthMetric=${rankingHealthMetric.toString()};
function metrics(row){return [
 ['排序依据',row.decision?.reason??'等待规则排序','不调用 JEV；首 token 置后阈值20秒'],
 ['AA 智能分',num(row.aaScore),(row.aaRank===undefined?'暂无排名':'全榜第 '+row.aaRank+' 名')+' · '+trendDetail(row.trends?.aaScore)],
 ['生成速度',row.tokensPerSecond===undefined?'未知':num(row.tokensPerSecond,0)+' tok/s',trendDetail(row.trends?.tokensPerSecond)],
 ['首 token 延迟',row.ttftMs===undefined?'未知':num(row.ttftMs/1000,2)+' 秒',(row.tailReason?row.tailReason+' · ':'')+trendDetail(row.trends?.ttftMs)],
 ['剩余额度',quota(row),trendDetail(row.trends?.remainingPct)],
 ['请求稳定性',row.stabilityPct===undefined?'未知':num(row.stabilityPct)+'%','错误率趋势：'+trendDetail(row.trends?.errorRate)],
 ['路由尝试',healthMetric(row.health).value,healthMetric(row.health).detail],
 ['缓存命中率',row.trends?.cacheHitRate?.current===undefined?'未知':num(row.trends.cacheHitRate.current*100)+'%',trendDetail(row.trends?.cacheHitRate)],
 ['样本权重',num(row.performanceSamples,2),trendDetail(row.trends?.performanceScore)]
 ];}
function quota(row){return row.accounts?.length?row.accounts.map((a,i)=>(row.accounts.length>1?'#'+(i+1)+' ':'')+(a.remainingPct===undefined?'未知':num(a.remainingPct)+'%')).join(' · '):'未知';}
function selected(){const tables=state?.tables||[];return tables.find(t=>t.group===group)||tables[0];}
function draw(){
 const tables=state?.tables||[],table=selected();
 $('group-tabs').innerHTML=['sck-haiku','sck-sonnet','sck-opus'].flatMap(id=>{const t=tables.find(t=>t.group===id);if(!t)return [];return '<button role="tab" data-group="'+id+'" aria-selected="'+(table?.group===id)+'" class="tab '+(table?.group===id?'active':'')+'">'+id.slice(4).replace(/^./,x=>x.toUpperCase())+'<span>'+t.rows.length+'</span></button>';}).join('');
 $('group-tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{group=b.dataset.group;expanded=null;draw();});
 $('models-heading').textContent=table?table.group.slice(4).replace(/^./,x=>x.toUpperCase())+' 模型':'模型';
 $('model-count').textContent=(table?.rows.length||0)+' 个成员';
 $('updated').textContent=table?.at?'更新于 '+new Date(table.at).toLocaleTimeString():'';
 const attempt=state?.attempts?.[table?.group];
 $('attempt-budget').textContent=attempt?'最近刷新尝试：'+new Date(attempt.at).toLocaleString()+' · '+attempt.status+' · '+attempt.modelCount+' 个评分模型 · '+attempt.encoding+' · 共享 '+attempt.stateBytes+'/'+attempt.limits.stateBytes+' 字节 · 请求 '+attempt.requestBytes+'/'+attempt.limits.requestBytes+' 字节':'';
 $('snapshot').textContent=table?.at?(table.scored?'最近成功评分：':'历史请求数据：')+new Date(table.at).toLocaleString()+' · 本轮规则：'+(table.rules||'未记录'):'';
 $('legacy').textContent=table&&!table.scored?'等待下一次请求触发规则排序。':'';
 $('model-list').innerHTML=table?.rows.map((r,i)=>{
  const short=r.model.replace(/^remote-magpie\\//,''),slash=short.lastIndexOf('/'),open=expanded===r.model;
  const score=ruleLabel(r);
  const stat=(cls,label,value)=>'<div class="row-stat '+cls+'"><span>'+label+'</span><strong>'+esc(value)+'</strong></div>';
  return '<article class="model-row '+(open?'expanded':'')+'"><div class="model-row-header"><button class="model-row-main" data-index="'+i+'" aria-expanded="'+open+'" aria-label="'+esc('第 '+(i+1)+' 名 '+r.model)+'"><span class="rank">#'+(i+1)+'</span><div class="model-primary"><div class="model-name-row"><h3 title="'+esc(r.model)+'">'+esc(short.slice(slash+1))+'</h3>'+(i===0&&r.decision&&!r.decision.tail?'<span class="tag">推荐</span>':'')+'</div><p>'+esc(short.slice(0,slash))+' · '+(r.ttftMs===undefined?'TTFT ?':num(r.ttftMs/1000,2)+'s')+'</p></div>'+stat('intelligence','智能分',num(r.aaScore))+stat('speed','速度',r.tokensPerSecond===undefined?'未知':num(r.tokensPerSecond,0)+' tok/s')+stat('quota','额度',quota(r))+'<div class="score"><span>规则</span><strong title="'+esc(r.decision?.reason??'等待规则排序')+'">'+score+'</strong></div><span class="chevron">'+(open?'−':'+')+'</span></button><button class="pin-button" data-pin="'+i+'" '+(pinning?'disabled':'')+' aria-pressed="'+!!r.pinned+'" aria-label="'+esc((r.pinned?'取消置顶 ':'置顶 ')+r.model)+'">'+(r.pinned?'取消置顶':'置顶')+'</button></div>'+(open?'<div class="row-details"><div class="model-path" title="'+esc(r.model)+'">'+esc(r.model)+'</div><div class="metrics">'+metrics(r).map(([label,value,detail])=>'<div><span>'+label+'</span><strong>'+esc(value)+'</strong><small>'+esc(detail)+'</small></div>').join('')+'</div>'+(r.performanceScore===undefined?'':'<p class="mobile-performance">历史绩效 '+num(r.performanceScore,2)+' / 5</p>')+'</div>':'')+'</article>';
 }).join('')||'<p class="empty-state">尚无分组成员。</p>';
 $('model-list').querySelectorAll('.model-row-main').forEach(b=>b.onclick=()=>{const id=table.rows[Number(b.dataset.index)].model;expanded=expanded===id?null:id;draw();});
 $('model-list').querySelectorAll('[data-pin]').forEach(b=>b.onclick=async()=>{
  if(pinning)return;const row=table.rows[Number(b.dataset.pin)],targetGroup=table.group;
  pinning=true;$('pin-message').textContent='';draw();
  try{const response=await fetch('api/model-ranking/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({group:targetGroup,model:row.model,pinned:!row.pinned})});const result=await response.json();if(!response.ok)throw Error(result.error||'保存失败');$('pin-message').textContent=row.pinned?'已取消置顶，下次刷新按规则排序。':'已置顶，仍受20秒和可用性限制。';}
  catch(e){$('pin-message').textContent='置顶更新未完成：'+e.message;}
  finally{pinning=false;await load();draw();}
 });
}
async function load(){
 const sequence=++readSequence;
 try{const next=await api();if(sequence!==readSequence)return;state=next;if(!dirty){$('rule').value=state.rules;$('refresh').value=state.refreshMinutes;}
  $('last-refresh').textContent=state.at?new Date(state.at).toLocaleString():'尚未刷新';
  $('sync-title').textContent=state.error?'同步异常':!state.configured?'尚未配置':'运行正常';
  $('sync-time').textContent=state.at?new Date(state.at).toLocaleString():'等待首次刷新';
  $('error').textContent=state.error||(!state.configured?'规则排序尚未初始化。':'');
  $('request-json').textContent=JSON.stringify(state.requests||[],null,2);$('save-rule').disabled=saving;draw();
 }catch(e){if(sequence===readSequence){$('sync-title').textContent='读取失败';$('error').textContent=e.message;}}
}
$('rule').oninput=()=>{dirty=true;};$('refresh').onchange=()=>{dirty=true;};
$('save-rule').onclick=async()=>{
 if(saving)return;saving=true;++readSequence;
 const body={rules:$('rule').value,refreshMinutes:Number($('refresh').value)};
 clearTimeout(saveTimer);$('save-rule').classList.remove('saved');$('save-arrow').textContent='→';
 $('save-rule').disabled=true;$('save-label').textContent='保存中…';$('save-message').textContent='';
 try{await api(body);if($('rule').value===body.rules&&Number($('refresh').value)===body.refreshMinutes)dirty=false;
  $('save-message').textContent='已保存，下次员工请求到达时刷新排序。';$('save-rule').classList.add('saved');$('save-label').textContent='已保存设置';$('save-arrow').textContent='✓';saveTimer=setTimeout(()=>{$('save-rule').classList.remove('saved');$('save-label').textContent='保存刷新间隔';$('save-arrow').textContent='→';},2200);await load();
 }catch(e){$('save-message').textContent='保存失败：'+e.message;}
 finally{saving=false;$('save-rule').disabled=false;if(!$('save-rule').classList.contains('saved'))$('save-label').textContent='保存刷新间隔';}
};
load();setInterval(load,15000);
</script></body></html>`;
