import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as rpc from "../shared/rpc";
import type { Brief, GoalTier, GoalView, Inbox, PermissionRequest, Roster, TaskView } from "../shared/types";

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
      <Text style={s.muted} numberOfLines={12}>{body}</Text>
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
            <Text style={s.text}>{n.text}</Text>
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
              <Text style={s.muted} numberOfLines={6}>{g.brief}</Text>
              {(tasksQuery.data?.tasks ?? []).map(t => (
                <View key={t.id}>
                  <TaskRow task={t} ctx={ctx} depth={0} onOpen={id => setOpenTask(openTask === id ? undefined : id)} />
                  {openTask === t.id && detailQuery.data && (
                    <View style={[s.card, { marginLeft: 14, backgroundColor: ctx.theme.colors.surface2 }]}>
                      <Text style={s.muted}>{detailQuery.data.task.context.slice(0, 800)}</Text>
                      {detailQuery.data.audit.map((a, i) => (
                        <Text key={i} style={s.mono} numberOfLines={4}>
                          {a.at.slice(5, 16)} {a.action} · {a.actor}{a.evidence ? ` — ${a.evidence.slice(0, 160)}` : ""}
                        </Text>
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

function RosterTab({ ctx, brief }: { ctx: Ctx; brief?: Brief }) {
  const s = makeStyles(ctx);
  const queryClient = useQueryClient();
  const rosterRpc = useRpc(rpc.roster);
  const permsRpc = useRpc(rpc.pendingPermissions);
  const answer = useRpc(rpc.answerPermission);
  const pause = useRpc(rpc.setPaused);
  const [pausePending, setPausePending] = useState(false);
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
            <Text style={s.muted} numberOfLines={6}>{p.request.summary ?? p.request.kind ?? p.request.id}{p.request.detail ? `\n${p.request.detail}` : ""}</Text>
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
      <Section title="员工编制" ctx={ctx}>
        <View style={s.card}>
          {r?.defs.map(d => {
            const insts = r.instances.filter(i => i.def === d.id);
            return (
              <View key={d.id} style={{ gap: 2 }}>
                <Text style={s.text}>
                  {d.id} · {d.provider}/{d.model} · 上限 {d.maxInstances}{d.enabled ? "" : " · 已停用"}
                </Text>
                {insts.map(i => (
                  <Text key={i.id} style={s.muted}>
                    {"  "}· {i.id.split("⟨").pop()?.replace("⟩", "")} · {i.cwd?.split("/").pop() ?? "运营仓库"}{i.agentStatus ? ` · ${i.agentStatus}` : ""}
                  </Text>
                ))}
              </View>
            );
          })}
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
