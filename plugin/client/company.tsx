import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View, type StyleProp, type TextStyle } from "react-native";
import * as RN from "react-native";
import * as rpc from "../shared/rpc";
import type { Brief, GoalTier, GoalView, Inbox, PermissionRequest, Roster, TaskAttachment, TaskView } from "../shared/types";

const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const STATE_LABEL: Record<string, string> = {
  blocked: "阻塞", ready: "就绪", doing: "进行中", review: "待验收", done: "完成",
};
const STATE_COLOR: Record<string, string> = {
  blocked: "#d97706", ready: "#2563eb", doing: "#7c3aed", review: "#0891b2", done: "#16a34a",
};
const TIER_LABEL: Record<string, string> = { quick: "quick 小需求", standard: "standard 常规", program: "program 大项目" };
const KIND_LABEL: Record<string, string> = { goal: "范围", task: "任务", gate: "关口", release: "上线申请", deploy: "部署实测" };

type Ctx = { theme: PluginSurfaceProps["theme"]; compact: boolean };

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

/** Hosts may ship a narrow react-native subset; probe Image instead of assuming it. */
const RNImage = (RN as Record<string, unknown>).Image as React.ComponentType<{
  source: { uri: string }; style?: unknown; resizeMode?: string; accessibilityLabel?: string;
}> | undefined;

const IMAGE_INLINE_MAX = 5 * 1024 * 1024;

const formatSize = (bytes: number): string =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;

function AttachmentRow({ taskId, a, label, ctx }: { taskId: string; a: TaskAttachment; label: string; ctx: Ctx }) {
  const s = makeStyles(ctx);
  const open = useRpc(rpc.openAttachment);
  const m = useMutation({ mutationFn: () => open({ taskId, name: a.relPath }) });
  return (
    <Pressable accessibilityRole="button" style={s.row} disabled={m.isPending} onPress={() => m.mutate()}>
      <Text style={{ color: ctx.theme.colors.accent, fontSize: 13 }}>{label}</Text>
      <Text style={[s.text, { flexShrink: 1 }]} numberOfLines={1}>{a.name}</Text>
      <Text style={s.muted}>{formatSize(a.sizeBytes)}</Text>
      {m.isError && <Text style={s.muted}>{String((m.error as Error).message).slice(0, 80)}</Text>}
    </Pressable>
  );
}

function InlineImage({ taskId, a, ctx }: { taskId: string; a: TaskAttachment; ctx: Ctx }) {
  const s = makeStyles(ctx);
  const read = useRpc(rpc.readAttachment);
  const previewable = !!RNImage && a.sizeBytes <= IMAGE_INLINE_MAX;
  const q = useQuery({
    queryKey: ["attachmentImage", taskId, a.relPath],
    queryFn: () => read({ taskId, name: a.relPath }),
    enabled: previewable,
    staleTime: 300_000,
    retry: false,
  });
  const uri = q.data?.dataUri;
  return (
    <View style={{ gap: 4 }}>
      {previewable && uri ? (
        <RNImage source={{ uri }} accessibilityLabel={a.name} resizeMode="contain"
          style={{ width: "100%", height: 200, borderRadius: 8, backgroundColor: ctx.theme.colors.surface2 }} />
      ) : null}
      <AttachmentRow taskId={taskId} a={a} label="打开" ctx={ctx} />
      {previewable && q.isError && <Text style={s.muted}>预览不可用，可点打开查看。</Text>}
    </View>
  );
}

