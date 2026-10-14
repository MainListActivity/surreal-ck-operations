import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { company } from "./company";
import { refreshModels, refreshQuota } from "./dispatch";
import { serviceHome } from "./env";
import * as rpc from "../shared/rpc";

const SOURCE = "owner:paseo-plugin";

const compareVersion = (a: string, b: string): number => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

const resolveSlot = (entry: any, match: (id: string) => { family: string; version: string } | undefined, family: string): string | undefined => {
  let best: { version: string; id: string } | undefined;
  for (const m of entry.models ?? []) {
    if (m.isSelectable === false) continue;
    const hit = match(m.id);
    if (hit?.family === family && (!best || compareVersion(hit.version, best.version) > 0)) best = { version: hit.version, id: m.id };
  }
  return best?.id;
};

export function registerHandlers(server: PluginServerContext): void {
  server.handle(rpc.inbox, async () => (await company()).owner.inbox());
  server.handle(rpc.brief, async () => (await company()).owner.brief());

  server.handle(rpc.createGoal, async (input: RpcInput<typeof rpc.createGoal>) => {
    const goal = await (await company()).owner.createGoal({
      text: input.text, source: SOURCE, key: input.key, tier: input.tier, project: input.project, pipeline: input.pipeline,
    });
    return { id: goal.id, state: goal.state };
  });

  server.handle(rpc.triageGoal, async (input: RpcInput<typeof rpc.triageGoal>) => {
    const goal = await (await company()).owner.triage(input.goalId, input.tier, "owner:paseo-plugin");
    return { id: goal.id, state: goal.state, tier: goal.tier };
  });

  server.handle(rpc.addDirection, async (input: RpcInput<typeof rpc.addDirection>) => {
    await (await company()).owner.addDirection({ text: input.text, source: SOURCE, key: input.key });
    return { ok: true };
  });

  server.handle(rpc.decide, async (input: RpcInput<typeof rpc.decide>) => {
    const task = await (await company()).owner.decide({
      taskId: input.taskId, decision: input.decision, note: input.note, source: SOURCE, key: input.key,
    });
    return { state: task.state };
  });

  server.handle(rpc.voidTask, async (input: RpcInput<typeof rpc.voidTask>) => {
    const task = await (await company()).owner.retire({
      taskId: input.taskId, note: input.note, source: SOURCE, key: input.key,
    });
    return { state: task.state };
  });

  server.handle(rpc.revokeTask, async (input: RpcInput<typeof rpc.revokeTask>) => {
    const reason = input.note.trim() || "老板终止在途执行";
    return await (await company()).workforce.revokeTaskLease(input.taskId, reason,
      "【交接包】老板终止了上一棒的在途执行。先核对任务分支/授权目录中的实际改动与已有 checkpoint，再继续；不要重复已完成且已验证的步骤。",
      SOURCE);
  });

  server.handle(rpc.unlockTask, async (input: RpcInput<typeof rpc.unlockTask>) => {
    const unlocked = await (await company()).owner.unlockDependents({ taskId: input.taskId, source: SOURCE });
    return { unlocked };
  });

  server.handle(rpc.cancelGoalRpc, async (input: RpcInput<typeof rpc.cancelGoalRpc>) => {
    return await (await company()).owner.cancelGoal({
      goalId: input.goalId, note: input.note, source: SOURCE, key: input.key,
    });
  });

  server.handle(rpc.resolveNotice, async (input: RpcInput<typeof rpc.resolveNotice>) => {
    await (await company()).owner.resolveNotice(input.key);
    return { ok: true };
  });

  server.handle(rpc.setPaused, async (input: RpcInput<typeof rpc.setPaused>) => {
    await (await company()).owner.setPaused(input.paused);
    return { ok: true };
  });

  server.handle(rpc.goalTasks, async (input: RpcInput<typeof rpc.goalTasks>) => {
    const { db } = await company();
    const { view } = await import("./vendor/src/core.ts");
    const { id } = await import("./vendor/src/core.ts");
    const [rows] = await db.db.query<[Parameters<typeof view>[0][]]>(
      "SELECT *, string::slice(context ?? '', 0, 1200) AS context FROM task WHERE goal = $goal ORDER BY created_at, id LIMIT 500;", { goal: id("goal", input.goalId) });
    return { tasks: rows.map(view) };
  });

  server.handle(rpc.taskDetail, async (input: RpcInput<typeof rpc.taskDetail>) => {
    const { db } = await company();
    const { view, id, asId } = await import("./vendor/src/core.ts");
    const task = await db.db.select<any>(id("task", input.taskId));
    if (!task) throw new Error("task not found");
    const [audit] = await db.db.query<[any[]]>(
      `SELECT action, actor, string::slice(evidence ?? '', 0, 6000) AS evidence, version, at
       FROM (SELECT * FROM audit WHERE task = $task ORDER BY at DESC LIMIT 300) ORDER BY at;`,
      { task: task.id });
    return {
      task: view(task as Parameters<typeof view>[0]),
      audit: audit.map(a => ({ action: a.action, actor: asId(a.actor), evidence: a.evidence, version: a.version, at: String(a.at) })),
    };
  });

  server.handle(rpc.taskAttachments, async (input: RpcInput<typeof rpc.taskAttachments>) => {
    const { listTaskAttachments } = await import("./vendor/src/attachments.ts");
    return { attachments: await listTaskAttachments(serviceHome(), input.taskId) };
  });

  server.handle(rpc.attachmentUrl, async (input: RpcInput<typeof rpc.attachmentUrl>) => {
    // 老板亲定 LAN 口径：附件打开路径统一为内嵌预览服务 URL（/e/ 路由，无时效）。
    // 公网签名链路（preview-sign + 签名面 :18778）保留给远程可达链路的部署腿。
    const { resolveTaskAttachment } = await import("./vendor/src/attachments.ts");
    const { previewLanBase } = await import("./vendor/src/deliverables.ts");
    const abs = await resolveTaskAttachment(serviceHome(), input.taskId, input.name);
    if (!abs) throw new Error("附件不存在或越界");
    const rel = input.name.split("/").map(encodeURIComponent).join("/");
    const url = `${previewLanBase(serviceHome())}/e/${encodeURIComponent(input.taskId)}/${rel}`;
    return { url };
  });

  server.handle(rpc.openAttachment, async (input: RpcInput<typeof rpc.openAttachment>) => {
    const { isOpenBlocked, resolveTaskAttachment } = await import("./vendor/src/attachments.ts");
    if (isOpenBlocked(input.name)) throw new Error("该文件类型不允许一键打开");
    const abs = await resolveTaskAttachment(serviceHome(), input.taskId, input.name);
    if (!abs) throw new Error("附件不存在或越界");
    spawn("/usr/bin/open", [abs], { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  });

  server.handle(rpc.openExternal, async (input: RpcInput<typeof rpc.openExternal>) => {
    const url = input.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("只允许 http(s) 链接");
    const [bin, args] = process.platform === "darwin" ? ["/usr/bin/open", [url]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
    spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  });

  server.handle(rpc.consoleUrl, async () => {
    const { consoleUrl } = await import("./console.ts");
    const { previewLanBase } = await import("./vendor/src/deliverables.ts");
    return { url: consoleUrl(serviceHome(), () => previewLanBase(serviceHome())) };
  });

  server.handle(rpc.readAttachment, async (input: RpcInput<typeof rpc.readAttachment>) => {
    const {
      ATTACHMENT_READ_MAX_BYTES, attachmentKind, attachmentMime, resolveTaskAttachment,
    } = await import("./vendor/src/attachments.ts");
    const abs = await resolveTaskAttachment(serviceHome(), input.taskId, input.name);
    if (!abs) throw new Error("附件不存在或越界");
    if (attachmentKind(input.name) !== "image") throw new Error("仅图片附件支持内联读取");
    const buf = await readFile(abs);
    if (buf.byteLength > ATTACHMENT_READ_MAX_BYTES) throw new Error("图片超过 5MB 内联上限，请用打开查看");
    return { dataUri: `data:${attachmentMime(input.name)};base64,${buf.toString("base64")}`, mime: attachmentMime(input.name), sizeBytes: buf.byteLength };
  });

  server.handle(rpc.roster, async (_input: unknown, { paseo }: { paseo: any }) => {
    const { db, workforce, opsRepo } = await company();
    const { staffingPool, quotaBlockedProviders, reviewStaffingPreviews } = await import("./vendor/src/dispatcher/dispatcher.ts");
    const { readProviderQuotas } = await import("./dispatch.ts");
    const cfg = await workforce.config();
    const [health] = await db.db.query<[any[]]>("SELECT provider, state, last_error, until FROM provider_health;");
    const agents = paseo ? await paseo.agents.list() : { entries: [] };
    const statusById = new Map<string, string>(
      (agents.entries ?? []).map((a: any) => [a.id, a.status ?? "unknown"]));
    const usageEntries = paseo ? await refreshQuota(paseo, await company()).catch(() => []) : [];
    const modelSlots = paseo ? await refreshModels(paseo, await company()).catch(() => ({} as Record<string, string>)) : {};
    const resolveDisplay = (d: { provider: string; model?: string }): string | undefined =>
      d.model?.startsWith("auto:")
        ? modelSlots[`${d.provider}:${d.model.slice(5)}`] ?? "未解析"
        : undefined;
    const defs = await workforce.defs();
    const insts = await workforce.insts();
    const healthView = health.map(h => ({ provider: String(h.provider).split("⟨").pop()?.replace("⟩", "") ?? String(h.provider), state: h.state, lastError: h.last_error, until: h.until }));

    // Staffing preview: recompute the exact inputs the tick derives, then call the same
    // staffingPool — the numbers the owner sees are the numbers dispatch picks by.
    type InstState = import("./vendor/src/dispatcher/dispatcher").InstState;
    const healthMap = new Map(healthView.map(h => [h.provider, { provider: h.provider, state: h.state as "healthy" | "exhausted", until: h.until, failures: 0, lastError: h.lastError }]));
    const states = new Map<string, InstState>();
    for (const inst of insts) {
      const st = inst.paseoAgentId ? statusById.get(inst.paseoAgentId) ?? "missing" : "missing";
      states.set(inst.id,
        st === "running" || st === "initializing" ? "busy" :
        st === "idle" ? "idle" :
        st === "error" && healthMap.get(inst.provider ?? "")?.state === "exhausted" ? "exhausted" : "down");
    }
    const tasks = await workforce.tasks();
    const holding = new Set(tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
    const busyBy = new Map<string, number>();
    for (const inst of insts) {
      if (states.get(inst.id) !== "busy") continue;
      busyBy.set(inst.provider ?? "", (busyBy.get(inst.provider ?? "") ?? 0) + 1);
    }
    const quotaBlocked = quotaBlockedProviders(await readProviderQuotas({ db }), cfg, Date.now());
    const slots = new Map(Object.entries(modelSlots));
    const homes = [...new Set([opsRepo, ...insts.map(i => i.cwd ?? opsRepo), ...tasks.map(t => t.repoPath ?? opsRepo)])];
    const roles = [...new Set([...defs.map(d => d.role), ...insts.map(i => i.role)])];
    const now = Math.floor(Date.now() / 1000);
    const poolBase = { defs, insts, states, holding, health: healthMap,
      quotaBlocked, busyBy, providerMax: cfg.providerMax, slots, opsRepo, sidecar: true, now };
    const entriesView = (entries: import("./vendor/src/dispatcher/dispatcher").StaffingEntry[]) =>
      entries.map(e => ({ kind: e.kind, ref: e.ref, weight: e.weight, share: e.share,
        eligible: e.eligible, reason: e.reason, model: e.model }));
    const pools = roles.flatMap(role => homes.map(home => ({
      role, home, entries: entriesView(staffingPool({ ...poolBase, role, home })),
    })).filter(p => p.entries.length));
    const reviewPools = (await reviewStaffingPreviews(tasks, poolBase, workforce))
      .map(p => ({ ...p, entries: entriesView(p.entries) }));

    return {
      paused: cfg.paused,
      opsRepo,
      usage: usageEntries.map((u: any) => ({
        providerId: u.providerId, displayName: u.displayName, planLabel: u.planLabel, status: u.status,
        windows: (u.windows ?? []).map((w: any) => ({ label: w.label, remainingPct: w.remainingPct, resetsAt: w.resetsAt, tone: w.tone })),
        balances: (u.balances ?? []).map((b: any) => ({ label: b.label, remaining: b.remaining, limit: b.limit, unit: b.unit, tone: b.tone })),
      })),
      defs: defs.map(d => ({
        id: d.id, role: d.role, provider: d.provider, model: d.model, resolved: resolveDisplay(d),
        thinking: d.thinking, enabled: d.enabled, maxInstances: d.maxInstances, weight: d.weight, avgScore: d.avgScore,
      })),
      instances: insts.map(i => ({
        id: i.id, def: i.def, role: i.role, provider: i.provider, cwd: i.cwd,
        agentId: i.paseoAgentId, agentStatus: i.paseoAgentId ? statusById.get(i.paseoAgentId) : undefined,
      })),
      health: healthView,
      pools,
      reviewPools,
    };
  });

  server.handle(rpc.pulse, async (_input: unknown, { paseo }: { paseo: any }) => {
    const { db, owner, workforce, opsRepo } = await company();
    const { staffingPool, quotaBlockedProviders, roleCapacity } = await import("./vendor/src/dispatcher/dispatcher.ts");
    const { localDate } = await import("./vendor/src/owner-brief.ts");
    const { readProviderQuotas } = await import("./dispatch.ts");
    const { RecordId } = await import("surrealdb");
    const asId = (x: unknown) => { const s = String(x); return s.includes("⟨") ? s.split("⟨").pop()!.replace("⟩", "") : s; };
    const now = Date.now();
    const nowS = Math.floor(now / 1000);
    const cfg = await workforce.config();

    // Same inputs the dispatcher tick derives: the "why unclaimed" answer below is
    // the identical staffingPool verdict, not a parallel reimplementation.
    const [health] = await db.db.query<[any[]]>("SELECT provider, state, last_error, until FROM provider_health;");
    const agents = paseo ? await paseo.agents.list() : { entries: [] };
    const statusById = new Map<string, string>((agents.entries ?? []).map((a: any) => [a.id, a.status ?? "unknown"]));
    const modelSlots = paseo ? await refreshModels(paseo, await company()).catch(() => ({} as Record<string, string>)) : {};
    const defs = await workforce.defs();
    const insts = await workforce.insts();
    const healthView = health.map(h => ({ provider: String(h.provider).split("⟨").pop()?.replace("⟩", "") ?? String(h.provider), state: h.state, lastError: h.last_error, until: h.until }));
    type InstState = import("./vendor/src/dispatcher/dispatcher").InstState;
    const healthMap = new Map(healthView.map(h => [h.provider, { provider: h.provider, state: h.state as "healthy" | "exhausted", until: h.until, failures: 0, lastError: h.lastError }]));
    const states = new Map<string, InstState>();
    for (const inst of insts) {
      const st = inst.paseoAgentId ? statusById.get(inst.paseoAgentId) ?? "missing" : "missing";
      states.set(inst.id,
        st === "running" || st === "initializing" ? "busy" :
        st === "idle" ? "idle" :
        st === "error" && healthMap.get(inst.provider ?? "")?.state === "exhausted" ? "exhausted" : "down");
    }
    const tasks = await workforce.tasks();
    const holding = new Set(tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
    const busyBy = new Map<string, number>();
    for (const inst of insts) {
      if (states.get(inst.id) !== "busy") continue;
      busyBy.set(inst.provider ?? "", (busyBy.get(inst.provider ?? "") ?? 0) + 1);
    }
    const quotaBlocked = quotaBlockedProviders(await readProviderQuotas({ db }), cfg, now);
    const poolBase = { defs, insts, states, holding, health: healthMap, quotaBlocked, busyBy,
      providerMax: cfg.providerMax, slots: new Map(Object.entries(modelSlots)), opsRepo, sidecar: true, now: nowS };

    const brief = await owner.briefData(now, localDate(new Date(now)),
      roleCapacity(defs, quotaBlocked, healthMap, nowS));

    const [doingRows] = await db.db.query<[any[]]>(
      `SELECT id, title, executor_role, discipline, current_employee, goal.title AS goal_title FROM task WHERE state = 'doing';`);
    const doingIds = (doingRows ?? []).map(r => r.id);
    const [claims] = await db.db.query<[any[]]>(
      `SELECT task, at, actor FROM audit WHERE action = 'claim' AND task INSIDE $ids ORDER BY at DESC;`,
      { ids: doingIds.length ? doingIds : [new RecordId("task", "none")] });
    const claimBy = new Map<string, any>();
    for (const c of claims ?? []) { const k = String(c.task); if (!claimBy.has(k)) claimBy.set(k, c); }
    const doing = (doingRows ?? []).map((r: any) => {
      const claim = claimBy.get(String(r.id));
      return {
        taskId: asId(r.id), title: String(r.title ?? ""), employee: r.current_employee ? asId(r.current_employee) : undefined,
        role: String(r.executor_role ?? ""), discipline: r.discipline ?? undefined, goal: r.goal_title ?? undefined,
        sinceMin: claim ? Math.max(0, Math.round((now - Date.parse(String(claim.at))) / 60_000)) : undefined,
      };
    });

    // Ready queue with the dominant "nobody can take this" reason when the whole
    // pool is ineligible: this is what silent starvation looks like to the owner.
    // Batch the per-task audit lookups: a ready queue of N tasks used to cost N
    // sequential round trips, stalling the single ~50KB/s WSS channel for minutes.
    const readyTasks = tasks.filter(t => t.state === "ready");
    const [readyAudits] = readyTasks.length ? await db.db.query<[any[]]>(
      `SELECT task, at FROM audit WHERE task IN $ids
       AND action IN ['create','dependency_unlocked','return','release','revoke','resume'] ORDER BY at DESC;`,
      { ids: readyTasks.map(t => new RecordId("task", t.id)) }) : [[]];
    const readyAt = new Map<string, unknown>();
    for (const a of readyAudits ?? []) { const k = asId(a.task); if (!readyAt.has(k)) readyAt.set(k, a.at); }
    const ready = [] as Array<{ taskId: string; title: string; role: string; discipline?: string; waitingMin: number; unclaimableReason?: string }>;
    for (const t of readyTasks) {
      const at = readyAt.get(t.id);
      const waitingMin = at ? Math.max(0, Math.round((now - Date.parse(String(at))) / 60_000)) : 0;
      const pool = staffingPool({ ...poolBase, role: t.executorRole, home: t.repoPath ?? opsRepo, task: t });
      let unclaimableReason: string | undefined;
      if (pool.length && !pool.some(e => e.eligible)) {
        const counts = new Map<string, number>();
        for (const e of pool) counts.set(e.reason ?? "未知", (counts.get(e.reason ?? "未知") ?? 0) + 1);
        unclaimableReason = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      } else if (!pool.length) {
        unclaimableReason = "该岗位没有任何编制";
      }
      ready.push({ taskId: t.id, title: t.title, role: t.executorRole, discipline: t.discipline, waitingMin, unclaimableReason });
    }

    const [recentDone] = await db.db.query<[any[]]>(
      `SELECT task, task.title AS title, at, actor FROM audit WHERE action IN ['accept','owner_approve'] ORDER BY at DESC LIMIT 8;`);

    const readyIds = new Set(ready.map(r => r.taskId));
    return {
      at: new Date(now).toISOString(),
      paused: !!cfg.paused,
      doing, ready,
      stuck: (brief.stuck ?? []).filter(s => !readyIds.has(s.taskId)),
      waiting: brief.waiting ?? [],
      recentDone: (recentDone ?? []).map((r: any) => ({ taskId: asId(r.task), title: String(r.title ?? ""), at: String(r.at), actor: r.actor ? asId(r.actor) : undefined })),
      last24h: brief.last24h,
      resources: brief.resources ?? [],
      staffingAlerts: brief.staffingAlerts ?? 0,
      churn: brief.churn,
      goals: brief.goals ?? [],
    };
  });

  server.handle(rpc.providerOptions, async (_input: unknown, { paseo }: { paseo: any }) => {
    const { ROLES } = await import("./vendor/src/core.ts");
    const { MODEL_FAMILY } = await import("./dispatch.ts");
    if (paseo) await refreshQuota(paseo, await company()).catch(() => []);
    const snapshot = paseo
      ? await paseo.providers.waitForReady({ timeoutMs: 15_000 }).catch(() => paseo.providers.snapshot()).catch(() => ({ entries: [] }))
      : { entries: [] };
    if (paseo) {
      await Promise.allSettled((snapshot.entries ?? [])
        .filter((e: any) => e.enabled !== false && !(e.models ?? []).length)
        .map(async (e: any) => {
          const listed = await paseo.providers.listModels(e.provider).catch(() => undefined);
          if (listed?.models?.length) e.models = listed.models;
        }));
    }
    const providers = (snapshot.entries ?? [])
      .filter((e: any) => e.enabled !== false)
      .map((e: any) => {
        const models = (e.models ?? [])
          .filter((m: any) => m.isSelectable !== false)
          .map((m: any) => ({
            id: m.id, label: m.label, isDefault: m.isDefault ?? false,
            thinkingOptions: (m.thinkingOptions ?? []).map((t: any) => ({ id: t.id, label: t.label, isDefault: t.isDefault ?? false })),
          }));
        const match = MODEL_FAMILY[e.provider];
        const newest = new Map<string, { version: string; id: string }>();
        if (match) {
          for (const m of models) {
            const hit = match(m.id);
            if (hit && (!newest.has(hit.family) || compareVersion(hit.version, newest.get(hit.family)!.version) > 0)) {
              newest.set(hit.family, { version: hit.version, id: m.id });
            }
          }
        }
        return {
          id: e.provider, label: e.label ?? e.provider, status: e.status ?? "unknown",
          families: [...newest.entries()].map(([family, v]) => ({ slot: `auto:${family}`, resolvesTo: v.id })),
          models,
        };
      });
    return { roles: [...ROLES], providers };
  });

  server.handle(rpc.registerDef, async (input: RpcInput<typeof rpc.registerDef>, { paseo }: { paseo: any }) => {
    const { workforce } = await company();
    if (paseo) await refreshQuota(paseo, await company()).catch(() => []);
    const snapshot = paseo ? await paseo.providers.snapshot().catch(() => ({ entries: [] })) : { entries: [] };
    const entry = (snapshot.entries ?? []).find((e: any) => e.provider === input.provider && e.enabled !== false);
    if (!entry) throw new Error(`provider ${input.provider} 未在 Paseo 中启用`);
    if (!(entry.models ?? []).length && paseo) {
      const listed = await paseo.providers.listModels(input.provider).catch(() => undefined);
      if (listed?.models?.length) entry.models = listed.models;
    }
    const modelIds = new Set((entry.models ?? []).map((m: any) => m.id));
    const { MODEL_FAMILY } = await import("./dispatch.ts");
    const match = MODEL_FAMILY[input.provider];
    const isAuto = input.model.startsWith("auto:");
    if (isAuto) {
      const family = input.model.slice(5);
      const ok = match && (entry.models ?? []).some((m: any) => match(m.id)?.family === family);
      if (!ok) throw new Error(`provider ${input.provider} 没有 ${input.model} 可解析的模型族`);
    } else if (!modelIds.has(input.model)) {
      throw new Error(`provider ${input.provider} 没有模型 ${input.model}`);
    }
    if (input.thinking) {
      const resolved = isAuto
        ? (entry.models ?? []).find((m: any) => m.id === resolveSlot(entry, match!, input.model.slice(5)))
        : (entry.models ?? []).find((m: any) => m.id === input.model);
      const options = (resolved?.thinkingOptions ?? []).map((t: any) => t.id);
      if (options.length > 0 && !options.includes(input.thinking)) {
        throw new Error(`模型 ${resolved?.id ?? input.model} 不支持 thinking=${input.thinking}`);
      }
    }
    const defId = `${input.role}-${input.provider}`;
    await workforce.upsertDef(defId, {
      role: input.role as any, provider: input.provider, model: input.model,
      thinking: input.thinking, maxInstances: input.maxInstances, weight: input.weight,
      enabled: input.enabled,
    });
    return { id: defId };
  });

  server.handle(rpc.setDefEnabled, async (input: RpcInput<typeof rpc.setDefEnabled>) => {
    const { db } = await company();
    const { id } = await import("./vendor/src/core.ts");
    await db.db.query(
      "UPDATE $def SET enabled = $enabled, error_streak = 0, disabled_reason = NONE, disabled_at = NONE;",
      { def: id("employee_def", input.defId), enabled: input.enabled });
    return { ok: true };
  });

  server.handle(rpc.pendingPermissions, async (_input: unknown, { paseo }: { paseo: any }) => {
    const { entries } = await paseo.agents.list();
    const items = [];
    for (const agent of entries ?? []) {
      if (agent.labels?.company !== "surreal-ck") continue;
      const detail = await paseo.agents.ref(agent.id).refresh();
      const pending = detail?.pendingPermissions ?? agent.pendingPermissions ?? [];
      for (const request of pending) {
        items.push({
          agentId: agent.id,
          title: agent.title ?? agent.name,
          employeeId: agent.labels?.employee_id,
          role: agent.labels?.role,
          request: {
            id: request.id,
            kind: request.kind ?? request.type,
            summary: request.summary ?? request.title ?? request.description,
            detail: typeof request.detail === "string" ? request.detail.slice(0, 2000) : undefined,
          },
        });
      }
    }
    return { items };
  });

  server.handle(rpc.answerPermission, async (input: RpcInput<typeof rpc.answerPermission>, { paseo }: { paseo: any }) => {
    await paseo.agents.ref(input.agentId).respondToPermission({
      requestId: input.requestId,
      response: { behavior: input.behavior, message: input.message },
    });
    return { ok: true };
  });
}
