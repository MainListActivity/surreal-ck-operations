import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View, type StyleProp, type TextStyle } from "react-native";
import * as RN from "react-native";
import * as rpc from "../shared/rpc";
import { waitingLabel } from "../shared/waiting-label";
import type { Brief, DispatchBlockedView, DispatchReasonView, GoalTier, GoalView, Inbox, PermissionRequest, Pulse, Roster, TaskAttachment, TaskView } from "../shared/types";

const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const STATE_LABEL: Record<string, string> = {
  blocked: "阻塞", ready: "就绪", doing: "进行中", review: "待验收", done: "完成",
};
const STATE_COLOR: Record<string, string> = {
  blocked: "#d97706", ready: "#2563eb", doing: "#7c3aed", review: "#0891b2", done: "#16a34a",
};
const TIER_LABEL: Record<string, string> = { quick: "quick 小需求", standard: "standard 常规", program: "program 大项目" };
const PIPELINE_LABEL: Record<string, string> = { software: "软件产线", video: "视频产线", story: "故事产线" };
const KIND_LABEL: Record<string, string> = { goal: "范围", task: "任务", gate: "关口", release: "上线申请", deploy: "部署实测" };

type Ctx = { theme: PluginSurfaceProps["theme"]; compact: boolean; navigation?: NavApi };

function makeStyles({ theme, compact }: Ctx) {
  const c = theme.colors;
  return {
    screen: { flex: 1, backgroundColor: c.surface0 },
    scroll: { padding: compact ? 16 : 24, gap: 16 },
    h1: { color: c.foreground, fontSize: compact ? 18 : 22, fontWeight: "600" as const },
    h2: { color: c.foreground, fontSize: compact ? 15 : 17, fontWeight: "600" as const, marginTop: 8 },
    card: { backgroundColor: c.surface1, borderRadius: 10, padding: compact ? 12 : 16, gap: 8, borderWidth: 1, borderColor: c.border },
    text: { color: c.foreground, fontSize: 13, lineHeight: 19 },
    muted: { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 },
    mono: { color: c.foregroundMuted, fontSize: 11, fontFamily: "Menlo" as const },
    row: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const, flexWrap: "wrap" as const },
    button: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: c.accent },
    buttonText: { color: c.accentForeground, fontSize: 13, fontWeight: "600" as const },
    buttonSecondary: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 },
    buttonSecondaryText: { color: c.foreground, fontSize: 13 },
    buttonDanger: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: "#dc2626" },
    buttonDangerText: { color: "#dc2626", fontSize: 13 },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, color: c.foreground, fontSize: 13, backgroundColor: c.surface0 },
    chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: c.border },
    chipActive: { backgroundColor: c.accent, borderColor: c.accent },
    chipText: { color: c.foreground, fontSize: 12 },
    chipTextActive: { color: c.accentForeground },
    tab: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: "transparent" },
    tabActive: { borderBottomColor: c.accent },
    tabText: { color: c.foregroundMuted, fontSize: 13 },
    tabTextActive: { color: c.accent },
    badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: c.surface2 },
    badgeText: { color: c.foregroundMuted, fontSize: 11 },
  };
}

function Section({ title, count, ctx, children }: { title: string; count?: number; ctx: Ctx; children: React.ReactNode }) {
  const s = makeStyles(ctx);
  return (
    <View style={{ gap: 8 }}>
      <View style={s.row}>
        <Text style={s.h2}>{title}</Text>
        {count !== undefined && count > 0 && (
          <View style={s.badge}><Text style={s.badgeText}>{count}</Text></View>
        )}
      </View>
      {children}
    </View>
  );
}

