import type { TurnEnded } from './contracts.ts';
export interface RuntimeAgent { id: string; title?: string | null; provider?: string }
export interface ProviderUsage {
  providerId: string; status: string; planLabel?: string | null;
  windows?: Array<{ id: string; label: string; remainingPct?: number | null; resetsAt?: string | null; tone?: string }>;
  balances?: Array<{ id: string; label: string; remaining?: number | null; limit?: number | null; unit?: string; tone?: string }>;
}
/** 宿主能力适配面：Paseo SDK 和原生执行器均在此转换，不让业务导入宿主 SDK。 */
export interface RuntimeHost {
  providers: {
    listModels(provider: string): Promise<{ models?: Array<{ id: string; isSelectable?: boolean; isDefault?: boolean }> }>;
    listUsage(): Promise<{ fetchedAt?: string; providers?: ProviderUsage[] }>;
  };
  agents: { ref(id: string): {
    timeline?: { refetch(options: { direction: 'tail' | 'before'; cursor?: {epoch: string; seq: number}; limit: number; projection: 'projected' }): Promise<{
      error?: string | null; gap?: boolean; staleCursor?: boolean; epoch: string; hasOlder: boolean;
      startCursor?: {epoch: string; seq: number} | null;
      entries: Array<{ turnId?: string; seqEnd: number; item: { type: string; text?: string } }>;
    }> };
    send(prompt: string): Promise<unknown>;
    refresh(): Promise<{ agent?: { labels?: Record<string, string> } } | null>;
    respondToPermission(input: { requestId: string; response: { behavior: "allow" } }): Promise<unknown>;
  } };
}
export interface RuntimeEvents {
  'agent.turn_started': { agent: RuntimeAgent; turnId?: string | null };
  'agent.turn_ended': TurnEnded;
  'agent.archived': { agent: RuntimeAgent };
  'workspace.archived': unknown;
  'agent.permission_requested': { agent: RuntimeAgent; request: unknown };
}
export interface RuntimeEventSource {
  on<K extends keyof RuntimeEvents>(name: K, fn: (event: RuntimeEvents[K], context: { paseo: RuntimeHost }) => void | Promise<void>): () => void;
}
