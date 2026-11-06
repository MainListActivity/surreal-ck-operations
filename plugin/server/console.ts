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
import { createOwnerApiFetch } from "./owner-api.ts";

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
        const goalId = url.searchParams.get("goalId") ?? "";
        const { db } = await opts.company();
        const { view, id } = await import("./vendor/src/core.ts");
        const [rows] = await db.db.query<[unknown[]]>(
          "SELECT * FROM task WHERE goal = $goal ORDER BY created_at, id;", { goal: id("goal", goalId) });
        return json({ tasks: rows.map(r => view(r as Parameters<typeof view>[0])) });
      }
      if (req.method === "GET" && sub === "/api/goal-retired-pending") {
        const goalId = url.searchParams.get("goalId") ?? "";
        if (!goalId) return json({ error: "goalId required" }, 400);
        try {
          const { GoalGovernanceStore } = await import("./vendor/src/goal-store.ts");
          const view = await new GoalGovernanceStore((await opts.company()).db.db).retiredWorkPending(goalId);
          return json(view);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
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
      if(req.method==='POST'&&sub==='/api/goal-retired-resolution'){
        if(req.headers.get('origin')&&req.headers.get('origin')!==url.origin)return json({error:'origin mismatch'},403);
        try{
          const input=await req.json() as Parameters<import('./vendor/src/goal-store.ts').GoalGovernanceStore['resolveRetiredWork']>[0];
          const {GoalGovernanceStore}=await import('./vendor/src/goal-store.ts');
          const card=await new GoalGovernanceStore((await opts.company()).db.db).resolveRetiredWork({...input,actor:SOURCE});
          return json({ok:true,goalId:card.goalId,state:card.state,readyToComplete:card.readyToComplete});
        }catch{return json({error:'历史任务处置失败：请核对版本、作废状态及替代交付'},409);}
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
<title>公司 · 消息流</title>
<style>
${relayShellCss}
:root{--flow-w:1180px}
.shell{grid-template-columns:220px minmax(0,1fr)}
.main-area{display:grid;grid-template-rows:62px minmax(0,1fr)}
.content{width:100%;max-width:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr) 360px;min-height:calc(100vh - 62px)}
.flow-pane{min-width:0;overflow:auto;padding:18px 20px 40px}
.goal-rail{display:flex;gap:8px;overflow-x:auto;padding-bottom:12px;margin-bottom:12px}
.goal-chip{flex:none;min-width:180px;max-width:240px;padding:10px 12px;border:1px solid var(--relay-border);border-radius:10px;background:var(--relay-panel);cursor:pointer;text-align:left;color:var(--relay-text)}
.goal-chip.active{border-color:var(--relay-accent-border);background:var(--relay-accent-soft)}
.goal-chip strong{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.goal-chip small{display:block;color:var(--relay-faint);font-size:10px;margin-top:4px}
.goal-chip .chip-cancel{height:22px;padding:0 7px;margin-left:6px;border:1px solid var(--relay-warning);border-radius:6px;background:transparent;color:var(--relay-warning);font-size:10px;font-weight:700;cursor:pointer}
.flow-head .row{display:flex;gap:7px;flex-wrap:wrap}
.retired-box{margin-top:16px;padding:12px;border:1px solid var(--relay-border);border-radius:12px;background:var(--relay-panel)}
.retired-box h3{margin:0 0 8px;font-size:13px}
.flow-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0 12px;flex-wrap:wrap}
.flow-head h1{margin:0;font-size:20px;letter-spacing:-.02em}
.flow-legend{display:flex;gap:12px;flex-wrap:wrap;color:var(--relay-muted);font-size:10px}
.flow-legend span{display:inline-flex;align-items:center;gap:5px}
.flow-legend i{width:18px;height:2px;display:inline-block;background:var(--relay-accent)}
.flow-legend i.dash{background:repeating-linear-gradient(90deg,var(--relay-border-strong) 0 4px,transparent 4px 7px)}
.flow-legend i.hold{background:var(--relay-warning)}
.flow-legend i.block{background:var(--relay-danger)}
.graph-scroll{overflow-x:auto;border:1px solid var(--relay-border);border-radius:14px;background:var(--relay-panel)}
.graph{min-width:var(--flow-w);display:block}
.lane-label{font:700 10px ui-monospace,Menlo,monospace;fill:var(--relay-faint);letter-spacing:.08em}
.lane-line{stroke:var(--relay-border);stroke-width:1}
.node-box{fill:var(--relay-panel-soft);stroke:var(--relay-border-strong);stroke-width:1.2;rx:9}
.node-box.active{stroke:var(--relay-accent);fill:var(--relay-accent-soft)}
.node-box.block{stroke:var(--relay-danger);fill:var(--relay-danger-soft)}
.node-box.hold{stroke:var(--relay-warning);fill:var(--relay-warning-soft)}
.node-title{font:650 11px "PingFang SC",system-ui,sans-serif;fill:var(--relay-text)}
.node-meta{font:10px ui-monospace,Menlo,monospace;fill:var(--relay-faint)}
.edge{fill:none;stroke:var(--relay-accent);stroke-width:1.6;opacity:.75}
.edge.draft{stroke:var(--relay-border-strong);stroke-dasharray:5 5;animation:dashmove 2.5s linear infinite}
.edge.hold{stroke:var(--relay-warning);stroke-dasharray:7 4}
.edge.block{stroke:var(--relay-danger)}
.edge-hit{fill:none;stroke:transparent;stroke-width:14;cursor:pointer}
@keyframes dashmove{to{stroke-dashoffset:-40}}
.dot{fill:var(--relay-accent)}
.drawer{border-left:1px solid var(--relay-border);background:var(--relay-panel);padding:18px;overflow:auto;max-height:calc(100vh - 62px)}
.drawer h2{margin:0 0 4px;font-size:15px}
.drawer .kicker{margin-bottom:14px;color:var(--relay-accent);font:800 10px ui-monospace,Menlo,monospace;letter-spacing:.12em}
.drawer section{margin:0 0 16px;padding-bottom:14px;border-bottom:1px solid var(--relay-border)}
.drawer label{display:grid;gap:6px;margin:8px 0;font-size:11px;color:var(--relay-muted);font-weight:700}
.drawer textarea{min-height:100px;font-size:12px}
.drawer .row{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
.drawer button{height:32px;padding:0 11px;border:1px solid var(--relay-border);border-radius:8px;background:var(--relay-panel-soft);color:var(--relay-text);font-size:11px;font-weight:700;cursor:pointer}
.drawer button.primary{background:var(--relay-accent);border:0;color:#fff}
.drawer button.warn{color:var(--relay-warning);border-color:var(--relay-warning)}
.drawer pre{white-space:pre-wrap;word-break:break-word;font:11px/1.7 ui-monospace,Menlo,monospace;color:var(--relay-muted);max-height:220px;overflow:auto;background:var(--relay-input);padding:9px;border-radius:8px}
.inbox-list{display:grid;gap:8px}
.inbox-card{padding:10px;border:1px solid var(--relay-border);border-radius:9px;background:var(--relay-panel-soft)}
.inbox-card h3{margin:0 0 5px;font-size:12px}
.inbox-card p{margin:0 0 8px;color:var(--relay-muted);font-size:11px;line-height:1.5}
.goal-form{display:grid;gap:8px}
.goal-form input,.goal-form select,.goal-form textarea{width:100%;font-size:11px}
.goal-form textarea{min-height:70px}
@media(max-width:900px){.content{grid-template-columns:1fr}.drawer{border-left:0;border-top:1px solid var(--relay-border);max-height:none}.shell{display:block}.sidebar{height:auto;position:sticky;top:0}.main-nav{flex-direction:row}.topbar{top:56px}}
</style></head><body>
<div class="shell">
<aside class="sidebar"><div class="brand"><span class="brand-mark"><i></i><i></i></span><span><strong>公司</strong><small>Message Flow</small></span></div>
<p class="nav-label">工作区</p><nav class="main-nav">
<button data-t="flow" class="on" data-cmd="tab:flow">${relayIcon("activity")}<span>消息流</span></button>
<button data-t="inbox" data-cmd="tab:inbox">${relayIcon("inbox")}<span>收件箱</span><b id="nav-count" hidden></b></button>
<button data-t="defs" data-cmd="tab:defs">${relayIcon("layers")}<span>编制</span></button>
<button data-cmd="theme" id="theme-btn" class="icon-button" aria-label="切换主题"></button>
<button onclick="location.href='ranking'" class="refresh">${relayIcon("layers")}<span>模型排序</span></button>
</nav><div class="sidebar-footer"><div class="operator"><span class="avatar">B</span><span><strong>老板</strong><small>控制面 · v0.3.78</small></span></div></div></aside>
<div class="main-area"><header class="topbar"><div class="breadcrumb"><span>公司</span><b>/</b><strong id="crumb">消息流</strong></div>
<div class="top-actions"><span class="status" id="stat">加载中…</span><button class="refresh" id="pause-btn" data-cmd="toggle-pause">暂停派工</button><button class="refresh" data-cmd="refresh">${relayIcon("refresh")}<span>刷新</span></button></div></header>
<main class="content"><div class="flow-pane" id="flow-pane"></div><aside class="drawer" id="drawer"></aside>
<template id="upgrade-card">上线内容：<span class="uc"></span> · 影响范围：<span class="ui"></span> · <button class="upgrade-start">升级至 v<span class="uv"></span></button> · <button class="upgrade-automatic">自动升级已开启</button></template>
</main></div></div>
<div id="toast" class="toast" role="status"></div>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=n=>'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'+(ICONS[n]||'')+'</svg>';
const ICONS={activity:'<path d="M3 12h4l2-7 4 14 2-7h6"/>',inbox:'<path d="M4 5h16v12H4z"/>',layers:'<path d="M12 3L3 8l9 5 9-5-9-5z"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5"/>'};
const store={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}}};
function prefTheme(){try{return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){return 'light'}}
function renderThemeBtn(){const b=$('theme-btn');if(b)b.innerHTML=icon((store.get('relay-theme')||prefTheme())==='light'?'activity':'layers')}
function toggleTheme(){const next=(store.get('relay-theme')||prefTheme())==='light'?'dark':'light';store.set('relay-theme',next);document.documentElement.dataset.theme=next;renderThemeBtn()}
document.documentElement.dataset.theme=store.get('relay-theme')||'light';renderThemeBtn();
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2200)}
const TOKEN=location.pathname.split('/')[2];
const api=async(cmd,o)=>{
  // 页面在 LAN 面与签名面都从自身前缀下发命令：相对地址留在 /o/<token>/ 内，Bearer 仍是同一把老板令牌。
  const r=await fetch('owner/'+cmd,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+OWNER,'X-Owner-Agent':'web'},body:JSON.stringify({command:cmd,...o})});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);return j;};