/** Clamped text with an inline expand toggle; long bodies no longer hide behind "…". */
function ExpandableText({ text, lines, style, ctx }: { text: string; lines: number; style?: StyleProp<TextStyle>; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 45;
  return (
    <View>
      <Text style={style} numberOfLines={open ? undefined : lines}>{text}</Text>
      {long && (
        <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} style={{ alignSelf: "flex-start" }}>
          <Text style={{ color: ctx.theme.colors.accent, fontSize: 12 }}>{open ? "收起" : "展开全部"}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Hosts may ship a narrow react-native subset; probe Image instead of assuming it.
 *  A real component is a function/class or a React object (forwardRef/memo/lazy) that
 *  carries $$typeof; native-module stubs are plain objects and must not reach JSX. */
const RNImage = (() => {
  const candidate = (RN as Record<string, unknown>).Image as unknown;
  return (typeof candidate === "function" ||
    (typeof candidate === "object" && candidate !== null && "$$typeof" in candidate))
    ? candidate as React.ComponentType<{
        source: { uri: string }; style?: unknown; resizeMode?: string; accessibilityLabel?: string;
        onError?: () => void;
      }>
    : undefined;
})();

type NavApi = NonNullable<PluginSurfaceProps["navigation"]>;

/** 在当前设备上打开链接：宿主内嵌浏览器 → Linking → window.open；都不行则由 remote(daemon 机器)兜底，返回落点。 */
async function openExternalAnywhere(
  url: string,
  nav: NavApi | undefined,
  remote: (input: { url: string }) => Promise<unknown>,
): Promise<"local" | "remote"> {
  try {
    if (typeof nav?.openBrowser === "function") {
      nav.openBrowser({ url, workspaceId: "" });
      return "local";
    }
  } catch { /* 宿主拒绝内嵌浏览器时继续降级 */ }
  const linking = (RN as { Linking?: { openURL?: (u: string) => Promise<unknown> } }).Linking;
  if (linking && typeof linking.openURL === "function") {
    await linking.openURL(url);
    return "local";
  }
  const win = (globalThis as { window?: { open?: (u: string, t?: string, f?: string) => unknown } }).window;
  if (typeof win?.open === "function") {
    win.open(url, "_blank", "noopener");
    return "local";
  }
  await remote({ url });
  return "remote";
}

const formatSize = (bytes: number): string =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;

/** 附件行：按下时向插件取预览 URL（LAN 免鉴权 http://<lanIP>:<port>/e/…）并交给宿主浏览器/播放器打开。 */
function AttachmentRow({ taskId, a, label, ctx }: { taskId: string; a: TaskAttachment; label: string; ctx: Ctx }) {
  const s = makeStyles(ctx);
  const getUrl = useRpc(rpc.attachmentUrl);
  const openRpc = useRpc(rpc.openExternal);
  const m = useMutation({
    mutationFn: async () => {
      const { url } = await getUrl({ taskId, name: a.relPath });
      await openExternalAnywhere(url, ctx.navigation, openRpc);
    },
  });
  return (
    <Pressable accessibilityRole="button" style={s.row} disabled={m.isPending} onPress={() => m.mutate()}>
      <Text style={{ color: ctx.theme.colors.accent, fontSize: 13 }}>{label}</Text>
      <Text style={[s.text, { flexShrink: 1 }]} numberOfLines={1}>{a.name}</Text>
      <Text style={s.muted}>{formatSize(a.sizeBytes)}</Text>
      {m.isError && <Text style={s.muted}>{String((m.error as Error).message).slice(0, 80)}</Text>}
    </Pressable>
  );
}

/**
 * 图片附件行：默认只列「预览 + 打开」。点预览才挂载 Image，且走 LAN 预览服务的
 * http URL 流式加载——图片字节不过 RPC 桥。旧实现把每张图整文件 base64 进
 * data URI 自动渲染，多图任务（evidence 里有上千张/数 GB）一展开就把插件进程
 * 内存撑爆重启；改为按需单张出图后，打开任务本身不再触发任何图片字节传输。
 */
function InlineImage({ taskId, a, ctx }: { taskId: string; a: TaskAttachment; ctx: Ctx }) {
  const s = makeStyles(ctx);
  const getUrl = useRpc(rpc.attachmentUrl);
  const [show, setShow] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const q = useQuery({
    queryKey: ["attachmentUrl", taskId, a.relPath],
    queryFn: () => getUrl({ taskId, name: a.relPath }),
    enabled: show && !!RNImage,
    staleTime: 300_000,
    retry: false,
  });
  const uri = q.data?.url;
  return (
    <View style={{ gap: 4 }}>
      <View style={s.row}>
        {!!RNImage && (
          <Pressable accessibilityRole="button" onPress={() => setShow(v => !v)}>
            <Text style={{ color: ctx.theme.colors.accent, fontSize: 13 }}>{show ? "收起" : "预览"}</Text>
          </Pressable>
        )}
        <AttachmentRow taskId={taskId} a={a} label="打开" ctx={ctx} />
      </View>
      {show && !!RNImage && (
        uri && !loadFailed ? (
          <RNImage source={{ uri }} accessibilityLabel={a.name} resizeMode="contain"
            onError={() => setLoadFailed(true)}
            style={{ width: "100%", height: 200, borderRadius: 8, backgroundColor: ctx.theme.colors.surface2 }} />
        ) : (
          <Text style={s.muted}>{q.isLoading ? "加载预览…" : "预览不可用，可点打开查看。"}</Text>
        )
      )}
    </View>
  );
}

const ATTACH_ACTION: Record<TaskAttachment["kind"], string> = {
  image: "打开", video: "播放", html: "在浏览器打开", audio: "播放", other: "下载",
};

/** Evidence-attachment section for an owner-facing card; renders nothing when empty. */
function Attachments({ taskId, ctx }: { taskId: string; ctx: Ctx }) {
  const s = makeStyles(ctx);
  const list = useRpc(rpc.taskAttachments);
  const q = useQuery({
    queryKey: ["taskAttachments", taskId],
    queryFn: () => list({ taskId }),
    staleTime: 30_000,
  });
  const items = q.data?.attachments ?? [];
  if (!q.data || items.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.muted}>附件 {items.length}</Text>
      {items.map(a => a.kind === "image"
        ? <InlineImage key={a.relPath} taskId={taskId} a={a} ctx={ctx} />
        : <AttachmentRow key={a.relPath} taskId={taskId} a={a} label={ATTACH_ACTION[a.kind]} ctx={ctx} />)}
    </View>
  );
}

const LINK_RE = /https?:\/\/[^\s"'<>）)】\]，。；、]+/g;

/** One-click external links harvested from a submission/question body. */
function LinkRows({ text, ctx }: { text: string; ctx: Ctx }) {
  const s = makeStyles(ctx);
  const openRpc = useRpc(rpc.openExternal);
  const links = useMemo(() => [...new Set(text.match(LINK_RE) ?? [])].slice(0, 5), [text]);
  if (links.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      {links.map(u => (
        <Pressable key={u} accessibilityRole="button" onPress={() => void openExternalAnywhere(u, ctx.navigation, openRpc)}>
          <Text style={{ color: ctx.theme.colors.accent, fontSize: 12 }} numberOfLines={1}>打开链接 {u}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function DecideCard({ taskId, kind, body, ctx, onDone }: {
  taskId: string; kind: "approve" | "reply"; body: string; ctx: Ctx; onDone: () => void;
}) {
  const s = makeStyles(ctx);
  const decide = useRpc(rpc.decide);
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: (decision: "approve" | "reject" | "reply") =>
      decide({ taskId, decision, note, key: newKey() }),
    onSuccess: () => { setNote(""); onDone(); },
  });
  return (
    <View style={s.card}>
      <Text style={s.text}>{taskId.slice(0, 8)}</Text>
      <ExpandableText text={body} lines={12} style={s.muted} ctx={ctx} />
      <LinkRows text={body} ctx={ctx} />
      <Attachments taskId={taskId} ctx={ctx} />
      <TextInput
        style={[s.input, { minHeight: 36 }]}
        placeholder={kind === "approve" ? "意见（驳回时必填）" : "回答内容"}
        placeholderTextColor={ctx.theme.colors.foregroundMuted}
        value={note}
        onChangeText={setNote}
        multiline
      />
      <View style={s.row}>
        {kind === "approve" ? (
          <>
            <Pressable accessibilityRole="button" style={s.button} disabled={mutation.isPending}
              onPress={() => mutation.mutate("approve")}>
              <Text style={s.buttonText}>批准</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={s.buttonDanger} disabled={mutation.isPending || !note.trim()}
              onPress={() => mutation.mutate("reject")}>
              <Text style={s.buttonDangerText}>驳回</Text>
            </Pressable>
          </>
        ) : (
          <Pressable accessibilityRole="button" style={s.button} disabled={mutation.isPending || note.trim().length < 2}
            onPress={() => mutation.mutate("reply")}>
            <Text style={s.buttonText}>回复</Text>
          </Pressable>
        )}
        {mutation.isError && <Text style={s.muted}>{String((mutation.error as Error).message).slice(0, 120)}</Text>}
      </View>
    </View>
  );
}

/** 时间间隔的人话格式：分钟→小时→天 */
const fmtAge = (min?: number): string => {
  if (min === undefined) return "";
  if (min < 60) return `${min} 分钟`;
  const h = min / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} 小时`;
  return `${Math.floor(h / 24)} 天`;
};

/** 可折叠分区：默认收起，点标题展开 */
function Collapsible({ title, count, ctx, children, defaultOpen }: {
  title: string; count?: number; ctx: Ctx; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const s = makeStyles(ctx);
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" style={s.row} onPress={() => setOpen(!open)}>
        <Text style={s.h2}>{open ? "▾ " : "▸ "}{title}</Text>
        {count !== undefined && count > 0 && (
          <View style={s.badge}><Text style={s.badgeText}>{count}</Text></View>
        )}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? v : []) as T[];
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** A goal root's people; an absent or malformed block reads as nobody bound, never as an invented name. */
const goalPeople = (v: unknown): { implementer?: string; authors: string[]; reviewers: string[]; submitter?: string; submitCommit?: string; peopleOmitted?: number } => {
  const p = (v ?? {}) as Record<string, unknown>;
  return { implementer: str(p.implementer) || undefined, authors: arr<unknown>(p.authors).map(str), reviewers: arr<unknown>(p.reviewers).map(str),
    submitter: str(p.submitter) || undefined, submitCommit: str(p.submitCommit) || undefined, peopleOmitted: num(p.peopleOmitted) || undefined };
};
/** A bounded list's truncation marker; a missing marker reads as complete, with nothing left out. */
const bound = (v: unknown): { total: number; shown: number; truncated: boolean } => {
  const b = (v ?? {}) as Record<string, unknown>;
  return { total: num(b.total), shown: num(b.shown), truncated: b.truncated === true };
};
/** A workflow state from the wire; anything but doing or review reads as ready, the state every execute item starts in. */
const workflowOf = (v: unknown): "ready" | "doing" | "review" => (v === "doing" ? "doing" : v === "review" ? "review" : "ready");
/** Reason rows as the owner reads them; a malformed row keeps safe defaults, and the page reads only typed fields. */
const reasonRows = (v: unknown): DispatchReasonView[] => arr<Record<string, unknown>>(v).map(r => ({
  code: str(r.code), text: str(r.text), candidates: arr<unknown>(r.candidates).map(str),
  candidatesOmitted: num(r.candidatesOmitted) || undefined,
  owner: r.owner === "owner" ? "owner" : r.owner === "system" ? "system" : "gm", basis: str(r.basis), recovery: str(r.recovery), nextTrigger: str(r.nextTrigger),
  actions: arr<Record<string, unknown>>(r.actions).map(a => ({
    authority: a.authority === "owner" ? "owner" : a.authority === "system" ? "system" : "gm", label: str(a.label), tool: str(a.tool) || undefined, executable: a.executable === true,
  })),
}));

const workflowWaitStateOf = (v: unknown): "ready" | "doing" | "review" | "blocked" | "done" | "void" | "unknown" =>
  v === "ready" || v === "doing" || v === "review" || v === "blocked" || v === "done" || v === "void" ? v : "unknown";
const workflowWaitKindOf = (v: unknown): "dependency" | "manager" | "owner" | "active_lease" | "unknown" =>
  v === "dependency" || v === "manager" || v === "owner" || v === "active_lease" ? v : "unknown";

/** 把 wire 上的 pulse 响应收敛成完整视图模型：缺字段/条目畸形时给安全默认，渲染路径不再裸读。 */
export function normalizePulse(raw: unknown): Pulse {
  const o = (raw ?? {}) as Record<string, unknown>;
  const l24 = (o.last24h ?? {}) as Record<string, unknown>;
  const ch = (o.churn ?? {}) as Record<string, unknown>;
  const marks = (o.bounds ?? {}) as Record<string, unknown>;
  return {
    at: str(o.at),
    dispatchAt: str(o.dispatchAt) || undefined,
    paused: o.paused === true,
    doing: arr<Record<string, unknown>>(o.doing).map(d => ({
      taskId: str(d.taskId), title: str(d.title), employee: str(d.employee) || undefined,
      role: str(d.role), discipline: str(d.discipline) || undefined, goal: str(d.goal) || undefined,
      sinceMin: typeof d.sinceMin === "number" ? d.sinceMin : undefined,
    })),
    ready: arr<Record<string, unknown>>(o.ready).map(r => ({
      taskId: str(r.taskId), title: str(r.title), role: str(r.role), discipline: str(r.discipline) || undefined,
      waitingMin: num(r.waitingMin), unclaimableReason: str(r.unclaimableReason) || undefined,
    })),
    stuck: arr<Record<string, unknown>>(o.stuck).map(t => ({ taskId: str(t.taskId), title: str(t.title), reason: str(t.reason) })),
    waiting: arr<Record<string, unknown>>(o.waiting).map(w => ({
      taskId: str(w.taskId), kind: w.kind === "gate" ? "gate" : "question", title: str(w.title),
      goal: str(w.goal) || undefined, hours: num(w.hours), downstream: num(w.downstream),
    })),
    recentDone: arr<Record<string, unknown>>(o.recentDone).map(d => ({
      taskId: str(d.taskId), title: str(d.title), at: str(d.at), actor: str(d.actor) || undefined,
    })),
    last24h: { done: num(l24.done), returned: num(l24.returned), rolledBack: num(l24.rolledBack), rejected: num(l24.rejected), retired: num(l24.retired) },
    resources: arr<unknown>(o.resources).map(str),
    churn: { created: num(ch.created), retired: num(ch.retired), claimLost: num(ch.claimLost) },
    goals: arr<Record<string, unknown>>(o.goals).map(g => ({ title: str(g.title), days: num(g.days) })),
    goalBlockers: arr<Record<string, unknown>>(o.goalBlockers).map(b => ({
      goalId: str(b.goalId), taskId: str(b.taskId), title: str(b.title), phase: b.phase === "review" ? "review" : "execute",
      summary: str(b.summary), feasible: b.feasible === true, since: str(b.since) || undefined, waitingMinutes: num(b.waitingMinutes),
      others: num(b.others), impact: num(b.impact), undispatchable: num(b.undispatchable),
      workflowState: workflowOf(b.workflowState), eligibleCount: num(b.eligibleCount), checkedAt: str(b.checkedAt),
      dependencyPath: arr<Record<string, unknown>>(b.dependencyPath).map(p => ({ taskId: str(p.taskId), title: str(p.title) })),
      people: goalPeople(b.people),
      reasons: reasonRows(b.reasons),
    })),
    workflowWaits: arr<Record<string, unknown>>(o.workflowWaits).map(w => {
      const people = w.people && typeof w.people === "object" ? w.people as Record<string, unknown> : undefined;
      return {
        goalId: str(w.goalId) || undefined, taskId: str(w.taskId), title: str(w.title),
        workflowState: workflowWaitStateOf(w.workflowState), kind: workflowWaitKindOf(w.kind),
        basis: str(w.basis), waitingForRole: str(w.waitingForRole), nextTrigger: str(w.nextTrigger), goalRootCount: num(w.goalRootCount),
        impact: typeof w.impact === "number" && Number.isFinite(w.impact) ? w.impact : undefined,
        dependencyPath: arr<Record<string, unknown>>(w.dependencyPath).map(p => ({ taskId: str(p.taskId), title: str(p.title) })),
        unknownReason: str(w.unknownReason) || undefined, dependencyPathTruncated: w.dependencyPathTruncated === true,
        people: people ? { implementer: str(people.implementer) || undefined, authors: arr<unknown>(people.authors).map(str),
          reviewers: arr<unknown>(people.reviewers).map(str), submitter: str(people.submitter) || undefined,
          submitCommit: str(people.submitCommit) || undefined, peopleOmitted: num(people.peopleOmitted) || undefined } : undefined,
        peopleSource: str(w.peopleSource) || undefined, submitterSource: str(w.submitterSource) || undefined,
        submitCommitSource: str(w.submitCommitSource) || undefined, peopleCheckedAt: str(w.peopleCheckedAt) || undefined,
        submitCheckedAt: str(w.submitCheckedAt) || undefined,
      };
    }),
    workflowWaitSummary: (() => {
      const summary = (o.workflowWaitSummary ?? {}) as Record<string, unknown>;
      return { source: "workflow-graph" as const, available: summary.available === true,
        checkedAt: str(summary.checkedAt) || undefined, totalRoots: num(summary.totalRoots), truncated: summary.truncated === true,
        reason: str(summary.reason) || undefined };
    })(),
    dispatchBlocked: arr<Record<string, unknown>>(o.dispatchBlocked).map(v => ({
      taskId: str(v.taskId), goalId: str(v.goalId) || undefined, title: str(v.title),
      phase: v.phase === "review" ? "review" : "execute", workflowState: workflowOf(v.workflowState), summary: str(v.summary),
      checkedAt: str(v.checkedAt), eligibleCount: num(v.eligibleCount),
      feasible: v.feasible === true, since: str(v.since) || undefined, waitingMinutes: num(v.waitingMinutes),
      reasons: reasonRows(v.reasons),
    })),
    bounds: {
      dispatchBlocked: bound(marks.dispatchBlocked), goalBlockers: bound(marks.goalBlockers), workflowWaits: bound(marks.workflowWaits), ready: bound(marks.ready),
      doing: bound(marks.doing), stuck: bound(marks.stuck), waiting: bound(marks.waiting), recentDone: bound(marks.recentDone),
      goals: bound(marks.goals), resources: bound(marks.resources),
    },
  };
}

/** The workflow state of a blocked item, in the owner's words. */
const WORKFLOW_LABEL: Record<"ready" | "doing" | "review", string> = { ready: "就绪", doing: "在办无人持有", review: "待复核" };
const WAIT_KIND_LABEL = { dependency: "正常依赖等待", manager: "经理关口", owner: "老板关口", active_lease: "活租约等待", unknown: "等待未知" } as const;
const WAIT_STATE_LABEL = { ready: "就绪", doing: "执行中", review: "待复核", blocked: "依赖阻塞", done: "完成", void: "作废", unknown: "未知" } as const;
/** A time of day from an ISO instant, in UTC as the server states it; an absent instant reads as unknown. */
const clockOf = (iso: string): string => (iso ? `${iso.slice(5, 16).replace("T", " ")}（UTC）` : "未知");

/** 动态页：一页回答「公司现在在干什么、什么卡住了、为什么」。 */
function PulseTab({ ctx }: { ctx: Ctx }) {
  const s = makeStyles(ctx);
  const pulseRpc = useRpc(rpc.pulse);
  const data = useQuery({ queryKey: ["pulse"], queryFn: () => pulseRpc({}), refetchInterval: 10_000 });
  const loaded = data.data != null;
  const p = useMemo(() => normalizePulse(data.data), [data.data]);
  // Each blocked item is counted once: the dispatch list holds both phases, and the ready queue is not added on top.
  const attention = p.waiting.length + p.stuck.length + p.resources.length + p.bounds.dispatchBlocked.total;
  return (
    <View style={{ gap: 12 }}>
      <View style={s.card}>
        <Text style={s.text}>
          {p.paused ? "派工已暂停" : "派工运行中"}
          {loaded ? ` · 在办 ${p.doing.length} · 就绪 ${p.ready.length} · 无法派工 ${p.bounds.dispatchBlocked.total} · 卡住 ${p.stuck.length} · 待你处理 ${p.waiting.length}` : ""}
        </Text>
        {attention > 0 && <Text style={s.muted}>需要关注 {attention} 项（往下翻）</Text>}
        {loaded && <Text style={s.muted}>派工结论检查于 {clockOf(p.dispatchAt ?? "")}；页面刷新于 {clockOf(p.at)}</Text>}
      </View>
      <Section title="正在办" count={p.doing.length} ctx={ctx}>
        {p.doing.length === 0 && <Text style={s.muted}>现在没有人在干活。</Text>}
        {p.doing.map(d => (
          <View key={d.taskId} style={s.card}>
            <Text style={s.text}>{d.title}</Text>
            <Text style={s.muted}>
              {d.employee ?? d.role}{d.discipline ? ` · ${d.discipline}` : ""}{d.goal ? ` · ${d.goal.slice(0, 40)}` : ""}
              {d.sinceMin !== undefined ? ` · 已进行 ${fmtAge(d.sinceMin)}` : ""}
            </Text>
          </View>
        ))}
      </Section>
      <Section title="待你处理" count={p.waiting.length} ctx={ctx}>
        {p.waiting.map(w => (
          <View key={w.taskId} style={s.card}>
            <Text style={s.text}>{w.kind === "gate" ? "批准" : "回答"} · {w.title}</Text>
            <Text style={s.muted}>已等 {w.hours < 1 ? `${Math.round(w.hours * 60)} 分钟` : `${w.hours.toFixed(1)} 小时`}{w.downstream ? ` · 卡住下游 ${w.downstream} 个任务` : ""}{w.goal ? ` · ${w.goal.slice(0, 40)}` : ""} · 到「收件箱」处理</Text>
          </View>
        ))}
      </Section>
      <Section title="卡住" count={p.stuck.length} ctx={ctx}>
        {p.stuck.map(t => (
          <View key={t.taskId} style={s.card}>
            <Text style={s.text}>{t.title}</Text>
            <Text style={s.muted}>{t.reason} · {t.taskId.slice(0, 8)}</Text>
          </View>
        ))}
      </Section>
      <Section title="目标工作流等待" count={p.workflowWaitSummary.totalRoots} ctx={ctx}>
        {!p.workflowWaitSummary.available ? (
          <Text style={s.muted}>等待图不可读：{p.workflowWaitSummary.reason ?? "未知"}</Text>
        ) : p.workflowWaits.length === 0 ? (
          <Text style={s.muted}>当前没有已识别的目标等待根。</Text>
        ) : p.workflowWaits.map(root => (
          <View key={`${root.goalId ?? ""}:${root.taskId}`} style={s.card}>
            <Text style={s.text}>{WAIT_KIND_LABEL[root.kind]} · {root.title}</Text>
            <Text style={s.muted}>工作流 {WAIT_STATE_LABEL[root.workflowState]} · 处理岗位 {root.waitingForRole || "未知"} · 根数 {root.goalRootCount}{root.impact !== undefined ? ` · 影响 ${root.impact} 项` : " · 影响未知"}</Text>
            <Text style={s.muted}>依据 {root.basis || "未知"} · 下一触发 {root.nextTrigger || "未知"}{root.unknownReason ? ` · ${root.unknownReason}` : ""}</Text>
            {root.dependencyPath && root.dependencyPath.length > 0 && <Text style={s.muted}>依赖路径（根在前）：{root.dependencyPath.map(item => item.title).join(" → ")}{root.dependencyPathTruncated ? " · 路径已截断" : ""}</Text>}
            {root.people && <Text style={s.muted}>人物来源 {root.peopleSource ?? "未知"} · 实现者 {root.people.implementer ?? "未绑定"} · 作者 {root.people.authors.join("、") || "未记录"} · 复核者 {root.people.reviewers.join("、") || "未记录"}{root.people.peopleOmitted ? ` · 另有 ${root.people.peopleOmitted} 人未列出` : ""}</Text>}
            {(root.people?.submitter || root.people?.submitCommit) && <Text style={s.muted}>提交人 {root.people.submitter ?? "未记录"}（{root.submitterSource ?? "来源未知"}） · 提交 SHA {root.people.submitCommit ?? "未记录"}（{root.submitCommitSource ?? "来源未知"}）</Text>}
            {root.peopleCheckedAt && <Text style={s.muted}>人物来源采集于 {clockOf(root.peopleCheckedAt)}</Text>}
            {root.submitCheckedAt && <Text style={s.muted}>提交审计采集于 {clockOf(root.submitCheckedAt)}</Text>}
          </View>
        ))}
        {p.workflowWaitSummary.available && <Text style={s.muted}>来源 workflow-graph · 采集于 {clockOf(p.workflowWaitSummary.checkedAt ?? "")}{p.dispatchAt ? ` · dispatcher pass ${clockOf(p.dispatchAt)}` : " · dispatcher pass 未记录"}</Text>}
        {p.workflowWaitSummary.truncated || p.bounds.workflowWaits.truncated ? <Text style={s.muted}>等待根列表已截断：显示 {p.bounds.workflowWaits.shown} / {p.workflowWaitSummary.totalRoots}。</Text> : null}
        {p.workflowWaits.some(root => root.kind === "active_lease") && <Text style={s.muted}>活租约中的复核任务来自独立工作流图，可能未纳入最近 dispatcher pass；这不表示不可派工。</Text>}
      </Section>
      <Section title="就绪待领" count={p.ready.length} ctx={ctx}>
        {p.ready.length === 0 && <Text style={s.muted}>没有排队等认领的任务。</Text>}
        {p.ready.map(r => (
          <View key={r.taskId} style={s.card}>
            <Text style={s.text}>{r.title}</Text>
            <Text style={s.muted}>
              {ROLE_LABEL[r.role] ?? r.role}{r.discipline ? ` · ${r.discipline}` : ""} · 已等 {fmtAge(r.waitingMin)}
            </Text>
            {r.unclaimableReason && (
              <Text style={{ color: "#d97706", fontSize: 13 }}>无人可派：{r.unclaimableReason}</Text>
            )}
          </View>
        ))}
      </Section>
      <Section title="无法派工" count={p.bounds.dispatchBlocked.total} ctx={ctx}>
        {p.dispatchBlocked.length === 0 && <Text style={s.muted}>没有无法派工的任务。</Text>}
        {p.dispatchBlocked.map(v => (
          <View key={`${v.taskId}:${v.phase}`} style={s.card}>
            <Text style={s.text}>{v.title}</Text>
            <Text style={s.muted}>
              {v.phase === "review" ? "复核" : "执行"} · 工作流：{WORKFLOW_LABEL[v.workflowState]} · 派工：无法派工 · 可选人数 {v.eligibleCount} · 已等 {fmtAge(v.waitingMinutes)}
            </Text>
            <Text style={{ color: "#d97706", fontSize: 13 }}>{v.summary}</Text>
            {v.reasons.map((r, i) => (
              <Text key={i} style={s.muted}>
                {r.text}（{r.candidates.filter(c => c !== "*").join("、") || "全局"}）· 负责：{r.owner === "gm" ? "经理" : r.owner === "system" ? "系统" : "老板"} · 恢复：{r.recovery}
              </Text>
            ))}
            <Text style={s.muted}>结论检查于 {clockOf(v.checkedAt)}</Text>
          </View>
        ))}
        {p.bounds.dispatchBlocked.truncated && (
          <Text style={s.muted}>只列出 {p.bounds.dispatchBlocked.shown} 项，共 {p.bounds.dispatchBlocked.total} 项。</Text>
        )}
      </Section>
      <Section title="资源异常" count={p.resources.length} ctx={ctx}>
        {p.resources.length === 0 && <Text style={s.muted}>订阅与编制都正常。</Text>}
        {p.resources.map((r, i) => <Text key={i} style={s.text}>{r}</Text>)}
      </Section>
      <Collapsible title="近 24 小时" ctx={ctx}>
        <View style={s.card}>
          <Text style={s.text}>
            完成 {p.last24h.done} · 退回 {p.last24h.returned} · 驳回 {p.last24h.rejected} · 通道回滚 {p.last24h.rolledBack} · 退役 {p.last24h.retired}
          </Text>
          <Text style={s.muted}>员工流动：新建 {p.churn.created} · 退役 {p.churn.retired} · 认领失败 {p.churn.claimLost}</Text>
        </View>
      </Collapsible>
      <Collapsible title="最近完成" count={p.recentDone.length} ctx={ctx}>
        <View style={s.card}>
          {p.recentDone.length === 0 && <Text style={s.muted}>暂无。</Text>}
          {p.recentDone.map(d => (
            <Text key={d.taskId + d.at} style={s.muted}>{d.at.slice(5, 16).replace("T", " ")} · {d.actor ? `${d.actor} · ` : ""}{d.title.slice(0, 60)}</Text>
          ))}
        </View>
      </Collapsible>
      <Collapsible title="在办目标" count={p.goals.length} ctx={ctx}>
        <View style={s.card}>
          {p.goals.map((g, i) => <Text key={i} style={s.text}>{g.title.slice(0, 70)}{g.days > 0 ? `（已 ${g.days} 天）` : ""}</Text>)}
        </View>
      </Collapsible>
      {data.isLoading && <Text style={s.muted}>加载中…</Text>}
      {data.isError && <Text style={s.muted}>加载失败：{String((data.error as Error).message).slice(0, 200)}</Text>}
    </View>
  );
}

function InboxTab({ ctx }: { ctx: Ctx }) {
  const s = makeStyles(ctx);
  const queryClient = useQueryClient();
  const inboxRpc = useRpc(rpc.inbox);
  const resolve = useRpc(rpc.resolveNotice);
  const consoleRpc = useRpc(rpc.consoleUrl);
  const openRpc = useRpc(rpc.openExternal);
  const consoleQ = useQuery({ queryKey: ["consoleUrl"], queryFn: () => consoleRpc({}), staleTime: 300_000 });
  const data = useQuery({ queryKey: ["inbox"], queryFn: () => inboxRpc({}), refetchInterval: 10_000 });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["inbox"] });
  const box: Inbox | undefined = data.data;
  const empty = box && box.gates.length + box.questions.length + box.notices.length === 0;
  return (
    <View style={{ gap: 12 }}>
      {consoleQ.data?.url ? (
        <Pressable accessibilityRole="button" style={s.card}
          onPress={() => void openExternalAnywhere(consoleQ.data!.url, ctx.navigation, openRpc)}>
          <Text style={s.muted}>网页审核台（手机浏览器打开，可审待办/看手册）</Text>
          <Text selectable style={{ color: ctx.theme.colors.accent, fontSize: 13 }}>{consoleQ.data.url}</Text>
        </Pressable>
      ) : null}
      <Section title="待批关口" count={box?.gates.length} ctx={ctx}>
        {box?.gates.map(g => (
          <DecideCard key={g.task.id} taskId={g.task.id} kind="approve" ctx={ctx} onDone={refresh}
            body={`${g.task.title}\n\n${g.submission ?? "（无提交说明）"}`} />
        ))}
      </Section>
      <Section title="待回问题" count={box?.questions.length} ctx={ctx}>
        {box?.questions.map(q => (
          <DecideCard key={q.task.id} taskId={q.task.id} kind="reply" ctx={ctx} onDone={refresh}
            body={`${q.task.title}\n\n${q.question ?? ""}`} />
        ))}
      </Section>
      <Section title="提醒" count={box?.notices.length} ctx={ctx}>
        {box?.notices.map(n => (
          <View key={n.key} style={s.card}>
            <ExpandableText text={n.text} lines={8} style={s.text} ctx={ctx} />
            <Text style={s.muted}>{n.at}</Text>
            <Pressable accessibilityRole="button" style={[s.buttonSecondary, { alignSelf: "flex-start" }]}
              onPress={async () => { await resolve({ key: n.key }); refresh(); }}>
              <Text style={s.buttonSecondaryText}>知道了</Text>
            </Pressable>
          </View>
        ))}
      </Section>
      {empty && <Text style={s.muted}>收件箱是空的。</Text>}
      {data.isLoading && <Text style={s.muted}>加载中…</Text>}
      {data.isError && <Text style={s.muted}>加载失败：{String((data.error as Error).message).slice(0, 200)}</Text>}
    </View>
  );
}

function NewGoalTab({ ctx, brief }: { ctx: Ctx; brief?: Brief }) {
  const s = makeStyles(ctx);
  const queryClient = useQueryClient();
  const create = useRpc(rpc.createGoal);
  const addDir = useRpc(rpc.addDirection);
  const triage = useRpc(rpc.triageGoal);
  const [text, setText] = useState("");
  const [tier, setTier] = useState<GoalTier | undefined>();
  const [project, setProject] = useState<string | undefined>();
  const [pipeline, setPipeline] = useState<"software" | "video" | "story" | undefined>();
  const [direction, setDirection] = useState("");
  const [feedback, setFeedback] = useState("");
  const submit = useMutation({
    mutationFn: () => create({ text, tier, project, pipeline, key: newKey() }),
    onSuccess: goal => {
      setText(""); setFeedback(`已创建目标 ${goal.id.slice(0, 16)}（${goal.state === "triage" ? "等待分级" : goal.state}）`);
      void queryClient.invalidateQueries();
    },
    onError: e => setFeedback(`失败：${(e as Error).message.slice(0, 200)}`),
  });
  const dirMutation = useMutation({
    mutationFn: () => addDir({ text: direction, key: newKey() }),
    onSuccess: () => { setDirection(""); void queryClient.invalidateQueries(); },
  });
  const triageMutation = useMutation({
    mutationFn: (v: { goalId: string; tier: GoalTier }) => triage(v),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const triaging = brief?.goals.filter(g => g.state === "triage") ?? [];
  return (
    <View style={{ gap: 12 }}>
      <Section title="新目标" ctx={ctx}>
        <View style={s.card}>
          <TextInput style={[s.input, { minHeight: 80 }]} placeholder="要公司做什么？越具体越好"
            placeholderTextColor={ctx.theme.colors.foregroundMuted} value={text} onChangeText={setText} multiline />
          <Text style={s.muted}>级别（不选则 Jev 判断，拿不准交给经理）</Text>
          <View style={s.row}>
            {([undefined, "quick", "standard", "program"] as (GoalTier | undefined)[]).map(t => (
              <Pressable key={t ?? "auto"} style={[s.chip, tier === t && s.chipActive]} onPress={() => setTier(t)}>
                <Text style={[s.chipText, tier === t && s.chipTextActive]}>{t ? TIER_LABEL[t] : "自动"}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.muted}>项目（不选则按事务性工作处理）</Text>
          <View style={s.row}>
            <Pressable style={[s.chip, project === undefined && s.chipActive]} onPress={() => setProject(undefined)}>
              <Text style={[s.chipText, project === undefined && s.chipTextActive]}>不关联</Text>
            </Pressable>
            {brief?.projects.map(p => (
              <Pressable key={p.id} style={[s.chip, project === p.id && s.chipActive]} onPress={() => setProject(p.id)}>
                <Text style={[s.chipText, project === p.id && s.chipTextActive]}>{p.name}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.muted}>产线（不选则用项目默认产线，没有则按软件产线）</Text>
          <View style={s.row}>
            {([undefined, "software", "video", "story"] as ("software" | "video" | "story" | undefined)[]).map(l => (
              <Pressable key={l ?? "default"} style={[s.chip, pipeline === l && s.chipActive]} onPress={() => setPipeline(l)}>
                <Text style={[s.chipText, pipeline === l && s.chipTextActive]}>{l ? PIPELINE_LABEL[l] : "项目默认"}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable accessibilityRole="button" style={[s.button, { alignSelf: "flex-start" }]}
            disabled={submit.isPending || text.trim().length < 2} onPress={() => submit.mutate()}>
            <Text style={s.buttonText}>下达目标</Text>
          </Pressable>
          {feedback !== "" && <Text style={s.muted}>{feedback}</Text>}
        </View>
      </Section>
      {triaging.length > 0 && (
        <Section title="等待分级" count={triaging.length} ctx={ctx}>
          {triaging.map(g => (
            <View key={g.id} style={s.card}>
              <Text style={s.text}>{g.title}</Text>
              <View style={s.row}>
                {(["quick", "standard", "program"] as GoalTier[]).map(t => (
                  <Pressable key={t} style={s.buttonSecondary} disabled={triageMutation.isPending}
                    onPress={() => triageMutation.mutate({ goalId: g.id, tier: t })}>
                    <Text style={s.buttonSecondaryText}>{TIER_LABEL[t]}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </Section>
      )}
      <Section title="公司方向" ctx={ctx}>
        <View style={s.card}>
          <TextInput style={[s.input, { minHeight: 48 }]} placeholder="记录一条公司运作方向，所有员工可见"
            placeholderTextColor={ctx.theme.colors.foregroundMuted} value={direction} onChangeText={setDirection} multiline />
          <Pressable accessibilityRole="button" style={[s.buttonSecondary, { alignSelf: "flex-start" }]}
            disabled={dirMutation.isPending || direction.trim().length < 2} onPress={() => dirMutation.mutate()}>
            <Text style={s.buttonSecondaryText}>记录方向</Text>
          </Pressable>
          {brief?.directions.slice(0, 5).map((d, i) => (
            <Text key={i} style={s.muted}>· {d.text}</Text>
          ))}
        </View>
      </Section>
    </View>
  );
}

function TaskRow({ task, ctx, depth, onOpen, verdict }: { task: TaskView; ctx: Ctx; depth: number; onOpen: (id: string) => void; verdict?: DispatchBlockedView }) {
  const s = makeStyles(ctx);
  return (
    <View>
      <Pressable style={[s.row, { paddingLeft: depth * 14 }]} onPress={() => onOpen(task.id)}>
        <View style={[s.badge, { backgroundColor: STATE_COLOR[task.state] ?? ctx.theme.colors.surface2 }]}>
          <Text style={[s.badgeText, { color: "#fff" }]}>{STATE_LABEL[task.state] ?? task.state}</Text>
        </View>
        <View style={[s.badge]}><Text style={s.badgeText}>{KIND_LABEL[task.kind] ?? task.kind}</Text></View>
        <Text style={[s.text, { flex: 1 }]} numberOfLines={2}>{task.title}</Text>
        <Text style={s.muted}>{task.currentEmployee?.split("⟨").pop()?.replace("⟩", "") ?? task.executorRole}</Text>
      </Pressable>
      {task.waiting && (
        <View style={{ paddingLeft: depth * 14 + 8 }}>
          <Text style={s.muted}>{waitingLabel(task.waiting)}</Text>
        </View>
      )}
      {verdict && (
        <View style={{ paddingLeft: depth * 14 + 8, gap: 2 }}>
          <Text style={{ color: "#d97706", fontSize: 13 }}>无法派工（{WORKFLOW_LABEL[verdict.workflowState]}）：{verdict.summary}</Text>
          <Text style={s.muted}>可选人数 {verdict.eligibleCount} · 结论检查于 {clockOf(verdict.checkedAt)}</Text>
        </View>
      )}
    </View>
  );
}

/** 老板对单个任务的生命周期操作：终止在途（撤租约）、解锁依赖、作废任务。终态任务不出按钮。 */
function TaskOwnerActions({ task, ctx, onDone }: { task: TaskView; ctx: Ctx; onDone: () => void }) {
  const s = makeStyles(ctx);
  const voidRpc = useRpc(rpc.voidTask);
  const revokeRpc = useRpc(rpc.revokeTask);
  const unlockRpc = useRpc(rpc.unlockTask);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string>();
  const mutation = useMutation({
    mutationFn: async (action: "revoke" | "void" | "unlock") => {
      if (action === "revoke") {
        const r = await revokeRpc({ taskId: task.id, note });
        if (!r.ok) throw new Error("没有在途租约可撤");
        return `已撤销 ${r.employee ?? ""} 的租约，任务回就绪等下一位员工`;
      }
      if (action === "void") {
        const t = await voidRpc({ taskId: task.id, note, key: newKey() });
        return `已作废（${t.state}）`;
      }
      const u = await unlockRpc({ taskId: task.id });
      return u.unlocked.length ? `已解锁：${u.unlocked.join("、")}` : "没有需要解锁的任务";
    },
    onSuccess: r => { setNote(""); setResult(r); onDone(); },
    onError: e => setResult(`失败：${String((e as Error).message).slice(0, 140)}`),
  });
  if (task.state === "done" || task.state === "void") return null;
  return (
    <View style={{ gap: 6, marginTop: 6 }}>
      <TextInput
        style={[s.input, { minHeight: 32 }]}
        placeholder="说明（作废必填，终止/解锁可留空）"
        placeholderTextColor={ctx.theme.colors.foregroundMuted}
        value={note} onChangeText={setNote} multiline
      />
      <View style={s.row}>
        {task.state === "doing" && task.currentEmployee ? (
          <Pressable accessibilityRole="button" style={s.buttonSecondary} disabled={mutation.isPending}
            onPress={() => mutation.mutate("revoke")}>
            <Text style={s.buttonSecondaryText}>终止在途执行</Text>
          </Pressable>
        ) : null}
        {task.state === "blocked" ? (
          <Pressable accessibilityRole="button" style={s.buttonSecondary} disabled={mutation.isPending}
            onPress={() => mutation.mutate("unlock")}>
            <Text style={s.buttonSecondaryText}>解锁依赖</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" style={s.buttonDanger}
          disabled={mutation.isPending || note.trim().length < 2}
          onPress={() => mutation.mutate("void")}>
          <Text style={s.buttonDangerText}>作废任务</Text>
        </Pressable>
      </View>
      {result ? <Text style={s.muted}>{result}</Text> : null}
    </View>
  );
}

/** 目标级操作：取消目标（作废全部未完成任务并关闭目标）。点开两次确认。 */
function CancelGoalButton({ goalId, ctx, onDone }: { goalId: string; ctx: Ctx; onDone: () => void }) {
  const s = makeStyles(ctx);
  const cancelRpc = useRpc(rpc.cancelGoalRpc);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string>();
  const mutation = useMutation({
    mutationFn: () => cancelRpc({ goalId, note, key: newKey() }),
    onSuccess: r => {
      setOpen(false); setNote("");
      setResult(`已作废 ${r.retired} 个任务${r.remaining ? `；仍有 ${r.remaining} 个未能作废，目标保持原状` : "，目标已关闭"}`);
      onDone();
    },
    onError: e => setResult(`失败：${String((e as Error).message).slice(0, 140)}`),
  });
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      <Pressable accessibilityRole="button" style={[s.buttonDanger, { alignSelf: "flex-start" }]}
        onPress={() => setOpen(o => !o)}>
        <Text style={s.buttonDangerText}>{open ? "收起" : "取消目标…"}</Text>
      </Pressable>
      {open ? (
        <>
          <Text style={s.muted}>将作废该目标全部未完成任务并关闭目标，操作进审计。</Text>
          <TextInput
            style={[s.input, { minHeight: 32 }]}
            placeholder="取消原因（必填）"
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            value={note} onChangeText={setNote} multiline
          />
          <Pressable accessibilityRole="button" style={[s.button, { alignSelf: "flex-start" }]}
            disabled={mutation.isPending || note.trim().length < 2}
            onPress={() => mutation.mutate()}>
            <Text style={s.buttonText}>确认取消目标</Text>
          </Pressable>
        </>
      ) : null}
      {result ? <Text style={s.muted}>{result}</Text> : null}
    </View>
  );
}

function GoalsTab({ ctx, brief }: { ctx: Ctx; brief?: Brief }) {
  const s = makeStyles(ctx);
  const tasksRpc = useRpc(rpc.goalTasks);
  const detailRpc = useRpc(rpc.taskDetail);
  const [openGoal, setOpenGoal] = useState<string | undefined>();
  const [openTask, setOpenTask] = useState<string | undefined>();
  const tasksQuery = useQuery({
    queryKey: ["goalTasks", openGoal],
    queryFn: () => tasksRpc({ goalId: openGoal! }),
    enabled: openGoal !== undefined,
    refetchInterval: 15_000,
  });
  const detailQuery = useQuery({
    queryKey: ["taskDetail", openTask],
    queryFn: () => detailRpc({ taskId: openTask! }),
    enabled: openTask !== undefined,
  });
  const queryClient = useQueryClient();
  const refreshAll = () => { void tasksQuery.refetch(); void detailQuery.refetch(); void queryClient.invalidateQueries(); };
  const goals = (brief?.goals ?? []).filter((g: GoalView) => g.state !== "cancelled");
  // Goal cards read the same pulse as the queue: the root blocker is the server's conclusion, not a second computation.
  const pulseRpc = useRpc(rpc.pulse);
  const pulseQuery = useQuery({ queryKey: ["pulse"], queryFn: () => pulseRpc({}), refetchInterval: 10_000 });
  const pulse = useMemo(() => normalizePulse(pulseQuery.data), [pulseQuery.data]);
  const blockers = pulse.goalBlockers;
  const verdictOf = new Map(pulse.dispatchBlocked.map(v => [v.taskId, v] as const));
  return (
    <View style={{ gap: 12 }}>
      {goals.length === 0 && <Text style={s.muted}>没有进行中的目标。</Text>}
      {pulse.bounds.goalBlockers.truncated && (
        <Text style={s.muted}>根阻点只列出 {pulse.bounds.goalBlockers.shown} 个目标，共 {pulse.bounds.goalBlockers.total} 个；其余目标的根阻点未在此列出。</Text>
      )}
      {goals.map(g => (
        <View key={g.id} style={s.card}>
          <Pressable style={s.row} onPress={() => setOpenGoal(openGoal === g.id ? undefined : g.id)}>
            <Text style={[s.text, { flex: 1 }]}>{g.title}</Text>
            <View style={s.badge}><Text style={s.badgeText}>{g.tier ?? "?"}</Text></View>
            <View style={s.badge}><Text style={s.badgeText}>{g.state}</Text></View>
          </Pressable>
          {blockers.find(b => b.goalId === g.id) && (() => {
            const root = blockers.find(b => b.goalId === g.id)!;
            return (
              <View style={{ gap: 2 }}>
                <Text style={s.muted}>
                  {root.feasible ? "等待派工" : "无法派工"}：{root.title}（{root.phase === "review" ? "复核" : "执行"}，工作流：{WORKFLOW_LABEL[root.workflowState]}）。{root.summary}。已等待 {root.waitingMinutes} 分钟{root.impact > 0 ? `；影响 ${root.impact} 项后续` : ""}
                </Text>
                <Text style={s.muted}>
                  无法派工 {root.undispatchable} 项（含根）；正常等待（依赖）{root.impact} 项{root.others > 0 ? `；同目标另有 ${root.others} 项阻塞` : ""}；结论检查于 {clockOf(root.checkedAt)}
                </Text>
              </View>
            );
          })()}
          {openGoal === g.id && (
            <View style={{ gap: 4 }}>
              <ExpandableText text={g.brief} lines={6} style={s.muted} ctx={ctx} />
              {(blockers.find(b => b.goalId === g.id)?.reasons ?? []).map((r, i) => (
                <Text key={i} style={s.muted}>
                  {r.text}（{r.candidates.filter(c => c !== "*").join("、") || "全局"}{r.candidatesOmitted ? `；另有 ${r.candidatesOmitted} 个候选未列出` : ""}）· 恢复：{r.recovery} · 处理：{r.owner === "gm" ? "经理" : "老板"}
                </Text>
              ))}
              {blockers.find(b => b.goalId === g.id) && (() => {
                const root = blockers.find(b => b.goalId === g.id)!;
                return (
                  <View style={{ gap: 4 }}>
                    {root.dependencyPath.length > 1 && (
                      <Text style={s.muted}>依赖路径（根在前）：{root.dependencyPath.map(p => p.title).join(" → ")}</Text>
                    )}
                    <Text style={s.muted}>
                      实现者：{root.people.implementer ?? "未绑定"}；作者：{root.people.authors.join("、") || "无"}；复核者：{root.people.reviewers.join("、") || "无"}；最后提交：{root.people.submitter ?? "无"}{root.people.submitCommit ? `（提交 ${root.people.submitCommit}）` : ""}{root.people.peopleOmitted ? `；另有 ${root.people.peopleOmitted} 人未列出` : ""}
                    </Text>
                    <Text style={s.muted}>数据时点（结论检查时刻）：{clockOf(root.checkedAt)}</Text>
                  </View>
                );
              })()}
              {(tasksQuery.data?.tasks ?? []).map(t => (
                <View key={t.id}>
                  <TaskRow task={t} ctx={ctx} depth={0} verdict={verdictOf.get(t.id)} onOpen={id => setOpenTask(openTask === id ? undefined : id)} />
                  {openTask === t.id && detailQuery.data && (
                    <View style={[s.card, { marginLeft: 14, backgroundColor: ctx.theme.colors.surface2 }]}>
                      <ExpandableText text={detailQuery.data.task.context} lines={8} style={s.muted} ctx={ctx} />
                      <TaskOwnerActions task={detailQuery.data.task} ctx={ctx} onDone={refreshAll} />
                      {detailQuery.data.audit.map((a, i) => (
                        <ExpandableText key={i} lines={4} style={s.mono} ctx={ctx}
                          text={`${a.at.slice(5, 16)} ${a.action} · ${a.actor}${a.evidence ? ` — ${a.evidence}` : ""}`} />
                      ))}
                    </View>
                  )}
                </View>
              ))}
              {tasksQuery.isLoading && <Text style={s.muted}>加载任务…</Text>}
              <CancelGoalButton goalId={g.id} ctx={ctx} onDone={refreshAll} />
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

const ROLE_LABEL: Record<string, string> = { gm: "总经理", product: "运营/产品", engineering: "工程", "ai-content": "AI 内容", "concept-design": "原型/概念设计", "asset-production": "量产制作", screenwriter: "专职编剧", "story-author": "长篇故事作者", cinematography: "摄影摄像", qa: "测试", cs: "客户成功", eval: "评审" };
const MODEL_PREVIEW = 10;

function RegisterDefCard({ ctx, editing, onDone, onCancel }: {
  ctx: Ctx; editing?: Roster["defs"][number]; onDone: () => void; onCancel?: () => void;
}) {
  const s = makeStyles(ctx);
  const optsRpc = useRpc(rpc.providerOptions);
  const regRpc = useRpc(rpc.registerDef);
  const options = useQuery({ queryKey: ["providerOptions"], queryFn: () => optsRpc({}), staleTime: 60_000 });
  const [role, setRole] = useState<string | undefined>(editing?.role);
  const [provider, setProvider] = useState<string | undefined>(editing?.provider);
  const [model, setModel] = useState<string | undefined>(editing?.model);
  const [thinking, setThinking] = useState<string | undefined>(editing?.thinking);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [maxInstances, setMaxInstances] = useState(String(editing?.maxInstances ?? 1));
  const [weight, setWeight] = useState(String(editing?.weight ?? 10));
  // undefined = "leave the stored value alone". A roster payload from an older plugin, or a page
  // opened before a reload, must not silently re-apply the quota limit when the form is saved.
  const [quotaLimited, setQuotaLimited] = useState<boolean | undefined>(editing ? editing.quotaLimited : true);
  const [showAllModels, setShowAllModels] = useState(false);
  const [result, setResult] = useState<string>();

  const prov = options.data?.providers.find(p => p.id === provider);
  const modelChoices = prov
    ? [
        ...prov.families.map(f => ({ id: f.slot, label: `${f.slot} → ${f.resolvesTo}`, hint: "自动跟随新版" })),
        ...prov.models.map(m => ({ id: m.id, label: m.label || m.id, hint: m.isDefault ? "pin · 默认" : "pin" })),
      ]
    : [];
  if (editing && editing.provider === provider && editing.model && !modelChoices.some(m => m.id === editing.model)) {
    modelChoices.unshift({ id: editing.model, label: `${editing.model}（当前值·不在列表）`, hint: "当前" });
  }
  const resolvedId = model?.startsWith("auto:") ? prov?.families.find(f => f.slot === model)?.resolvesTo : model;
  const resolvedModel = prov?.models.find(m => m.id === resolvedId);
  const thinkingOpts = resolvedModel?.thinkingOptions ?? [];
  if (editing && editing.thinking && thinking === editing.thinking && !thinkingOpts.some(t => t.id === editing.thinking)) {
    thinkingOpts.unshift({ id: editing.thinking, label: `${editing.thinking}（当前值）`, isDefault: false });
  }
  const visibleModels = showAllModels ? modelChoices : modelChoices.slice(0, MODEL_PREVIEW);
  const ready = !!role && !!provider && !!model;

  const submit = useMutation({
    mutationFn: () => regRpc({
      role: role!, provider: provider!, model: model!, thinking, enabled,
      maxInstances: Number.parseInt(maxInstances, 10) || undefined,
      weight: Number.parseInt(weight, 10) || undefined,
      quotaLimited,
    }),
    onSuccess: r => { setResult(editing ? `已更新 ${r.id}` : `已注册 ${r.id}`); if (!editing) { setModel(undefined); setThinking(undefined); } onDone(); },
    onError: e => setResult(`失败：${e instanceof Error ? e.message : String(e)}`),
  });

  const crumb = [
    role ? (ROLE_LABEL[role] ?? role) : undefined,
    provider ? (prov?.label ?? provider) : undefined,
    model,
  ].filter(Boolean).join(" / ");

  return (
    <View style={s.card}>
      {editing ? (
        <>
          <Text style={s.text}>编辑 {editing.id}（岗位与 provider 决定编制 id，不可改）</Text>
          <Text style={s.muted}>岗位 {ROLE_LABEL[editing.role] ?? editing.role} · provider {prov?.label ?? editing.provider}</Text>
        </>
      ) : (
        <>
          <Text style={s.muted}>{crumb ? `已选：${crumb}` : "① 先选岗位"}</Text>
          <View style={s.row}>
            {(options.data?.roles ?? []).map(r => (
              <Pressable key={r} accessibilityRole="button" style={[s.chip, role === r && s.chipActive]}
                onPress={() => { setRole(r); setProvider(undefined); setModel(undefined); setThinking(undefined); }}>
                <Text style={[s.chipText, role === r && s.chipTextActive]}>{ROLE_LABEL[r] ?? r}</Text>
              </Pressable>
            ))}
          </View>
          {role && (
            <>
              <Text style={s.muted}>② 订阅 provider{options.data ? `（${options.data.providers.length} 个已启用）` : "（加载中…）"}</Text>
              <View style={s.row}>
                {(options.data?.providers ?? []).map(p => (
                  <Pressable key={p.id} accessibilityRole="button" style={[s.chip, provider === p.id && s.chipActive]}
                    onPress={() => { setProvider(p.id); setModel(undefined); setThinking(undefined); }}>
                    <Text style={[s.chipText, provider === p.id && s.chipTextActive]}>{p.label}{p.status !== "ready" && p.status !== "available" ? ` · ${p.status}` : ""}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
        </>
      )}
      {prov && (
        <>
          <Text style={s.muted}>{editing ? "" : "③ "}模型（auto 跟随上游最新版，pin 锁定版本）</Text>
          <View style={s.row}>
            {visibleModels.map(m => (
              <Pressable key={m.id} accessibilityRole="button" style={[s.chip, model === m.id && s.chipActive]}
                onPress={() => { setModel(m.id); setThinking(undefined); }}>
                <Text style={[s.chipText, model === m.id && s.chipTextActive]}>{m.label}</Text>
              </Pressable>
            ))}
            {modelChoices.length > MODEL_PREVIEW && (
              <Pressable accessibilityRole="button" onPress={() => setShowAllModels(v => !v)}>
                <Text style={s.muted}>{showAllModels ? "收起" : `展开全部 ${modelChoices.length} 个`}</Text>
              </Pressable>
            )}
          </View>
        </>
      )}
      {prov && thinkingOpts.length > 0 && model && (
        <>
          <Text style={s.muted}>Thinking{resolvedId ? `（${resolvedId}）` : ""}</Text>
          <View style={s.row}>
            <Pressable accessibilityRole="button" style={[s.chip, thinking === undefined && s.chipActive]} onPress={() => setThinking(undefined)}>
              <Text style={[s.chipText, thinking === undefined && s.chipTextActive]}>默认</Text>
            </Pressable>
            {thinkingOpts.map(t => (
              <Pressable key={t.id} accessibilityRole="button" style={[s.chip, thinking === t.id && s.chipActive]} onPress={() => setThinking(t.id)}>
                <Text style={[s.chipText, thinking === t.id && s.chipTextActive]}>{t.label}{t.isDefault ? " ·默认" : ""}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {ready && (
        <>
          <View style={s.row}>
            <Text style={s.muted}>实例上限</Text>
            <TextInput style={[s.input, { width: 56, paddingVertical: 6 }]} value={maxInstances} onChangeText={setMaxInstances} keyboardType="number-pad" />
            <Text style={s.muted}>派工权重</Text>
            <TextInput style={[s.input, { width: 64, paddingVertical: 6 }]} value={weight} onChangeText={setWeight} keyboardType="number-pad" />
            <Text style={s.muted}>额度限制</Text>
            <Pressable accessibilityRole="button" style={[s.chip, quotaLimited !== false && s.chipActive]} onPress={() => setQuotaLimited(true)}>
              <Text style={[s.chipText, quotaLimited !== false && s.chipTextActive]}>受限</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={[s.chip, !quotaLimited && s.chipActive]} onPress={() => setQuotaLimited(false)}>
              <Text style={[s.chipText, !quotaLimited && s.chipTextActive]}>不受限</Text>
            </Pressable>
            {editing && (
              <>
                <Text style={s.muted}>状态</Text>
                <Pressable accessibilityRole="button" style={[s.chip, enabled && s.chipActive]} onPress={() => setEnabled(true)}>
                  <Text style={[s.chipText, enabled && s.chipTextActive]}>启用</Text>
                </Pressable>
                <Pressable accessibilityRole="button" style={[s.chip, !enabled && s.chipActive]} onPress={() => setEnabled(false)}>
                  <Text style={[s.chipText, !enabled && s.chipTextActive]}>停用</Text>
                </Pressable>
              </>
            )}
          </View>
          <View style={s.row}>
            <Pressable accessibilityRole="button" style={s.button} disabled={submit.isPending}
              onPress={() => { setResult(undefined); submit.mutate(); }}>
              <Text style={s.buttonText}>{submit.isPending ? "提交中…" : editing ? `保存 ${editing.id}` : `注册 ${role}-${provider}`}</Text>
            </Pressable>
            {editing && onCancel && (
              <Pressable accessibilityRole="button" style={s.buttonSecondary} onPress={onCancel}>
                <Text style={s.buttonSecondaryText}>取消编辑</Text>
              </Pressable>
            )}
            {result && <Text style={result.startsWith("失败") ? s.buttonDangerText : s.muted}>{result}</Text>}
          </View>
        </>
      )}
      {!ready && result && <Text style={result.startsWith("失败") ? s.buttonDangerText : s.muted}>{result}</Text>}
    </View>
  );
}

function RosterTab({ ctx, brief }: { ctx: Ctx; brief?: Brief }) {
  const s = makeStyles(ctx);
  const queryClient = useQueryClient();
  const rosterRpc = useRpc(rpc.roster);
  const permsRpc = useRpc(rpc.pendingPermissions);
  const answer = useRpc(rpc.answerPermission);
  const pause = useRpc(rpc.setPaused);
  const toggleDef = useRpc(rpc.setDefEnabled);
  const [pausePending, setPausePending] = useState(false);
  const [editDef, setEditDef] = useState<Roster["defs"][number] | undefined>();
  const data = useQuery({ queryKey: ["roster"], queryFn: () => rosterRpc({}), refetchInterval: 10_000 });
  const perms = useQuery({ queryKey: ["perms"], queryFn: () => permsRpc({}), refetchInterval: 8_000 });
  const r: Roster | undefined = data.data;
  const refreshAll = () => void queryClient.invalidateQueries();
  return (
    <View style={{ gap: 12 }}>
      <Section title="派工开关" ctx={ctx}>
        <View style={[s.card, s.row]}>
          <Text style={[s.text, { flex: 1 }]}>{r?.paused ? "派工已暂停" : "派工运行中"}</Text>
          <Pressable accessibilityRole="button" style={r?.paused ? s.button : s.buttonDanger}
            disabled={pausePending}
            onPress={async () => { setPausePending(true); try { await pause({ paused: !(r?.paused ?? false) }); refreshAll(); } finally { setPausePending(false); } }}>
            <Text style={r?.paused ? s.buttonText : s.buttonDangerText}>{r?.paused ? "恢复派工" : "暂停派工"}</Text>
          </Pressable>
        </View>
      </Section>
      <Section title="待确认权限" count={perms.data?.items.length} ctx={ctx}>
        {(perms.data?.items ?? []).map((p: PermissionRequest) => (
          <View key={`${p.agentId}:${p.request.id}`} style={s.card}>
            <Text style={s.text}>{p.employeeId ?? p.title ?? p.agentId}</Text>
            <ExpandableText text={`${p.request.summary ?? p.request.kind ?? p.request.id}${p.request.detail ? `\n${p.request.detail}` : ""}`} lines={6} style={s.muted} ctx={ctx} />
            <View style={s.row}>
              <Pressable accessibilityRole="button" style={s.button}
                onPress={async () => { await answer({ agentId: p.agentId, requestId: p.request.id, behavior: "allow" }); refreshAll(); }}>
                <Text style={s.buttonText}>允许</Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={s.buttonDanger}
                onPress={async () => { await answer({ agentId: p.agentId, requestId: p.request.id, behavior: "deny" }); refreshAll(); }}>
                <Text style={s.buttonDangerText}>拒绝</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </Section>
      {(() => {
        const usage = r?.usage ?? [];
        const health = r?.health ?? [];
        const defs = r?.defs ?? [];
        const insts = r?.instances ?? [];
        // 「需要处理」只放异常：耗尽/不健康的订阅、低额度窗口、停用编制、会话异常实例。
        const problems: string[] = [];
        for (const h of health.filter(h => h.state !== "healthy"))
          problems.push(`订阅 ${h.provider}：${h.state}${h.lastError ? `（${h.lastError.slice(0, 80)}）` : ""}`);
        for (const u of usage) {
          for (const w of u.windows.filter(w => (w.remainingPct ?? 100) <= 15))
            problems.push(`订阅 ${u.displayName ?? u.providerId}：${w.label} 剩余 ${Math.round(w.remainingPct!)}%`);
          for (const b of u.balances.filter(b => (b.remaining ?? 1) <= 0))
            problems.push(`订阅 ${u.displayName ?? u.providerId}：${b.label} 余额 ${b.remaining} ${b.unit ?? ""}`);
        }
        for (const d of defs.filter(d => !d.enabled))
          problems.push(`编制已停用：${d.id}`);
        for (const i of insts.filter(i => i.agentStatus && !["running", "idle", "initializing"].includes(i.agentStatus)))
          problems.push(`实例会话异常：${i.id.split("⟨").pop()?.replace("⟩", "")}（${i.agentStatus}）`);
        // A list the answer cut short may hide a problem, so "一切正常" is only said when nothing was cut.
        const cut = [r?.bounds?.usage, r?.bounds?.health, r?.bounds?.defs, r?.bounds?.instances].some(b => b?.truncated);
        return (
          <>
            <Section title="需要处理" count={problems.length} ctx={ctx}>
              <View style={s.card}>
                {problems.length === 0 && <Text style={s.muted}>{cut ? "已列出的项正常；部分列表已截断，未列出的项未参与判断。" : "一切正常。"}</Text>}
                {problems.map((p, i) => <Text key={i} style={[s.text, { color: "#d97706" }]}>{p}</Text>)}
              </View>
            </Section>
            <Collapsible title="订阅额度与健康" count={usage.length} ctx={ctx}>
              <View style={s.card}>
                {usage.map(u => {
                  const bits = [
                    ...u.windows.filter(w => w.remainingPct != null).map(w =>
                      `${w.label} 剩余 ${Math.round(w.remainingPct!)}%${w.resetsAt ? `（${w.resetsAt.slice(5, 16).replace("T", " ")} 重置）` : ""}`),
                    ...u.balances.filter(b => b.remaining != null).map(b =>
                      `${b.label} 剩 ${b.remaining}${b.limit != null ? `/${b.limit}` : ""} ${b.unit ?? ""}`),
                  ];
                  return (
                    <Text key={u.providerId} style={s.text}>
                      {u.displayName ?? u.providerId}{u.planLabel ? `（${u.planLabel}）` : ""}：
                      {bits.length ? bits.join("；") : `状态 ${u.status}`}
                    </Text>
                  );
                })}
                {usage.length === 0 && <Text style={s.muted}>暂无额度数据。</Text>}
                {health.map(h => (
                  <Text key={h.provider} style={s.muted}>{h.provider}：{h.state}{h.lastError ? `（${h.lastError.slice(0, 80)}）` : ""}</Text>
                ))}
                {r?.bounds?.usage?.truncated && <Text style={s.muted}>额度只列出 {r.bounds.usage.shown} 项，共 {r.bounds.usage.total} 项。</Text>}
                {r?.bounds?.health?.truncated && <Text style={s.muted}>健康只列出 {r.bounds.health.shown} 项，共 {r.bounds.health.total} 项。</Text>}
              </View>
            </Collapsible>
            <Section title="员工编制" count={defs.length} ctx={ctx}>
              {Object.keys(ROLE_LABEL)
                .map(role => ({ role, defs: defs.filter(d => d.role === role) }))
                .concat(defs.some(d => !(d.role in ROLE_LABEL)) ? [{ role: "", defs: defs.filter(d => !(d.role in ROLE_LABEL)) }] : [])
                .filter(g => g.defs.length > 0)
                .map(g => {
                  const roleInsts = insts.filter(i => g.defs.some(d => d.id === i.def));
                  const busy = roleInsts.filter(i => i.agentStatus === "running" || i.agentStatus === "initializing").length;
                  const idle = roleInsts.filter(i => i.agentStatus === "idle").length;
                  const enabled = g.defs.filter(d => d.enabled).length;
                  return (
                    <Collapsible key={g.role || "other"} ctx={ctx}
                      title={`${g.role ? (ROLE_LABEL[g.role] ?? g.role) : "其他"} · 启用 ${enabled}/${g.defs.length} · 忙 ${busy} 闲 ${idle}`}>
                      <View style={s.card}>
                        {[...g.defs].sort((a, b) => a.provider.localeCompare(b.provider)).map(d => {
                          const defInsts = insts.filter(i => i.def === d.id);
                          return (
                            <View key={d.id} style={{ gap: 2 }}>
                              <View style={s.row}>
                                <Text style={[s.text, { flex: 1 }]}>
                                  {d.provider}/{d.resolved ?? d.model} · 上限 {d.maxInstances}{d.avgScore ? ` · 绩效 ${d.avgScore.toFixed(1)}` : ""}{d.quotaLimited === false ? " · 不受额度限制" : ""}{d.enabled ? "" : " · 已停用"}
                                </Text>
                                <Pressable accessibilityRole="button" style={s.chip} onPress={() => setEditDef(d)}>
                                  <Text style={s.chipText}>编辑</Text>
                                </Pressable>
                                <Pressable accessibilityRole="button" style={s.chip}
                                  onPress={async () => { await toggleDef({ defId: d.id, enabled: !d.enabled }); refreshAll(); }}>
                                  <Text style={s.chipText}>{d.enabled ? "停用" : "启用"}</Text>
                                </Pressable>
                              </View>
                              {defInsts.map(i => (
                                <Text key={i.id} style={s.muted}>
                                  {"  "}· {i.id.split("⟨").pop()?.replace("⟩", "")} · {i.agentStatus ?? "未连接"}
                                </Text>
                              ))}
                            </View>
                          );
                        })}
                      </View>
                    </Collapsible>
                  );
                })}
              {r?.bounds?.defs?.truncated && <Text style={s.muted}>编制只列出 {r.bounds.defs.shown} 项，共 {r.bounds.defs.total} 项，未列出的编制不在上方。</Text>}
              {r?.bounds?.instances?.truncated && <Text style={s.muted}>实例只列出 {r.bounds.instances.shown} 个，共 {r.bounds.instances.total} 个，未列出的实例不在上方。</Text>}
            </Section>
            <Section title={editDef ? `编辑 ${editDef.id}` : "注册员工"} ctx={ctx}>
              <RegisterDefCard key={editDef?.id ?? "new"} ctx={ctx} editing={editDef}
                onDone={() => { setEditDef(undefined); refreshAll(); }} onCancel={() => setEditDef(undefined)} />
            </Section>
            <Collapsible title="调度明细（调试排障用）" ctx={ctx}>
              <View style={s.card}>
                <Text style={s.muted}>当前候选估算；最终派工由调度器执行。回避仅用于对应任务的 review。</Text>
                {(r?.reviewPools?.length ?? 0) === 0 && <Text style={s.muted}>暂无等待派工的验收任务。</Text>}
                {r?.reviewPools?.map(p => (
                  <View key={p.taskId} style={{ gap: 4 }}>
                    <Text style={s.text}>{p.title} · {p.taskId} · review · {p.role}</Text>
                    <Text style={s.muted}>项目：{p.home}</Text>
                    {p.status === "history_unavailable" && (
                      <Text style={s.text}>贡献者历史读取失败：候选不可派，中选率 0%，等待安全候选。</Text>
                    )}
                    {p.status === "blocked" && (
                      <Text style={s.text}>无合格复核人选：没有候选可以复核，任务不会被派工，原因见下方。</Text>
                    )}
                    {p.entries.length === 0 && <Text style={s.muted}>暂无候选，任务继续等待。</Text>}
                    {p.entries.map(e => (
                      <Text key={`${e.kind}:${e.ref}`} style={s.muted}>
                        {e.kind === "spawn" ? "新开" : "复用"} · {e.ref} · {e.eligible
                          ? `可派 · 权重 ${Math.round(e.weight * 10) / 10} · 中选率 ${Math.round(e.share * 100)}%`
                          : `不可派（${e.reason ?? "未知"}） · 中选率 0%`}
                      </Text>
                    ))}
                  </View>
                ))}
                {r?.bounds?.reviewPools?.truncated && (
                  <Text style={s.muted}>复核候选只列出 {r.bounds.reviewPools.shown} 项，共 {r.bounds.reviewPools.total} 项。</Text>
                )}
                {(r?.pools ?? []).filter(p => p.entries.length).map(p => (
                  <View key={`${p.role}@${p.home}`} style={{ gap: 2, marginTop: 8 }}>
                    <Text style={s.muted}>池 {ROLE_LABEL[p.role] ?? p.role}@{p.home === r?.opsRepo ? "运营仓库" : p.home.split("/").pop()}</Text>
                    {p.entries.map(e => (
                      <Text key={`${e.kind}:${e.ref}`} style={s.muted}>
                        {"  "}{e.kind === "spawn" ? "新开" : "复用"} · {e.ref.split("⟨").pop()?.replace("⟩", "")} · {e.eligible
                          ? `可派 · 权重 ${Math.round(e.weight * 10) / 10} · 中选率 ${Math.round(e.share * 100)}%`
                          : `不可派（${e.reason ?? "未知"}）`}
                      </Text>
                    ))}
                  </View>
                ))}
                {r?.bounds?.pools?.truncated && (
                  <Text style={s.muted}>候选池只列出 {r.bounds.pools.shown} 个，共 {r.bounds.pools.total} 个。</Text>
                )}
              </View>
            </Collapsible>
          </>
        );
      })()}
    </View>
  );
}


export function CompanySurface(props: PluginSurfaceProps) {
  const ctx: Ctx = { theme: props.theme, compact: props.layout.compact, navigation: props.navigation };
  const s = makeStyles(ctx);
  const briefRpc = useRpc(rpc.brief);
  const brief = useQuery({ queryKey: ["brief"], queryFn: () => briefRpc({}), refetchInterval: 15_000 });
  const [tab, setTab] = useState<"pulse" | "inbox" | "new" | "goals" | "roster">("pulse");
  const tabs = [
    { id: "pulse" as const, title: "动态" },
    { id: "inbox" as const, title: "收件箱" },
    { id: "new" as const, title: "发目标" },
    { id: "goals" as const, title: "目标进展" },
    { id: "roster" as const, title: "编制" },
  ];
  return (
    <View style={s.screen}>
      <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: props.theme.colors.border, paddingHorizontal: ctx.compact ? 8 : 16 }}>
        {tabs.map(t => (
          <Pressable key={t.id} style={[s.tab, tab === t.id && s.tabActive]} onPress={() => setTab(t.id)}>
            <Text style={[s.tabText, tab === t.id && s.tabTextActive]}>{t.title}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={s.scroll}>
        {tab === "pulse" && <PulseTab ctx={ctx} />}
        {tab === "inbox" && <InboxTab ctx={ctx} />}
        {tab === "new" && <NewGoalTab ctx={ctx} brief={brief.data} />}
        {tab === "goals" && <GoalsTab ctx={ctx} brief={brief.data} />}
        {tab === "roster" && <RosterTab ctx={ctx} brief={brief.data} />}
      </ScrollView>
    </View>
  );
}
