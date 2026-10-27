import type { PluginSurfaceProps, PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  usageOverview,
  usageRequests,
  usageLive,
  type UsageRequest,
  type UsageGroup,
  type UsageQuota,
} from "../shared/usage";
import { agentMetrics, metricNumber, metricSeconds } from "../shared/agent-metrics";
import { relayTheme } from "./relay-theme";

const n = (value: number | undefined) => (value === undefined ? "未知" : metricNumber(value, 0));
const speed = (value: number | undefined) =>
  value === undefined ? "未知" : `${metricNumber(value)} tok/s`;
type Props = PluginSurfaceProps;
function Action({
  label,
  onPress,
  active,
  disabled,
  theme,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  theme: Props["theme"];
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: !!disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingVertical: 7,
        paddingHorizontal: 11,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: active ? theme.colors.surface2 : theme.colors.surface1,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text style={{ fontSize: 12, color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}
function RequestRow({
  row,
  theme,
  live = false,
  compact = true,
}: {
  row: UsageRequest;
  theme: Props["theme"];
  live?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false),
    c = theme.colors;
  return (
    <View style={{ borderBottomWidth: 1, borderColor: c.border, paddingVertical: 10, gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`请求详情 ${row.model ?? "模型待确认"}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            justifyContent: "space-between",
          }}
        >
          <Text
            selectable
            style={{
              color: c.foreground,
              fontSize: 12,
              flexShrink: 1,
              flex: compact ? undefined : 1,
            }}
          >
            {row.model ?? "模型待确认"} · {row.provider ?? "供应商未知"}
          </Text>
          {!compact && (
            <>
              <Text style={{ color: c.foregroundMuted, fontSize: 11, width: 75 }}>
                {row.terminal}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 11, width: 90 }}>
                {metricSeconds(row.ttftMs)}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 11, width: 80 }}>
                {n(row.output)}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 11, width: 90 }}>
                {metricSeconds(row.totalMs)}
              </Text>
            </>
          )}
          <Text
            style={{ color: c.foregroundMuted, fontSize: 11, width: compact ? undefined : 140 }}
          >
            {live && !row.completed ? "进行中" : row.status ? `HTTP ${row.status}` : "状态未知"} ·{" "}
            {new Date(row.at).toLocaleTimeString()}
          </Text>
        </View>
      </Pressable>
      {compact && (
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
          首响应 {metricSeconds(row.ttftMs)} · 输出 {n(row.output)} ·{" "}
          {live && !row.completed
            ? `已等待 ${metricSeconds(Math.max(0, Date.now() - row.at))}`
            : `耗时 ${metricSeconds(row.totalMs)}`}
        </Text>
      )}
      {open && (
        <Text selectable style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 19 }}>
          使用终端 {row.terminal} · {row.accountLinked ? row.accountLabel : "账号未确认"}
          {"\n"}首文字 {metricSeconds(row.firstTextMs)} · 输入 {n(row.input)} · 缓存读取{" "}
          {n(row.cacheRead)} · 缓存写入 {n(row.cacheWrite)}
          {"\n"}原生生成速度 {speed(row.decodeTokensPerSecond)} · 标价折算{" "}
          {row.cost === undefined ? "未知" : `$${row.cost.toFixed(5)}`}（不等于订阅账单）
        </Text>
      )}
    </View>
  );
}
function Quotas({
  rows,
  theme,
  provider,
}: {
  rows: UsageQuota[];
  theme: Props["theme"];
  provider?: string;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(0),
    selected = provider ? rows.filter((q) => q.provider === provider) : rows;
  return (
    <View style={{ gap: 8 }}>
      <Action
        label={`订阅额度 · ${selected.length} 个账号/供应商 ${open ? "收起" : "展开"}`}
        theme={theme}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            按供应商独立展示；只有请求包含明确账号身份时才确认账号归属。额度每 60 秒刷新。
          </Text>
          {selected.slice(page * 10, page * 10 + 10).map((q) => (
            <View
              key={q.id}
              style={{
                padding: 10,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 6,
                gap: 4,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                {q.label} · {q.accountLabel ?? "未提供账号身份"}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {q.status === "error"
                  ? "额度读取失败"
                  : q.windows
                      .map(
                        (w) =>
                          `${w.label} ${w.remainingPct === undefined ? "剩余未知" : `剩余 ${w.remainingPct.toFixed(1)}%`}${w.resetsAt ? `，重置 ${new Date(w.resetsAt).toLocaleString()}` : ""}`,
                      )
                      .join(" · ") || "无额度窗口"}{" "}
                · 更新 {q.readAt ? new Date(q.readAt).toLocaleTimeString() : "未知"}
              </Text>
            </View>
          ))}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Action
              theme={theme}
              label="上一批额度"
              disabled={page === 0}
              onPress={() => setPage(page - 1)}
            />
            <Action
              theme={theme}
              label="下一批额度"
              disabled={(page + 1) * 10 >= selected.length}
              onPress={() => setPage(page + 1)}
            />
          </View>
        </>
      )}
    </View>
  );
}
function SessionUsage(props: Props & { agentId: string }) {
  const { theme, agentId } = props,
    c = theme.colors,
    read = useRpc(agentMetrics),
    liveRead = useRpc(usageLive),
    readOverview = useRpc(usageOverview);
  const metrics = useQuery({
    queryKey: ["agent-model-metrics", agentId],
    queryFn: () => read({ agentId }),
    refetchInterval: 5000,
  });
  const live = useQuery({
    queryKey: ["magpie-usage-live", agentId],
    queryFn: () => liveRead({ agentId }),
    refetchInterval: 1000,
  });
  const quota = useQuery({
    queryKey: ["magpie-usage-session-quotas"],
    queryFn: () => readOverview({ period: "today", offset: 0, limit: 1 }),
    refetchInterval: 60000,
  });
  const view = metrics.data,
    s = view?.summary,
    active = live.data?.requests.filter((r) => !r.completed) ?? [],
    last = live.data?.requests.at(-1);
  return (
    <View style={{ gap: 10, padding: 12, minWidth: 0 }}>
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
        Magpie · 当前会话用量
      </Text>
      {(metrics.isError || live.isError) && (
        <Text style={{ color: c.foregroundMuted }}>读取失败，将自动重试；已显示数据可能过期。</Text>
      )}
      {live.data && !live.data.available && (
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
          实时路由暂不可用，保留已确认数据。
        </Text>
      )}
      {active.length ? (
        active.map((row) => <RequestRow key={row.id} row={row} theme={theme} live />)
      ) : (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          暂无匹配的进行中请求{last ? "，最近请求如下。" : "；等待请求到达 Magpie。"}
        </Text>
      )}
      {!active.length && last && <RequestRow row={last} theme={theme} />}
      {!!s && (
        <Text style={{ color: c.foreground, fontSize: 12, lineHeight: 20 }}>
          本轮{view.turn?.endedAt ? "已结束" : "进行中"}
          {s.partial ? " · 部分观测" : ""} · {s.requests} 次请求 · 失败/中断 {s.failed}
          {"\n"}已计量输出 {n(s.outputTokens)} · 首响应 {metricSeconds(s.firstResponseMs)} · 首文字{" "}
          {metricSeconds(s.firstTextMs)}
          {"\n"}输出吞吐（含等待）{speed(s.tokensPerSecond)} · 原生生成速度{" "}
          {speed(s.decodeTokensPerSecond)}
        </Text>
      )}
      {view?.latest && !last && (
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
          最近实际模型 {view.latest.model ?? "未知"} · 首响应 {metricSeconds(view.latest.ttft_ms)} ·
          输出 {n(view.latest.output_tokens)}
        </Text>
      )}
      {view?.source === "company-gateway" &&
        view.latest?.completed === undefined &&
        view.latest && (
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
            当前流式观测 · 首响应 {metricSeconds(view.latest.ttft_ms)} · 首文字{" "}
            {metricSeconds(view.latest.first_text_ms)} · 已确认输出 {n(view.latest.output_tokens)} ·
            已确认输入 {n(view.latest.input_tokens)}
          </Text>
        )}
      <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
        按会话与当前租约精确匹配。实时状态每秒读取内存快照；token、首响应只显示上游已确认值。
      </Text>
      {quota.data && (
        <Quotas
          rows={quota.data.quotas}
          theme={theme}
          provider={active.at(-1)?.provider ?? last?.provider}
        />
      )}
    </View>
  );
}
function GroupList({
  title,
  rows,
  theme,
  onSelect,
}: {
  title: string;
  rows: UsageGroup[];
  theme: Props["theme"];
  onSelect: (id: string) => void;
}) {
  const [page, setPage] = useState(0);
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>
        {title}
      </Text>
      {rows.slice(page * 10, page * 10 + 10).map((r) => (
        <Pressable
          key={r.id}
          accessibilityRole="button"
          accessibilityLabel={`${title}筛选 ${r.label}`}
          onPress={() => onSelect(r.id)}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 20 }}>
            {r.label} · {n(r.requests)} 次 · 失败 {n(r.errors)} · 输出 {n(r.output)} · 首响应{" "}
            {metricSeconds(r.ttftMs)} · {speed(r.decodeTokensPerSecond)}
          </Text>
        </Pressable>
      ))}
      {rows.length > 10 && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Action
            label={`${title}上一批`}
            theme={theme}
            disabled={page === 0}
            onPress={() => setPage(page - 1)}
          />
          <Action
            label={`${title}下一批`}
            theme={theme}
            disabled={(page + 1) * 10 >= rows.length}
            onPress={() => setPage(page + 1)}
          />
        </View>
      )}
    </View>
  );
}
function GlobalUsage(props: Props) {
  const { theme } = props,
    c = theme.colors,
    [period, setPeriod] = useState<"today" | "7d" | "30d">("today"),
    [provider, setProvider] = useState<string>(),
    [model, setModel] = useState<string>(),
    [terminal, setTerminal] = useState<string>(),
    [offset, setOffset] = useState(0),
    [boundaries, setBoundaries] = useState<Record<number, string>>({}),
    [groups, setGroups] = useState(false),
    read = useRpc(usageOverview),
    readPage = useRpc(usageRequests),
    filter = {
      period,
      provider,
      model,
      terminal,
      offset,
      limit: 50,
      after: offset ? boundaries[offset] : undefined,
    };
  useEffect(() => setBoundaries({}), [period, provider, model, terminal]);
  const overview = useQuery({
    queryKey: ["magpie-usage-overview", period, provider, model, terminal],
    queryFn: () => read(filter),
    refetchInterval: 5000,
  });
  const page = useQuery({
    queryKey: ["magpie-usage-page", filter],
    queryFn: () => readPage(filter),
    refetchInterval: offset === 0 ? 5000 : false,
  });
  const data = overview.data,
    s = data?.totals;
  const select = (kind: "provider" | "model" | "terminal", id: string) => {
    if (kind === "provider") setProvider(id);
    if (kind === "model") setModel(id);
    if (kind === "terminal") setTerminal(id);
    setOffset(0);
  };
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: props.layout.compact ? 12 : 20, gap: 16 }}
    >
      <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>Magpie 用量</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        覆盖使用终端与实际供应商。汇总每 5 秒刷新，明细每页 50 条。
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(["today", "7d", "30d"] as const).map((p, i) => (
          <Action
            key={p}
            label={["今天", "近 7 天", "近 30 天"][i]!}
            active={period === p}
            theme={theme}
            onPress={() => {
              setPeriod(p);
              setOffset(0);
            }}
          />
        ))}
        <Action
          label="刷新用量"
          theme={theme}
          onPress={() => {
            void overview.refetch();
            void page.refetch();
          }}
        />
      </View>
      {(provider || model || terminal) && (
        <Action
          label={`清除筛选：${[provider, model, terminal].filter(Boolean).join(" · ")}`}
          theme={theme}
          onPress={() => {
            setProvider(undefined);
            setModel(undefined);
            setTerminal(undefined);
            setOffset(0);
          }}
        />
      )}
      {(overview.isError || page.isError) && (
        <Text style={{ color: c.foregroundMuted }}>
          读取失败；分页边界可能已过期，请点击“最新请求”或“刷新用量”重试。已有快照可能过期，不以零代替失败。
        </Text>
      )}
      {!data && !overview.isError && (
        <Text style={{ color: c.foregroundMuted }}>正在读取 Magpie…</Text>
      )}
      {data && s && (
        <>
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
            更新 {new Date(data.at).toLocaleTimeString()}
            {data.stale ? " · 汇总快照已过期" : ""}
            {data.partial ? " · 部分明细/额度暂不可用" : ""}
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 16,
              padding: 14,
              backgroundColor: c.surface1,
              borderRadius: 8,
            }}
          >
            {[
              ["请求", n(s.requests)],
              ["失败", n(s.errors)],
              ["输入", n(s.input)],
              ["输出", n(s.output)],
              ["缓存读 / 写", `${n(s.cacheRead)} / ${n(s.cacheWrite)}`],
              ["平均首响应", metricSeconds(s.ttftMs)],
              ["原生生成速度", speed(s.decodeTokensPerSecond)],
              [
                "已定价折算",
                s.cost === undefined ? "未知" : `$${s.cost.toFixed(3)} · ${s.unpriced} 次未定价`,
              ],
            ].map(([label, value]) => (
              <View key={label} style={{ minWidth: 125, gap: 4 }}>
                <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{label}</Text>
                <Text style={{ color: c.foreground, fontSize: 15 }}>{value}</Text>
              </View>
            ))}
          </View>
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
            价格为 Magpie 标价折算，不等于订阅账单；未定价请求不算免费。
          </Text>
          <View style={{ gap: 7 }}>
            <Text style={{ color: c.foreground, fontWeight: "600", fontSize: 13 }}>
              请求趋势 · 最近 {Math.min(24, data.series.length)} 个时段
            </Text>
            <View
              accessibilityLabel="请求数量趋势"
              style={{ height: 60, flexDirection: "row", alignItems: "flex-end", gap: 3 }}
            >
              {data.series.slice(-24).map((point, i) => (
                <View
                  key={`${point.at}-${i}`}
                  accessibilityLabel={`${new Date(point.at).toLocaleString()} ${point.requests}次，失败${point.errors}次`}
                  style={{
                    flex: 1,
                    height: Math.max(
                      2,
                      (point.requests /
                        Math.max(1, ...data.series.slice(-24).map((p) => p.requests))) *
                        55,
                    ),
                    backgroundColor: point.errors ? c.foregroundMuted : c.foreground,
                    borderRadius: 2,
                  }}
                />
              ))}
            </View>
          </View>
          <Action
            label={groups ? "收起供应商 / 模型 / 终端汇总" : "展开供应商 / 模型 / 终端汇总"}
            theme={theme}
            onPress={() => setGroups(!groups)}
          />
          {groups && (
            <>
              <GroupList
                title="供应商"
                rows={data.providers}
                theme={theme}
                onSelect={(id) => select("provider", id)}
              />
              <GroupList
                title="模型"
                rows={data.models}
                theme={theme}
                onSelect={(id) => select("model", id)}
              />
              <GroupList
                title="使用终端"
                rows={data.terminals}
                theme={theme}
                onSelect={(id) => select("terminal", id)}
              />
            </>
          )}
          <Quotas key={provider ?? "all"} rows={data.quotas} theme={theme} provider={provider} />
        </>
      )}
      <Text style={{ color: c.foreground, fontWeight: "600", fontSize: 14 }}>
        请求明细 · {page.data?.total ?? "未知"} 条
      </Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
        点击每条请求展开账号、token、价格与时延。浏览后续页时暂停自动刷新，返回首屏可查看最新记录。
      </Text>
      {page.data?.stale && <Text style={{ color: c.foregroundMuted }}>明细快照已过期</Text>}
      {!props.layout.compact && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {[
            ["实际模型 · 供应商", undefined],
            ["终端", 75],
            ["首响应", 90],
            ["输出", 80],
            ["耗时", 90],
            ["状态 · 时间", 140],
          ].map(([label, width]) => (
            <Text
              key={label}
              style={{
                color: c.foregroundMuted,
                fontSize: 11,
                width: typeof width === "number" ? width : undefined,
                flex: width === undefined ? 1 : undefined,
              }}
            >
              {label}
            </Text>
          ))}
        </View>
      )}
      {page.data?.rows.map((row) => (
        <RequestRow key={row.id} row={row} theme={theme} compact={props.layout.compact} />
      ))}
      {page.data?.total === 0 && (
        <Text style={{ color: c.foregroundMuted }}>当前筛选没有请求。</Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action label="最新请求" theme={theme} disabled={!offset} onPress={() => setOffset(0)} />
        <Action
          label="上一页"
          theme={theme}
          disabled={offset === 0 || page.isFetching}
          onPress={() => setOffset(Math.max(0, offset - 50))}
        />
        <Text style={{ color: c.foregroundMuted, fontSize: 12, alignSelf: "center" }}>
          第 {Math.floor(offset / 50) + 1} 页
        </Text>
        <Action
          label="下一页"
          theme={theme}
          disabled={!page.data || !page.data.hasMore || page.isFetching}
          onPress={() => {
            const last = page.data?.rows.at(-1);
            if (!last) return;
            setBoundaries((current) => ({ ...current, [offset + 50]: last.id }));
            setOffset(offset + 50);
          }}
        />
      </View>
    </ScrollView>
  );
}
export function MagpieUsageSurface(props: PluginSurfaceProps) {
  return <GlobalUsage {...props} theme={relayTheme(props.theme)} />;
}

export function AgentUsagePanel(props: PluginAgentPanelProps) {
  const theme = relayTheme(props.theme);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <SessionUsage {...props} theme={theme} />
    </ScrollView>
  );
}
