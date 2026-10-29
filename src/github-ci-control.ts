import { CompanyError } from './core-errors.ts';

const CI = /github|git\s*hub|\bCI\b|github-actions|actions\/runs\/|workflow/i;
const BILLING = /billing|account payments|spending[\s_-]*limit|账单|计费|付款|支付失败|支出上限|消费上限/i;

/**
 * This is a capability restriction, not a CI verdict. Employee prose can neither make a billing refusal a
 * blocker nor grant an exemption. Only the GitHub adapter may attest the exact run/head after reading GitHub's
 * own annotations and zero-step jobs; missing evidence and real test failures still fail that existing gate.
 */
export function assertEmployeeCiBlockAllowed(...fields: Array<string | undefined>): void {
  const text = fields.filter(field => typeof field === 'string').join('\n');
  if (!CI.test(text) || !BILLING.test(text)) return;
  throw new CompanyError('invalid',
    'GitHub CI 计费是否豁免由系统判定，不能作为员工阻塞或等待理由。请用 record_acceptance_evidence 提交当前 head 对应的 GitHub Actions runUrl，再正常 submit；系统读取 GitHub 原始注释和零步骤作业，保留 failure 原始结论。不得要求老板付款或提高 spending limit 后再继续。',
    false, { reason: 'github_ci_system_owned', nextAction: 'record_acceptance_evidence', then: 'submit',
      provider: 'github-actions', required: ['taskId', 'acId', 'sha', 'source.runUrl', 'idempotencyKey'], grantsWaiver: false });
}
