/**
 * 老板网页审核台：挂在预览服务同一 HTTP listener 上（LAN 面），路径 /o/<token>/。
 * 沙箱渲染环境没有 window/Linking，插件页里点不开外链——所以把收件箱/审批/手册
 * 做成纯网页，手机上用系统浏览器直接访问。
 * 鉴权：路径里的一次性随机 token（<home>/private/console-token 持久化，0600）。
 * LAN 面本身不做更重的鉴权是既定口径，token 只是防路过式撞库。
 */
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { relayShellCss, relayIcon } from "../shared/relay-shell.ts";

type CompanyApi = {
  upgrades?: import("./vendor/src/company-upgrades.ts").CompanyUpgrades;
  owner: {
    inbox(): Promise<unknown>;
    brief(): Promise<unknown>;
    decide(input: { taskId: string; decision: "approve" | "reject" | "reply"; note: string; source: string; key: string }): Promise<unknown>;
    retire(input: { taskId: string; note: string; source: string; key: string }): Promise<unknown>;
    unlockDependents(input: { taskId: string; source: string }): Promise<string[]>;
    cancelGoal(input: { goalId: string; note: string; source: string; key: string }): Promise<{ retired: number; remaining: number }>;
    resolveNotice(key: string): Promise<void>;
    instruct(input: { text: string; source: string; key: string }): Promise<{ taskId: string }>;
  };
  workforce: {
    revokeTaskLease(taskId: string, reason: string, handover: string, actor: string): Promise<{ ok: boolean; employee?: string }>;
  };
  db: { db: import("surrealdb").Surreal };
  modelRanking: import("./vendor/src/model-routing/ranking.ts").RankingRefresher;
  opsRepo: string;
};

export interface ConsoleOptions {
  home: string;
  /** 惰性取公司服务（DB 连接异步建立；console 请求晚于启动）。 */
  company: () => Promise<CompanyApi>;
  /** 附件直链的 LAN base，形如 http://192.168.x.x:18777；监听绑定后才稳定，用回调取最新值。 */
  lanBase: () => string;
}

const TOKEN_FILE = "console-token";
const SOURCE = "owner:web-console";

function consoleToken(home: string): string {
  const dir = join(home, "private");
  const file = join(dir, TOKEN_FILE);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch { /* 首次或损坏则重建 */ }
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(18).toString("base64url");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* 尽力而为 */ }
  return token;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

const text = (body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response =>
  new Response(body, { status, headers: { "Content-Type": contentType } });

/** 手册目录：opsRepo 下 agents/*.md、docs/*.md、根 AGENTS.md/PROTOCOL 类入口。 */
function listDocs(opsRepo: string): Array<{ name: string; group: string }> {
  const out: Array<{ name: string; group: string }> = [];
  const scan = (sub: string, group: string) => {
    try {
      for (const f of readdirSync(join(opsRepo, sub))) {
        if (f.endsWith(".md")) out.push({ name: `${sub}/${f}`, group });
      }
    } catch { /* 目录缺则跳过 */ }
  };
  scan("agents", "岗位手册");
  scan("docs", "运行文档");
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    if (existsSync(join(opsRepo, f))) out.push({ name: f, group: "总纲" });
  }
  return out;
}