let OWNER='';let GOALS=[],TASKS=[],MESSAGES=[],INBOX=null,DEFS=[],SEL=null,GOAL='',T='flow',PAUSED=false,NOTICES=[],RETIRED=null;
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
  if(cmd==='tab'){T=arg;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.t===arg));$('crumb').textContent={flow:'消息流',inbox:'收件箱',defs:'编制'}[arg]||arg;render();}
  else if(cmd==='theme')toggleTheme();
  else if(cmd==='refresh')load();
  else if(cmd==='goal'){GOAL=arg;SEL=null;await refreshRetired();render();}
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
  else if(cmd==='new-goal')newGoalForm();
  else if(cmd==='create-goal')createGoal();
  else if(cmd==='cancel-goal')cancelGoal(arg);
  else if(cmd==='save-task')saveTask(arg);
  else if(cmd==='reassign')reassignForm(arg);
  else if(cmd==='save-reassign')saveReassign(arg);
  else if(cmd==='toggle-pause')togglePause();
  else if(cmd==='resolve-notice')resolveNotice(arg);
  else if(cmd==='resolve-retired')resolveRetired(arg);
}
async function load(){
  try{
    const [g,t,m,i,d,s,n]=await Promise.all([api('goal.list',{}),api('task.list',{}),api('message.list',{includeSent:true}),api('inbox',{}),api('def.list',{}),api('status',{}),api('notice.list',{})]);
    GOALS=g.goals||[];TASKS=t.tasks||[];MESSAGES=m.messages||[];INBOX=i;DEFS=d.defs||[];NOTICES=n.notices||[];PAUSED=s.paused===true;
    await refreshRetired();
    const n2=(INBOX.gates||[]).length+(INBOX.questions||[]).length;const b=$('nav-count');if(b){b.textContent=n2;b.hidden=!n2}
    $('stat').textContent=n2?('待办 '+n2):'运行中';$('stat').className='status'+(n2?' violet':'');
    const pb=$('pause-btn');if(pb)pb.textContent=PAUSED?'恢复派工':'暂停派工';
    render();
  }catch(e){$('stat').textContent='加载失败：'+e.message}
}
async function refreshRetired(){
  RETIRED=null;if(!GOAL)return;
  try{RETIRED=await api('goal.retired.list',{goalId:GOAL});}
  catch(e){RETIRED={goalId:GOAL,goalVersion:0,items:[],error:e.message};}
}
const laneY=r=>70+r*104;
function graph(){
  const visible=GOAL?TASKS.filter(t=>String(t.goal?.id??t.goal??'')===GOAL):TASKS.slice(0,40);
  const lanes=[...new Set(['owner',...visible.flatMap(t=>[t.executor_role,t.reviewer_role].filter(Boolean))])].slice(0,12);
  const W=1180,H=Math.max(320,lanes.length*104+60);
  let svg='<svg class="graph" viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="消息流">';
  lanes.forEach((l,r)=>{const y=laneY(r);svg+='<line class="lane-line" x1="16" y1="'+y+'" x2="'+(W-16)+'" y2="'+y+'"/><text class="lane-label" x="20" y="'+(y-12)+'">'+esc(l)+'</text>'});
  const pos=r=>laneY(Math.max(0,lanes.indexOf(r)));
  visible.forEach((t,n)=>{
    const x=180+(n%5)*196,y=pos(t.executor_role),ry=pos(t.reviewer_role);
    const msgs=MESSAGES.filter(m=>String(m.task?.id??m.task??'')===String(t.id?.id??t.id));
    const held=msgs.some(m=>m.hold||m.state==='held'),blocked=t.state==='blocked',sent=msgs.some(m=>m.state==='sent');
    const cls=blocked?'block':held?'hold':t.state==='doing'?'active':'';
    const tid=esc(String(t.id?.id??t.id));
    svg+='<g class="flow-node" data-cmd="task:'+tid+'" style="cursor:pointer">';
    svg+='<rect class="node-box '+cls+'" x="'+(x-72)+'" y="'+(y-24)+'" width="144" height="48" rx="9"/>';
    svg+='<text class="node-title" x="'+(x-62)+'" y="'+(y-3)+'">'+esc((t.title||'任务').slice(0,15))+'</text>';
    svg+='<text class="node-meta" x="'+(x-62)+'" y="'+(y+14)+'">'+esc(t.state||'')+' · '+esc(t.executor_role||'')+'</text></g>';
    const ex=x+72,ey=ry-24;
    const path='M'+ex+' '+y+' C'+(ex+48)+' '+y+','+(x+120)+' '+ey+','+(x+170)+' '+ey;
    const edgeCls=sent?(blocked?'block':''):held?'hold':'draft';
    svg+='<path id="e-'+n+'" class="edge '+edgeCls+'" d="'+path+'"/>';
    svg+='<path class="edge-hit" data-cmd="task:'+tid+'" d="'+path+'"/>';
    if(sent&&!held&&!blocked)svg+='<circle class="dot" r="3.5"><animateMotion dur="3s" repeatCount="indefinite" path="'+path+'"/></circle>';
  });
  svg+='</svg>';return svg;
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
    +'<section><h3>操作</h3><div class="row"><button data-cmd="void:'+esc(id)+'">作废</button><button data-cmd="revoke:'+esc(id)+'">撤销租约</button><button data-cmd="unlock:'+esc(id)+'">解锁</button><button data-cmd="reassign:'+esc(id)+'">改派</button></div></section>';
}
function reassignForm(id){
  $('drawer').innerHTML='<div class="kicker">REASSIGN</div><h2>改派任务</h2><div class="goal-form">'
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
function renderFlow(){
  const rail='<div class="goal-rail"><button class="goal-chip '+(GOAL?'':'active')+'" data-cmd="goal:"><strong>全部目标</strong><small>'+TASKS.length+' 个任务</small></button>'
    +GOALS.map(g=>{const gid=String(g.id?.id??g.id),active=GOAL===gid;
      return '<div class="goal-chip '+(active?'active':'')+'" data-cmd="goal:'+esc(gid)+'" role="button" tabindex="0"><strong>'+esc((g.title||'').slice(0,20))+'</strong><small>'+esc(g.state||'')+(active?' <button class="chip-cancel" data-cmd="cancel-goal:'+esc(gid)+'">取消目标</button>':'')+'</small></div>';
    }).join('')+'</div>';
  $('flow-pane').innerHTML='<div class="flow-head"><h1>消息流</h1><div class="flow-legend"><span><i></i>已发</span><span><i class="dash"></i>待发 draft</span><span><i class="hold"></i>需要我放行</span><span><i class="block"></i>阻塞到老板</span></div><div class="row"><button class="primary small" data-cmd="new-goal">+ 新增目标</button><button class="primary small" data-cmd="new-task">+ 新增任务</button></div></div>'
    +rail+'<div class="graph-scroll">'+graph()+'</div>'+retiredHtml();
  if(SEL)SEL.startsWith('m:')?drawerMsg(SEL.slice(2)):drawerTask(SEL);else drawerDefault();
}
function retiredHtml(){
  if(!GOAL)return '';
  const items=RETIRED?.items||[];
  const err=RETIRED?.error?'<p class="meta">读取失败：'+esc(RETIRED.error)+'</p>':'';
  return '<section class="retired-box"><h3>待处置作废任务 '+(RETIRED?items.length:'…')+'</h3>'+err
    +items.map(x=>'<div class="inbox-card"><h3>'+esc(x.title||x.taskId)+'</h3><p class="meta">'+esc(String(x.taskId))+' · '+esc(x.retiredBy||'')+'</p><div class="goal-form">'
      +'<label>处置方式<select id="rr-d-'+esc(String(x.taskId))+'"><option value="fixture">fixture</option><option value="replaced">replaced</option><option value="excluded">excluded</option></select></label>'
      +'<label>替代任务 ID（replaced 时必填，逗号分隔）<input id="rr-r-'+esc(String(x.taskId))+'"/></label>'
      +'<label>处置原因（至少 10 个字）<input id="rr-n-'+esc(String(x.taskId))+'"/></label>'
      +'<div class="row"><button data-cmd="resolve-retired:'+esc(String(x.taskId))+'">提交处置</button></div></div></div>').join('')
    +(items.length?'':'<p class="meta">无待处置任务</p>')+'</section>';
}
async function cancelGoal(goalId){
  const note=prompt('取消目标的原因（至少 2 个字）')||'';
  if(note.trim().length<2)return;
  await api('goal.cancel',{goalId,note});toast('已取消目标');GOAL='';SEL=null;RETIRED=null;await load();
}
function newGoalForm(){
  $('drawer').innerHTML='<div class="kicker">NEW GOAL</div><h2>新建目标</h2><div class="goal-form">'
    +'<label>目标内容<textarea id="g-text"></textarea></label>'
    +'<label>产线<select id="g-pipeline"><option value="software">software</option><option value="story">story</option><option value="video">video</option></select></label>'
    +'<label>档位<select id="g-tier"><option value="quick">quick</option><option value="standard">standard</option><option value="program">program</option></select></label>'
    +'<div class="row"><button class="primary" data-cmd="create-goal">创建并分级</button></div></div>';
}
async function createGoal(){
  const text=$('g-text').value.trim();if(text.length<2){toast('请填写目标内容');return}
  const pipeline=$('g-pipeline').value,tier=$('g-tier').value;
  const g=await api('goal.create',{text,pipeline,tier});
  const goalId=String(g.id?.id??g.id??'');
  await api('goal.triage',{goalId,tier});
  toast('已创建目标');GOAL=goalId;SEL=null;await load();
}
async function togglePause(){
  await api(PAUSED?'task.resume':'task.pause',{});PAUSED=!PAUSED;toast(PAUSED?'已暂停派工':'已恢复派工');await load();
}
async function resolveNotice(key){
  await api('notice.resolve',{key});toast('已关闭提醒');await load();
}
async function resolveRetired(taskId){
  const item=(RETIRED?.items||[]).find(x=>String(x.taskId)===taskId);
  if(!item){toast('该任务已不在待处置列表');return}
  const disposition=$('rr-d-'+taskId).value;
  const replacementTaskIds=$('rr-r-'+taskId).value.split(',').map(s=>s.trim()).filter(Boolean);
  const reason=$('rr-n-'+taskId).value.trim();
  if(reason.length<10){toast('处置原因至少 10 个字');return}
  await api('goal.retired.resolve',{goalId:GOAL,taskId,goalVersion:RETIRED.goalVersion,taskVersion:item.version??0,disposition,replacementTaskIds,reason});
  toast('已处置');await refreshRetired();render();
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
  $('drawer').innerHTML='<div class="kicker">DEF</div><h2>新建 / 修改编制</h2><div class="goal-form"><label>ID<input id="d-id"/></label><label>岗位<select id="d-role">'+['product','engineering','qa','concept-design','asset-production','screenwriter','story-author','cinematography','cs','eval'].map(r=>'<option>'+r+'</option>').join('')+'</select></label><label>provider<input id="d-provider" value="codex"/></label><label>model<input id="d-model" value="auto:sol"/></label><div class="row"><button class="primary" data-cmd="create-def">保存编制</button></div></div>';
}
function render(){if(T==='flow')renderFlow();else if(T==='inbox')renderInbox();else renderDefs()}
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
async function unlockTask(id){await api('task.unlock',{taskId:id});await load()}
async function toggleDef(id,on){await api(on?'def.enable':'def.disable',{id});await load()}
async function createDef(){await api('def.ensure',{id:$('d-id').value,role:$('d-role').value,provider:$('d-provider').value,model:$('d-model').value});toast('已保存编制');await load()}
function newTaskForm(){
  $('drawer').innerHTML='<div class="kicker">NEW TASK</div><h2>新增任务</h2><div class="goal-form">'
    +'<label>标题<input id="n-title"/></label><label>需求<textarea id="n-req"></textarea></label><label>验收标准<textarea id="n-ac"></textarea></label>'
    +'<label>执行岗<select id="n-ex">'+['engineering','qa','product','concept-design','asset-production','screenwriter','story-author','cinematography','cs'].map(r=>'<option>'+r+'</option>').join('')+'</select></label>'
    +'<label>复核岗<select id="n-rev">'+['qa','engineering','owner','product'].map(r=>'<option>'+r+'</option>').join('')+'</select></label>'
    +'<label>依赖任务 ID（逗号分隔）<input id="n-deps"/></label><div class="row"><button class="primary" data-cmd="create-task">创建并生成两条草稿</button></div></div>';
}
async function createTask(){await api('task.create',{title:$('n-title').value,requirement:$('n-req').value,acceptanceText:$('n-ac').value,executorRole:$('n-ex').value,reviewerRole:$('n-rev').value,dependencies:$('n-deps').value.split(',').map(s=>s.trim()).filter(Boolean),goalId:GOAL||undefined});toast('已创建');SEL=null;await load()}
boot().catch(e=>{$('stat').textContent='初始化失败：'+e.message});
</script></body></html>`;

