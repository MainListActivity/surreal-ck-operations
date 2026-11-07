import {routingDesignCss} from '../shared/model-routing-design.ts';
import {ROUTING_DEFAULTS,ROUTING_WEIGHTS,ROUTING_FORMULA,ROUTING_COST_HELP,routingNumber,routingMetrics,routingTrends,routingCalculation} from '../shared/model-routing-view.ts';
import {rankingTrendDetail} from '../shared/ranking-trends.ts';
import {relayShellCss,relayIcon} from '../shared/relay-shell.ts';
/** Review-console counterpart of the same owner model management surface. */
export const rankingPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模型排序 · 公司审核台</title><style>${relayShellCss}${routingDesignCss}</style></head><body><div class="shell">
<aside class="sidebar">
<a class="brand" href="./" title="返回公司审核台"><span class="brand-mark"><i></i><i></i></span><span><strong>Relay</strong><small>Operations</small></span></a>
<p class="nav-label">管理工作区</p>
<nav class="main-nav">
<button onclick="location.href='./#todo'">${relayIcon("inbox")}<span>待办</span></button>
<button onclick="location.href='./#goals'">${relayIcon("target")}<span>目标</span></button>
<button onclick="location.href='./#docs'">${relayIcon("book")}<span>手册</span></button>
<button class="active">${relayIcon("layers")}<span>模型排序</span></button>
</nav>
<div class="sidebar-footer"><div class="operator"><span class="avatar">ML</span><span><strong>老板</strong><small>公司审核台</small></span></div></div>
</aside>
<div class="main-area">
<header class="topbar">
<div class="breadcrumb"><span>公司审核台</span><b>/</b><strong>模型排序</strong></div>
<div class="top-actions"><button class="icon-button theme-toggle" id="theme-btn" aria-label="切换主题">${relayIcon("moon")}<span class="theme-label">深色</span></button></div>
</header>
<main class="content">
<header class="page-title"><div><p class="kicker">MODEL ROUTING</p><h1>模型排序</h1><p class="page-copy">评分、真实实测与模型管理。Haiku / Sonnet 自动排序，Opus / Fable 保持手动。</p></div><div class="sync-state"><span class="sync-dot"></span><span id="updated">正在读取…</span></div></header>
<div class="ranking-layout"><aside class="rule-card"><div class="number-title"><span>01</span><div><h2>评分规则</h2><p>非线性计算 · 无模型调用费用</p></div></div><p id="formula"></p><div id="policy-editor"></div><p>延迟以20秒为衰减参考，连续扣分；未知指标使用保守先验，新模型获得有限探索。</p><button id="save-rule" class="save-rule" disabled>保存设置</button><div class="row-actions"><button id="default-weights" class="small-button">恢复默认</button><button id="refresh-observations" class="small-button">更新观测</button></div><p id="preview-status" class="status-line" role="status"></p><p id="cost-help"></p><div class="rule-meta"><span>最近成功排序</span><strong id="last-refresh">尚未刷新</strong><p>保存后立即重算并应用；请求读取已生效顺序，实测数据最多每30秒后台更新。</p></div><p id="error" class="routing-error" role="alert"></p></aside>
<section class="ranking-card"><div class="number-title"><span>02</span><div><h2>模型优先级与管理</h2><p id="ranking-mode">实时成员 · 按总分排序</p></div></div><div class="model-tabs" id="group-tabs" role="tablist" aria-label="模型分组"></div><div class="routing-tools"><button id="show-ranking" class="active">当前排序</button><button id="show-catalog">管理模型</button><input id="search" class="routing-input" placeholder="搜索模型或供应商" aria-label="搜索模型或供应商"></div><p id="summary" class="model-note"></p><p id="message" class="status-line" role="status"></p><div id="model-list" class="model-list"></div><div id="pagination" class="pagination"></div></section></div>
</main></div></div><script>
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=value=>JSON.parse(JSON.stringify(value));
const defaults=${JSON.stringify(ROUTING_DEFAULTS)},weightLabels=${JSON.stringify(ROUTING_WEIGHTS)};
const formula=${JSON.stringify(ROUTING_FORMULA)},costHelp=${JSON.stringify(ROUTING_COST_HELP)};
const routingNumber=${routingNumber.toString()},routingMetrics=${routingMetrics.toString()},routingTrends=${routingTrends.toString()},routingCalculation=${routingCalculation.toString()};
const trendDetail=${rankingTrendDetail.toString()};
const groups=['sck-haiku','sck-sonnet','sck-opus','sck-fable'],groupLabel=g=>g.replace('sck-','').replace(/^./,x=>x.toUpperCase());
let state,policy,preview,dirty=false,previewReady=false,previewTimer,previewSeq=0,mode='ranking',group='sck-haiku',search='',expanded='',shown=12,busy=false,catalog,catalogOffset=0,catalogExpanded='',catalogSeq=0,searchTimer;
const api=async(path,body)=>{const r=await fetch('api/'+path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||'请求失败');return j;};
function setTheme(theme){document.documentElement.dataset.theme=theme;try{localStorage.setItem('relay-theme',theme)}catch{}}
try{const theme=localStorage.getItem('relay-theme');if(theme)setTheme(theme)}catch{}
function renderTheme(){const dark=(document.documentElement.dataset.theme||((matchMedia('(prefers-color-scheme:dark)').matches)?'dark':'light'))==='dark';$('theme-btn').innerHTML='${relayIcon("sun")}'+'<span class="theme-label">'+(dark?'浅色':'深色')+'</span>'}
$('theme-btn').onclick=()=>{setTheme((document.documentElement.dataset.theme||((matchMedia('(prefers-color-scheme:dark)').matches)?'dark':'light'))==='dark'?'light':'dark');renderTheme()};
renderTheme();
$('formula').textContent=formula;$('cost-help').textContent=costHelp;
function editor(){
 $('policy-editor').innerHTML=Object.entries(weightLabels).map(([key,title])=>'<label class="weights-row">'+esc(title)+'<input class="routing-input" aria-label="'+esc(title)+'权重" data-weight="'+key+'" type="number" min="0" max="100" value="'+policy.weights[key]+'"></label>').join('');
 $('policy-editor').querySelectorAll('[data-weight]').forEach(input=>input.oninput=()=>{policy.weights[input.dataset.weight]=Number(input.value);changePolicy();});
}
function changePolicy(){dirty=true;previewReady=false;preview=undefined;const seq=++previewSeq;clearTimeout(previewTimer);$('preview-status').textContent='正在计算预览，未保存…';$('save-rule').disabled=false;draw();previewTimer=setTimeout(()=>runPreview(false,seq),450);}
async function runPreview(refresh,seq=++previewSeq){
 try{const result=await api('model-ranking/preview',{policy:copy(policy),refresh});if(seq!==previewSeq)return;preview=result;previewReady=true;$('preview-status').textContent=dirty?'预览中，保存前不影响线上。':'观测已更新。';draw();}
 catch(e){if(seq===previewSeq){previewReady=false;$('preview-status').textContent=e.message+'；线上未变更。';}}
}
function currentTable(){return (dirty?(previewReady?preview?.tables:[]):state?.tables)?.find(t=>t.group===group);}
function rankingRows(){return (currentTable()?.rows??[]).filter(row=>row.model.toLowerCase().includes(search.toLowerCase()));}
function rowHtml(row,index){
 const actualRank=(currentTable()?.rows.findIndex(r=>r.model===row.model)??index)+1;
 const parts=row.model.replace(/^remote-magpie\\//,'').split('/'),name=parts.pop(),open=expanded===row.model,f=row.decision?.factors;
 const detail=open?'<div class="score-details"><code>'+esc(row.model)+'</code><p class="model-note">'+esc(row.decision?.reason??'本组手动维护，尚无自动评分')+'</p><div class="metric-grid">'+routingMetrics(row).map(([title,value,note])=>'<div><small>'+esc(title)+'</small><strong>'+esc(value)+'</strong><small>'+esc(note)+'</small></div>').join('')+'</div>'+
 (f?'<p class="factor-line">'+esc(routingCalculation(row))+'</p>':'')+
 Object.entries(row.decision?.contributions??{}).map(([key,v])=>'<div class="factor-line">'+esc(weightLabels[key])+'：原始分 '+routingNumber(v.value===undefined?undefined:v.value*100)+' / 100 · 权重 '+v.weight+' · '+(key==='staleness'?'探索加分 +'+routingNumber(v.points,2):'乘数 '+routingNumber(v.factor,3))+'</div>').join('')+
 routingTrends(row).map(([title,trend])=>'<p class="factor-line">'+esc(title)+'：'+esc(trendDetail(trend))+'</p>').join('')+'<div class="row-actions">'+(['sck-haiku','sck-sonnet'].includes(group)?'<button class="small-button" data-pin="'+index+'" '+(dirty||busy?'disabled':'')+'>'+(row.pinned?'取消置顶':'置顶模型')+'</button>':'')+'<button class="small-button" data-manage="'+index+'">管理此模型</button></div><div class="row-actions">'+Object.entries({auto:'自动计费',free:'免费',included:'订阅/积分',unknown:'未知',paid:'额外付费'}).map(([key,title])=>'<button class="small-button" data-billing="'+key+'" data-billing-row="'+index+'">'+((policy.billingOverrides[row.model]??'auto')===key?'✓ ':'')+title+'</button>').join('')+'</div></div>':'';
 return '<article class="model-row '+(open?'open':'')+'"><button class="model-main" aria-expanded="'+open+'" data-expand="'+index+'"><b class="rank">#'+actualRank+'</b><span class="model-id"><strong>'+esc(name)+'</strong><small>'+esc(parts.join('/'))+(row.pinned?' · 手动置顶':'')+'</small></span><span class="model-stat"><small>智能分</small><strong>'+routingNumber(row.aaScore)+'</strong></span><span class="model-stat speed"><small>速度</small><strong>'+routingNumber(row.tokensPerSecond,0)+' tok/s</strong></span><span class="model-stat quota"><small>首 token</small><strong>'+routingNumber(row.ttftMs===undefined?undefined:row.ttftMs/1000)+'s</strong></span><span class="jev"><small>总分</small><strong>'+routingNumber(row.decision?.score)+'</strong></span><span class="expand">'+(open?'−':'+')+'</span></button>'+detail+'</article>';
}
function draw(){
 $('group-tabs').innerHTML=groups.map(g=>'<button role="tab" aria-selected="'+(g===group)+'" data-group="'+g+'" class="'+(g===group?'active':'')+'">'+groupLabel(g)+' <span>'+(state?.tables?.find(t=>t.group===g)?.rows.length??0)+'</span></button>').join('');
 $('group-tabs').querySelectorAll('[data-group]').forEach(b=>b.onclick=()=>{group=b.dataset.group;shown=12;draw();});
 $('show-ranking').classList.toggle('active',mode==='ranking');$('show-catalog').classList.toggle('active',mode==='catalog');
 $('ranking-mode').textContent=dirty?'配置预览 · 未应用线上':'实时成员 · 按总分排序';
 if(mode==='catalog'){drawCatalog();return;}
 const rows=rankingRows(),table=currentTable();
 $('summary').textContent=['sck-opus','sck-fable'].includes(group)?'本组由你维护成员与顺序，自动公式不修改此分组。':'手动置顶之后全部模型仅按总分降序；展开可查看计算因子。';
 $('model-list').innerHTML=rows.slice(0,shown).map(rowHtml).join('')||'<p class="model-note">'+(dirty&&!previewReady?'正在等待有效预览…':'本组暂无匹配成员，可在管理模型中添加。')+'</p>';
 $('pagination').innerHTML=shown<rows.length?'<button class="small-button" id="more-models">显示其余 '+(rows.length-shown)+' 个模型</button>':'';
 if($('more-models'))$('more-models').onclick=()=>{shown+=20;draw();};
 $('model-list').querySelectorAll('[data-expand]').forEach(b=>b.onclick=()=>{const row=rows[Number(b.dataset.expand)];expanded=expanded===row.model?'':row.model;draw();});
 $('model-list').querySelectorAll('[data-pin]').forEach(b=>b.onclick=()=>{const row=rows[Number(b.dataset.pin)];action(()=>api('model-ranking/pin',{group,model:row.model,pinned:!row.pinned}),'置顶已更新。');});
 $('model-list').querySelectorAll('[data-manage]').forEach(b=>b.onclick=()=>{const row=rows[Number(b.dataset.manage)];search=row.model.replace(/:(low|medium|high|xhigh|max)$/,'');$('search').value=search;mode='catalog';catalogOffset=0;loadCatalog();});
 $('model-list').querySelectorAll('[data-billing]').forEach(b=>b.onclick=()=>{const row=rows[Number(b.dataset.billingRow)],kind=b.dataset.billing;if(kind==='auto')delete policy.billingOverrides[row.model];else policy.billingOverrides[row.model]=kind;changePolicy();});
 if(table?.at)$('last-refresh').textContent=new Date(table.at).toLocaleString();
}
async function action(write,message){if(busy)return;busy=true;draw();$('message').textContent='保存中…';try{await write();$('message').textContent=message;await read();if(mode==='catalog')await loadCatalog();}catch(e){$('message').textContent=e.message;await read();if(mode==='catalog')await loadCatalog();}finally{busy=false;draw();}}
async function read(){try{state=await api('model-ranking');if(!dirty){policy=copy(state.policy??defaults);editor();}$('updated').textContent=state.at?'最近更新 '+new Date(state.at).toLocaleTimeString():'等待首次刷新';$('error').textContent=state.error??'';if(mode==='ranking')draw();}catch(e){$('error').textContent=e.message;}}
async function loadCatalog(){const seq=++catalogSeq;$('summary').textContent='正在读取实时目录…';try{const result=await api('model-catalog?query='+encodeURIComponent(search)+'&offset='+catalogOffset);if(seq!==catalogSeq)return;catalog=result;draw();}catch(e){$('summary').textContent=e.message;}}
function aaOptions(model,query=''){
 return '<option value="">选择对应的 AA 模型</option><option value="__none">不对应 AA</option>'+(catalog?.benchmarks??[]).filter(b=>(b.name+' '+b.slug).toLowerCase().includes(query.toLowerCase())).slice(0,100).map(b=>'<option value="'+esc(b.slug)+'" '+(model.slug===b.slug?'selected':'')+'>'+esc(b.name)+' · '+routingNumber(b.score)+'</option>').join('');
}
function drawCatalog(){
 $('summary').textContent='从实时 Magpie 目录入组/移出，关联有评分的 AA 模型。已排除 group/ 和 auto/ 生成分组。';
 const models=catalog?.models??[];
 $('model-list').innerHTML=models.map((model,index)=>{
 const open=catalogExpanded===model.id,members=model.members[group]??[];
 return '<article class="catalog-row"><button class="catalog-toggle" data-catalog-expand="'+index+'" aria-expanded="'+open+'"><strong>'+esc(model.name)+'</strong><small>'+esc(model.id)+'</small><small>'+(model.aa?'AA '+routingNumber(model.aa.score)+' · '+esc(model.aa.name):'尚未关联 AA')+' · '+esc(model.groups.map(groupLabel).join(' / ')||'未入组')+' '+(open?'−':'+')+'</small></button>'+(open?'<div class="catalog-editor"><label>思考等级<select class="routing-input" id="effort-'+index+'"><option value="">默认</option>'+model.levels.map(level=>'<option '+(level==='max'?'selected':'')+'>'+esc(level)+'</option>').join('')+'</select></label><button class="small-button" data-add="'+index+'" '+(busy?'disabled':'')+'>添加到 '+groupLabel(group)+'</button>'+members.map((member,j)=>'<button class="small-button" data-remove="'+index+'" data-member="'+j+'" '+(busy?'disabled':'')+'>移出 '+groupLabel(group)+' · '+esc(member.split('/').pop())+'</button>').join('')+'<label>关联 AA（只展示有评分条目）<input class="routing-input" data-aa-search="'+index+'" placeholder="搜索 AA 名称或 slug"><select class="routing-input" id="aa-'+index+'">'+aaOptions(model)+'</select></label><button class="small-button" data-aa-save="'+index+'" '+(busy?'disabled':'')+'>保存 AA 关联</button></div>':'')+'</article>';
 }).join('')||'<p class="model-note">暂无匹配模型。</p>';
 $('pagination').innerHTML='<button id="catalog-prev" class="small-button" '+(catalogOffset===0?'disabled':'')+'>上一页</button><span>'+(models.length?catalogOffset+1:0)+'–'+(catalogOffset+models.length)+' / '+(catalog?.total??0)+'</span><button id="catalog-next" class="small-button" '+(catalog?.nextOffset==null?'disabled':'')+'>下一页</button>';
 $('catalog-prev').onclick=()=>{catalogOffset=Math.max(0,catalogOffset-40);loadCatalog();};$('catalog-next').onclick=()=>{catalogOffset=catalog.nextOffset;loadCatalog();};
 $('model-list').querySelectorAll('[data-catalog-expand]').forEach(b=>b.onclick=()=>{const model=models[Number(b.dataset.catalogExpand)];catalogExpanded=catalogExpanded===model.id?'':model.id;drawCatalog();});
 $('model-list').querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.add),model=models[i],effort=$('effort-'+i).value;action(()=>api('model-membership',{group,model:model.id+(effort?':'+effort:''),present:true,expectedMembers:model.members[group]??[]}),'分组与排序已生效。');});
 $('model-list').querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{const model=models[Number(b.dataset.remove)],members=model.members[group]??[];action(()=>api('model-membership',{group,model:members[Number(b.dataset.member)],present:false,expectedMembers:members}),'成员已移出。');});
 $('model-list').querySelectorAll('[data-aa-search]').forEach(input=>input.oninput=()=>{const i=Number(input.dataset.aaSearch);$('aa-'+i).innerHTML=aaOptions(models[i],input.value);});
 $('model-list').querySelectorAll('[data-aa-save]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.aaSave),model=models[i],slug=$('aa-'+i).value;if(!slug){$('message').textContent='请先选择 AA 模型。';return;}action(()=>api('model-alias',{model:model.id,slug:slug==='__none'?null:slug}),'AA 关联已保存。');});
}
$('search').oninput=e=>{search=e.target.value;shown=12;clearTimeout(searchTimer);if(mode==='catalog'){catalogOffset=0;searchTimer=setTimeout(loadCatalog,300);}else draw();};
$('show-ranking').onclick=()=>{mode='ranking';draw();};$('show-catalog').onclick=()=>{mode='catalog';catalogOffset=0;loadCatalog();};
$('default-weights').onclick=()=>{policy={...copy(defaults),billingOverrides:policy.billingOverrides};editor();changePolicy();};
$('refresh-observations').onclick=()=>runPreview(true);
$('save-rule').onclick=()=>action(async()=>{await api('model-ranking',{rules:state.rules,policy});dirty=false;previewReady=false;preview=undefined;$('save-rule').disabled=true;$('preview-status').textContent='已保存，排序已立即生效。';},'排序设置已保存。');
read();setInterval(read,15000);
</script></body></html>`;