const ATTACH_ACTION: Record<TaskAttachment["kind"], string> = {
  image: "打开", video: "播放", html: "在浏览器打开", audio: "播放", other: "打开",
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
  const links = useMemo(() => [...new Set(text.match(LINK_RE) ?? [])].slice(0, 5), [text]);
  if (links.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      {links.map(u => (
        <Pressable key={u} accessibilityRole="button" onPress={() => void openExternalUrl(u)}>
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

function InboxTab({ ctx }: { ctx: Ctx }) {
  const s = makeStyles(ctx);
  const queryClient = useQueryClient();
  const inboxRpc = useRpc(rpc.inbox);
  const resolve = useRpc(rpc.resolveNotice);
  const data = useQuery({ queryKey: ["inbox"], queryFn: () => inboxRpc({}), refetchInterval: 10_000 });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["inbox"] });
  const box: Inbox | undefined = data.data;
  const empty = box && box.gates.length + box.questions.length + box.notices.length === 0;
  return (
    <View style={{ gap: 12 }}>
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
  const [direction, setDirection] = useState("");
  const [feedback, setFeedback] = useState("");
  const submit = useMutation({
    mutationFn: () => create({ text, tier, project, key: newKey() }),
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

function TaskRow({ task, ctx, depth, onOpen }: { task: TaskView; ctx: Ctx; depth: number; onOpen: (id: string) => void }) {
  const s = makeStyles(ctx);
  return (
    <Pressable style={[s.row, { paddingLeft: depth * 14 }]} onPress={() => onOpen(task.id)}>
      <View style={[s.badge, { backgroundColor: STATE_COLOR[task.state] ?? ctx.theme.colors.surface2 }]}>
        <Text style={[s.badgeText, { color: "#fff" }]}>{STATE_LABEL[task.state] ?? task.state}</Text>
      </View>
      <View style={[s.badge]}><Text style={s.badgeText}>{KIND_LABEL[task.kind] ?? task.kind}</Text></View>
      <Text style={[s.text, { flex: 1 }]} numberOfLines={2}>{task.title}</Text>
      <Text style={s.muted}>{task.currentEmployee?.split("⟨").pop()?.replace("⟩", "") ?? task.executorRole}</Text>
    </Pressable>
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
  const goals = (brief?.goals ?? []).filter((g: GoalView) => g.state !== "cancelled");
  return (
    <View style={{ gap: 12 }}>
      {goals.length === 0 && <Text style={s.muted}>没有进行中的目标。</Text>}
      {goals.map(g => (
        <View key={g.id} style={s.card}>
          <Pressable style={s.row} onPress={() => setOpenGoal(openGoal === g.id ? undefined : g.id)}>
            <Text style={[s.text, { flex: 1 }]}>{g.title}</Text>
            <View style={s.badge}><Text style={s.badgeText}>{g.tier ?? "?"}</Text></View>
            <View style={s.badge}><Text style={s.badgeText}>{g.state}</Text></View>
          </Pressable>
          {openGoal === g.id && (
            <View style={{ gap: 4 }}>
              <ExpandableText text={g.brief} lines={6} style={s.muted} ctx={ctx} />
              {(tasksQuery.data?.tasks ?? []).map(t => (
                <View key={t.id}>
                  <TaskRow task={t} ctx={ctx} depth={0} onOpen={id => setOpenTask(openTask === id ? undefined : id)} />
                  {openTask === t.id && detailQuery.data && (
                    <View style={[s.card, { marginLeft: 14, backgroundColor: ctx.theme.colors.surface2 }]}>
                      <ExpandableText text={detailQuery.data.task.context} lines={8} style={s.muted} ctx={ctx} />
                      {detailQuery.data.audit.map((a, i) => (
                        <ExpandableText key={i} lines={4} style={s.mono} ctx={ctx}
                          text={`${a.at.slice(5, 16)} ${a.action} · ${a.actor}${a.evidence ? ` — ${a.evidence}` : ""}`} />
                      ))}
                    </View>
                  )}
                </View>
              ))}
              {tasksQuery.isLoading && <Text style={s.muted}>加载任务…</Text>}
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

const ROLE_LABEL: Record<string, string> = { gm: "总经理", product: "运营/产品", engineering: "工程", "ai-content": "AI 内容", "concept-design": "原型/概念设计", "asset-production": "量产制作", qa: "测试", cs: "客户成功", eval: "评审" };
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
      <Section title="订阅额度" ctx={ctx}>
        <View style={s.card}>
          {(r?.usage ?? []).map(u => {
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
          {(r?.usage.length ?? 0) === 0 && <Text style={s.muted}>暂无额度数据。</Text>}
        </View>
      </Section>
      <Section title="订阅健康度" ctx={ctx}>
        <View style={s.card}>
          {(r?.health.length ?? 0) === 0 && <Text style={s.muted}>各订阅正常。</Text>}
          {r?.health.map(h => (
            <Text key={h.provider} style={s.text}>{h.provider}：{h.state}{h.lastError ? `（${h.lastError.slice(0, 80)}）` : ""}</Text>
          ))}
        </View>
      </Section>
      <Section title={editDef ? `编辑 ${editDef.id}` : "注册员工"} ctx={ctx}>
        <RegisterDefCard key={editDef?.id ?? "new"} ctx={ctx} editing={editDef}
          onDone={() => { setEditDef(undefined); refreshAll(); }} onCancel={() => setEditDef(undefined)} />
      </Section>
      <Section title="员工编制" count={r?.defs.length} ctx={ctx}>
        <View style={s.card}>
          {(() => {
            const defs = r?.defs ?? [];
            const insts = r?.instances ?? [];
            const groups = Object.keys(ROLE_LABEL)
              .map(role => ({ role, defs: defs.filter(d => d.role === role) }))
              .concat(defs.some(d => !(d.role in ROLE_LABEL))
                ? [{ role: "", defs: defs.filter(d => !(d.role in ROLE_LABEL)) }]
                : [])
              .filter(g => g.defs.length > 0);
            return groups.map(g => (
              <View key={g.role || "other"} style={{ gap: 4 }}>
                <Text style={s.muted}>
                  {g.role ? `${ROLE_LABEL[g.role]}（${g.role}）` : "其他"} · {g.defs.length} 编制 · {g.defs.reduce((n, d) => n + insts.filter(i => i.def === d.id).length, 0)} 实例
                </Text>
                {[...g.defs].sort((a, b) => a.provider.localeCompare(b.provider) || (b.weight ?? 0) - (a.weight ?? 0)).map(d => {
                  const defInsts = insts.filter(i => i.def === d.id);
                  return (
                    <View key={d.id} style={{ gap: 2 }}>
                      <View style={s.row}>
                        <Text style={[s.text, { flex: 1 }]}>
                          {"  "}{d.provider}/{d.model}{d.resolved ? ` → ${d.resolved}` : ""}{d.thinking ? ` · ${d.thinking}` : ""} · 上限 {d.maxInstances} · 权 {d.weight}{d.enabled ? "" : " · 已停用"}
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
                          {"    "}· {i.id.split("⟨").pop()?.replace("⟩", "")} · {i.cwd?.split("/").pop() ?? "运营仓库"}{i.agentStatus ? ` · ${i.agentStatus}` : ""}
                        </Text>
                      ))}
                    </View>
                  );
                })}
              </View>
            ));
          })()}
        </View>
      </Section>
    </View>
  );
}

export function CompanySurface(props: PluginSurfaceProps) {
  const ctx: Ctx = { theme: props.theme, compact: props.layout.compact };
  const s = makeStyles(ctx);
  const briefRpc = useRpc(rpc.brief);
  const brief = useQuery({ queryKey: ["brief"], queryFn: () => briefRpc({}), refetchInterval: 15_000 });
  const [tab, setTab] = useState<"inbox" | "new" | "goals" | "roster">("inbox");
  const tabs = [
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
        {tab === "inbox" && <InboxTab ctx={ctx} />}
        {tab === "new" && <NewGoalTab ctx={ctx} brief={brief.data} />}
        {tab === "goals" && <GoalsTab ctx={ctx} brief={brief.data} />}
        {tab === "roster" && <RosterTab ctx={ctx} brief={brief.data} />}
      </ScrollView>
    </View>
  );
}
