import { MagpieUsageSurface } from "./usage";
import { SessionHistorySurface } from "./session-history";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import * as RN from "react-native";
import * as rpc from "../shared/rpc";
import type { RunnerStatus } from "../shared/runner-status";
import { relayPalette } from "./relay-theme";
import { fs, radius, sp } from "../shared/relay-tokens.ts";
import { openInNewWindow } from "./web";

type NavApi = NonNullable<PluginSurfaceProps["navigation"]>;

/** 在当前设备上打开链接：宿主内嵌浏览器 → Linking → 网页端新窗口（./web）；都不行则由 remote(daemon 机器)兜底。 */
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
  if (openInNewWindow(url)) return "local";
  await remote({ url });
  return "remote";
}

const formatTime = (iso: string | undefined): string | undefined => {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { hour12: false });
};

const MODE_LABEL: Record<RunnerStatus["mode"], string> = { token: "云端令牌", root: "本机" };

function Row({ label, value, muted, ctx }: { label: string; value: React.ReactNode; muted?: boolean; ctx: Ctx }) {
  const { palette } = ctx;
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: sp(12), paddingVertical: sp(6) }}>
      <Text style={{ color: palette.core.foregroundMuted, fontSize: fs(12) }}>{label}</Text>
      <View style={{ flexShrink: 1, alignItems: "flex-end" }}>
        {typeof value === "string" || typeof value === "number"
          ? <Text style={{ color: muted ? palette.core.foregroundMuted : palette.core.foreground, fontSize: fs(13), fontWeight: "600" }}>{value}</Text>
          : value}
      </View>
    </View>
  );
}

type Ctx = { theme: PluginSurfaceProps["theme"]; compact: boolean; palette: ReturnType<typeof relayPalette>; navigation?: NavApi };

/** 执行端状态面板：连接、数据库访问方式、心跳、作业与在岗员工，并提供打开老板端的链接。 */
function RunnerStatusPanel({ ctx }: { ctx: Ctx }) {
  const statusRpc = useRpc(rpc.runnerStatus);
  const openRpc = useRpc(rpc.openExternal);
  const status = useQuery({ queryKey: ["runner-status"], queryFn: () => statusRpc({}), refetchInterval: 15_000 });
  const data = status.data;
  const { palette } = ctx;
  const card = {
    backgroundColor: palette.core.surface1,
    borderRadius: radius(13),
    borderWidth: sp(1),
    borderColor: palette.core.border,
    padding: ctx.compact ? sp(14) : sp(17),
    gap: sp(4),
  };
  return (
    <View style={{ gap: sp(12) }}>
      <View style={card}>
        <Text style={{ color: palette.core.foreground, fontSize: fs(14), fontWeight: "700" }}>执行端状态</Text>
        {status.isLoading && <Text style={{ color: palette.core.foregroundMuted, fontSize: fs(12) }}>正在读取…</Text>}
        {status.isError && (
          <Text accessibilityRole="alert" style={{ color: palette.danger, fontSize: fs(12) }}>读取失败，请重试。</Text>
        )}
        {data && (
          <View>
            <Row label="执行端连接" value={data.connected ? "已连接" : "未连接"} ctx={ctx} />
            <Row label="数据库访问方式" value={MODE_LABEL[data.mode] ?? data.mode} ctx={ctx} />
            <Row label="令牌到期时间" value={formatTime(data.tokenExpiresAt) ?? "—"} muted={!data.tokenExpiresAt} ctx={ctx} />
            <Row label="最近心跳" value={formatTime(data.lastHeartbeatAt) ?? "尚无心跳"} muted={!data.lastHeartbeatAt} ctx={ctx} />
            <Row label="执行中作业" value={data.runningJobs} ctx={ctx} />
            <Row label="在岗员工" value={data.onDutyEmployees} ctx={ctx} />
          </View>
        )}
      </View>
      <View style={card}>
        <Text style={{ color: palette.core.foreground, fontSize: fs(14), fontWeight: "700" }}>老板端</Text>
        {data?.ownerEndUrl ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="打开老板端"
            onPress={() => void openExternalAnywhere(data.ownerEndUrl!, ctx.navigation, openRpc)}
          >
            <Text style={{ color: palette.core.accent, fontSize: fs(13), fontWeight: "600" }}>打开老板端</Text>
          </Pressable>
        ) : (
          <Text style={{ color: palette.core.foregroundMuted, fontSize: fs(12) }}>未配置 OWNER_END_URL</Text>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={status.isFetching}
        onPress={() => void status.refetch()}
        style={{
          alignSelf: "flex-start",
          paddingHorizontal: sp(14),
          paddingVertical: sp(9),
          borderRadius: radius(9),
          borderWidth: sp(1),
          borderColor: palette.core.border,
          backgroundColor: palette.core.surface1,
          opacity: status.isFetching ? 0.5 : 1,
        }}
      >
        <Text style={{ color: palette.core.foreground, fontSize: fs(12), fontWeight: "600" }}>
          {status.isFetching ? "刷新中…" : "刷新"}
        </Text>
      </Pressable>
    </View>
  );
}

type CompanyTab = "status" | "usage" | "history";

/**
 * 公司入口面板：只显示执行端状态。
 * 旧的 usage / history 入口（initialTab）仍转到各自独立面板，避免既有链接失效。
 */
export function CompanySurface(props: PluginSurfaceProps & { initialTab?: CompanyTab }) {
  if (props.initialTab === "usage") return <MagpieUsageSurface {...props} />;
  if (props.initialTab === "history") return <SessionHistorySurface {...props} />;
  const ctx: Ctx = {
    theme: props.theme,
    compact: props.layout.compact,
    palette: relayPalette(props.theme),
    navigation: props.navigation,
  };
  return (
    <View style={{ flex: 1, backgroundColor: ctx.palette.core.surface0 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: ctx.compact ? sp(14) : sp(20), gap: sp(12) }}>
        <Text style={{ color: ctx.palette.core.foreground, fontSize: ctx.compact ? fs(19) : fs(23), fontWeight: "700" }}>执行端</Text>
        <RunnerStatusPanel ctx={ctx} />
      </ScrollView>
    </View>
  );
}
