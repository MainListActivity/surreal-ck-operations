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
import { relayShellCss, relayIcon, RELAY_ICON_PATHS } from "../shared/relay-shell.ts";
import { createOwnerApiFetch } from "./owner-api.ts";

type CompanyApi = {
  upgrades?: import("./vendor/src/company-upgrades.ts").CompanyUpgrades;
  owner: {
    inbox(): Promise<unknown>;
    brief(): Promise<unknown>;
    decide(input: { taskId: string; decision: "approve" | "reject" | "reply"; note: string; source: string; key: string }): Promise<unknown>;
    retire(input: { taskId: string; note: string; source: string; key: string }): Promise<unknown>;
    resolveNotice(key: string): Promise<void>;
    instruct(input: { text: string; source: string; key: string }): Promise<{ taskId: string }>;
  };
  workforce: {
    revokeTaskLease(taskId: string, reason: string, handover: string, actor: string): Promise<{ ok: boolean; employee?: string }>;
  };
  db: { db: import("surrealdb").Surreal };
  modelRouting: import("./vendor/src/model-routing/controller.ts").ModelRoutingController;
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
  const ownerFetch = createOwnerApiFetch({ home: opts.home, company: opts.company as () => Promise<import("./company.ts").Company> });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // 编制外 agent 的 /api/owner/* 接口：Bearer 鉴权，路径独立于 /o/<token>/。
    if (url.pathname.startsWith("/api/owner/")) return ownerFetch(req);
    // 页面自身的写操作：/o/<token>/owner/<cmd> 与 /api/owner/* 走同一个 Bearer 校验与处理器，
    // 这样签名面（没有 /api/owner/* 路由）上打开的页面也能用完整命令。
    if (req.method === "POST" && url.pathname.startsWith(prefix + "/owner/")) {
      if (req.headers.get("origin") && req.headers.get("origin") !== url.origin) return json({ error: "origin mismatch" }, 403);
      const command = url.pathname.slice((prefix + "/owner/").length);
      if (!command || command.includes("/")) return json({ error: "not found" }, 404);
      const body = await req.text();
      return ownerFetch(new Request(new URL(`/api/owner/${command}`, url.origin).toString(), {
        method: "POST", headers: req.headers, body,
      }));
    }
    // 页面自身换出 Bearer：/o/<token>/ 路径只证明打开了这个页面。
    if (req.method === "POST" && url.pathname === prefix + "/api/exchange") {
      const body = await req.json().catch(() => ({})) as { pageToken?: string };
      if (body.pageToken !== token) return json({ error: "invalid page token" }, 401);
      const { ensureOwnerToken } = await import("./vendor/src/owner-token.ts");
      return json({ ownerToken: ensureOwnerToken(opts.home) });
    }
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
      if(req.method==='GET'&&sub==='/api/model-catalog'){
        try{const {ownerModelCatalog}=await import('./owner-actions.ts');return json(await ownerModelCatalog(await opts.company(),{query:url.searchParams.get('query')??'',offset:Number(url.searchParams.get('offset')??0),limit:40}));}
        catch{return json({error:'模型目录读取失败'},400);}
      }
      if(req.method==='POST'&&['/api/model-membership','/api/model-alias'].includes(sub)){
        if(req.headers.get('origin')&&req.headers.get('origin')!==url.origin)return json({error:'origin mismatch'},403);
        try{
          const b=await req.json();
          if(sub==='/api/model-membership'){
            const {ownerModelMembership}=await import('./owner-actions.ts');
            return json(await ownerModelMembership(await opts.company(),b));
          }
          const {ownerModelAlias}=await import('./owner-actions.ts');
          return json(await ownerModelAlias(await opts.company(),b as {model?:unknown;slug?:unknown}));
        }catch(error){return json({error:(error as Error).message.slice(0,300)},409);}
      }
      if (req.method === "GET" && sub === "/api/model-ranking") {
        const { ownerModelRanking }=await import("./owner-actions.ts");
        return json(await ownerModelRanking(await opts.company()));
      }
      if(req.method==='POST'&&sub==='/api/model-ranking/preview'){
        if(req.headers.get('origin')&&req.headers.get('origin')!==url.origin)return json({error:'origin mismatch'},403);
        try{const b=await req.json() as {policy:unknown;refresh?:boolean};
          const {ownerModelRankingPreview}=await import('./owner-actions.ts');
          return json(await ownerModelRankingPreview(await opts.company(),b.policy,b.refresh));
        }catch{return json({error:'预览失败：请检查权重或点击更新观测'},400);}
      }
      if (req.method === "POST" && sub === "/api/model-ranking/pin") {
        if(req.headers.get("origin")&&req.headers.get("origin")!==url.origin)return json({error:"origin mismatch"},403);
        const b=await req.json() as {group?:unknown;model?:unknown;pinned?:unknown};
        try {
          const {ownerModelRankingPin}=await import('./owner-actions.ts');
          return json(await ownerModelRankingPin(await opts.company(),b));
        } catch (error) {
          const invalid = /invalid/.test((error as Error).message);
          return json({error:invalid?"置顶参数无效":"置顶更新失败，请刷新后重试"},invalid?400:409);
        }
      }
      if (req.method === "POST" && sub === "/api/model-ranking") {
        if(req.headers.get("origin")&&req.headers.get("origin")!==url.origin)return json({error:"origin mismatch"},403);
        try{
          const b=await req.json() as {rules?:unknown;refreshMinutes?:unknown;policy?:unknown};
          const {ownerModelRankingSave}=await import('./owner-actions.ts');
          return json(await ownerModelRankingSave(await opts.company(),b));
        }catch{return json({error:'排序设置无效或保存失败'},400);}
      }
      if (req.method === "GET" && sub === "/api/inbox") return json(await (async()=>{const c=await opts.company();return c.upgrades?c.upgrades.inbox():c.owner.inbox();})());
      if (req.method === "GET" && sub === "/api/brief") return json(await (await opts.company()).owner.brief());
      if (req.method === "GET" && sub === "/api/tasks") {
        const tag = url.searchParams.get("tag") ?? "";
        const { db } = await opts.company();
        const { view } = await import("./vendor/src/core.ts");
        const [rows] = await db.db.query<[unknown[]]>(
          tag ? "SELECT * FROM task WHERE tag = $tag ORDER BY created_at, id;" : "SELECT * FROM task ORDER BY created_at, id LIMIT 500;",
          tag ? { tag } : {});
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
      if(req.method==='POST'&&sub==='/api/upgrade/automatic'){
        if(req.headers.get('origin')&&req.headers.get('origin')!==url.origin)return json({error:'origin mismatch'},403);
        const b=await req.json() as {enabled?:unknown};if(typeof b.enabled!=='boolean')return json({error:'enabled must be boolean'},400);
        const c=await opts.company();if(!c.upgrades)return json({error:'升级服务尚未就绪'},409);
        return json(await c.upgrades.setAuto(b.enabled,SOURCE));
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
<title>公司 · 目标进度</title>
<style>
${relayShellCss}
:root{--flow-w:1180px}
.shell{grid-template-columns:220px minmax(0,1fr)}
.main-area{display:grid;grid-template-rows:62px minmax(0,1fr)}
.content{width:100%;max-width:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr) 360px;min-height:calc(100vh - 62px)}
.flow-pane{min-width:0;overflow:auto;padding:var(--relay-sp-18) var(--relay-sp-20) var(--relay-sp-40)}
.chain-rail{display:flex;gap:var(--relay-sp-8);overflow-x:auto;padding-bottom:var(--relay-sp-12);margin-bottom:var(--relay-sp-12)}
.chain-chip{flex:none;min-width:180px;max-width:240px;padding:var(--relay-sp-10) var(--relay-sp-12);border:1px solid var(--relay-border);border-radius:var(--relay-r-10);background:var(--relay-panel);cursor:pointer;text-align:left;color:var(--relay-text)}
.chain-chip.active{border-color:var(--relay-accent-border);background:var(--relay-accent-soft)}
.chain-chip strong{display:block;font-size:var(--relay-fs-12);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chain-chip small{display:block;color:var(--relay-faint);font-size:var(--relay-fs-10);margin-top:var(--relay-sp-4)}
.chain-chip .chip-cancel{height:22px;padding:0 var(--relay-sp-7);margin-left:var(--relay-sp-6);border:1px solid var(--relay-warning);border-radius:var(--relay-r-6);background:transparent;color:var(--relay-warning);font-size:var(--relay-fs-10);font-weight:700;cursor:pointer}
.flow-head .row{display:flex;gap:var(--relay-sp-7);flex-wrap:wrap}
.retired-box{margin-top:var(--relay-sp-16);padding:var(--relay-sp-12);border:1px solid var(--relay-border);border-radius:var(--relay-r-12);background:var(--relay-panel)}
.retired-box h3{margin:0 0 var(--relay-sp-8);font-size:var(--relay-fs-13)}
.flow-head{display:flex;align-items:center;justify-content:space-between;gap:var(--relay-sp-12);margin:var(--relay-sp-8) 0 var(--relay-sp-12);flex-wrap:wrap}
.flow-head h1{margin:0;font-size:var(--relay-fs-20);letter-spacing:-.02em}
.flow-legend{display:flex;gap:var(--relay-sp-12);flex-wrap:wrap;color:var(--relay-muted);font-size:var(--relay-fs-10)}
.flow-legend span{display:inline-flex;align-items:center;gap:var(--relay-sp-5)}
.flow-legend i{width:18px;height:2px;display:inline-block;background:var(--relay-accent)}
.flow-legend i.dash{background:repeating-linear-gradient(90deg,var(--relay-border-strong) 0 4px,transparent 4px 7px)}
.flow-legend i.hold{background:var(--relay-warning)}
.flow-legend i.block{background:var(--relay-danger)}
.graph-scroll{overflow-x:auto;border:1px solid var(--relay-border);border-radius:var(--relay-r-14);background:var(--relay-panel)}
.graph{display:block}
.lane-label{font:700 var(--relay-fs-10) ui-monospace,Menlo,monospace;fill:var(--relay-faint);letter-spacing:.08em}
.lane-line{stroke:var(--relay-border);stroke-width:1}
.node-box{fill:var(--relay-panel-soft);stroke:var(--relay-border-strong);stroke-width:1.2;rx:9}
.node-box.active{stroke:var(--relay-accent);fill:var(--relay-accent-soft)}
.node-box.block{stroke:var(--relay-danger);fill:var(--relay-danger-soft)}
.node-box.hold{stroke:var(--relay-warning);fill:var(--relay-warning-soft)}
.node-box.done{stroke:var(--relay-success);fill:var(--relay-success-soft)}
.band-title{font:700 var(--relay-fs-13) "PingFang SC",system-ui,sans-serif;fill:var(--relay-text)}
.band-eta{font:750 var(--relay-fs-20) "PingFang SC",system-ui,sans-serif;fill:var(--relay-accent)}
.band-meta{font:var(--relay-fs-11) "PingFang SC",system-ui,sans-serif;fill:var(--relay-muted)}
.band-count{font:650 var(--relay-fs-12) "PingFang SC",system-ui,sans-serif;fill:var(--relay-text)}
.bar-track{fill:var(--relay-border)}
.bar-done{fill:var(--relay-success)}
.bar-doing{fill:var(--relay-accent)}
.bar-blocked{fill:var(--relay-danger)}
.bug-head{font:700 var(--relay-fs-10) "PingFang SC",system-ui,sans-serif;fill:var(--relay-faint)}
.bug-row{cursor:pointer}
.bug-row rect{fill:transparent}
.bug-row:hover rect{fill:var(--relay-accent-soft)}
.bug-text{font:var(--relay-fs-11) "PingFang SC",system-ui,sans-serif;fill:var(--relay-text)}
.bug-state{font:700 var(--relay-fs-11) "PingFang SC",system-ui,sans-serif}
.bug-state.fixing,.bug-state.reopened{fill:var(--relay-danger)}
.bug-state.verifying{fill:var(--relay-warning)}
.bug-state.fixed{fill:var(--relay-success)}
.bug-state.dropped{fill:var(--relay-faint)}
.bug-badge{fill:var(--relay-danger)}
.bug-badge-text{font:700 var(--relay-fs-9) ui-monospace,Menlo,monospace;fill:var(--relay-on-accent)}
.node-title{font:650 var(--relay-fs-11) "PingFang SC",system-ui,sans-serif;fill:var(--relay-text)}
.node-meta{font:var(--relay-fs-10) ui-monospace,Menlo,monospace;fill:var(--relay-faint)}
.edge{fill:none;stroke:var(--relay-accent);stroke-width:1.6;opacity:.75}
.edge.draft{stroke:var(--relay-border-strong);stroke-dasharray:5 5;animation:dashmove 2.5s linear infinite}
.edge.hold{stroke:var(--relay-warning);stroke-dasharray:7 4}
.edge.block{stroke:var(--relay-danger)}
.edge-hit{fill:none;stroke:transparent;stroke-width:14;cursor:pointer}
@keyframes dashmove{to{stroke-dashoffset:-40}}
.dot{fill:var(--relay-accent)}
.drawer{border-left:1px solid var(--relay-border);background:var(--relay-panel);padding:var(--relay-sp-18);overflow:auto;max-height:calc(100vh - 62px)}
.drawer h2{margin:0 0 var(--relay-sp-4);font-size:var(--relay-fs-15)}
.drawer .kicker{margin-bottom:var(--relay-sp-14);color:var(--relay-accent);font:800 var(--relay-fs-10) ui-monospace,Menlo,monospace;letter-spacing:.12em}
.drawer section{margin:0 0 var(--relay-sp-16);padding-bottom:var(--relay-sp-14);border-bottom:1px solid var(--relay-border)}
.drawer label{display:grid;gap:var(--relay-sp-6);margin:var(--relay-sp-8) 0;font-size:var(--relay-fs-11);color:var(--relay-muted);font-weight:700}
.drawer textarea{min-height:100px;font-size:var(--relay-fs-12)}
.drawer .row{display:flex;gap:var(--relay-sp-7);flex-wrap:wrap;margin-top:var(--relay-sp-9)}
.drawer button{height:32px;padding:0 var(--relay-sp-11);border:1px solid var(--relay-border);border-radius:var(--relay-r-8);background:var(--relay-panel-soft);color:var(--relay-text);font-size:var(--relay-fs-11);font-weight:700;cursor:pointer}
.drawer button.primary{background:var(--relay-accent);border:0;color:var(--relay-on-accent)}
.drawer button.warn{color:var(--relay-warning);border-color:var(--relay-warning)}
.drawer pre{white-space:pre-wrap;word-break:break-word;font:var(--relay-fs-11)/1.7 ui-monospace,Menlo,monospace;color:var(--relay-muted);max-height:220px;overflow:auto;background:var(--relay-input);padding:var(--relay-sp-9);border-radius:var(--relay-r-8)}
.inbox-list{display:grid;gap:var(--relay-sp-8)}
.inbox-card{padding:var(--relay-sp-10);border:1px solid var(--relay-border);border-radius:var(--relay-r-9);background:var(--relay-panel-soft)}
.inbox-card h3{margin:0 0 var(--relay-sp-5);font-size:var(--relay-fs-12)}
.inbox-card p{margin:0 0 var(--relay-sp-8);color:var(--relay-muted);font-size:var(--relay-fs-11);line-height:1.5}
.task-form{display:grid;gap:var(--relay-sp-8)}
.task-form input,.task-form select,.task-form textarea{width:100%;font-size:var(--relay-fs-11)}
.task-form textarea{min-height:70px}
@media(max-width:900px){.content{grid-template-columns:1fr}.drawer{border-left:0;border-top:1px solid var(--relay-border);max-height:none}.shell{display:block}.sidebar{height:auto;position:sticky;top:0}.main-nav{flex-direction:row}.topbar{top:56px}}
</style></head><body>
<div class="shell">
<aside class="sidebar"><div class="brand"><span class="brand-mark"><i></i><i></i></span><span><strong>公司</strong><small>Message Flow</small></span></div>
<p class="nav-label">工作区</p><nav class="main-nav">
<button data-t="flow" class="on" data-cmd="tab:flow">${relayIcon("activity")}<span>目标进度</span></button>
<button data-t="inbox" data-cmd="tab:inbox">${relayIcon("inbox")}<span>收件箱</span><b id="nav-count" hidden></b></button>
<button data-t="defs" data-cmd="tab:defs">${relayIcon("layers")}<span>编制</span></button>
<button data-t="routes" data-cmd="tab:routes">${relayIcon("layers")}<span>路由表</span></button>
<button data-t="notes" data-cmd="tab:notes">${relayIcon("layers")}<span>线的笔记</span></button>
<button data-cmd="theme" id="theme-btn" class="icon-button theme-toggle" aria-label="切换主题">${relayIcon("moon")}<span class="theme-label">深色</span></button>
<button onclick="location.href='ranking'" class="refresh">${relayIcon("layers")}<span>模型排序</span></button>
</nav><div class="sidebar-footer"><div class="operator"><span class="avatar">B</span><span><strong>老板</strong><small id="release-ver">控制面</small></span></div></div></aside>
<div class="main-area"><header class="topbar"><div class="breadcrumb"><span>公司</span><b>/</b><strong id="crumb">目标进度</strong></div>
<div class="top-actions"><span class="status" id="stat">加载中…</span><button class="refresh" id="pause-btn" data-cmd="toggle-pause">暂停派工</button><button class="refresh" data-cmd="refresh">${relayIcon("refresh")}<span>刷新</span></button></div></header>
<main class="content"><div class="flow-pane" id="flow-pane"></div><aside class="drawer" id="drawer"></aside>
<template id="upgrade-card">上线内容：<span class="uc"></span> · 影响范围：<span class="ui"></span> · <button class="upgrade-start">升级至 v<span class="uv"></span></button> · <button class="upgrade-automatic">自动升级已开启</button></template>
</main></div></div>
<div id="toast" class="toast" role="status"></div>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=n=>'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'+(ICONS[n]||'')+'</svg>';
const ICONS={activity:'<path d="M3 12h4l2-7 4 14 2-7h6"/>',inbox:'<path d="M4 5h16v12H4z"/>',layers:'<path d="M12 3L3 8l9 5 9-5-9-5z"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5"/>',sun:'${RELAY_ICON_PATHS.sun}',moon:'${RELAY_ICON_PATHS.moon}'};
const store={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}}};
function prefTheme(){try{return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){return 'light'}}
function renderThemeBtn(){const b=$('theme-btn');if(!b)return;const dark=(store.get('relay-theme')||prefTheme())==='dark';b.innerHTML=icon(dark?'sun':'moon')+'<span class="theme-label">'+(dark?'浅色':'深色')+'</span>'}
function toggleTheme(){const next=(store.get('relay-theme')||prefTheme())==='light'?'dark':'light';store.set('relay-theme',next);document.documentElement.dataset.theme=next;renderThemeBtn()}
document.documentElement.dataset.theme=store.get('relay-theme')||'light';renderThemeBtn();
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2200)}
const TOKEN=location.pathname.split('/')[2];
const api=async(cmd,o)=>{
  // 页面在 LAN 面与签名面都从自身前缀下发命令：相对地址留在 /o/<token>/ 内，Bearer 仍是同一把老板令牌。
  const r=await fetch('owner/'+cmd,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+OWNER,'X-Owner-Agent':'web'},body:JSON.stringify({command:cmd,...o})});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);return j;};
