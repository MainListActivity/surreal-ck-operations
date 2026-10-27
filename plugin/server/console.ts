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
import { relayWebTheme } from "../shared/relay-design.ts";

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
${relayWebTheme}*{box-sizing:border-box}
body{margin:0;font:15px/1.55 -apple-system,system-ui,sans-serif;background:var(--relay-bg);color:var(--relay-text)}
header{position:sticky;top:0;background:var(--relay-panel);border-bottom:1px solid var(--relay-border);padding:12px 16px;display:flex;gap:12px;align-items:center;z-index:9}
header b{font-size:16px}header span{color:var(--relay-muted);font-size:12px}
nav{display:flex;gap:4px;padding:8px 12px;background:var(--relay-input);border-bottom:1px solid var(--relay-border);position:sticky;top:49px;z-index:8;overflow-x:auto}
nav button{background:none;border:1px solid var(--relay-border);border-radius:8px;color:var(--relay-muted);padding:6px 12px;font-size:13px;white-space:nowrap}
nav button.on{color:#fff;border-color:var(--relay-accent);background:var(--relay-control)}
main{padding:12px;max-width:760px;margin:0 auto}
.card{background:var(--relay-panel);border:1px solid var(--relay-border);border-radius:12px;padding:14px;margin-bottom:12px}
.card h3{margin:0 0 4px;font-size:15px}
.meta{color:var(--relay-muted);font-size:12px;margin-bottom:8px;word-break:break-all}
.body{white-space:pre-wrap;word-break:break-word;font-size:14px;color:var(--relay-text);max-height:300px;overflow:auto;background:var(--relay-input);border-radius:8px;padding:10px;margin:8px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
button.act{border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600}
.ok{background:#2f7d4f;color:#fff}.no{background:#8a3a3a;color:#fff}.mid{background:var(--relay-accent);color:#fff}
button:disabled{opacity:.5}
textarea{width:100%;background:var(--relay-input);border:1px solid var(--relay-border);border-radius:8px;color:var(--relay-text);padding:8px;font:14px/1.5 inherit;min-height:60px;margin-top:8px}
a{color:var(--relay-score);word-break:break-all}
.att{display:block;padding:8px 10px;background:var(--relay-input);border-radius:8px;margin-top:6px;font-size:13px}
.empty{color:var(--relay-faint);text-align:center;padding:30px 0}
.notice{display:flex;justify-content:space-between;gap:10px;align-items:center}
.notice button{background:var(--relay-border);color:var(--relay-text);border:none;border-radius:8px;padding:6px 12px;font-size:13px}
.doc{cursor:pointer;padding:9px 10px;background:var(--relay-input);border-radius:8px;margin-top:6px;font-size:14px}
.trow{padding:10px 0;border-top:1px solid var(--relay-border)}
.trow:first-child{border-top:none}
.trow .row{margin-top:6px}
.trow .act{padding:6px 12px;font-size:13px}
.docbody{white-space:pre-wrap;font:13px/1.6 ui-monospace,Menlo,monospace;background:var(--relay-input);border-radius:8px;padding:12px;margin-top:8px;max-height:60vh;overflow:auto}
.tier{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--relay-border);color:var(--relay-muted)}
.st{font-size:11px;color:var(--relay-muted)}
.glist .card{cursor:default}
.err{color:var(--relay-danger);font-size:13px;margin-top:8px;white-space:pre-wrap}
.okm{color:var(--relay-success);font-size:13px;margin-top:8px}
h4.sec{color:var(--relay-muted);font-size:12px;letter-spacing:.08em;margin:20px 0 8px}

header{height:68px;padding:0 4vw;background:var(--relay-bg)}header .brand-mark{width:30px;height:30px;display:grid;place-items:center;border-radius:9px;background:var(--relay-accent);color:white;font-size:14px;font-weight:700}
nav{top:68px;background:var(--relay-bg);padding:10px 4vw;gap:7px}nav button{border-color:transparent;border-radius:9px}nav button.on{background:var(--relay-tab);color:var(--relay-score);border-color:var(--relay-border)}
main{max-width:1240px;width:92vw;padding:30px 0 60px}.card{border-radius:16px;padding:22px;box-shadow:var(--relay-shadow)}textarea{border-radius:13px;padding:14px}.refresh-button{margin-left:auto;background:var(--relay-control);color:var(--relay-text);border:1px solid var(--relay-border);border-radius:9px;padding:7px 12px}
@media(max-width:600px){header{height:60px;padding:0 18px}nav{top:60px;padding:8px 12px}main{width:auto;padding:20px 12px 40px}.card{padding:16px}}
</style></head><body>
<header><span class="brand-mark">M</span><b>公司审核台</b><span id="stat"></span><button onclick="load()" class="refresh-button">刷新</button></header>
<nav>
<button data-t="todo" class="on" onclick="tab('todo')">待办</button>
<button data-t="goals" onclick="tab('goals')">目标</button>
<button data-t="docs" onclick="tab('docs')">手册</button>
<button onclick="location.href='ranking'">模型排序</button>
<button data-t="gm" onclick="tab('gm')">给经理留言</button>
</nav>
<main id="m"></main>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const linkify=s=>esc(s).replace(/https?:\\/\\/[^\\s"'<>）)】\\]，。；、]+/g,u=>'<a href="'+u+'" target="_blank" rel="noopener">'+u+'</a>');
const KIND={goal:'范围',task:'任务',gate:'关口',release:'上线申请',deploy:'部署实测'};
const api=async(p,o)=>{const r=await fetch('api/'+p,o?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)}:undefined);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);return j};
let INBOX=null,BRIEF=null,DOCS=null,T='todo';
function tab(t){T=t;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));render()}
async function load(){
  document.getElementById('stat').textContent='加载中…';
  // brief is only rendered on the goals tab; polling it every 20s on todo used to
  // run the heaviest aggregate query in a loop and starve the shared DB channel.
  try{
    INBOX=await api('inbox');
    if(T!=='todo'||!BRIEF)BRIEF=await api('brief');
    const n=(INBOX.gates?.length||0)+(INBOX.questions?.length||0);
    document.getElementById('stat').textContent=n?('待办 '+n):'无待办';
    render();}catch(e){document.getElementById('stat').textContent='加载失败';}
}
async function atts(el,tid){
  try{const r=await api('attachments?taskId='+encodeURIComponent(tid));
    el.innerHTML=(r.attachments||[]).map(a=>'<a class="att" target="_blank" href="'+a.url+'">'+esc(a.name)+' · '+((a.sizeBytes/1024).toFixed(1))+'KB · '+esc(a.kind)+'</a>').join('')||'';
  }catch(e){}
}
const newKey=()=>'k'+Date.now().toString(36)+Math.random().toString(36).slice(2,14);
async function decide(tid,dec){
  try{
    const noteEl=document.getElementById('n-'+tid),note=noteEl?noteEl.value:'';
    if(dec!=='approve'&&note.trim().length<2){alert('退回/回复需要写明说明');return}
    await api('decide',{taskId:tid,decision:dec,note,key:newKey()});await load();
  }catch(e){alert(e.message)}
}
async function upgrade(tid,version,digest){
 const el=document.getElementById('upgrade-'+tid);if(el){el.disabled=true;el.textContent='正在启动升级…'}
 try{await api('upgrade',{taskId:tid,taskVersion:version,digest});await load()}catch(e){alert(e.message);if(el){el.disabled=false;el.textContent='重新升级'}}
}
function upgradeCard(x){
 const p=x.plan,busy=['queued','preparing','checking','installing','verifying'].includes(x.status),done=x.status==='succeeded';
 const list=a=>'<ul>'+a.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul>';
 return '<div class="card"><div class="meta">公司系统升级 · '+esc(x.phase)+'</div><h3>v'+esc(p.version)+' · '+esc(p.title)+'</h3>'+
 '<h4>上线内容</h4>'+list(p.changes)+'<h4>影响范围</h4>'+list(p.impact)+'<h4>数据变化</h4><p>'+esc(p.migration)+'</p><h4>回退方式</h4><p>'+esc(p.rollback)+'</p>'+
 '<details><summary>提交详情</summary><code>'+esc(p.sha)+'</code></details>'+(x.error?'<p role="alert">'+esc(x.error)+'</p>':'')+
 (!done?'<button id="upgrade-'+esc(x.taskId)+'" class="act ok" '+(busy?'disabled':'')+' onclick="upgrade(\\''+x.taskId+'\\','+x.taskVersion+',\\''+p.digest+'\\')">'+(busy?esc(x.phase):'升级至 v'+esc(p.version))+'</button>':'<p class="okm">升级完成，已自动回复通过</p>')+'</div>';
}
async function notice(key){try{await api('notice',{key});await load()}catch(e){alert(e.message)}}
async function voidTask(tid,gid){
  const note=prompt('作废原因（必填，会进任务审计）')||'';
  if(note.trim().length<2)return;
  try{await api('void',{taskId:tid,note,key:newKey()});if(gid)reloadGoalTasks(gid);else await load()}catch(e){alert(e.message)}
}
async function revokeTask(tid,gid){
  const note=prompt('终止原因（可留空），只撤当前在途执行，任务回 ready 等下一位员工','');
  if(note===null)return;
  try{const r=await api('revoke',{taskId:tid,note});alert(r.ok?('已撤销 '+(r.employee||'')+' 的租约'):'该任务没有在途租约');if(gid)reloadGoalTasks(gid);else await load()}catch(e){alert(e.message)}
}
async function unlockTask(tid,gid){
  try{const r=await api('unlock',{taskId:tid});alert(r.unlocked&&r.unlocked.length?('已解锁：'+r.unlocked.join('、')):'没有需要解锁的任务');if(gid)reloadGoalTasks(gid);else await load()}catch(e){alert(e.message)}
}
async function cancelGoal(gid){
  const note=prompt('取消目标原因（必填），会作废其全部未完成任务并关闭目标')||'';
  if(note.trim().length<2)return;
  if(!confirm('确认取消这个目标？未完成任务将全部作废。'))return;
  try{const r=await api('cancel-goal',{goalId:gid,note,key:newKey()});alert('已作废 '+r.retired+' 个任务'+(r.remaining?('；仍有 '+r.remaining+' 个未能作废，目标保持原状'):'，目标已关闭'));await load()}catch(e){alert(e.message)}
}
const TERMINAL=['done','void'];
function taskActions(t,gid){
  let h='';
  if(t.state==='doing'&&t.currentEmployee)h+='<button class="act mid" onclick="revokeTask(\\''+t.id+'\\',\\''+gid+'\\')">终止在途</button>';
  if(t.state==='blocked')h+='<button class="act mid" onclick="unlockTask(\\''+t.id+'\\',\\''+gid+'\\')">解锁</button>';
  if(!TERMINAL.includes(t.state))h+='<button class="act no" onclick="voidTask(\\''+t.id+'\\',\\''+gid+'\\')">作废</button>';
  return h;
}
async function reloadGoalTasks(gid){
  const d=document.getElementById('gt-'+gid)?.querySelector('.docbody');if(!d)return;
  try{const r=await api('tasks?goalId='+encodeURIComponent(gid));
    d.innerHTML=(r.tasks||[]).map(t=>'<div class="trow"><div class="meta">['+esc(t.state)+'] '+esc(t.executorRole)+'→'+esc(t.reviewerRole)+(t.currentEmployee?' · '+esc(t.currentEmployee):'')+'</div><div>'+esc(t.title)+'</div><div class="row">'+taskActions(t,gid)+'</div></div>').join('')||'（无任务）';
  }catch(e){d.textContent=e.message}
}
async function instruct(){
  const t=document.getElementById('gm-text');if(!t.value.trim())return;
  try{await api('instruct',{text:t.value,key:newKey()});t.value='';document.getElementById('gm-ok').textContent='已下达，经理稍后处理';await load()}catch(e){alert(e.message)}
}
async function openDoc(name,el){
  if(el.dataset.open){el.dataset.open='';el.nextSibling.remove();return}
  el.dataset.open='1';const d=document.createElement('div');d.className='docbody';d.textContent='加载中…';el.after(d);
  try{const r=await api('doc?name='+encodeURIComponent(name));d.textContent=r.text}catch(e){d.textContent=e.message}
}
async function openGoal(gid){
  const el=document.getElementById('gt-'+gid);
  if(el.dataset.open){el.dataset.open='';el.querySelector('.docbody')?.remove();return}
  el.dataset.open='1';const d=document.createElement('div');d.className='docbody';d.textContent='加载中…';el.appendChild(d);
  await reloadGoalTasks(gid);
}
function render(){
  const m=document.getElementById('m');
  if(T==='todo'){
    const g=(INBOX?.gates||[]).filter(x=>!x.task.companyUpgrade).map(x=>\`<div class="card"><h3>\${esc(x.task.title)}</h3>
      <div class="meta">\${KIND[x.task.kind]||x.task.kind} · 执行 \${esc(x.task.executor_role)} · 提交人 \${esc(x.task.current_employee||'—')}</div>
      <div class="body">\${linkify(x.submission||'（无提交说明）')}</div>
      <div class="atts" id="at-\${x.task.id}"></div>
      <textarea id="n-\${x.task.id}" placeholder="说明（批准可留空，退回必填）"></textarea>
      <div class="row"><button class="act ok" onclick="decide('\${x.task.id}','approve')">批准</button>
      <button class="act no" onclick="decide('\${x.task.id}','reject')">退回</button>
      <button class="act no" onclick="voidTask('\${x.task.id}')">作废</button></div></div>\`).join('');
    const q=(INBOX?.questions||[]).filter(x=>!x.task.companyUpgrade).map(x=>\`<div class="card"><h3>\${esc(x.task.title)}</h3>
      <div class="meta">来自 \${esc(x.task.executor_role)} 的问题</div>
      <div class="body">\${linkify(x.question||'（无问题文本）')}</div>
      <div class="atts" id="at-\${x.task.id}"></div>
      <textarea id="n-\${x.task.id}" placeholder="答复"></textarea>
      <div class="row"><button class="act mid" onclick="decide('\${x.task.id}','reply')">回复</button></div></div>\`).join('');
    const n=(INBOX?.notices||[]).map(x=>\`<div class="card notice"><span>\${linkify(x.text)}</span><button onclick="notice('\${x.key}')">已阅</button></div>\`).join('');
    const u=(INBOX?.upgrades?.items||[]).map(upgradeCard).join('');
    const v=INBOX?.upgrades?.current;
    const head=v?'<div class="card"><strong>当前版本 v'+esc(v.version)+'</strong><details><summary>提交详情</summary><code>'+esc(v.sha)+'</code></details></div>':'';
    m.innerHTML=head+((u||g||q||n)?(u+g+q+n):'<div class="empty">没有待办事项</div>');
    [...(INBOX?.gates||[]),...(INBOX?.questions||[])].forEach(x=>{const e=document.getElementById('at-'+x.task.id);if(e)atts(e,x.task.id)});
  }else if(T==='goals'){
    var cards={};((BRIEF&&BRIEF.goalCards)||[]).forEach(function(c){cards[c.goalId]=c});
    m.innerHTML=((BRIEF&&BRIEF.goals)||[]).map(function(g){
      var c=cards[g.id]||{};
      var deadline=(c.deadline&&c.deadline.status==='exact'&&c.deadline.at)?('截止 '+new Date(c.deadline.at).toISOString()):'截止未知';
      var stages=(c.stages||[]).map(function(x){return esc(x.label)+'='+({done:'已',waiting:'等',active:'进行',missing:'缺',not_required:'不需',unknown:'未知'}[x.status]||'未知')}).join(' · ');
      var missing=(c.outcome&&c.outcome.missing&&c.outcome.missing.length)?('<div class="meta">缺证据：'+esc(c.outcome.missing.join(' / '))+'</div>'):'';
      var repair=c.needsRepair?('<div class="meta" style="color:#b00">需修复：'+esc((c.repairReasons||[]).map(function(r){return r.message}).join('；'))+'</div>'):'';
      var blockers=(c.blockers&&c.blockers.length)?('<div class="body" style="max-height:160px"><b>当前阻点</b><br>'+c.blockers.map(function(b){return esc(b.kind)+' · '+esc(b.summary)+(b.nextTrigger?(' · 下一触发 '+esc(b.nextTrigger)):'')+(b.waitedMinutes!==undefined?(' · 已等 '+b.waitedMinutes+' 分钟'):'')}).join('<br>')+'</div>'):'';
      return '<div class="card glist" id="gt-'+g.id+'"><h3>'+esc(g.title)+'</h3><div class="meta"><span class="tier">'+esc(g.tier)+'</span> <span class="st">'+esc(g.state)+'</span> '+(g.project?esc(g.project):'')+' · '+esc(deadline)+'</div><div class="meta">阶段：'+stages+'</div>'+missing+repair+blockers+'<div class="body" style="max-height:120px">'+esc(g.brief||'')+'</div><div class="row"><button class="act mid" onclick="openGoal(\\''+g.id+'\\')">查看任务</button><button class="act no" onclick="cancelGoal(\\''+g.id+'\\')">取消目标</button></div></div>';
    }).join('')||'<div class="empty">无在办目标</div>';
  }else if(T==='docs'){
    if(!DOCS)api('docs').then(r=>{DOCS=r.docs;render()}).catch(()=>{});
    const groups={};(DOCS||[]).forEach(d=>(groups[d.group]=groups[d.group]||[]).push(d));
    m.innerHTML=Object.keys(groups).map(g=>'<h4 class="sec">'+esc(g)+'</h4>'+groups[g].map(d=>'<div class="doc" onclick="openDoc(\\''+d.name+'\\',this)">'+esc(d.name)+'</div>').join('')).join('')||'<div class="empty">加载中…</div>';
  }else{
    m.innerHTML='<div class="card"><h3>给经理留言</h3><div class="meta">写成任务派给经理，回复在收件箱里看</div><textarea id="gm-text" style="min-height:120px" placeholder="比如：盘一下 G1 的进度给我个简报"></textarea><div class="row"><button class="act mid" onclick="instruct()">下达</button></div><div class="okm" id="gm-ok"></div></div>';
  }
}
load();setInterval(()=>{if(T==='todo')load()},20000);
</script></body></html>`;
