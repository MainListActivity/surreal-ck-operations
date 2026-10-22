/**
 * QA 专属只读验收台（SYS-DISP 7454fc89 / B1–B3）。
 *
 * A separate LAN page, not a tab in the owner CompanySurface. The QA exchanges the one-time code from
 * `qa_observation_session` here for an HttpOnly cookie carrying the restricted read-only QA session; the cookie
 * is never in the URL or the page, and the page has no owner RPC and no write route. The timeline follows
 * page.nextCursor; context and evidence are read in nextOffset+sha256 segments and reassembled here. A pass
 * observation that is partial or stale is shown as partial/unavailable, never as complete.
 */
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";

type QaCore = {
  // Typed as any on the boundary: the core's own contracts are authoritative; this page only shapes their answers.
  qaObservationLogin?: (code: string) => Promise<any>;
  qaObservationRead?: (auth: any, input: any) => Promise<any>;
  qaObservationTimeline?: (auth: any, input: any) => Promise<any>;
  qaObservationText?: (auth: any, input: any) => Promise<any>;
};
type QaCompanyApi = { core: QaCore };
export interface QaConsoleOptions { home: string; company: () => Promise<QaCompanyApi>; log?: (message: string) => void }

type QaScope = { id?: string; goalId?: string; deploymentTaskId?: string; subjects?: string[]; expiresAt?: string; leaseHolder?: string; leaseFence?: number; version?: number; status?: string };
type QaRead = {
  meta?: { checkedAt?: string; dataSource?: string; instanceAt?: string; runtimeRelease?: string; scope?: QaScope;
    completeness?: Record<string, unknown> };
  task?: Record<string, unknown>;
  contribution?: { authors?: string[]; reviewers?: string[]; excluded?: string[]; implementer?: string; ambiguous?: boolean;
    unknown?: Array<{ actor?: string; action?: string; reason?: string }> };
  dispatch?: { available?: boolean; complete?: boolean; source?: string; checkedAt?: string; reason?: string;
    originalVerdicts?: number; originalReasons?: number; attemptAt?: string; attemptOk?: boolean;
    verdicts?: Array<{ phase?: string; dispatchable?: boolean; workflowState?: string; eligibleCount?: number;
      waitingMinutes?: number; summary?: string; checkedAt?: string;
      reasons?: Array<{ code?: string; text?: string; candidates?: string[]; owner?: string; recovery?: string; nextTrigger?: string; basis?: string; until?: string; actions?: Array<{ authority?: string; label?: string; tool?: string; executable?: boolean }> }> }> };
  goal?: { id?: string; states?: Record<string, number>; total?: number; undispatchable?: number; checkedAt?: string;
    dispatchAvailable?: boolean; dispatchComplete?: boolean; dispatchSource?: string; dispatchReason?: string;
    dispatchCheckedAt?: string; dispatchAttemptAt?: string; dispatchAttemptOk?: boolean;
    root?: { taskId?: string; title?: string; phase?: string; workflowState?: string; summary?: string; feasible?: boolean;
      waitingMinutes?: number; since?: string; checkedAt?: string; eligibleCount?: number; undispatchable?: number; others?: number;
      noticeKey?: string; factsAvailable?: boolean; impact?: number; dependencyPath?: Array<{ taskId?: string; title?: string }>;
      people?: { implementer?: string; authors?: string[]; reviewers?: string[]; submitter?: string; submitCommit?: string; peopleOmitted?: number };
      reasons?: Array<{ code?: string; text?: string; candidates?: string[]; owner?: string; recovery?: string; nextTrigger?: string; basis?: string; until?: string;
        actions?: Array<{ authority?: string; label?: string; tool?: string; executable?: boolean }> }>;
      reasonsOmitted?: number } };
  contextOmitted?: boolean; contextBytes?: number; contextSha256?: string;
};
type QaTimeline = { meta?: QaRead['meta']; history?: Array<{ auditId?: string; action?: string; actor?: string; at?: string; version?: number; evidence?: string; evidenceBytes?: number; evidenceSha256?: string; evidenceTruncated?: boolean }>; page?: { returned?: number; total?: number; hasMore?: boolean; nextCursor?: string; snapshotAt?: string } };
type QaTextSegment = { taskId?: string; field?: string; auditId?: string; totalBytes?: number; sha256?: string; offset?: number; bytes?: number; nextOffset?: number | null; text?: string };