let OWNER='';let ROUTES=[],TASKS=[],MESSAGES=[],INBOX=null,DEFS=[],SEL=null,CHAIN='',T='flow',PAUSED=false,NOTICES=[],PROGRESS=null;
async function boot(){
  const x=await fetch('api/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageToken:TOKEN})});
  const j=await x.json().catch(()=>({}));if(!x.ok)throw new Error(j.error||'exchange failed');OWNER=j.ownerToken;
  document.addEventListener('click',onCommand);
  await load();setInterval(load,10000);
}
async function onCommand(ev){
  const el=ev.target.closest('[data-cmd]');if(!el)return;
  // Only the first colon separates the command: ids and notice keys may themselves contain colons.
  const raw=String(el.dataset.cmd),cut=raw.indexOf(':');
  const cmd=cut<0?raw:raw.slice(0,cut),arg=cut<0?'':raw.slice(cut+1);
  if(cmd==='tab'){T=arg;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.t===arg));$('crumb').textContent={flow:'目标进度',inbox:'收件箱',defs:'编制',routes:'路由表',notes:'线的笔记'}[arg]||arg;render();}
  else if(cmd==='theme')toggleTheme();
  else if(cmd==='refresh')load();
  else if(cmd==='chain'){CHAIN=arg;SEL=null;render();}
  else if(cmd==='bug'){SEL='b:'+arg;drawerBug(arg);}
  else if(cmd==='task'){SEL=arg;render();}
  else if(cmd==='msg'){SEL='m:'+arg;render();}
  else if(cmd==='save-msg')saveMsg(arg);
  else if(cmd==='hold-msg')holdMsg(arg,!MESSAGES.find(m=>String(m.id?.id??m.id)===arg)?.hold);
  else if(cmd==='release-msg')releaseMsg(arg);
  else if(cmd==='void')voidTask(arg);
  else if(cmd==='revoke')revokeTask(arg);
  else if(cmd==='unlock')unlockTask(arg);
  else if(cmd==='decide'){const [id,dec]=String(arg).split(':');decide(id,dec,el.dataset.note||'');}
  else if(cmd==='toggle-def'){const [id,on]=String(arg).split(':');toggleDef(id,on==='1');}
  else if(cmd==='upgrade-automatic'){await api('upgrade.automatic',{enabled:!(INBOX?.upgrades?.automatic?.enabled)});toast('已切换自动升级');await load();}
  else if(cmd==='upgrade-start'){await api('upgrade.start',{taskId:arg.split(':')[0],taskVersion:Number(arg.split(':')[1]),digest:arg.split(':')[2]});toast('已启动升级');await load();}
  else if(cmd==='create-task')createTask();
  else if(cmd==='new-task')newTaskForm();
  else if(cmd==='route-edit')routeEditForm(arg);
  else if(cmd==='route-save')saveRouteForm(arg);
  else if(cmd==='route-disable')disableRouteCmd(arg);
  else if(cmd==='route-enable')enableRouteCmd(arg);
  else if(cmd==='save-task')saveTask(arg);
  else if(cmd==='reassign')reassignForm(arg);
  else if(cmd==='save-reassign')saveReassign(arg);
  else if(cmd==='toggle-pause')togglePause();
  else if(cmd==='resolve-notice')resolveNotice(arg);
  else if(cmd==='notes-lane'){NLANE=arg;T='notes';document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.t==='notes'));$('crumb').textContent='线的笔记';render();}
  else if(cmd==='note-add')addNote();
  else if(cmd==='note-edit')noteEditForm(arg);
  else if(cmd==='note-save')saveNote(arg);
  else if(cmd==='note-pin')pinNote(arg);
  else if(cmd==='note-activate')activateNote(arg);
  else if(cmd==='note-remove')removeNote(arg);
}
async function load(){
  try{
    const [pr,nt,g,t,m,i,d,s,n]=await Promise.all([api('progress',{}).catch(e=>({error:e.message})),api('note.list',{}),api('route.list',{}),api('task.list',{}),api('message.list',{includeSent:true}),api('inbox',{}),api('def.list',{}),api('status',{}),api('notice.list',{})]);
    PROGRESS=pr;NOTES=nt.notes||[];ROUTES=g.routes||[];TASKS=t.tasks||[];MESSAGES=m.messages||[];INBOX=i;DEFS=d.defs||[];NOTICES=n.notices||[];PAUSED=s.paused===true;
    const n2=(INBOX.gates||[]).length+(INBOX.questions||[]).length;const b=$('nav-count');if(b){b.textContent=n2;b.hidden=!n2}
    const rv=$('release-ver');if(rv)rv.textContent='控制面'+(INBOX.upgrades&&INBOX.upgrades.current?' · v'+INBOX.upgrades.current.version:'');
    $('stat').textContent=n2?('待办 '+n2):'运行中';$('stat').className='status'+(n2?' violet':'');
    const pb=$('pause-btn');if(pb)pb.textContent=PAUSED?'恢复派工':'暂停派工';
    render();
  }catch(e){$('stat').textContent='加载失败：'+e.message}
}
const BAND=96,BUG_ROW=48,BUG_MAX=12,STEP=196;
const laneY=r=>BAND+70+r*104;
const STATE_ZH={planned:'待开始',ready:'待开始',doing:'进行中',review:'复核中',blocked:'阻塞',done:'已完成',void:'已作废'};
const BUG_ZH={fixing:'待修复',verifying:'待复验',fixed:'已修复',reopened:'修复未通过',dropped:'已放弃'};
/** task.list sends record IDs as task:⟨uuid⟩; progress sends the bare uuid. */
const bare=v=>String(v??'').replace(/^task:/,'').replace(/^⟨|⟩$/g,'');
const clip=(s,n)=>{const t=String(s??'').replace(/\\s+/g,' ').trim();return t.length>n?t.slice(0,n-1)+'…':t};
function duration(m){
  if(m<60)return Math.max(1,Math.round(m))+' 分钟';
  if(m<1440){const h=Math.floor(m/60),r=Math.round(m%60);return h+' 小时'+(r?' '+r+' 分':'')}
  const d=Math.floor(m/1440),h=Math.round(m%1440/60);return d+' 天'+(h?' '+h+' 小时':'');
}
function clock(iso){const d=new Date(iso),p=n=>String(n).padStart(2,'0');return (d.getMonth()+1)+' 月 '+d.getDate()+' 日 '+p(d.getHours())+':'+p(d.getMinutes())}
/** The selected chain, or the whole company when none is. */
function progressScope(){
  const c=CHAIN?(PROGRESS?.chains||[]).find(x=>x.root===bare(CHAIN)):null;
  if(c)return c;
  if(PROGRESS?.counts)return PROGRESS;
  return {error:PROGRESS?.error||'没有返回进度数据',counts:{done:0,doing:0,waiting:0,blocked:0,total:0},forecast:{remainingMinutes:null,basis:'none',samples:0,ownerWaiting:0},defects:[]};
}
function forecastText(p){
  const f=p.forecast,c=p.counts;
  if(p.error)return {eta:'进度读取失败',why:p.error};
  if(!c.total)return {eta:'还没有任务',why:''};
  if(f.remainingMinutes===0)return {eta:'已全部完成',why:''};
  if(f.remainingMinutes===null)return {eta:'暂无法预测',why:'还没有完成过的任务，第一项完成后开始预测'};
  const base=f.basis==='chain'?'本链':'全公司';
  return {eta:'预计还需 '+duration(f.remainingMinutes),
    why:'约 '+clock(f.finishAt)+' 完成 · 按'+base+' '+f.samples+' 个已完成任务的中位耗时 '+duration(f.medianMinutes)+' 推算，只计已知任务'+(f.ownerWaiting?' · 其中 '+f.ownerWaiting+' 项等你决定':'')};
}
function progressBand(W){
  const p=progressScope(),c=p.counts,x=20,w=W-40,t=forecastText(p);
  const open=(p.defects||[]).filter(d=>d.state==='fixing'||d.state==='verifying').length,fixed=(p.defects||[]).filter(d=>d.state==='fixed').length;
  const title=CHAIN?(p.title||'任务链'):'全部任务链';
  let s='<text class="band-title" x="'+x+'" y="24">'+esc(clip(title,48))+'</text>';
  s+='<text class="band-eta" x="'+x+'" y="52">'+esc(t.eta)+'</text>';
  s+='<text class="band-meta" x="'+(x+240)+'" y="51">'+esc(t.why)+'</text>';
  s+='<rect class="bar-track" x="'+x+'" y="64" width="'+w+'" height="6" rx="3"/>';
  let at=x;const seg=(n,cls)=>{if(!c.total||!n)return;const sw=w*n/c.total;s+='<rect class="'+cls+'" x="'+at+'" y="64" width="'+sw+'" height="6"/>';at+=sw};
  seg(c.done,'bar-done');seg(c.doing,'bar-doing');seg(c.blocked,'bar-blocked');
  s+='<text class="band-count" x="'+x+'" y="88">已完成 '+c.done+' · 进行中 '+c.doing+' · 待开始 '+c.waiting+' · 阻塞 '+c.blocked+' · 缺陷待处理 '+open+' · 已修复 '+fixed+'</text>';
  return s;
}
function bugBand(top,W){
  const list=(progressScope().defects||[]);
  const cols=[20,104,270];
  let s='<line class="lane-line" x1="16" y1="'+top+'" x2="'+(W-16)+'" y2="'+top+'"/>';
  s+='<text class="band-title" x="20" y="'+(top+24)+'">缺陷与修复</text>';
  if(!list.length)return s+'<text class="band-meta" x="110" y="'+(top+24)+'">没有被退回的问题</text>';
  ['状态','任务','问题与修复方案'].forEach((h,i)=>{s+='<text class="bug-head" x="'+cols[i]+'" y="'+(top+46)+'">'+h+'</text>'});
  const tw=Math.floor((W-cols[2]-24)/11.5);
  list.slice(0,BUG_MAX).forEach((d,i)=>{
    const y=top+54+i*BUG_ROW;
    s+='<g class="bug-row" data-cmd="bug:'+esc(d.id)+'"><rect x="16" y="'+y+'" width="'+(W-32)+'" height="'+BUG_ROW+'"/>';
    s+='<text class="bug-state '+esc(d.state)+'" x="'+cols[0]+'" y="'+(y+19)+'">'+esc(BUG_ZH[d.state]||d.state)+'</text>';
    s+='<text class="bug-text" x="'+cols[1]+'" y="'+(y+19)+'">'+esc(clip(d.taskTitle,13))+'</text>';
    s+='<text class="bug-text" x="'+cols[2]+'" y="'+(y+19)+'">'+esc(clip(d.problem,tw))+'</text>';
    s+='<text class="band-meta" x="'+cols[2]+'" y="'+(y+37)+'">'+esc(clip(d.fix?'修复：'+d.fix:'还没有修复方案',tw))+'</text></g>';
  });
  if(list.length>BUG_MAX)s+='<text class="band-meta" x="20" y="'+(top+54+BUG_MAX*BUG_ROW+18)+'">另有 '+(list.length-BUG_MAX)+' 条，选中任务链查看</text>';
  return s;
}
function bugBandHeight(){const n=(progressScope().defects||[]).length;return n?60+Math.min(n,BUG_MAX)*BUG_ROW+(n>BUG_MAX?30:12):42}
function graph(){
  const kids=new Map(),byId=new Map();
  for(const t of TASKS){const tid=String(t.id?.id??t.id);byId.set(tid,t);const p=t.parent?String(t.parent?.id??t.parent):'';if(p){if(!kids.has(p))kids.set(p,[]);kids.get(p).push(tid)}}
  const chainOf=r=>{const out=[];const walk=id=>{if(!byId.has(id)||out.includes(id))return;out.push(id);(kids.get(id)||[]).forEach(walk)};walk(r);return out};
  const chainIds=CHAIN?new Set(chainOf(CHAIN)):null;
  const visible=chainIds?TASKS.filter(t=>chainIds.has(String(t.id?.id??t.id))):TASKS.slice(0,60);
  const lanes=[...new Set(['owner',...visible.flatMap(t=>[t.executor_role,t.reviewer_role].filter(Boolean))])].slice(0,12);
  // Each lane fills from the left, so a long chain stays on screen; the bands use the visible width, never the scroll width.
  const seat=new Map(),used=new Map();
  visible.forEach(t=>{const n=used.get(t.executor_role)||0;used.set(t.executor_role,n+1);seat.set(String(t.id?.id??t.id),180+n*STEP)});
  const V=Math.max(760,($('flow-pane')?.clientWidth||1180)-42),W=Math.max(V,Math.max(0,...used.values())*STEP+260),lanesEnd=BAND+lanes.length*104+40,H=lanesEnd+bugBandHeight();
  let svg='<svg class="graph" viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="目标进度与消息流">'+progressBand(V);
  lanes.forEach((l,r)=>{const y=laneY(r);svg+='<line class="lane-line" x1="16" y1="'+y+'" x2="'+(W-16)+'" y2="'+y+'"/><text class="lane-label" x="20" y="'+(y-12)+'">'+esc(l)+'</text>'});
  const pos=r=>laneY(Math.max(0,lanes.indexOf(r)));
  visible.forEach((t,n)=>{
    const x=seat.get(String(t.id?.id??t.id)),y=pos(t.executor_role),ry=pos(t.reviewer_role);
    const msgs=MESSAGES.filter(m=>String(m.task?.id??m.task??'')===String(t.id?.id??t.id));
    const held=msgs.some(m=>m.hold||m.state==='held'),blocked=t.state==='blocked',sent=msgs.some(m=>m.state==='sent');
    const cls=blocked?'block':held?'hold':t.state==='done'?'done':['doing','review'].includes(t.state)?'active':'';
    const tid=esc(String(t.id?.id??t.id));
    const planned=t.state==='planned';
    svg+='<g class="flow-node" data-cmd="task:'+tid+'" style="cursor:pointer">';
    svg+='<rect class="node-box '+(planned?'hold':cls)+'" x="'+(x-72)+'" y="'+(y-24)+'" width="144" height="48" rx="9" '+(planned?'stroke-dasharray="6 4"':'')+'/>';
    svg+='<text class="node-title" x="'+(x-62)+'" y="'+(y-3)+'">'+esc((t.title||'任务').slice(0,15))+'</text>';
    svg+='<text class="node-meta" x="'+(x-62)+'" y="'+(y+14)+'">'+esc(STATE_ZH[t.state]||t.state||'')+' · '+esc(t.executor_role||'')+'</text>';
    const bugs=(PROGRESS?.defects||[]).filter(d=>d.taskId===bare(t.id?.id??t.id)&&(d.state==='fixing'||d.state==='verifying')).length;
    if(bugs)svg+='<circle class="bug-badge" cx="'+(x+68)+'" cy="'+(y-24)+'" r="8"/><text class="bug-badge-text" x="'+(x+65)+'" y="'+(y-21)+'">'+bugs+'</text>';
    svg+='</g>';
    const ex=x+72,ey=ry-24;
    const path='M'+ex+' '+y+' C'+(ex+48)+' '+y+','+(x+120)+' '+ey+','+(x+170)+' '+ey;
    const edgeCls=sent?(blocked?'block':''):held?'hold':'draft';
    svg+='<path id="e-'+n+'" class="edge '+edgeCls+'" d="'+path+'"/>';
    svg+='<path class="edge-hit" data-cmd="task:'+tid+'" d="'+path+'"/>';
    if(sent&&!held&&!blocked)svg+='<circle class="dot" r="3.5"><animateMotion dur="3s" repeatCount="indefinite" path="'+path+'"/></circle>';
    if(t.parent){const pid=String(t.parent?.id??t.parent);const pi=visible.findIndex(o=>String(o.id?.id??o.id)===pid);
      if(pi>=0){const px=seat.get(pid),py=pos(visible[pi].executor_role);
        const pp='M'+px+' '+py+' C'+px+' '+(py+60)+','+x+' '+(y-70)+','+x+' '+(y-26);
        svg+='<path class="edge '+(t.state==='planned'?'hold':'')+'" stroke-dasharray="'+(t.state==='planned'?'6 4':'none')+'" d="'+pp+'"/>'}}
  });
  svg+=bugBand(lanesEnd,V)+'</svg>';return svg;
}
function drawerBug(id){
  const d=(PROGRESS?.defects||[]).find(x=>x.id===id);
  if(!d){$('drawer').innerHTML='<p class="meta">缺陷不存在</p>';return}
  $('drawer').innerHTML='<div class="kicker">DEFECT</div><h2>'+esc(d.taskTitle)+'</h2><p class="meta">'+esc(BUG_ZH[d.state]||d.state)+' · '+esc(d.foundBy)+' · '+esc(clock(d.foundAt))+'</p>'
    +'<section><h3>问题</h3><pre>'+esc(d.problem)+'</pre></section>'
    +'<section><h3>修复方案</h3>'+(d.fix?'<pre>'+esc(d.fix)+'</pre><p class="meta">'+esc(d.fixedBy||'')+' · '+esc(clock(d.fixedAt))+'</p>':'<p class="meta">还没有提交修复</p>')+'</section>'
    +'<section><div class="row"><button data-cmd="task:'+esc(String((TASKS.find(t=>bare(t.id?.id??t.id)===d.taskId)||{}).id??d.taskId))+'">查看任务</button></div></section>';
}
function drawerDefault(){
  const drafts=MESSAGES.filter(m=>m.state!=='sent');
  $('drawer').innerHTML='<div class="kicker">DRAWER</div><h2>消息与任务</h2><p class="meta">点击节点或连线查看正文、放行与审计。</p>'
    +'<section><h3>待发消息 '+drafts.length+'</h3><div class="inbox-list">'+drafts.slice(0,12).map(m=>'<div class="inbox-card"><h3>'+esc(m.step)+' → '+esc(m.role)+'</h3><p>'+esc(m.body.slice(0,80))+'</p><button data-cmd="msg:'+esc(m.id)+'">查看</button></div>').join('')||'<p class="meta">无</p>'+'</div></section>'
    +'<section><h3>收件箱</h3>'+((INBOX?.gates||[]).length+(INBOX?.questions||[]).length)+' 项待你决定</section>'
    +'<section><h3>提醒 '+(noticeList().length||'')+'</h3><div class="inbox-list">'+noticesHtml()+'</div></section>'
    +'<section><h3>公司系统升级</h3>'+upgradeHtml()+'</section>';
}
function upgradeHtml(){
  const items=INBOX?.upgrades?.items||[];
  if(!items.length)return '<p class="meta">无待升级版本</p>';
  return items.map(x=>'<div class="inbox-card"><h3>v'+esc(x.plan?.version||'')+' · '+esc(x.status||'')+'</h3><p>'+esc(x.taskId||'')+'</p><div class="row"><button data-cmd="upgrade-start:'+esc(String(x.taskId))+':'+esc(String(x.taskVersion))+':'+esc(String(x.plan?.digest||''))+'">升级至 v'+esc(x.plan?.version||'')+'</button></div></div>').join('');
}
function noticeList(){return (NOTICES&&NOTICES.length)?NOTICES:(INBOX?.notices||[])}
function noticesHtml(){
  const items=noticeList();
  if(!items.length)return '<p class="meta">无未解决提醒</p>';
  return items.map(n=>'<div class="inbox-card"><p>'+esc(n.text||n.key)+'</p><button data-cmd="resolve-notice:'+esc(String(n.key))+'">已处理</button></div>').join('');
}
function drawerMsg(id){
  const m=MESSAGES.find(x=>String(x.id?.id??x.id)===id);
  if(!m){$('drawer').innerHTML='<p class="meta">消息不存在</p>';return}
  const locked=m.state==='sent';
  $('drawer').innerHTML='<div class="kicker">MESSAGE</div><h2>'+esc(m.step)+' · '+esc(m.role)+'</h2>'
    +'<section><label>消息正文<textarea id="msg-body" '+(locked?'disabled':'')+'>'+esc(m.body)+'</textarea></label>'
    +(locked?'<p class="meta">已发出并锁定 · '+esc(m.sentAt||'')+'</p>':'<div class="row"><button class="primary" data-cmd="save-msg:'+esc(id)+'">保存</button><button class="warn" data-cmd="hold-msg:'+esc(id)+'">'+(m.hold?'取消放行标记':'需要我放行')+'</button><button data-cmd="release-msg:'+esc(id)+'">放行</button></div>')+'</section>'
    +'<section><h3>原文留存</h3><pre>'+esc(m.body)+'</pre></section>';
}
function drawerTask(id){
  const t=TASKS.find(x=>String(x.id?.id??x.id)===id);
  if(!t){$('drawer').innerHTML='<p class="meta">任务不存在</p>';return}
  const msgs=MESSAGES.filter(m=>String(m.task?.id??m.task??'')===id);
  $('drawer').innerHTML='<div class="kicker">TASK '+esc(id.slice(0,8))+'</div><h2>'+esc(t.title||'')+'</h2><p class="meta">'+esc(t.executor_role||'')+' → '+esc(t.reviewer_role||'')+' · '+esc(t.state||'')+'</p>'
    +'<section><h3>需求与验收</h3><label>需求<textarea id="t-req">'+esc(t.requirement||t.context||'')+'</textarea></label>'
    +'<label>验收标准<textarea id="t-ac">'+esc(t.acceptance_text||'')+'</textarea></label>'
    +'<div class="row"><button class="primary" data-cmd="save-task:'+esc(id)+'">保存需求与验收</button></div></section>'
    +'<section><h3>消息</h3>'+msgs.map(m=>'<div class="inbox-card"><h3>'+esc(m.step)+' · '+esc(m.state)+(m.hold?' · 待放行':'')+'</h3><p>'+esc(m.body.slice(0,90))+'</p><button data-cmd="msg:'+esc(String(m.id?.id??m.id))+'">编辑/放行</button></div>').join('')+'</section>'
    +'<section><h3>会话将读到的笔记</h3><div class="row"><button data-cmd="notes-lane:'+esc(laneOfTask(t,t.executor_role))+'">执行线</button>'+(t.reviewer_role==='owner'?'':'<button data-cmd="notes-lane:'+esc(laneOfTask(t,t.reviewer_role))+'">复核线</button>')+'</div></section>'
    +'<section><h3>操作</h3><div class="row"><button data-cmd="void:'+esc(id)+'">作废</button><button data-cmd="revoke:'+esc(id)+'">撤销租约</button><button data-cmd="reassign:'+esc(id)+'">改派</button></div></section>';
}
function reassignForm(id){
  $('drawer').innerHTML='<div class="kicker">REASSIGN</div><h2>改派任务</h2><div class="task-form">'
    +'<label>执行岗<select id="r-ex">'+['engineering','qa','product','concept-design','asset-production','screenwriter','story-author','cinematography','cs'].map(r=>'<option>'+r+'</option>').join('')+'</select></label>'
    +'<label>复核岗<select id="r-rev">'+['qa','engineering','owner','product'].map(r=>'<option>'+r+'</option>').join('')+'</select></label>'
    +'<label>改派说明<input id="r-note"/></label>'
    +'<div class="row"><button class="primary" data-cmd="save-reassign:'+esc(id)+'">确认改派</button><button data-cmd="task:'+esc(id)+'">返回</button></div></div>';
}
async function saveTask(id){
  const requirement=$('t-req').value,acceptanceText=$('t-ac').value;
  if(requirement.trim().length<1||acceptanceText.trim().length<1){toast('需求与验收标准都不能为空');return}
  await api('task.update',{taskId:id,requirement,acceptanceText});toast('已保存');await load();
}
async function saveReassign(id){
  const executorRole=$('r-ex').value,reviewerRole=$('r-rev').value,note=$('r-note').value.trim();
  if(note.length<1){toast('请填写改派说明');return}
  await api('task.reassign',{taskId:id,executorRole,reviewerRole,note});toast('已改派');SEL=id;await load();
}
function chainNote(id,task,total){
  const c=(PROGRESS?.chains||[]).find(x=>x.root===bare(id));
  const m=c?.forecast?.remainingMinutes;
  if(m===0)return '已完成 · '+total+' 个任务';
  return (m?'还需 '+duration(m):STATE_ZH[task.state]||task.state||'')+' · '+(c?.counts?.done??0)+'/'+total+' 完成';
}
function renderFlow(){
  const roots=TASKS.filter(t=>!t.parent);
  const countOf=r=>{let n=0;const walk=id=>{TASKS.filter(t=>t.parent&&String(t.parent?.id??t.parent)===id).forEach(t=>{n++;walk(String(t.id?.id??t.id))})};walk(r);return n};
  const rail='<div class="chain-rail"><button class="chain-chip '+(CHAIN?'':'active')+'" data-cmd="chain:"><strong>全部任务链</strong><small>'+roots.length+' 条链</small></button>'
    +roots.slice(0,30).map(g=>{const gid=String(g.id?.id??g.id),active=CHAIN===gid;
      return '<div class="chain-chip '+(active?'active':'')+'" data-cmd="chain:'+esc(gid)+'" role="button" tabindex="0"><strong>'+esc((g.title||'').slice(0,20))+'</strong><small>'+esc(chainNote(gid,g,countOf(gid)+1))+'</small></div>';
    }).join('')+'</div>';
  $('flow-pane').innerHTML='<div class="flow-head"><h1>目标进度</h1><div class="flow-legend"><span><i></i>已发</span><span><i class="dash"></i>待发 draft</span><span><i class="hold"></i>需要我放行</span><span><i class="block"></i>阻塞到老板</span></div><div class="row"><button class="primary small" data-cmd="new-task">+ 新增任务</button><button class="small" data-cmd="tab:routes">路由表</button></div></div>'
    +rail+'<div class="graph-scroll">'+graph()+'</div>';
  if(SEL)SEL.startsWith('m:')?drawerMsg(SEL.slice(2)):SEL.startsWith('b:')?drawerBug(SEL.slice(2)):drawerTask(SEL);else drawerDefault();
}
async function togglePause(){
  await api(PAUSED?'task.resume':'task.pause',{});PAUSED=!PAUSED;toast(PAUSED?'已暂停派工':'已恢复派工');await load();
}
async function resolveNotice(key){
  await api('notice.resolve',{key});toast('已关闭提醒');await load();
}
function renderInbox(){
  const gates=INBOX?.gates||[],asks=INBOX?.questions||[];
  $('flow-pane').innerHTML='<div class="flow-pane"><div class="flow-head"><h1>收件箱</h1></div><div class="decision-grid">'
    +gates.map(x=>'<article class="decision-card"><div class="card-top"><span class="type-label">批准 / 退回</span></div><h3>'+esc(x.task.title||'')+'</h3><div class="submission">'+esc(x.submission||'')+'</div><div class="decision-actions"><button class="approve" data-cmd="decide:'+esc(String(x.task.id))+':approve">批准</button><button class="reject" data-cmd="decide:'+esc(String(x.task.id))+':reject">退回</button></div></article>').join('')
    +asks.map(x=>'<article class="decision-card"><div class="card-top"><span class="type-label">回复 / 放行</span></div><h3>'+esc(x.task.title||'')+'</h3><div class="submission">'+esc(x.question||'')+'</div><label class="comment-field"><span>答复</span><textarea data-note="'+esc(String(x.task.id))+'"></textarea></label><div class="decision-actions"><button class="approve" data-cmd="decide:'+esc(String(x.task.id))+':reply">回复并恢复</button></div></article>').join('')
    +'</div></div>';$('drawer').innerHTML='<div class="kicker">INBOX</div><h2>老板决定</h2><p class="meta">批准、退回、回复员工提问都会解除阻塞并恢复任务。</p>'
    +'<section><h3>提醒</h3><div class="inbox-list">'+noticesHtml()+'</div></section>';
}
function renderDefs(){
  $('flow-pane').innerHTML='<div class="flow-pane"><div class="flow-head"><h1>编制</h1></div><div class="decision-grid">'
    +DEFS.map(d=>'<article class="decision-card"><div class="card-top"><span class="type-label">'+esc(d.role)+'</span><span class="status '+(d.enabled?'success':'')+'">'+(d.enabled?'启用':'停用')+'</span></div><h3>'+esc(d.id)+'</h3><p class="byline">'+esc(d.provider)+' · '+esc(d.model||'')+'</p><div class="decision-actions"><button data-cmd="toggle-def:'+esc(d.id)+':'+(d.enabled?0:1)+'">'+(d.enabled?'停用':'启用')+'</button></div></article>').join('')+'</div></div>';
  $('drawer').innerHTML='<div class="kicker">DEF</div><h2>新建 / 修改编制</h2><div class="task-form"><label>ID<input id="d-id"/></label><label>岗位<select id="d-role">'+['product','engineering','qa','concept-design','asset-production','screenwriter','story-author','cinematography','cs','eval'].map(r=>'<option>'+r+'</option>').join('')+'</select></label><label>provider<input id="d-provider" value="codex"/></label><label>model<input id="d-model" value="auto:sol"/></label><div class="row"><button class="primary" data-cmd="create-def">保存编制</button></div></div>';
}
function render(){if(T==='flow')renderFlow();else if(T==='inbox')renderInbox();else if(T==='routes')renderRoutes();else if(T==='notes')renderLaneNotes();else renderDefs()}
async function saveMsg(id){await api('message.edit',{messageId:id,body:$('msg-body').value});toast('已保存');await load()}
async function holdMsg(id,on){await api(on?'message.hold':'message.release',{messageId:id});toast(on?'已标记需要我放行':'已取消');await load()}
async function releaseMsg(id){await api('message.release',{messageId:id});toast('已放行，等待派工');await load()}
async function decide(id,dec,note){
  if(dec==='reject'){note=prompt('退回说明')||'';if(note.trim().length<2)return}
  if(dec==='reply'){const el=document.querySelector('[data-note="'+CSS.escape(id)+'"]');note=el?el.value:''}
  await api(dec,{taskId:id,note,decision:dec});toast('已处理');await load();
}
async function voidTask(id){const note=prompt('作废原因')||'';if(note.trim().length<2)return;await api('task.void',{taskId:id,note});await load()}
async function revokeTask(id){await api('task.revoke',{taskId:id});await load()}
async function toggleDef(id,on){await api(on?'def.enable':'def.disable',{id});await load()}
async function createDef(){await api('def.ensure',{id:$('d-id').value,role:$('d-role').value,provider:$('d-provider').value,model:$('d-model').value});toast('已保存编制');await load()}
function newTaskForm(){
  const opts=ROUTES.filter(r=>r.enabled!==false).map(r=>'<option value="'+esc(r.type??r.id)+'">'+esc(r.label||r.type)+' ('+esc(r.type??r.id)+')</option>').join('');
  $('drawer').innerHTML='<div class="kicker">NEW TASK</div><h2>新增任务</h2><div class="task-form">'
    +'<label>类型<select id="n-type" onchange="previewChain()">'+opts+'</select></label>'
    +'<label>标题<input id="n-title" oninput="previewChain()"/></label><label>需求<textarea id="n-req"></textarea></label><label>验收标准<textarea id="n-ac"></textarea></label>'
    +'<label>分组 tag<input id="n-tag"/></label><label><input type="checkbox" id="n-hold"/> 生成后先让我过目（hold）</label>'
    +'<section id="n-preview"></section><div class="row"><button class="primary" data-cmd="create-task">创建任务链</button></div></div>';
  previewChain();
}
function previewChain(){
  const el=$('n-preview');if(!el)return;const type=$('n-type')?.value,title=($('n-title')?.value||'任务').trim()||'任务';
  const byType={};ROUTES.forEach(r=>byType[r.type??r.id]=r);
  let html='<h3>链预览</h3>',cur=type,seen=new Set(),n=0;
  while(cur&&byType[cur]&&!seen.has(cur)&&n<10){const r=byType[cur];seen.add(cur);n++;
    html+='<div class="inbox-card"><h3>'+esc(n===1?title:title+' · '+esc(r.label))+'</h3><p class="meta">'+esc(r.executor_role)+' → '+esc(r.reviewer_role)+(n>1?' · planned':'')+'</p><p>'+esc((r.execute_body||'').slice(0,120))+'</p><p>'+esc((r.review_body||'').slice(0,120))+'</p></div>';
    cur=r.next;}
  el.innerHTML=html;
}
async function createTask(){
  const type=$('n-type').value,title=$('n-title').value.trim(),requirement=$('n-req').value,acceptanceText=$('n-ac').value;
  if(title.length<3||requirement.trim().length<1){toast('标题与需求必填');return}
  const tag=$('n-tag').value.trim();
  await api('task.create',{type,title,requirement,acceptanceText,...(tag?{tag}:{}) ,...($('n-hold').checked?{hold:true}:{})});
  toast('已创建任务链');SEL=null;await load();
}
let NOTES=[],NLANE='';
const noteId=n=>String(n.id?.id??n.id);
function laneOfTask(t,role){const p=String(t.project?.id??t.project??'').replace(/^project:/,'');return (p||'company')+':'+role}
function renderLaneNotes(){
  const lanes=[...new Set(NOTES.map(n=>n.lane).concat(NLANE?[NLANE]:[]))].sort();
  if(!NLANE&&lanes.length)NLANE=lanes[0];
  const rows=NOTES.filter(n=>n.lane===NLANE);
  $('flow-pane').innerHTML='<div class="flow-pane"><div class="flow-head"><h1>线的笔记</h1></div><div class="row">'
    +lanes.map(l=>'<button '+(l===NLANE?'class="primary" ':'')+'data-cmd="notes-lane:'+esc(l)+'">'+esc(l)+' ('+NOTES.filter(n=>n.lane===l&&n.state==='active').length+')</button>').join('')
    +'</div><div class="decision-grid">'
    +(rows.length?rows.map(n=>'<article class="decision-card"><div class="card-top"><span class="type-label">'+esc(n.author)+'</span><span class="status '+(n.state==='active'?'success':'')+'">'+(n.state==='active'?'生效':'待生效')+(n.pinned?' · 置顶':'')+'</span></div><p>'+esc(n.text)+'</p><div class="row">'
      +(n.state==='proposed'?'<button class="primary" data-cmd="note-activate:'+esc(noteId(n))+'">生效</button>':'')
      +'<button data-cmd="note-edit:'+esc(noteId(n))+'">编辑</button><button data-cmd="note-pin:'+esc(noteId(n))+'">'+(n.pinned?'取消置顶':'置顶')+'</button><button data-cmd="note-remove:'+esc(noteId(n))+'">删除</button></div></article>').join(''):'<p class="meta">这条线还没有笔记</p>')
    +'</div></div>';
  $('drawer').innerHTML='<div class="kicker">NOTES</div><h2>添加笔记</h2><p class="meta">一条线 = 项目 × 职能。只记长期有效的要求、方法和坑，不记某次任务的结论。</p><div class="task-form">'
    +'<label>线<input id="n-lane" value="'+esc(NLANE)+'" placeholder="surreal_ck:qa"/></label>'
    +'<label>内容<textarea id="n-text"></textarea></label>'
    +'<div class="row"><button class="primary" data-cmd="note-add">添加</button></div></div>';
}
function noteEditForm(id){
  const n=NOTES.find(x=>noteId(x)===id);if(!n)return;
  $('drawer').innerHTML='<div class="kicker">NOTE</div><h2>编辑笔记</h2><div class="task-form"><label>内容<textarea id="n-edit">'+esc(n.text)+'</textarea></label>'
    +'<div class="row"><button class="primary" data-cmd="note-save:'+esc(id)+'">保存</button><button data-cmd="tab:notes">返回</button></div></div>';
}
async function addNote(){const lane=$('n-lane').value.trim();await api('note.add',{lane,text:$('n-text').value});NLANE=lane;toast('已添加');await load()}
async function saveNote(id){await api('note.edit',{noteId:id,text:$('n-edit').value});toast('已保存');await load()}
async function pinNote(id){const n=NOTES.find(x=>noteId(x)===id);await api('note.pin',{noteId:id,pinned:!n?.pinned});await load()}
async function activateNote(id){await api('note.activate',{noteId:id});toast('已生效');await load()}
async function removeNote(id){await api('note.remove',{noteId:id});toast('已删除');await load()}
function renderRoutes(){
  $('flow-pane').innerHTML='<div class="flow-pane"><div class="flow-head"><h1>路由表</h1></div><div class="decision-grid">'
    +ROUTES.map(r=>'<article class="decision-card"><div class="card-top"><span class="type-label">'+esc(r.type)+'</span><span class="status '+(r.enabled?'success':'')+'">'+(r.enabled?'启用':'停用')+'</span></div><h3>'+esc(r.label)+'</h3><p class="byline">'+esc(r.executor_role)+' → '+esc(r.reviewer_role)+(r.next?' · 后续 '+esc(r.next):'')+(r.hold?' · hold':'')+(r.code?' · code':'')+'</p><div class="decision-actions"><button data-cmd="route-edit:'+esc(r.type)+'">编辑</button>'+(r.enabled?'<button class="reject" data-cmd="route-disable:'+esc(r.type)+'">停用</button>':'<button class="approve" data-cmd="route-enable:'+esc(r.type)+'">启用</button>')+'</div></article>').join('')+'</div></div>';
  $('drawer').innerHTML='<div class="kicker">ROUTES</div><h2>路由表</h2><p class="meta">每条路由决定一个任务类型的执行岗、复核岗与消息模板。</p>';
}
function routeEditForm(type){
  const r=ROUTES.find(x=>(x.type??'')===type);if(!r)return;
  const roleOpts=cur=>['engineering','qa','product','concept-design','asset-production','screenwriter','story-author','cinematography','cs','owner'].map(o=>'<option '+(o===cur?'selected':'')+'>'+o+'</option>').join('');
  $('drawer').innerHTML='<div class="kicker">ROUTE '+esc(type)+'</div><h2>'+esc(r.label)+'</h2><div class="task-form">'
    +'<label>名称<input id="rt-label" value="'+esc(r.label)+'"/></label>'
    +'<label>执行岗<select id="rt-ex">'+roleOpts(r.executor_role)+'</select></label>'
    +'<label>复核岗<select id="rt-rev">'+roleOpts(r.reviewer_role)+'</select></label>'
    +'<label><input type="checkbox" id="rt-code" '+(r.code?'checked':'')+'/> code 任务</label>'
    +'<label>执行模板<textarea id="rt-eb">'+esc(r.execute_body||'')+'</textarea></label>'
    +'<label>复核模板<textarea id="rt-rb">'+esc(r.review_body||'')+'</textarea></label>'
    +'<label>下一类型 next<select id="rt-next"><option value="">（无）</option>'+ROUTES.map(o=>'<option value="'+esc(o.type)+'" '+(o.type===r.next?'selected':'')+'>'+esc(o.label||o.type)+'</option>').join('')+'</select></label>'
    +'<label><input type="checkbox" id="rt-hold" '+(r.hold?'checked':'')+'/> hold 草稿</label>'
    +'<div class="row"><button class="primary" data-cmd="route-save:'+esc(type)+'">保存路由</button><button data-cmd="tab:routes">返回</button></div></div>';
}
async function saveRouteForm(type){
  await api('route.save',{type,label:$('rt-label').value,executorRole:$('rt-ex').value,reviewerRole:$('rt-rev').value,
    code:$('rt-code').checked,executeBody:$('rt-eb').value||undefined,reviewBody:$('rt-rb').value||undefined,
    next:$('rt-next').value||undefined,hold:$('rt-hold').checked});
  toast('已保存路由');await load();T='routes';render();
}
async function disableRouteCmd(type){await api('route.disable',{type});toast('已停用');await load()}
async function enableRouteCmd(type){const r=ROUTES.find(x=>x.type===type);if(!r)return;await api('route.save',{type,label:r.label,executorRole:r.executor_role,reviewerRole:r.reviewer_role,code:r.code,executeBody:r.execute_body,reviewBody:r.review_body,next:r.next,hold:r.hold});toast('已启用');await load()}
boot().catch(e=>{$('stat').textContent='初始化失败：'+e.message});
</script></body></html>`;

