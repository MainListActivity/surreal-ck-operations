import {SessionHistoryPanel,SessionHistorySurface} from "./client/session-history";
import { ModelSwitchTimeline } from './client/model-switch';
import { modelSwitchSchema } from './shared/model-switch';
import { MagpieUsageSurface, AgentUsagePanel } from "./client/usage";
import { AgentMetricsTimeline } from "./client/agent-metrics";
import { agentMetricsViewSchema } from "./shared/agent-metrics";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CompanySurface } from "./client/company";

export default function contribute(client: PluginClientContext) {
  client.addSurface("employee-history",SessionHistorySurface);
  client.addCommandCenterItem({id:"employee-history-global",title:"只读审阅员工历史（输入会话 ID）",icon:"BookOpen",context:"global",onSelect({openSurface}){openSurface("employee-history");}});
  client.addSidebarItem({id:"employee-history",title:"会话审阅",icon:"BookOpen",surface:"employee-history"});
  client.addWorkspacePanel({id:"employee-history",title:"只读审阅历史",icon:"BookOpen",context:"agent",locations:["workspace","explorer"],Component:SessionHistoryPanel});
  client.addCommandCenterItem({id:"employee-history",title:"只读审阅员工历史",icon:"BookOpen",context:"agent",onSelect({openPanel}){openPanel("employee-history",{location:"explorer"});}});
  client.addWorkspacePanel({
    id: "agent-model-metrics",
    title: "会话用量",
    icon: "Gauge",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: AgentUsagePanel,
  });
  client.addCommandCenterItem({
    id: "open-agent-model-metrics",
    title: "查看会话用量",
    icon: "Gauge",
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("agent-model-metrics", { location: "explorer" });
    },
  });
  client.addTimelineRenderer({kind: "sck-model-switch", version: 1, schema: modelSwitchSchema, Component: ModelSwitchTimeline});
  client.addTimelineRenderer({
    kind: "sck-model-metrics",
    version: 1,
    schema: agentMetricsViewSchema,
    Component: AgentMetricsTimeline,
  });
  client.addSurface("company", CompanySurface);
  client.addSurface("magpie-usage", MagpieUsageSurface);
  client.addSidebarItem({
    id: "magpie-usage",
    title: "Magpie 用量",
    icon: "Gauge",
    surface: "magpie-usage",
  });
  client.addCommandCenterItem({
    id: "open-magpie-usage",
    title: "查看 Magpie 用量",
    icon: "Gauge",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("magpie-usage");
    },
  });
  client.addSidebarItem({
    id: "company",
    title: "公司",
    icon: "Building2",
    surface: "company",
  });
  client.addCommandCenterItem({
    id: "open-company",
    title: "打开公司收件箱",
    icon: "Building2",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("company");
    },
  });
  return () => {};
}
