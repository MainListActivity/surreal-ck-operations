// SYS03 AC03：受控外部动作的真实出口。首个用途是取消 CI 运行。
//
// 本模块只用公司自己的、已登录的 `gh` CLI（与 pr-gate/acceptance 的读路径同一个出口，不引入新凭证、不读 private 配置），
// 并且诚实区分三种结果：
//   * 读得到运行、取消请求被 provider 接受   → confirmed，记下 provider 的账号名（只作为 external_account，绝不当作人）
//   * provider 说不存在这个运行             → refused（确定的拒绝，不是未知）
//   * 读失败或取消请求的结果无法判定         → result_unknown（调用方据此保留重试与对账路径）
// 任何"我们没有请求过"的外部状态变更由调用方的只读对账写成 unknown_actor；本模块永远不推断内部归属。
import { ghCli, type GhRunner } from './pr-gate.ts';
import type { ExternalActionGateway, ExternalActionTarget } from './disposition.ts';

/** One JSON object through gh, kept small: only the fields the ledger needs are projected with --jq. */
const readRun = async (run: GhRunner, target: ExternalActionTarget): Promise<{
  status?: string; conclusion?: string; account?: string; createdAt?: string; headBranch?: string; headSha?: string;
}> => {
  const raw = await run(['api', `repos/${target.repo}/actions/runs/${target.runId}`, '--jq',
    '{status: .status, conclusion: .conclusion, account: (.triggering_actor.login // .actor.login // null), createdAt: (.created_at // null), headBranch: (.head_branch // null), headSha: (.head_sha // null)}']);
  const parsed = JSON.parse(raw) as { status?: string | null; conclusion?: string | null; account?: string | null; createdAt?: string | null; headBranch?: string | null; headSha?: string | null };
  return {
    status: parsed.status ?? undefined,
    conclusion: parsed.conclusion ?? undefined,
    account: parsed.account ?? undefined,
    createdAt: parsed.createdAt ?? undefined,
    headBranch: parsed.headBranch ?? undefined,
    headSha: parsed.headSha ?? undefined,
  };
};

/**
 * The company's controlled GitHub Actions exit. `run` is injectable so tests drive an isolated fake endpoint instead of
 * the network, exactly as the acceptance adapter does.
 */
export function createCompanyGithubGateway(run: GhRunner = ghCli): ExternalActionGateway {
  const target = (t: ExternalActionTarget) => `repos/${t.repo}/actions/runs/${t.runId}`;

  return {
    async cancelRun(t, context) {
      if (!t.repo || !t.runId) return { confirmed: false, error: 'a run target needs both repo and runId' };
      let before: Awaited<ReturnType<typeof readRun>> | undefined;
      try {
        before = await readRun(run, t);
      } catch (error) {
        // The run could not be read: a missing run is a definite refusal, unreadable is an unknown.
        const message = String((error as Error)?.message ?? error);
        if (/not found|404/i.test(message)) return { refused: true, reason: `run ${t.repo}#${t.runId} is not known to the provider: ${message}` };
        return { confirmed: false, error: `run ${t.repo}#${t.runId} could not be read: ${message}` };
      }
      // Already in a terminal state. **On a first request** that is a definite provider answer, not an unknown: there is
      // nothing to cancel. **On a replay** (we already asked for this actionKey) a terminal run whose conclusion is a
      // cancellation is the cancellation we asked for — a crash between the provider accepting and the receipt being
      // written lands here, and recording it as `refused` would deny an action that really happened (QA V5).
      if (['completed'].includes(before.status ?? '')) {
        if (context?.retryAfterRequest && /cancel/i.test(before.conclusion ?? '')) {
          return {
            confirmed: true, runStatus: before.status, externalAccount: before.account,
            observed: { before: before.status ?? null, after: before.status ?? null, conclusion: before.conclusion ?? null,
              account: before.account ?? before.account ?? null, replay: 'already-terminal-cancelled' },
          };
        }
        return { refused: true, reason: `run ${t.repo}#${t.runId} is already ${before.status} (${before.conclusion ?? 'no conclusion'})` };
      }
      try {
        // A cancel of an already-cancelling run is a provider-side no-op, so this POST is safe to retry under one actionKey.
        await run(['api', '--method', 'POST', `${target(t)}/cancel`]);
      } catch (error) {
        return { confirmed: false, error: `cancel request for ${t.repo}#${t.runId} failed: ${String((error as Error)?.message ?? error)}` };
      }
      // The provider accepted the request. Read the run back so the record carries what the provider actually says now;
      // an unreadable readback does not downgrade the accepted request to a failure.
      let after: Awaited<ReturnType<typeof readRun>> | undefined;
      try { after = await readRun(run, t); } catch { after = undefined; }
      return {
        confirmed: true,
        runStatus: after?.status ?? before.status,
        externalAccount: after?.account ?? before.account,
        observed: { before: before.status ?? null, after: after?.status ?? null, conclusion: after?.conclusion ?? null,
          account: after?.account ?? before.account ?? null },
      };
    },

    async observeRun(t) {
      if (!t.repo || !t.runId) return { readable: false, error: 'a run target needs both repo and runId' };
      try {
        const row = await readRun(run, t);
        return { readable: true, exists: true, runStatus: row.status, conclusion: row.conclusion,
          externalAccount: row.account, headBranch: row.headBranch, headSha: row.headSha, attribution: 'unknown_actor' };
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        // gh reports a missing run as an error as well; a 404 is an absent run (a real, readable fact), not an unreadable one.
        if (/not found|404/i.test(message)) return { readable: true, exists: false, attribution: 'unknown_actor' };
        return { readable: false, error: message };
      }
    },
  };
}