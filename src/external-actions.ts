// SYS03 AC03：受控外部动作的真实出口。首个用途是取消 CI 运行。
//
// 本模块只用公司自己的、已登录的 `gh` CLI（与 pr-gate/acceptance 的读路径同一个出口，不引入新凭证、不读 private 配置），
// 并且诚实区分三种结果：
//   * 读得到运行、取消请求被 provider 接受   → confirmed，记下 provider 的账号名（只作为 external_account，绝不当作人）
//   * provider 说不存在这个运行             → refused（确定的拒绝，不是未知）
//   * 读失败或取消请求的结果无法判定         → result_unknown（调用方据此保留重试与对账路径）
// 任何"我们没有请求过"的外部状态变更由调用方的只读对账写成 unknown_actor；本模块永远不推断内部归属。
//
// QA D3（本轮）：同一个 actionKey 只发**一次**取消请求。重放不是「再发一次」，而是**只读一次运行状态**并把读到的
// 结果如实判成 confirmed / refused / result_unknown；并发请求之间用 context.claimRequest 原子占位，只有占位成功的那
// 一条会真的 POST。还没落定的 run 重放读回来是 result_unknown，等它真的 cancelled 之后再读一次才变 confirmed。
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
 * owner/name of a GitHub repository, from an SSH or HTTPS remote URL (both the scp-style "git at github.com:owner/name.git"
 * and the "https://github.com/owner/name" forms) or from a value that already is a slug. Anything else — a filesystem path,
 * a bare repo name — has no slug to compare, and the caller must treat the binding as unverified instead of guessing (QA D5).
 */
export function githubRepoSlug(value: string): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return raw;
  const matched = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw);
  return matched ? `${matched[1]}/${matched[2]}` : undefined;
}

/**
 * The company's controlled GitHub Actions exit. `run` is injectable so tests drive an isolated fake endpoint instead of
 * the network, exactly as the acceptance adapter does.
 */
export function createCompanyGithubGateway(run: GhRunner = ghCli): ExternalActionGateway {
  const target = (t: ExternalActionTarget) => `repos/${t.repo}/actions/runs/${t.runId}`;

  return {
    async cancelRun(t, context) {
      if (!t.repo || !t.runId) return { confirmed: false, error: 'a run target needs both repo and runId' };
      // A replay never posts: we already asked the provider for this actionKey, so all that is left is reading what the
      // provider says **now** (QA D3). `claimRequest` is the ledger's atomic "this call is the one that may post" slot.
      const replay = context?.replay === true;
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
        if (replay && /cancel/i.test(before.conclusion ?? '')) {
          return {
            confirmed: true, runStatus: before.status, externalAccount: before.account,
            observed: { before: before.status ?? null, after: before.status ?? null, conclusion: before.conclusion ?? null,
              account: before.account ?? before.account ?? null, replay: 'already-terminal-cancelled' },
          };
        }
        return { refused: true, reason: `run ${t.repo}#${t.runId} is already ${before.status} (${before.conclusion ?? 'no conclusion'})` };
      }
      // A replay of a request that has not settled yet. The cancel request for this actionKey did go out (that is what
      // "replay" means here) and the provider has not refused it, but the run has not reached a terminal state either — so
      // the honest answer is "unknown, read it again once it settles", never a fabricated success and never a second POST.
      if (replay) {
        return {
          confirmed: false, observed: { before: before.status ?? null, after: before.status ?? null, replay: 'not-settled-yet' },
          error: `run ${t.repo}#${t.runId} is ${before.status ?? 'still running'}: the cancel request for this action key already went out and the provider has not refused it, but the run has not settled — read it again for the confirmed result`,
        };
      }
      // The one and only POST for this actionKey. Concurrent requests under one key contend for this slot, so at most one
      // of them reaches the provider at all — and a request that loses the slot records that it did not post (QA D2).
      if (context?.claimRequest && !(await context.claimRequest())) {
        return {
          confirmed: false, observed: { before: before.status ?? null, replay: 'request-already-claimed' },
          error: `another request for the same action key already owns the cancel exit to ${t.repo}#${t.runId}; this call posted nothing`,
        };
      }
      try {
        // A cancel of an already-cancelling run is a provider-side no-op, but under one actionKey this POST happens once.
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