function readDoc(opsRepo: string, name: string): string | undefined {
  // 只允许已知白名单前缀的相对路径，防目录逃逸。
  if (!/^([a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_.-]+\.md$/.test(name)) return undefined;
  if (!name.startsWith("agents/") && !name.startsWith("docs/") && !["AGENTS.md", "CLAUDE.md"].includes(name)) return undefined;
  try { return readFileSync(join(opsRepo, name), "utf8"); } catch { return undefined; }
}

export function createConsoleFetch(opts: ConsoleOptions): (req: Request) => Promise<Response> {
  const token = consoleToken(opts.home);
  const prefix = `/o/${token}`;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) {
      return text("not found", 404);
    }
    // 浏览器相对地址以父路径为基：/o/<tok> 下 fetch('api/x') 会落到 /o/api/x。
    // 302 到带尾斜杠形态，让页面内相对请求都留在 /o/<tok>/ 前缀内。
    if (url.pathname === prefix) return new Response(null, { status: 302, headers: { Location: `${prefix}/` } });
    const sub = url.pathname.slice(prefix.length) || "/";

    try {
      if (req.method === "GET" && sub === "/") return text(PAGE, 200, "text/html; charset=utf-8");
      if (req.method === "GET" && sub === "/ranking") {
        const { rankingPage }=await import("./ranking-page.ts");
        return text(rankingPage,200,"text/html; charset=utf-8");
      }
      if (req.method === "GET" && sub === "/api/model-ranking") {
        const { modelRankingView }=await import("./model-ranking.ts");
        return json(await modelRankingView((await opts.company()).db.db));
      }
      if(req.method==='POST'&&sub==='/api/model-ranking/preview'){
        if(req.headers.get('origin')&&req.headers.get('origin')!==url.origin)return json({error:'origin mismatch'},403);
        try{const b=await req.json() as {policy:unknown;refresh?:boolean};if(b.refresh!==undefined&&typeof b.refresh!=='boolean')throw Error('refresh');
          return json(await (await opts.company()).modelRanking.preview(b.policy,b.refresh));
        }catch{return json({error:'预览失败：请检查权重或点击更新观测'},400);}
      }
      if (req.method === "POST" && sub === "/api/model-ranking/pin") {
        if(req.headers.get("origin")&&req.headers.get("origin")!==url.origin)return json({error:"origin mismatch"},403);
        const b=await req.json() as {group?:unknown;model?:unknown;pinned?:unknown};
        if(!["sck-haiku","sck-sonnet","sck-opus"].includes(b.group as string)||typeof b.model!=="string"||!b.model||b.model.length>300||typeof b.pinned!=="boolean")return json({error:"置顶参数无效"},400);
        try {
          await (await opts.company()).modelRanking.setPin(b.group as string,b.model,b.pinned);
          return json({ok:true});
        } catch { return json({error:"置顶更新失败，请刷新后重试"},409); }
      }
      if (req.method === "POST" && sub === "/api/model-ranking") {
        if(req.headers.get("origin")&&req.headers.get("origin")!==url.origin)return json({error:"origin mismatch"},403);
        const b=await req.json() as {rules?:unknown;refreshMinutes?:unknown;policy?:unknown};
        if(typeof b.rules!=="string"||b.rules.length>8000||![2,5,10].includes(b.refreshMinutes as number))return json({error:"排序规则或刷新间隔无效"},400);
        const { saveRankingSettings }=await import("./vendor/src/model-routing/ranking.ts");
        const ctx=await opts.company();
        try{
          const {rankingPolicy}=await import('./vendor/src/model-routing/weights.ts');
          const policy=b.policy===undefined?undefined:rankingPolicy(b.policy);
          await saveRankingSettings(ctx.db.db,{rules:b.rules,refreshMinutes:b.refreshMinutes as number,policy},ctx.modelRanking);
        }catch{return json({error:'排序设置无效或保存失败'},400);}
        return json({ok:true});
      }
      if (req.method === "GET" && sub === "/api/inbox") return json(await (async()=>{const c=await opts.company();return c.upgrades?c.upgrades.inbox():c.owner.inbox();})());
      if (req.method === "GET" && sub === "/api/brief") return json(await (await opts.company()).owner.brief());
      if (req.method === "GET" && sub === "/api/tasks") {
        const goalId = url.searchParams.get("goalId") ?? "";
        const { db } = await opts.company();
        const { view, id } = await import("./vendor/src/core.ts");
        const [rows] = await db.db.query<[unknown[]]>(
          "SELECT * FROM task WHERE goal = $goal ORDER BY created_at, id;", { goal: id("goal", goalId) });
        return json({ tasks: rows.map(r => view(r as Parameters<typeof view>[0])) });
      }
      if (req.method === "GET" && sub === "/api/task") {
        const taskId = url.searchParams.get("id") ?? "";
        const { db } = await opts.company();
        const { view, id, asId } = await import("./vendor/src/core.ts");
        const task = await db.db.select<Record<string, unknown> & { id: unknown }>(id("task", taskId));
        if (!task) return json({ error: "task not found" }, 404);
        const [audit] = await db.db.query<[Array<{ action: string; actor: unknown; evidence?: string; version: number; at: unknown }>]>(
          "SELECT action, actor, evidence, version, at FROM audit WHERE task = $task ORDER BY at;", { task: task.id });
        return json({ task: view(task as unknown as Parameters<typeof view>[0]), audit: audit.map(a => ({ ...a, actor: asId(a.actor as never), at: String(a.at) })) });
      }
      if (req.method === "GET" && sub === "/api/attachments") {
        const taskId = url.searchParams.get("taskId") ?? "";
        const { listTaskAttachments } = await import("./vendor/src/attachments.ts");
        const items = await listTaskAttachments(opts.home, taskId);
        const base = opts.lanBase();
        return json({ attachments: items.map(a => ({
          ...a, url: `${base}/e/${encodeURIComponent(taskId)}/${a.relPath.split("/").map(encodeURIComponent).join("/")}`,
        })) });
      }
      if (req.method === "GET" && sub === "/api/docs") {
        const { opsRepo } = await opts.company();
        return json({ docs: listDocs(opsRepo) });
      }
      if (req.method === "GET" && sub === "/api/doc") {
        const { opsRepo } = await opts.company();
        const body = readDoc(opsRepo, url.searchParams.get("name") ?? "");
        return body === undefined ? json({ error: "not found" }, 404) : json({ name: url.searchParams.get("name"), text: body });
      }
      if (req.method === "POST" && sub === "/api/upgrade") {
        if(req.headers.get("origin") && req.headers.get("origin")!==url.origin)return json({error:"origin mismatch"},403);
        const b=await req.json() as {taskId:string;taskVersion:number;digest:string};
        const c=await opts.company();if(!c.upgrades)return json({error:"升级服务尚未就绪"},409);
        return json(await c.upgrades.start(b,SOURCE));
      }
      if (req.method === "POST" && sub === "/api/decide") {
        const b = await req.json() as { taskId?: string; decision?: string; note?: string; key?: string };
        if (!b.taskId || !["approve", "reject", "reply"].includes(b.decision ?? "")) return json({ error: "bad input" }, 400);
        const key = typeof b.key === "string" && /^[A-Za-z0-9_-]{8,72}$/.test(b.key)
          ? b.key : createHash("sha256").update(`${b.taskId}:${b.decision}:${b.note ?? ""}:${Date.now()}`).digest("hex").slice(0, 24);
        const task = await (await opts.company()).owner.decide({
          taskId: b.taskId, decision: b.decision as "approve" | "reject" | "reply",
          note: b.note ?? "", source: SOURCE, key,
        });
        return json({ ok: true, task });
      }
      if (req.method === "POST" && sub === "/api/void") {
        const b = await req.json() as { taskId?: string; note?: string; key?: string };
        if (!b.taskId || (b.note ?? "").trim().length < 2) return json({ error: "作废需要写明原因" }, 400);
        const key = typeof b.key === "string" && /^[A-Za-z0-9_-]{8,72}$/.test(b.key) ? b.key : `web-void:${b.taskId}:${Date.now()}`;
        const task = await (await opts.company()).owner.retire({ taskId: b.taskId, note: b.note!, source: SOURCE, key });
        return json({ ok: true, task });
      }
      if (req.method === "POST" && sub === "/api/revoke") {
        const b = await req.json() as { taskId?: string; note?: string };
        if (!b.taskId) return json({ error: "bad input" }, 400);
        const reason = (b.note ?? "").trim() || "老板终止在途执行";
        const r = await (await opts.company()).workforce.revokeTaskLease(b.taskId, reason,
          "【交接包】老板终止了上一棒的在途执行。先核对任务分支/授权目录中的实际改动与已有 checkpoint，再继续；不要重复已完成且已验证的步骤。",
          SOURCE);
        return json(r);
      }
      if (req.method === "POST" && sub === "/api/unlock") {
        const b = await req.json() as { taskId?: string };
        if (!b.taskId) return json({ error: "bad input" }, 400);
        const unlocked = await (await opts.company()).owner.unlockDependents({ taskId: b.taskId, source: SOURCE });
        return json({ ok: true, unlocked });
      }
      if (req.method === "POST" && sub === "/api/cancel-goal") {
        const b = await req.json() as { goalId?: string; note?: string; key?: string };
        if (!b.goalId || (b.note ?? "").trim().length < 2) return json({ error: "取消目标需要写明原因" }, 400);
        const key = typeof b.key === "string" && /^[A-Za-z0-9_-]{8,72}$/.test(b.key) ? b.key : `web-cancel:${b.goalId}:${Date.now()}`;
        const r = await (await opts.company()).owner.cancelGoal({ goalId: b.goalId, note: b.note!, source: SOURCE, key });
        return json({ ok: true, ...r });
      }
      if (req.method === "POST" && sub === "/api/notice") {
        const b = await req.json() as { key?: string };
        if (!b.key) return json({ error: "bad input" }, 400);
        await (await opts.company()).owner.resolveNotice(b.key);
        return json({ ok: true });
      }
      if (req.method === "POST" && sub === "/api/instruct") {
        const b = await req.json() as { text?: string; key?: string };
        if (!b.text || b.text.trim().length < 2) return json({ error: "bad input" }, 400);
        const key = typeof b.key === "string" && /^[A-Za-z0-9_-]{8,72}$/.test(b.key)
          ? b.key : createHash("sha256").update(`instruct:${b.text}:${Date.now()}`).digest("hex").slice(0, 24);
        const r = await (await opts.company()).owner.instruct({ text: b.text, source: SOURCE, key });
        return json({ ok: true, taskId: r.taskId });
      }
      return text("not found", 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
}

export function consoleUrl(home: string, lanBase: () => string): string {
  return `${lanBase()}/o/${consoleToken(home)}`;
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>公司审核台</title>
<style>
${relayShellCss}
</style></head><body>
<div class="shell">
<aside class="sidebar">
<div class="brand"><span class="brand-mark"><i></i><i></i></span><span><strong>Relay</strong><small>Operations</small></span></div>
<p class="nav-label">管理工作区</p>
<nav class="main-nav">
<button data-t="todo" class="on" onclick="tab('todo')">${relayIcon("inbox")}<span>待办</span><b id="nav-count" hidden></b></button>
<button data-t="goals" onclick="tab('goals')">${relayIcon("target")}<span>目标</span></button>
<button data-t="docs" onclick="tab('docs')">${relayIcon("book")}<span>手册</span></button>
<button onclick="location.href='ranking'">${relayIcon("layers")}<span>模型排序</span></button>
<button data-t="gm" onclick="tab('gm')">${relayIcon("send")}<span>给经理留言</span></button>
</nav>
<div class="sidebar-footer"><div class="operator"><span class="avatar">ML</span><span><strong>老板</strong><small>公司审核台</small></span></div></div>
</aside>
<div class="main-area">
<header class="topbar">
<div class="breadcrumb"><span>公司审核台</span><b>/</b><strong id="crumb">待办</strong></div>
<div class="top-actions"><span class="status" id="stat">加载中…</span><button class="icon-button" id="theme-btn" onclick="toggleTheme()" aria-label="切换主题"></button><button class="refresh" onclick="load()">${relayIcon("refresh")}<span>刷新</span></button></div>
</header>
<main class="content" id="m"></main>
</div>
</div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const linkify=s=>esc(s).replace(/https?:\\/\\/[^\\s"'<>）)】\\]，。；、]+/g,u=>'<a href="'+u+'" target="_blank" rel="noopener">'+u+'</a>');
const KIND={goal:'范围',task:'任务',gate:'关口',release:'上线申请',deploy:'部署实测'};
const CRUMB={todo:'待办',goals:'目标',docs:'手册',gm:'给经理留言'};
const STATE_TONE={doing:['进行中','blue'],ready:['待领取',''],blocked:['被阻塞','danger'],review:['待验收','violet'],done:['已完成','success'],void:['已作废','']};
const ICONS={check:'<path d="M5 12l4 4L19 6"/>',x:'<path d="M6 6l12 12M18 6L6 18"/>',send:'<path d="M21 3L9 15M21 3l-7 18-5-6-6-5 18-7z"/>',file:'<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/>',activity:'<path d="M3 12h4l2-7 4 14 2-7h6"/>',moon:'<path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>'};
const icon=n=>'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'+(ICONS[n]||'')+'</svg>';
const badge=(text,tone)=>'<span class="status '+(tone||'')+'"><i></i>'+esc(text)+'</span>';
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(function(){el.classList.remove('show')},2200)}
const store={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}}};
function prefTheme(){try{return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){return 'light'}}
function renderThemeBtn(){$('theme-btn').innerHTML=icon((store.get('relay-theme')||prefTheme())==='light'?'moon':'sun')}
function toggleTheme(){const next=(store.get('relay-theme')||prefTheme())==='light'?'dark':'light';store.set('relay-theme',next);document.documentElement.dataset.theme=next;renderThemeBtn()}
const savedTheme=store.get('relay-theme');if(savedTheme)document.documentElement.dataset.theme=savedTheme;
const api=async(p,o)=>{const r=await fetch('api/'+p,o?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)}:undefined);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);return j};
let INBOX=null,BRIEF=null,DOCS=null,T='todo';
function tab(t){T=t;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.t===t));$('crumb').textContent=CRUMB[t]||t;render()}
async function load(){
  $('stat').textContent='加载中…';
  // brief is only rendered on the goals tab; polling it every 20s on todo used to
  // run the heaviest aggregate query in a loop and starve the shared DB channel.
  try{
    INBOX=await api('inbox');
    if(T!=='todo'||!BRIEF)BRIEF=await api('brief');
    const g=(INBOX.gates||[]).filter(x=>!x.task.companyUpgrade).length,q=(INBOX.questions||[]).filter(x=>!x.task.companyUpgrade).length,n=g+q;
    const navBadge=$('nav-count');navBadge.textContent=n;navBadge.hidden=!n;
    const stat=$('stat');stat.textContent=n?('待办 '+n):'无待办';stat.className='status'+(n?' violet':'');
    render();}catch(e){$('stat').textContent='加载失败';}
}
async function atts(el,tid){
  try{const r=await api('attachments?taskId='+encodeURIComponent(tid));
    el.innerHTML=(r.attachments||[]).map(a=>'<a class="attachment" target="_blank" href="'+a.url+'">'+icon('file')+'<span><strong>'+esc(a.name)+'</strong><small>'+((a.sizeBytes/1024).toFixed(1))+'KB · '+esc(a.kind)+'</small></span></a>').join('')||'';
  }catch(e){}
}
const newKey=()=>'k'+Date.now().toString(36)+Math.random().toString(36).slice(2,14);
async function decide(tid,dec){
  try{
    const noteEl=$('n-'+tid),note=noteEl?noteEl.value:'';
    if(dec!=='approve'&&note.trim().length<2){alert('退回/回复需要写明说明');return}
    await api('decide',{taskId:tid,decision:dec,note,key:newKey()});
    toast(dec==='approve'?'已批准，任务继续推进':dec==='reject'?'已退回并通知提交人':'回复已发送');await load();
  }catch(e){alert(e.message)}
}
async function upgrade(tid,version,digest){
 const el=$('upgrade-'+tid);if(el){el.disabled=true;el.textContent='正在启动升级…'}
 try{await api('upgrade',{taskId:tid,taskVersion:version,digest});await load()}catch(e){alert(e.message);if(el){el.disabled=false;el.textContent='重新升级'}}
}
function upgradeCard(x){
 const p=x.plan,busy=['queued','preparing','checking','installing','verifying'].includes(x.status),done=x.status==='succeeded';
 const list=a=>'<ul>'+a.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul>';
 return '<article class="decision-card upgrade-card"><div class="card-top"><span class="type-label">公司系统升级 · '+esc(x.phase)+'</span>'+badge(done?'已完成':busy?'进行中':'待执行',done?'success':busy?'blue':'warning')+'</div>'
 +'<h3>v'+esc(p.version)+' · '+esc(p.title)+'</h3>'
 +'<div class="upgrade-cols"><div><h4>上线内容</h4>'+list(p.changes)+'<h4>影响范围</h4>'+list(p.impact)+'</div>'
 +'<div><h4>数据变化</h4><p class="upgrade-p">'+esc(p.migration)+'</p><h4>回退方式</h4><p class="upgrade-p">'+esc(p.rollback)+'</p></div></div>'
 +'<details class="sha"><summary>提交详情</summary><code>'+esc(p.sha)+'</code></details>'+(x.error?'<p class="err" role="alert">'+esc(x.error)+'</p>':'')
 +(done?'<p class="okm">升级完成，已自动回复通过</p>':'<div class="decision-actions"><button id="upgrade-'+esc(x.taskId)+'" class="approve" '+(busy?'disabled':'')+' onclick="upgrade(\\''+x.taskId+'\\','+x.taskVersion+',\\''+p.digest+'\\')">'+(busy?esc(x.phase):'升级至 v'+esc(p.version))+'</button></div>')+'</article>';
}
async function notice(key){try{await api('notice',{key});await load()}catch(e){alert(e.message)}}
async function voidTask(tid,gid){
  const note=prompt('作废原因（必填，会进任务审计）')||'';
  if(note.trim().length<2)return;
  try{await api('void',{taskId:tid,note,key:newKey()});toast('任务已作废');if(gid)reloadGoalTasks(gid);else await load()}catch(e){alert(e.message)}
}
async function revokeTask(tid,gid){
  const note=prompt('终止原因（可留空），只撤当前在途执行，任务回 ready 等下一位员工','');
  if(note===null)return;
  try{const r=await api('revoke',{taskId:tid,note});toast(r.ok?('已撤销 '+(r.employee||'')+' 的租约'):'该任务没有在途租约');if(gid)reloadGoalTasks(gid);else await load()}catch(e){alert(e.message)}
}
async function unlockTask(tid,gid){
  try{const r=await api('unlock',{taskId:tid});toast(r.unlocked&&r.unlocked.length?('已解锁：'+r.unlocked.join('、')):'没有需要解锁的任务');if(gid)reloadGoalTasks(gid);else await load()}catch(e){alert(e.message)}
}
async function cancelGoal(gid){
  const note=prompt('取消目标原因（必填），会作废其全部未完成任务并关闭目标')||'';
  if(note.trim().length<2)return;
  if(!confirm('确认取消这个目标？未完成任务将全部作废。'))return;
  try{const r=await api('cancel-goal',{goalId:gid,note,key:newKey()});toast('已作废 '+r.retired+' 个任务'+(r.remaining?('；仍有 '+r.remaining+' 个未能作废'):''));await load()}catch(e){alert(e.message)}
}
const TERMINAL=['done','void'];
function stateBadge(s){const d=STATE_TONE[s]||[s,''];return badge(d[0],d[1])}
function taskActions(t,gid){
  let h='';
  if(t.state==='doing'&&t.currentEmployee)h+='<button class="mid" onclick="revokeTask(\\''+t.id+'\\',\\''+gid+'\\')">终止在途</button>';
  if(t.state==='blocked')h+='<button class="mid" onclick="unlockTask(\\''+t.id+'\\',\\''+gid+'\\')">解锁</button>';
  if(!TERMINAL.includes(t.state))h+='<button class="no" onclick="voidTask(\\''+t.id+'\\',\\''+gid+'\\')">作废</button>';
  return h;
}
async function reloadGoalTasks(gid){
  const d=document.querySelector('#gt-'+CSS.escape(gid)+' .task-list');if(!d)return;
  try{const r=await api('tasks?goalId='+encodeURIComponent(gid));
    d.innerHTML=(r.tasks||[]).map(t=>'<div class="task-row"><strong>'+esc(t.title)+'</strong><span class="task-people">'+esc(t.executorRole)+' → '+esc(t.reviewerRole)+(t.currentEmployee?' · '+esc(t.currentEmployee):'')+'</span>'+stateBadge(t.state)+'<div class="task-acts">'+taskActions(t,gid)+'</div></div>').join('')||'<div class="task-row"><strong>（无任务）</strong></div>';
  }catch(e){d.textContent=e.message}
}
async function instruct(){
  const t=$('gm-text');if(!t.value.trim())return;
  try{await api('instruct',{text:t.value,key:newKey()});t.value='';$('gm-ok').textContent='已下达，经理稍后处理';toast('已下达给经理');await load()}catch(e){alert(e.message)}
}
async function openDoc(name,el){
  document.querySelectorAll('.docs-nav button').forEach(b=>b.classList.toggle('active',b===el));
  const view=$('doc-view');
  const slash=name.lastIndexOf('/'),base=name.slice(slash+1);
  view.innerHTML='<div class="doc-meta"><span class="doc-icon">'+icon('file')+'</span><div><p>'+esc(name)+'</p><h2>'+esc(base)+'</h2></div></div><div class="doc-info"><span>岗位手册与运行文档 · ops 仓库只读</span></div><div class="docbody">加载中…</div>';
  try{const r=await api('doc?name='+encodeURIComponent(name));view.querySelector('.docbody').textContent=r.text}catch(e){view.querySelector('.docbody').textContent=e.message}
}
function filterDocs(){
  const q=($('doc-q').value||'').toLowerCase();
  document.querySelectorAll('.docs-nav button').forEach(b=>{b.style.display=b.dataset.doc.toLowerCase().includes(q)?'':'none'});
}
async function openGoal(gid){
  const el=document.querySelector('#gt-'+CSS.escape(gid));
  if(el.dataset.open){el.dataset.open='';el.querySelector('.task-drawer')?.remove();el.classList.remove('open');return}
  el.dataset.open='1';el.classList.add('open');
  const d=document.createElement('div');d.className='task-drawer';
  d.innerHTML='<div class="task-head"><span>任务</span><span>执行 → 审核</span><span>状态</span><span></span></div><div class="task-list">加载中…</div><button class="text-button danger" onclick="cancelGoal(\\''+gid+'\\')">取消这个目标</button>';
  el.appendChild(d);
  await reloadGoalTasks(gid);
}
function stageChip(x){const tone={done:'done',active:'active',waiting:'waiting',missing:'missing'}[x.status]||'';const label={done:'已',waiting:'等',active:'进行',missing:'缺',not_required:'不需',unknown:'未知'}[x.status]||'未知';return '<span class="stage '+tone+'">'+esc(x.label)+' '+label+'</span>'}
function goalBlockerHtml(b){
  var parts=['<b>'+esc(b.kind)+'</b> · '+esc(b.summary)];
  if(b.responsibleRole)parts.push('责任：'+esc(b.responsibleRole));
  if(b.holder)parts.push('持有人：'+esc(b.holder));
  if(b.waitedMinutes!==undefined)parts.push('已等 '+b.waitedMinutes+' 分钟');
  if(b.nextTrigger)parts.push('下一触发：'+esc(b.nextTrigger));
  if(b.dependencyPath&&b.dependencyPath.length)parts.push('依赖路径：'+b.dependencyPath.map(function(p){return esc(p.title)}).join(' → ')+(b.dependencyPathTruncated?' …':''));
  if(b.handoff){var h=b.handoff.pendingAction?('待办：'+esc(b.handoff.pendingAction)):((b.handoff.completed&&b.handoff.completed.length)?('已完成 '+b.handoff.completed.length+' 项'):esc(b.handoff.kind));parts.push('交接：'+h)}
  return parts.join('；');
}
function goalFinalGateHtml(fg){
  if(!fg||!fg.taskId)return '终验：缺失';
  return '终验：《'+esc(fg.title||fg.taskId)+'》（'+esc(fg.state||'未知')+(fg.reviewerRole?'，复核 '+esc(fg.reviewerRole):'')+(fg.ownerGate?'，老板关口':'')+(fg.effective?'':'，已被替代')+'）；证据任务：'+esc((fg.evidenceTaskIds||[]).join(', ')||'无');
}
function render(){
  const m=$('m');
  if(T==='todo'){
    const gates=(INBOX?.gates||[]).filter(x=>!x.task.companyUpgrade);
    const asks=(INBOX?.questions||[]).filter(x=>!x.task.companyUpgrade);
    const notices=INBOX?.notices||[];
    const items=INBOX?.upgrades?.items||[];
    const v=INBOX?.upgrades?.current;
    const stats=[['待审批',gates.length,'验收提交等待你的决定','violet'],['待回复',asks.length,'来自执行员工的问题','amber'],['升级流程',items.filter(x=>x.status!=='succeeded').length,'公司系统版本升级','blue'],['系统通知',notices.length,'运行提醒与简报','green']];
    const statHtml='<section class="stat-grid">'+stats.map(s=>'<article class="metric-card '+s[3]+'"><span>'+s[0]+'</span><strong>'+s[1]+'</strong><small>'+s[2]+'</small><i></i></article>').join('')+'</section>';
    const head=v?'<section class="panel version-panel"><span class="type-label">当前生产版本</span><div class="version-row"><strong>v'+esc(v.version)+'</strong><code>'+esc(v.sha)+'</code></div></section>':'';
    const g=gates.map(x=>'<article class="decision-card"><div class="card-top"><span class="type-label">'+esc(KIND[x.task.kind]||x.task.kind)+'</span>'+badge('待验收','violet')+'</div>'
      +'<h3>'+esc(x.task.title)+'</h3><p class="byline">执行 '+esc(x.task.executor_role)+' · 提交人 '+esc(x.task.current_employee||'—')+'</p>'
      +'<div class="submission">'+linkify(x.submission||'（无提交说明）')+'</div>'
      +'<div class="atts" id="at-'+x.task.id+'"></div>'
      +'<label class="comment-field"><span>决策说明（批准可留空，退回必填）</span><textarea id="n-'+x.task.id+'" placeholder="补充约束、提醒或后续要求…"></textarea></label>'
      +'<div class="decision-actions"><button class="approve" onclick="decide(\\''+x.task.id+'\\',\\'approve\\')">'+icon('check')+'批准</button>'
      +'<button class="reject" onclick="decide(\\''+x.task.id+'\\',\\'reject\\')">'+icon('x')+'退回</button>'
      +'<button class="quiet" onclick="voidTask(\\''+x.task.id+'\\')">作废</button></div></article>').join('');
    const q=asks.map(x=>'<article class="decision-card"><div class="card-top"><span class="type-label">提问</span>'+badge('待回复','warning')+'</div>'
      +'<h3>'+esc(x.task.title)+'</h3><p class="byline">来自 '+esc(x.task.executor_role)+' 的问题</p>'
      +'<div class="submission">'+linkify(x.question||'（无问题文本）')+'</div>'
      +'<div class="atts" id="at-'+x.task.id+'"></div>'
      +'<label class="comment-field"><span>答复</span><textarea id="n-'+x.task.id+'" placeholder="写下清晰的口径和下一步…"></textarea></label>'
      +'<div class="decision-actions"><button class="approve" onclick="decide(\\''+x.task.id+'\\',\\'reply\\')">'+icon('send')+'回复</button></div></article>').join('');
    const n=notices.map(x=>'<div class="notice"><span>'+icon('activity')+'</span><div>'+linkify(x.text)+'</div><button onclick="notice(\\''+x.key+'\\')">已阅</button></div>').join('');
    const u=items.map(upgradeCard).join('');
    m.innerHTML=head+statHtml+((u||g||q||n)?(u+'<section class="section-bar"><div><h2>需要你的决定</h2><p>按到达时间排序，处理完会自动离开列表</p></div></section><div class="decision-grid">'+g+q+'</div>'+n):'<div class="empty">没有待办事项</div>');
    [...(INBOX?.gates||[]),...(INBOX?.questions||[])].forEach(x=>{const e=$('at-'+x.task.id);if(e)atts(e,x.task.id)});
  }else if(T==='goals'){
    var cards={};((BRIEF&&BRIEF.goalCards)||[]).forEach(function(c){cards[c.goalId]=c});
    var coverage=BRIEF&&BRIEF.goalCardCoverage;
    var rows=((BRIEF&&BRIEF.goals)||[]);
    var cover=(coverage&&coverage.omitted>0)?('<p class="meta">目标详情已展示 '+coverage.shown+'/'+coverage.total+'（按活动阻点优先；未展开的目标只显示标题）</p>'):'';
    m.innerHTML=cover+(rows.map(function(g,i){
      var c=cards[g.id];
      if(!c){return '<article class="goal-card" id="gt-'+g.id+'"><div class="goal-main"><span class="goal-index">'+(i+1)+'</span>'
        +'<div class="goal-name"><h3>'+esc(g.title)+'</h3><p class="meta">详情未展开（已展示 '+(coverage?coverage.shown:0)+'/'+(coverage?coverage.total:rows.length)+'）</p></div></div></article>'}
      var deadline=(c.deadline&&c.deadline.status==='exact'&&c.deadline.at)?('截止 '+new Date(c.deadline.at).toISOString().slice(0,10)):'截止未知';
      var stages=(c.stages||[]).map(stageChip).join('')||'<span class="stage">阶段未知</span>';
      var missing=(c.outcome&&c.outcome.missing&&c.outcome.missing.length)?('<p class="meta">缺证据：'+esc(c.outcome.missing.join(' / '))+'</p>'):'';
      var repair=c.needsRepair?('<p class="meta bad">需修复：'+esc((c.repairReasons||[]).map(function(r){return r.message}).join('；'))+'</p>'):'';
      var blockers=(c.blockers&&c.blockers.length)?('<p class="meta">当前阻点：</p>'+c.blockers.map(function(b){return '<p class="meta">'+goalBlockerHtml(b)+'</p>'}).join('')+(c.blockersOmitted?('<p class="meta">另有 '+c.blockersOmitted+' 个阻点未展示（卡片上限）</p>'):'')):'';
      var finalLine='<p class="meta">'+goalFinalGateHtml(c.finalGate)+'</p>';
      var total='<p class="meta">任务 '+(c.taskTotal||0)+' 个</p>';
      return '<article class="goal-card" id="gt-'+g.id+'"><button class="goal-main" onclick="openGoal(\\''+g.id+'\\')">'
        +'<span class="goal-index">'+(i+1)+'</span>'
        +'<div class="goal-name"><span><span class="tier">'+esc(g.tier)+'</span> '+esc(g.state)+(g.project?' · '+esc(g.project):'')+' · '+esc(deadline)+'</span>'
        +'<h3>'+esc(g.title)+'</h3><p>'+esc((g.brief||'').slice(0,140))+'</p></div>'
        +'<div class="goal-stages">'+stages+'</div>'+icon('chevron','goal-arrow')+'</button>'
        +'<div class="goal-extra">'+missing+repair+finalLine+total+blockers+'</div></article>';
    }).join('')||'<div class="empty">无在办目标</div>');
  }else if(T==='docs'){
    if(!DOCS)api('docs').then(r=>{DOCS=r.docs;render()}).catch(()=>{});
    const groups={};(DOCS||[]).forEach(d=>(groups[d.group]=groups[d.group]||[]).push(d));
    m.innerHTML='<div class="docs-shell"><aside class="docs-nav"><label class="docs-search">'+icon('file')+'<input id="doc-q" placeholder="搜索文档" oninput="filterDocs()"></label>'
      +Object.keys(groups).map(g=>'<p>'+esc(g)+'</p>'+groups[g].map(d=>'<button data-doc="'+esc(d.name)+'" onclick="openDoc(\\''+d.name+'\\',this)">'+icon('file')+'<span>'+esc(d.name)+'</span></button>').join('')).join('')
      +(DOCS?'':'<p>加载中…</p>')+'</aside><article class="doc-view" id="doc-view"><p class="empty">从左侧选择一篇手册查看</p></article></div>';
  }else{
    m.innerHTML='<div class="message-layout"><section class="compose-card"><div class="compose-head"><span class="avatar large">经</span><div><h2>发给值班经理</h2><p>写成任务派给经理，回复会出现在待办里</p></div>'+badge('在线','success')+'</div>'
      +'<label class="compose"><span>你希望经理做什么？</span><textarea id="gm-text" style="min-height:150px" placeholder="比如：盘一下 G1 的进度给我个简报"></textarea><small>写清“为什么”和“结果长什么样”，经理会自行拆解执行步骤。</small></label>'
      +'<div class="send-row"><button class="primary" onclick="instruct()">'+icon('send')+'下达给经理</button></div><p class="okm" id="gm-ok"></p></section></div>';
  }
}
const startTab=location.hash.slice(1);
if(CRUMB[startTab])T=startTab;
document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.t===T));
$('crumb').textContent=CRUMB[T]||T;
renderThemeBtn();render();
load();setInterval(()=>{if(T==='todo')load()},20000);
</script></body></html>`;
