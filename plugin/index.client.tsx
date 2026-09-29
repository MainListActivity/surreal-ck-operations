import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CompanySurface } from "./client/company";

export default function contribute(client: PluginClientContext) {
  client.addSurface("company", CompanySurface);
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