const COOKIE = "sck_qa";
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const html = (body: string, status = 200): Response => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
const redirect = (location: string): Response => new Response(null, { status: 303, headers: { Location: location } });
const method = (): Response => new Response("method not allowed; this console is read-only", { status: 405, headers: { Allow: "GET" } });
const notFound = (): Response => new Response("not found", { status: 404 });
const cookieOf = (req: Request): string | undefined => {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
};
const releaseOf = (home: string): string | undefined => {
  try { return basename(realpathSync(join(home, "active"))); } catch { return undefined; }
};
const layout = (title: string, body: string): string => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,system-ui,sans-serif;background:#0d0f14;color:#e6e8ee}
header{position:sticky;top:0;background:#161a22;border-bottom:1px solid #262b38;padding:12px 16px;display:flex;gap:12px;align-items:center;z-index:9}
header b{font-size:16px}header span{color:#8b93a7;font-size:12px}main{padding:12px;max-width:840px;margin:0 auto}
.card{background:#161a22;border:1px solid #262b38;border-radius:12px;padding:14px;margin-bottom:12px}
.card h3{margin:0 0 4px;font-size:15px}.meta{color:#8b93a7;font-size:12px;margin-bottom:8px;word-break:break-all}
pre{white-space:pre-wrap;word-break:break-word;background:#10131a;border-radius:8px;padding:10px;max-height:55vh;overflow:auto;font:13px/1.6 ui-monospace,Menlo,monospace}
a{color:#6fa3ff;word-break:break-all}details{margin-top:6px}summary{cursor:pointer;color:#9aa3b8;font-size:13px}
.tag{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid #2a3140;color:#9aa3b8;margin-left:6px}
.err{color:#ff9a9a;font-size:13px;margin-top:8px;white-space:pre-wrap}.ok{color:#7fd0a0}.warn{color:#ffc26a}
input{width:100%;background:#10131a;border:1px solid #2a3140;border-radius:8px;color:#e6e8ee;padding:9px;font:14px/1.5 inherit;margin:8px 0}
button{background:#2a4d8f;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}</style></head><body>
<header><b>QA 只读验收台</b><span>受限会话 · 仅 allowlist · 无写操作</span></header><main>${body}</main></body></html>`;

function loginPage(error = ""): Response {
  return html(layout("QA 只读验收台", `<div class="card"><h3>输入一次性登录码</h3>
<p class="meta">登录码由本任务 sck 会话的 <code>qa_observation_session</code> 生成，5 分钟一次性使用。本页面不接收 owner token 或员工凭证；登录后只获得 30 分钟只读受限会话。</p>
<form method="post" action="/q/login"><input name="code" autocomplete="one-time-code" placeholder="一次性登录码" required><button type="submit">进入只读验收</button></form>
${error ? `<div class="err">${esc(error)}</div>` : ""}</div>`));
}
const scopeLinks = (scope: QaScope | undefined, current?: string): string => {
  const subjects = scope?.subjects ?? [];
  const links = subjects.map(id => `<a href="/q/?taskId=${encodeURIComponent(id)}"${id === current ? ' style="font-weight:700"' : ""}>${esc(id)}</a>`).join(" · ");
  return `<div class="meta">scope ${esc(scope?.id)} · goal ${esc(scope?.goalId)} · 部署任务 ${esc(scope?.deploymentTaskId)} · fence ${esc(scope?.leaseFence)} · 到期 ${esc(scope?.expiresAt)}</div>
<div class="meta">主体：${links || "无"} · <a href="/q/?goal=1">目标汇总</a> · <a href="/q/">刷新</a></div>`;
};
const dispatchHtml = (dispatch: QaRead["dispatch"]): string => {
  if (!dispatch) return "";
  const state = dispatch.available
    ? `<span class="ok">可用</span>${dispatch.complete === false ? '<span class="tag warn">partial</span>' : '<span class="tag ok">complete</span>'}`
    : `<span class="warn">不可用（失败关闭）</span>${dispatch.complete === false ? '<span class="tag warn">partial</span>' : ""}`;
  const counts = dispatch.originalVerdicts !== undefined || dispatch.originalReasons !== undefined
    ? ` · 原总数 ${esc(dispatch.originalVerdicts)} 主体 / ${esc(dispatch.originalReasons)} 原因` : "";
  const attempt = dispatch.attemptOk === false
    ? ` · 最近一次保存失败（${esc(dispatch.attemptAt)}），旧快照为 stale` : "";
  const verdicts = (dispatch.verdicts ?? []).map(v => `<div class="card"><h3>${v.phase === "review" ? "复核" : "执行"} · ${v.dispatchable ? "可派" : "无法派工"} · 工作流 ${esc(v.workflowState)} · 可选 ${esc(v.eligibleCount)} · 已等 ${esc(v.waitingMinutes)} 分钟</h3>
<div class="meta">结论检查于 ${esc(v.checkedAt)}${v.summary ? ` · ${esc(v.summary)}` : ""}</div>
${(v.reasons ?? []).map(r => {
      const actions = r.actions && r.actions.length > 0
        ? r.actions.map(a => `${esc(a.authority ?? "未知")}：${esc(a.label ?? "未知")}${a.tool ? `（工具 ${esc(a.tool)}${a.executable === false ? "，不可执行" : ""}）` : a.executable === false ? "（不可执行）" : ""}`).join("；")
        : "未知（旧记录未携带结构化动作）";
      return `<div class="meta">${esc(r.code)} · ${esc(r.text)} · 候选 ${esc((r.candidates ?? []).filter(c => c !== "*").join("、") || "全局")} · 负责 ${esc(r.owner ?? "未知")} · 恢复 ${esc(r.recovery ?? "未知")}${r.until ? ` · 到 ${esc(r.until)}` : ""}</div>
<div class="meta">下一触发 ${esc(r.nextTrigger ?? "未知")} · 依据 ${esc(r.basis ?? "未知")} · 动作 ${actions}</div>`;
    }).join("")}</div>`).join("");
  return `<div class="card"><h3>派工评估 ${state}</h3><div class="meta">来源 ${esc(dispatch.source)} · 检查于 ${esc(dispatch.checkedAt)}${counts}${attempt}</div>${dispatch.available ? verdicts : `<div class="err">${esc(dispatch.reason ?? "派工结论不可用")}</div>`}</div>`;
};
const taskHtml = (read: QaRead, taskId: string | undefined): string => {
  const task = read.task;
  if (!task) return "";
  const inlineContext = typeof task.context === "string" && task.context.length > 0 ? task.context : "";
  const contextLink = `<a href="/q/text?taskId=${encodeURIComponent(taskId ?? "")}&field=context">读取正文${inlineContext ? "（分段/原文）" : ""}</a>`;
  return `<div class="card"><h3>${esc(task.title)}</h3>
<div class="meta">编号 ${esc(task.id)} · 状态 ${esc(task.state)} · 版本 ${esc(task.version)} · 执行 ${esc(task.executorRole)} · 复核 ${esc(task.reviewerRole)} · 实现人 ${esc(task.implementer ?? "未知")} · 当前租约 ${esc(task.currentEmployee ?? "无")}</div>
<div class="meta">goal ${esc(task.goalId)} · kind ${esc(task.kind)} · 依赖 ${esc((task.dependencies as unknown[] | undefined)?.length ?? 0)} 项 · 等待 ${esc(task.waiting ? JSON.stringify(task.waiting) : "无")}</div>
${inlineContext ? `<details open><summary>正文（${esc(Buffer.byteLength(inlineContext, "utf8"))} 字节，页面已渲染）</summary><pre>${esc(inlineContext)}</pre></details>` : ""}
<div class="meta">完整性：${inlineContext ? "core 返回正文，页面已渲染" : "正文未在页面内联"} · ${contextLink}</div>
${read.contextOmitted ? `<div class="meta">正文未内联（${esc(read.contextBytes)} 字节，sha256 ${esc(read.contextSha256)}）：${contextLink}</div>` : ""}
<div class="row"><a href="/q/timeline?taskId=${encodeURIComponent(taskId ?? "")}">审计时间线</a><a href="/q/?taskId=${encodeURIComponent(taskId ?? "")}">刷新本主体</a></div></div>`;
};
const contributionHtml = (read: QaRead): string => {
  const c = read.contribution;
  if (!c) return "";
  const unknown = c.unknown ?? [];
  return `<div class="card"><h3>贡献者（作者回避）</h3><div class="meta">作者 ${esc((c.authors ?? []).join("、") || "无")} · 复核 ${esc((c.reviewers ?? []).join("、") || "无")} · 回避 ${esc((c.excluded ?? []).join("、") || "无")} · 实现人 ${esc(c.implementer ?? "未定")}${c.ambiguous ? " · 作者不唯一" : ""}</div>
${unknown.length ? `<div class="warn">未知贡献 ${unknown.length} 条（fail-closed）：${esc(unknown.map(u => `${u.actor ?? "?"}:${u.action ?? "?"}`).join("、"))}</div>` : ""}</div>`;
};
const metaHtml = (read: QaRead, runtimeRelease: string | undefined): string => {
  const meta = { ...(read.meta ?? {}), ...(runtimeRelease ? { runtimeRelease } : {}) };
  return `<div class="card"><div class="meta">检查于 ${esc(meta.checkedAt)} · 数据源 ${esc(meta.dataSource ?? "live")} · 实例时点 ${esc(meta.instanceAt)}${meta.runtimeRelease ? ` · release ${esc(meta.runtimeRelease)}` : ""}</div>
<div class="meta">完整性 ${esc(JSON.stringify(meta.completeness ?? {}))}</div></div>`;
};
const timelineHtml = (timeline: QaTimeline, taskId: string): string => {
  const page = timeline.page ?? {};
  const entries = (timeline.history ?? []).map(entry => {
    const body = entry.evidence
      ? (entry.evidenceTruncated
        ? `<div class="meta">证据已截断（${esc(entry.evidenceBytes)} 字节，sha256 ${esc(entry.evidenceSha256)}）：<a href="/q/text?taskId=${encodeURIComponent(taskId)}&field=evidence&auditId=${encodeURIComponent(entry.auditId ?? "")}">分段读取并重组</a></div>`
        : `<details><summary>证据（${esc(entry.evidenceBytes ?? entry.evidence.length)} 字节）</summary><pre>${esc(entry.evidence)}</pre></details>`)
      : "";
    return `<div class="card"><h3>${esc(entry.action)} · ${esc(entry.actor)}${entry.version !== undefined ? ` · v${esc(entry.version)}` : ""}</h3><div class="meta">${esc(entry.at)} · auditId ${esc(entry.auditId)}</div>${body}</div>`;
  }).join("");
  const next = page.hasMore && page.nextCursor
    ? `<a href="/q/timeline?taskId=${encodeURIComponent(taskId)}&cursor=${encodeURIComponent(page.nextCursor)}">下一页</a>` : "已到末页";
  return `<div class="card"><h3>审计时间线</h3><div class="meta">本页 ${esc(page.returned)} 条 · 共 ${esc(page.total)} 条 · 快照 ${esc(page.snapshotAt)}</div><div class="row">${next} · <a href="/q/?taskId=${encodeURIComponent(taskId)}">返回主体</a> · <a href="/q/timeline?taskId=${encodeURIComponent(taskId)}">从头</a></div></div>${entries}`;
};
const textHtml = (result: Awaited<ReturnType<typeof collectText>>, taskId: string, field: string, auditId: string | undefined): string => {
  const next = !result.complete && result.nextOffset !== null && result.sha256
    ? `<a href="/q/text?taskId=${encodeURIComponent(taskId)}&field=${encodeURIComponent(field)}${auditId ? `&auditId=${encodeURIComponent(auditId)}` : ""}&offset=${result.nextOffset}&expectSha256=${result.sha256}">继续下一段</a>` : "";
  return `<div class="card"><h3>${field === "evidence" ? "审计证据" : "任务正文"}</h3>
<div class="meta">${result.complete ? '<span class="ok">完整</span>' : '<span class="warn">部分（可继续）</span>'} · 已重组 ${esc(result.segments)} 段 / ${esc(result.text.length)} 字符 · 全文 ${esc(result.totalBytes)} 字节 · sha256 ${esc(result.sha256)}</div>
<div class="row">${next} · <a href="/q/text?taskId=${encodeURIComponent(taskId)}&field=${encodeURIComponent(field)}${auditId ? `&auditId=${encodeURIComponent(auditId)}` : ""}">从头发起</a> · <a href="/q/?taskId=${encodeURIComponent(taskId)}">返回主体</a></div>
<pre>${esc(result.text)}</pre></div>`;
};

async function collectText(core: QaCore, token: string, taskId: string, field: "context" | "evidence", auditId: string | undefined) {
  const parts: string[] = [];
  let offset = 0;
  let sha: string | undefined;
  let totalBytes = 0;
  let segments = 0;
  let complete = false;
  for (let i = 0; i < 64; i++) {
    if (!core.qaObservationText) throw new Error("QA observation text is unavailable");
    const segment = await core.qaObservationText({ token }, {
      taskId, field, ...(auditId ? { auditId } : {}), offset, limit: 16_384,
      ...(sha ? { expectSha256: sha } : {}),
    });
    sha = segment.sha256;
    totalBytes = segment.totalBytes ?? totalBytes;
    parts.push(segment.text ?? "");
    segments++;
    if (segment.nextOffset === null || segment.nextOffset === undefined) { complete = true; break; }
    offset = segment.nextOffset;
    if (parts.join("").length > 8 * 1024 * 1024) break;
  }
  return { text: parts.join(""), totalBytes, sha256: sha, complete, nextOffset: complete ? null : offset, segments };
}

export function createQaConsoleFetch(opts: QaConsoleOptions): (req: Request) => Promise<Response> {
  const scopes = new Map<string, QaScope>();
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/q") return redirect("/q/");
    if (!url.pathname.startsWith("/q/")) return notFound();
    let core: QaCore;
    try { core = (await opts.company()).core; } catch (error) {
      return html(layout("QA 只读验收台", `<div class="card"><div class="err">公司服务不可用：${esc((error as Error).message)}</div></div>`), 503);
    }
    if (url.pathname === "/q/login") {
      if (req.method !== "POST") return method();
      if (!core.qaObservationLogin) return html(layout("QA 只读验收台", `<div class="card"><div class="err">QA 登录不可用</div></div>`), 503);
      let code = "";
      try {
        const form = await req.formData();
        code = String((form as any).get("code") ?? "").trim();
      } catch { /* malformed form */ }
      if (!code) return loginPage("缺少登录码");
      try {
        const login = await core.qaObservationLogin(code);
        if (!login.token) return loginPage("登录码无效");
        scopes.set(login.token, login.scope ?? {});
        if (scopes.size > 50) scopes.delete(scopes.keys().next().value as string);
        return new Response(null, { status: 303, headers: {
          Location: "/q/",
          "Set-Cookie": `${COOKIE}=${encodeURIComponent(login.token)}; HttpOnly; SameSite=Strict; Path=/q; Max-Age=1800`,
        } });
      } catch (error) { return loginPage((error as Error).message); }
    }
    if (req.method !== "GET") return method();
    const token = cookieOf(req);
    if (!token) return loginPage();
    const runtimeRelease = releaseOf(opts.home);
    try {
      if (url.pathname === "/q/") {
        const known = scopes.get(token);
        const goal = url.searchParams.get("goal") === "1";
        const taskId = url.searchParams.get("taskId") ?? (goal ? undefined : known?.subjects?.[0]);
        if (!goal && !taskId) return loginPage("请从 sck 会话返回的链接打开，或重新登录");
        if (!core.qaObservationRead) throw new Error("QA observation read is unavailable");
        const read = await core.qaObservationRead({ token }, goal ? { goalId: known?.goalId } : { taskId });
        const scope = read.meta?.scope ?? known;
        if (scope?.id) scopes.set(token, scope);
        if (goal) {
          // `read` is typed at the untyped QaCore boundary: narrow the goal view to its declared shape so the
          // dependency-path/reason/action callbacks keep their structure instead of widening to implicit any.
          const g = (read.goal ?? {}) as NonNullable<QaRead["goal"]>;
          const coverage = g.dispatchComplete === true
            ? `完整${g.dispatchCheckedAt ? `（检查于 ${esc(g.dispatchCheckedAt)}）` : ""}`
            : `不可用/未知${g.dispatchReason ? `（${esc(g.dispatchReason)}）` : ""}`;
          const undispatchable = g.dispatchComplete === true ? esc(g.undispatchable ?? 0) : "未知（未核验）";
          const root = g.root;
          const rootHtml = root ? (() => {
            const facts = root.factsAvailable === true;
            const impact = facts ? `${esc(root.impact ?? 0)} 项` : "未知（事实不可读）";
            const path = facts && (root.dependencyPath ?? []).length > 0
              ? root.dependencyPath!.map(p => `${esc(p.title ?? p.taskId)}（${esc(p.taskId)}）`).join(" → ")
              : facts ? "无后续等待" : "未知";
            const people = facts && root.people
              ? `实现人 ${esc(root.people.implementer ?? "未定")} · 作者 ${esc((root.people.authors ?? []).join("、") || "无")} · 复核 ${esc((root.people.reviewers ?? []).join("、") || "无")} · 提交人 ${esc(root.people.submitter ?? "未知")} · 提交 SHA ${esc(root.people.submitCommit ?? "未知")}${root.people.peopleOmitted ? ` · 另有 ${esc(root.people.peopleOmitted)} 人未列出` : ""}`
              : "未知（事实不可读）";
            const reasons = (root.reasons ?? []).map(r => {
              const actions = r.actions && r.actions.length > 0
                ? r.actions.map(a => `${esc(a.authority ?? "未知")}：${esc(a.label ?? "未知")}${a.tool ? `（工具 ${esc(a.tool)}，${a.executable === false ? "不可执行" : "可执行"}）` : a.executable === false ? "（不可执行）" : ""}`).join("；")
                : "未知（旧记录未携带结构化动作）";
              return `<div class="meta">${esc(r.code)} · ${esc(r.text)} · 候选 ${esc((r.candidates ?? []).filter(c => c !== "*").join("、") || "全局")} · 负责 ${esc(r.owner ?? "未知")} · 恢复 ${esc(r.recovery ?? "未知")}</div>
<div class="meta">下一触发 ${esc(r.nextTrigger ?? "未知")} · 依据 ${esc(r.basis ?? "未知")} · 动作 ${actions}</div>`;
            }).join("");
            return `<div class="card"><h3>根阻点 · ${esc(root.title)}</h3>
<div class="meta">任务 ${esc(root.taskId)} · ${esc(root.phase === "review" ? "复核" : "执行")} · 工作流 ${esc(root.workflowState)} · 可派 ${root.feasible ? "是" : "否"} · 可选 ${esc(root.eligibleCount)} 人 · 已等 ${esc(root.waitingMinutes)} 分钟${root.since ? ` · 自 ${esc(root.since)}` : ""} · 结论检查于 ${esc(root.checkedAt)}${root.noticeKey ? ` · notice ${esc(root.noticeKey)}` : ""}</div>
<div class="meta">${esc(root.summary)} · 本目标无法派工 ${esc(root.undispatchable)} 项（另 ${esc(root.others)} 项同目标） · 影响 ${impact}</div>
<div class="meta">依赖路径 ${path}</div>
<div class="meta">${people}</div>
${reasons}${root.reasonsOmitted ? `<div class="meta">另有 ${esc(root.reasonsOmitted)} 条原因未列出</div>` : ""}</div>`;
          })() : `<div class="card"><div class="meta">根阻点：本轮 pass 中该目标无可报的阻断结论（或派工快照不可用）</div></div>`;
          return html(layout("QA 目标汇总", `${scopeLinks(scope)}${metaHtml(read, runtimeRelease)}<div class="card"><h3>目标 ${esc(g.id)}</h3>
<div class="meta">总任务 ${esc(g.total)} · 状态计数 ${esc(JSON.stringify(g.states ?? {}))} · 派工覆盖 ${coverage} · 无法派工 ${undispatchable} · 检查于 ${esc(g.checkedAt)}</div>
<pre>${esc(JSON.stringify(g.states ?? {}, null, 2))}</pre></div>${rootHtml}`));
        }
        return html(layout("QA 只读验收", `${scopeLinks(scope, taskId)}${metaHtml(read, runtimeRelease)}${taskHtml(read, taskId)}${dispatchHtml(read.dispatch)}${contributionHtml(read)}`));
      }
      if (url.pathname === "/q/timeline") {
        const taskId = url.searchParams.get("taskId") ?? "";
        if (!taskId) return notFound();
        if (!core.qaObservationTimeline) throw new Error("QA observation timeline is unavailable");
        const timeline = await core.qaObservationTimeline({ token }, {
          taskId, pageSize: 10, ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        });
        return html(layout("QA 审计时间线", `${timelineHtml(timeline, taskId)}`));
      }
      if (url.pathname === "/q/text") {
        const taskId = url.searchParams.get("taskId") ?? "";
        const field = url.searchParams.get("field") === "evidence" ? "evidence" : "context";
        const auditId = url.searchParams.get("auditId") ?? undefined;
        if (!taskId) return notFound();
        const result = await collectText(core, token, taskId, field, auditId);
        return html(layout("QA 正文/证据", textHtml(result, taskId, field, auditId)));
      }
      return notFound();
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (/session|forbidden|expired|invalid/i.test(message)) {
        return new Response(null, { status: 303, headers: { Location: "/q/", "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/q; Max-Age=0` } });
      }
      return html(layout("QA 只读验收", `<div class="card"><div class="err">${esc(message.slice(0, 500))}</div><div class="row"><a href="/q/">返回</a></div></div>`), 500);
    }
  };
}
