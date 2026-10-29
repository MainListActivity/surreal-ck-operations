import { CompanyError } from './core-errors.ts';
import { createGithubActionsAdapter } from './acceptance.ts';
import { extractPrUrls, ghCli, type GhRunner } from './pr-gate.ts';
import { git } from './company-release.ts';
import { githubRepoSlug } from './external-actions.ts';

const CI = /github|git\s*hub|\bCI\b|github-actions|actions\/runs\/|workflow/i;
const BILLING = /billing|account payments|spending[\s_-]*limit|账单|计费|付款|支付失败|支出上限|消费上限|账户问题/i;

export interface CiBillingRefusal { runUrl: string; sha: string }
export type CiBillingCheck = (input: { text: string; head?: string; repo?: string }) => Promise<CiBillingRefusal | undefined>;

/** Resolve the task's current PR/run references, then reuse the same trusted verifier as acceptance. */
export function createCiBillingCheck(run: GhRunner = ghCli): CiBillingCheck {
  return async ({text, head, repo}) => {
    // Block/wait is an interactive RPC. Bound the entire read, not each of several GitHub calls separately.
    const deadline = Date.now() + 8_000;
    const boundedRun: GhRunner = async args => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('CI source read deadline');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([run(args), new Promise<never>((_,reject) => {
          timer = setTimeout(() => reject(Error('CI source read deadline')),remaining);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    const adapter = createGithubActionsAdapter(boundedRun);
    const requiredHead = head;
    head ??= /\bhead\s*[:=]?\s+([a-f0-9]{40})\b/i.exec(text)?.[1];
    const urls = extractPrUrls(text);
    const shortPrs = [...text.matchAll(/\bPR\s*#(\d+)/gi)].map(match => match[1]!);
    if (repo && shortPrs.length) {
      try {
        const slug = githubRepoSlug(repo) ?? githubRepoSlug(await git(repo,['config','--get','remote.origin.url']));
        if (slug) for (const number of shortPrs) urls.push(`https://github.com/${slug}/pull/${number}`);
      } catch { /* A local path without a verified remote never supplies a guessed repository. */ }
    }
    const candidates: CiBillingRefusal[] = [];
    if (head) {
      for (const runUrl of [...new Set(text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/g) ?? [])].slice(0,5)) {
        candidates.push({runUrl,sha:head});
      }
    }
    for (const url of [...new Set(urls)].slice(0,5)) {
      try {
        const pr = JSON.parse(await boundedRun(['pr','view',url,'--json','state,headRefOid,statusCheckRollup'])) as {
          state?: string; headRefOid?: string; statusCheckRollup?: Array<{detailsUrl?: string}>;
        };
        if (!pr.headRefOid || pr.state === 'CLOSED' || (requiredHead && requiredHead !== pr.headRefOid)) continue;
        for (const check of pr.statusCheckRollup ?? []) {
          const runUrl = check.detailsUrl?.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/)?.[0];
          if (runUrl) candidates.push({runUrl,sha:pr.headRefOid});
        }
      } catch { /* Unreadable sources never become billing waivers. Acceptance stays closed. */ }
    }
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (Date.now() >= deadline || seen.size >= 5) break;
      if (seen.has(candidate.runUrl)) continue;
      seen.add(candidate.runUrl);
      const verdict = await adapter.verify({provider:'github-actions',runUrl:candidate.runUrl,sha:candidate.sha});
      if (verdict.ok && (verdict.source.infrastructure as {reason?: string} | undefined)?.reason === 'billing') return candidate;
    }
    return undefined;
  };
}

export function refuseEmployeeCiBlock(source?: CiBillingRefusal): never {
  throw new CompanyError('invalid',
    'GitHub CI 计费是否豁免由系统判定，不能作为员工阻塞或等待理由。请用 record_acceptance_evidence 提交当前 head 对应的 GitHub Actions runUrl，再正常 submit；系统读取 GitHub 原始注释和零步骤作业，保留 failure 原始结论。不得要求老板付款或提高 spending limit 后再继续。',
    false, { reason: 'github_ci_system_owned', nextAction: 'record_acceptance_evidence', then: 'submit',
      provider: 'github-actions', required: ['taskId', 'acId', 'sha', 'source.runUrl', 'idempotencyKey'], grantsWaiver: false,
      ...(source ? {source} : {}) });
}

/**
 * This is a capability restriction, not a CI verdict. Employee prose can neither make a billing refusal a
 * blocker nor grant an exemption. Only the GitHub adapter may attest the exact run/head after reading GitHub's
 * own annotations and zero-step jobs; missing evidence and real test failures still fail that existing gate.
 */
export function assertEmployeeCiBlockAllowed(...fields: Array<string | undefined>): void {
  // Background and unrelated clauses must not turn an ordinary customer invoice into a CI blocker.
  const clauses = fields.filter(field => typeof field === 'string').flatMap(field => field!.split(/[\n;；。]/));
  if (clauses.some(text => CI.test(text) && BILLING.test(text))) refuseEmployeeCiBlock();
}
