import {UnifiedUsage} from './client/usage';
import {AgentMetricsPanel,AgentMetricsTimeline} from "./client/agent-metrics";
import {agentMetricsViewSchema} from "./shared/agent-metrics";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CompanySurface } from "./client/company";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({id:"agent-model-metrics",title:"模型实测",icon:"Gauge",context:"agent",locations:["workspace","explorer"],Component:AgentMetricsPanel});
  client.addCommandCenterItem({id:"open-agent-model-metrics",title:"查看模型实测",icon:"Gauge",context:"agent",onSelect({openPanel}){openPanel("agent-model-metrics",{location:"explorer"});}});
  client.addTimelineRenderer({kind:"sck-model-metrics",version:1,schema:agentMetricsViewSchema,Component:AgentMetricsTimeline});
  client.addSurface("company", CompanySurface);
  client.addSurface("usage", UnifiedUsage);
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
