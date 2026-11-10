import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { commDir, readJsonFile, writeFileAtomic } from '../comm.ts';

const LIMIT = 3;
type Streak = { digest: string; count: number };
type State = { delivery: string; task: string; tools: Record<string, Streak> };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DENIED = new Set(['forbidden', 'invalid', 'not_configured', 'payment_approval_required', 'limit_reached']);

function refusal(value: unknown, thrown = false): string | undefined {
  if (!value || typeof value !== 'object') return;
  const r = value as { code?: string; message?: string; status?: number | string; errorCode?: string; body?: { error?: { code?: string } }; gaps?: unknown };
  if (thrown) return DENIED.has(r.code ?? '') ? digest([r.code, r.message]) : undefined;
  if ([400, 401, 402, 403, 422, 429].includes(Number(r.status))) return digest([r.status, r.errorCode ?? r.body?.error?.code ?? 'denied']);
  if (r.status === 'blocked') return digest(['blocked', r.gaps ?? null]);
}

/** Per-lease durable streaks; serialization prevents a burst from getting past the third refusal. */
export class OpsCircuit {
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(private readonly root: string) {}
  async run(input: { employee: string; task: string; delivery: string; tool: string;
    check: () => void; invoke: () => Promise<unknown>; block: (text: string) => Promise<unknown> }): Promise<unknown> {
    const previous = this.tails.get(input.employee) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.execute(input));
    this.tails.set(input.employee, pending);
    try { return await pending; }
    finally { if (this.tails.get(input.employee) === pending) this.tails.delete(input.employee); }
  }
  private async execute(input: Parameters<OpsCircuit['run']>[0]): Promise<unknown> {
    input.check();
    const path = join(commDir(this.root, input.employee), 'ops-denials.json');
    const saved = readJsonFile<State>(path);
    const state: State = saved?.delivery === input.delivery && saved.task === input.task && saved.tools && typeof saved.tools === 'object'
      ? saved : { delivery: input.delivery, task: input.task, tools: {} };
    const old = state.tools[input.tool];
    const stop = async (): Promise<never> => {
      input.check();
      await input.block(`【ops 拒绝熔断】工具 ${input.tool} 在同一任务租约下连续 ${LIMIT} 次收到相同权限/契约拒绝，已停止重试。请老板核对权限、契约或供应商能力后恢复任务。`);
      throw Object.assign(new Error('ops 拒绝熔断：任务已上报老板，停止重复调用'), { code: 'temporarily_unavailable' });
    };
    if (Number.isSafeInteger(old?.count) && old!.count >= LIMIT) return stop();
    let result: unknown, error: unknown, failed = false;
    try { result = await input.invoke(); } catch (e) { error = e; failed = true; }
    if (failed && (error as { code?: string })?.code === 'unauthorized') throw error;
    // A reply to an old lease must never count against or block a successor task.
    input.check();
    const reason = refusal(failed ? error : result, failed);
    if (reason) {
      state.tools[input.tool] = { digest: reason, count: old?.digest === reason ? Math.min(LIMIT, old.count + 1) : 1 };
      writeFileAtomic(path, JSON.stringify(state));
      if (state.tools[input.tool]!.count >= LIMIT) return stop();
    } else if (!failed && !(result && typeof result === 'object' && ('ok' in result && (result as {ok: unknown}).ok === false || 'status' in result && Number((result as {status: unknown}).status) >= 400))) {
      delete state.tools[input.tool];
      writeFileAtomic(path, JSON.stringify(state));
    }
    if (failed) throw error;
    return result;
  }
}
