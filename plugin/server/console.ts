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

type CompanyApi = {
  owner: {
    inbox(): Promise<unknown>;
    brief(): Promise<unknown>;
    decide(input: { taskId: string; decision: "approve" | "reject" | "reply"; note: string; source: string; key: string }): Promise<unknown>;
    resolveNotice(key: string): Promise<void>;
    instruct(input: { text: string; source: string; key: string }): Promise<{ taskId: string }>;
  };
  db: { db: {
    query<T>(q: string, vars?: Record<string, unknown>): Promise<T>;
    select<T>(record: unknown): Promise<T | undefined>;
  } };
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
      if (req.method === "GET" && sub === "/api/inbox") return json(await (await opts.company()).owner.inbox());
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
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:15px/1.55 -apple-system,system-ui,sans-serif;background:#0d0f14;color:#e6e8ee}
header{position:sticky;top:0;background:#161a22;border-bottom:1px solid #262b38;padding:12px 16px;display:flex;gap:12px;align-items:center;z-index:9}
header b{font-size:16px}header span{color:#8b93a7;font-size:12px}
nav{display:flex;gap:4px;padding:8px 12px;background:#11141b;border-bottom:1px solid #262b38;position:sticky;top:49px;z-index:8;overflow-x:auto}
nav button{background:none;border:1px solid #2a3140;border-radius:8px;color:#9aa3b8;padding:6px 12px;font-size:13px;white-space:nowrap}
nav button.on{color:#fff;border-color:#4d8dff;background:#1b2740}
main{padding:12px;max-width:760px;margin:0 auto}
.card{background:#161a22;border:1px solid #262b38;border-radius:12px;padding:14px;margin-bottom:12px}
.card h3{margin:0 0 4px;font-size:15px}
.meta{color:#8b93a7;font-size:12px;margin-bottom:8px;word-break:break-all}
.body{white-space:pre-wrap;word-break:break-word;font-size:14px;color:#cfd5e3;max-height:300px;overflow:auto;background:#10131a;border-radius:8px;padding:10px;margin:8px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
button.act{border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600}
.ok{background:#2f7d4f;color:#fff}.no{background:#8a3a3a;color:#fff}.mid{background:#2a4d8f;color:#fff}
button:disabled{opacity:.5}
textarea{width:100%;background:#10131a;border:1px solid #2a3140;border-radius:8px;color:#e6e8ee;padding:8px;font:14px/1.5 inherit;min-height:60px;margin-top:8px}
a{color:#6fa3ff;word-break:break-all}
.att{display:block;padding:8px 10px;background:#10131a;border-radius:8px;margin-top:6px;font-size:13px}
.empty{color:#67707f;text-align:center;padding:30px 0}
.notice{display:flex;justify-content:space-between;gap:10px;align-items:center}
.notice button{background:#2a3140;color:#cfd5e3;border:none;border-radius:8px;padding:6px 12px;font-size:13px}
.doc{cursor:pointer;padding:9px 10px;background:#10131a;border-radius:8px;margin-top:6px;font-size:14px}
.docbody{white-space:pre-wrap;font:13px/1.6 ui-monospace,Menlo,monospace;background:#10131a;border-radius:8px;padding:12px;margin-top:8px;max-height:60vh;overflow:auto}
.tier{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid #2a3140;color:#9aa3b8}
.st{font-size:11px;color:#8b93a7}
.glist .card{cursor:default}
.err{color:#ff9a9a;font-size:13px;margin-top:8px;white-space:pre-wrap}
.okm{color:#7fd0a0;font-size:13px;margin-top:8px}
h4.sec{color:#9aa3b8;font-size:12px;letter-spacing:.08em;margin:20px 0 8px}
</style></head><body>
<header><b>公司审核台</b><span id="stat"></span><button onclick="load()" style="margin-left:auto;background:#2a3140;color:#cfd5e3;border:none;border-radius:8px;padding:6px 12px">刷新</button></header>
<nav>
<button data-t="todo" class="on" onclick="tab('todo')">待办</button>
<button data-t="goals" onclick="tab('goals')">目标</button>
<button data-t="docs" onclick="tab('docs')">手册</button>
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
  try{[INBOX,BRIEF]=await Promise.all([api('inbox'),api('brief')]);
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
async function notice(key){try{await api('notice',{key});await load()}catch(e){alert(e.message)}}
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
  try{const r=await api('tasks?goalId='+encodeURIComponent(gid));
    d.textContent=(r.tasks||[]).map(t=>'['+t.state+'] '+t.title+'  ('+t.executor_role+'→'+t.reviewer_role+')').join('\\n')||'（无任务）';
  }catch(e){d.textContent=e.message}
}
function render(){
  const m=document.getElementById('m');
  if(T==='todo'){
    const g=(INBOX?.gates||[]).map(x=>\`<div class="card"><h3>\${esc(x.task.title)}</h3>
      <div class="meta">\${KIND[x.task.kind]||x.task.kind} · 执行 \${esc(x.task.executor_role)} · 提交人 \${esc(x.task.current_employee||'—')}</div>
      <div class="body">\${linkify(x.submission||'（无提交说明）')}</div>
      <div class="atts" id="at-\${x.task.id}"></div>
      <textarea id="n-\${x.task.id}" placeholder="说明（批准可留空，退回必填）"></textarea>
      <div class="row"><button class="act ok" onclick="decide('\${x.task.id}','approve')">批准</button>
      <button class="act no" onclick="decide('\${x.task.id}','reject')">退回</button></div></div>\`).join('');
    const q=(INBOX?.questions||[]).map(x=>\`<div class="card"><h3>\${esc(x.task.title)}</h3>
      <div class="meta">来自 \${esc(x.task.executor_role)} 的问题</div>
      <div class="body">\${linkify(x.question||'（无问题文本）')}</div>
      <div class="atts" id="at-\${x.task.id}"></div>
      <textarea id="n-\${x.task.id}" placeholder="答复"></textarea>
      <div class="row"><button class="act mid" onclick="decide('\${x.task.id}','reply')">回复</button></div></div>\`).join('');
    const n=(INBOX?.notices||[]).map(x=>\`<div class="card notice"><span>\${linkify(x.text)}</span><button onclick="notice('\${x.key}')">已阅</button></div>\`).join('');
    m.innerHTML=(g||q||n)?(g+q+n):'<div class="empty">没有待办事项</div>';
    [...(INBOX?.gates||[]),...(INBOX?.questions||[])].forEach(x=>{const e=document.getElementById('at-'+x.task.id);if(e)atts(e,x.task.id)});
  }else if(T==='goals'){
    m.innerHTML=(BRIEF?.goals||[]).map(g=>\`<div class="card glist" id="gt-\${g.id}"><h3>\${esc(g.title)}</h3>
      <div class="meta"><span class="tier">\${esc(g.tier)}</span> <span class="st">\${esc(g.state)}</span> \${g.project?esc(g.project):''}</div>
      <div class="body" style="max-height:120px">\${esc(g.brief||'')}</div>
      <div class="row"><button class="act mid" onclick="openGoal('\${g.id}')">查看任务</button></div></div>\`).join('')||'<div class="empty">无在办目标</div>';
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
