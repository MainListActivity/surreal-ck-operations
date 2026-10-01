import type { PaseoApi } from "@getpaseo/client";

export const COMPANY_TITLE = "SCK · ";

export async function isCompanyAgent(paseo: PaseoApi, agent: { id: string; title?: string | null }): Promise<boolean> {
  if (agent.title?.startsWith(COMPANY_TITLE)) return true;
  const detail = await paseo.agents.ref(agent.id).refresh().catch(() => undefined);
  return (detail as { agent?: { labels?: Record<string, string> } } | null | undefined)?.agent?.labels?.company === "surreal-ck";
}
