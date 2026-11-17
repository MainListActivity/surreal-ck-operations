import { CompanyError } from './core-errors.ts';
import { createGithubActionsAdapter } from './acceptance.ts';
import { extractPrUrls, ghCli, type GhRunner } from './pr-gate.ts';
import { git } from './company-release.ts';
import { githubRepoSlug } from './external-actions.ts';

// The CI word names the GitHub or Actions run that a clause is about. As a token, CI is matched case-sensitively so a
// lowercase word run (CIbilling, ci_payment) still counts while a capitalised word (CIO, CIDS) does not.
const CI = /github|git\s*hub|\bActions\b|github-actions|actions\/runs\/|workflow|工作流/i;
const CI_TOKEN = /(?<![A-Za-z0-9])(?:CI(?![A-Z0-9])|ci(?![a-z0-9]))/;
// Billing words are read from the whole clause, citation objects included. A billing word beside a CI word is
// never an employee's block reason; only a pure citation, or a customer's invoice without a CI word, escapes.
const BILLING = /billing|account payments?|payments?|not\s+paid|spend(?:ing)?[\s_-]*limit|insufficient\s+(?:funds|balance)|unpaid|overdue|delinquent|账单|计费|付款|支付|未付|欠款|欠费|逾期|余额|充值|额度|缴费|免费分钟|购买分钟|分钟[^，,。；;]{0,4}(?:用尽|用完|用光|耗尽|不足|配额|额度)|minutes?\s*(?:quota|exhausted|used up|ran out|run out)|账户问题|支出上限|消费上限/i;
// Acts and handles that mark fetched or quoted material. They only qualify a segment for the citation
// exemption; they never by themselves remove content from the verdict.
const CITATION = /抓取|引文|引述|引用|旁证|核对|核查|摘自|摘录|节选|仅作|仅供|详见|参阅|查阅|豁免|判定|认定|结论|fetch(?:ed)?|cit(?:e|ed|ation)|quot(?:e|ed|ation)|referenc(?:e|ed)|self-serve|\.md\b|release\s*页|文档内容|页面内容|资料内容|页内容/i;
const CITATION_STRIP = new RegExp(CITATION.source, 'gi');
// Fixed disclaimers about the cited material. Each phrase is closed, so a payment or overdue state written beside
// a citation always survives the strip. Negated obstruction words are limited to failure and blocked wording about
// the material; a negated payment or overdue state (未付款逾期) is a claim and is never removed.
const CITATION_DISCLAIMER = /(?:无法|不能|不可|难以|不足以|未)作为|引文与报告一致|(?:未|不)(?:对|申请|请求|获得)?(?:任何|该|本|其)?\s*(?:CI|GitHub\s*CI|GitHub|Actions|workflow)?\s*(?:作出|申请|请求|获得)?(?:任何)?(?:豁免|判定|认定|结论)(?:或(?:成功)?(?:判定|豁免))?|仅(?:作为|作|为|供)(?:研究)?(?:旁证|参考)|(?:未|无|没有|没|不|并未|并无|未见|未发现|未曾|从未|不曾)(?:发现|见|显示|出现)?(?:任何)?(?:失败|阻塞|受阻|异常|错误|问题|故障|障碍)/gi;
// Document and source names allowed inside a citation: file paths, URLs, doc nouns and the platform names being
// cited. Bare account and payment words are absent on purpose: they carry claims. A document name that contains
// one (计费页) stands only for that document.
const OBJECTS = /https?:\/\/\S+|[\w./~@-]+\.(?:md|markdown|txt|log|json|sha256|csv|ya?ml|html?|pdf|ts|js)|支出上限说明|消费上限说明|官方文档|文档内容|页面内容|资料内容|页内容|判定依据|计费页面|计费文档|计费说明|计费页|账单文档|账单页|模型页|说明页|release\s*页|文档|页面|网页|资料|内容|说明|报告|正文|副本|出处|来源|链接|地址|官网|手册|指南|页|github-actions|github|git\s*hub|actions|workflow|devin|release|billing|self-serve|page|docs?|document|report|source|url|link|citation|quote|evidence|annotation|(?<![a-z0-9])ci(?![a-z0-9])|(?<![a-z0-9])cli(?![a-z0-9])/gi;
// Function words that carry no claim on their own; state verbs and request verbs are never filler.
const FILLER = /本轮|本次|目前|当前|现在|此前|之前|之后|随后|一致|无误|如下|如上|以上|以下|其中|确认|核实|重新|再次|等等|以及|已经|曾经|尚未|依然|仍然|进行|作出|做出|得到|获得|the|a|an|of|to|in|on|for|and|or|is|are|was|were|be|been|with|by|from|as|at|it|its|this|that|these|those|after|before|during|per|via|against|according|only|just|also|same|consistent|matches?|performed|checked|verified|reviewed|[已未无没不对向为作与和及或并将了的地得后前中内里上下间时仍尚再又也都仅只就才该本其此各某任何所有等则且而但然因由从到于把被让使按照依据随]/gi;
/** A sentence or clause is a pure citation when a citation marker is present and nothing survives the whitelist. */
const pureCitation = (text: string): boolean => {
  if (!CITATION.test(text)) return false;
  const residual = text.replace(CITATION_DISCLAIMER, '').replace(OBJECTS, '').replace(CITATION_STRIP, '').replace(FILLER, '');
  return residual.replace(/[\s\p{P}\p{S}]/gu, '').length === 0;
};
const unstarted = /(?:检查|作业).{0,30}(?:未启动|没有启动|未执行|没有执行|未通过|没有通过)/;
const COMPLETED = /已(?:由系统)?(?:完成|通过|豁免|记录|判定)|already (?:passed|completed|waived)/i;
// States that keep a CI item from being complete: stuck, exhausted, unpaid, waiting on payment, blocked.
const REVIVAL = /仍.{0,10}(?:失败|阻塞|受阻)|(?:未|没有|没|尚未)(?:通过|启动|执行|运行|解决|恢复|付|付款|支付|结清)|需[\u4e00-\u9fff]{0,6}(?:付款|支付|充值|缴费)|请[\u4e00-\u9fff]{0,6}付款|要求[\u4e00-\u9fff]{0,4}付款|卡住|耗尽|余额不足|不足|(?:已|仍)(?:逾期|欠费)|已达上限|达到上限|超出上限|超过上限|\b(?:blocked|pending|unpaid|overdue|delinquent|still failing|stuck|on\s+hold)\b/i;
// A customer's own invoice or payment wait is business, not a CI cause, when its clause names no CI.
const CUSTOMER = /客户|customer/i;
const ciWord = (text: string): boolean => CI.test(text) || CI_TOKEN.test(text) || unstarted.test(text);
/**
 * The clauses that state a current CI cause. Sentences split at newlines and 。；; clauses split at ，,：:
 * - a pure-citation sentence or clause states nothing, but its CI word still counts as the field's CI context;
 * - a clause with a CI word is a cause unless it only says CI is completed (the exemption never spans clauses);
 * - a clause without a CI word is a cause when it carries a billing or stuck state and the field names CI somewhere,
 *   so a sentence break or comma cannot split a CI payment state from its CI, while a customer's wait stays business.
 */
function ciCauseClauses(fields: Array<string | undefined>): string[] {
  return fields.filter((field): field is string => typeof field === 'string').flatMap(field => {
    const fieldHasCi = ciWord(field);
    return field.split(/[\n;；。]/).filter(sentence => !pureCitation(sentence)).flatMap(sentence =>
      sentence.split(/[,，：:]/).filter(clause => {
        if (!clause.trim() || pureCitation(clause)) return false;
        if (ciWord(clause)) {
          const completedOnly = COMPLETED.test(clause) && !BILLING.test(clause) && !REVIVAL.test(clause) && !unstarted.test(clause);
          return !completedOnly;
        }
        return fieldHasCi && !CUSTOMER.test(clause) && (BILLING.test(clause) || REVIVAL.test(clause));
      }));
  });
}
/** Only the current CI cause triggers adjudication, not a completed CI item beside an unrelated business wait. */
export const isCiBlockCause = (fields: string[]): boolean => ciCauseClauses(fields).length > 0;

export interface CiBillingRefusal { runUrl: string; sha: string }
export type CiBillingCheck = (input: { text: string; head?: string; repo?: string }) => Promise<CiBillingRefusal | undefined>;

/** Resolve the task's current PR/run references, then reuse the same trusted verifier as acceptance. */
export function createCiBillingCheck(run: GhRunner = ghCli): CiBillingCheck {
  return async ({text, head, repo}) => {
    // Block/wait is an interactive RPC. Bound the entire read, not each of several GitHub calls separately.
    const deadline = Date.now() + 8_000;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('CI source read deadline');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation(), new Promise<never>((_,reject) => {
          timer = setTimeout(() => reject(Error('CI source read deadline')),remaining);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    const boundedRun: GhRunner = args => bounded(() => run(args));
    const adapter = createGithubActionsAdapter(boundedRun);
    const requiredHead = head;
    head ??= /\bhead\s*[:=]?\s+([a-f0-9]{40})\b/i.exec(text)?.[1];
    const urls = extractPrUrls(text);
    const shortPrs = [...text.matchAll(/\bPR\s*#(\d+)/gi)].map(match => match[1]!);
    if (repo && shortPrs.length) {
      try {
        const slug = githubRepoSlug(repo) ?? githubRepoSlug(await bounded(() => git(repo,['config','--get','remote.origin.url'])));
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
    const unique = [...new Map(candidates.map(candidate => [candidate.runUrl,candidate])).values()].slice(0,5);
    const verdicts = await Promise.all(unique.map(async candidate => ({candidate,
      verdict:await adapter.verify({provider:'github-actions',runUrl:candidate.runUrl,sha:candidate.sha})})));
    // A real/unknown failure alongside billing must still be repairable. Billing is never a blanket CI waiver.
    if (verdicts.some(({verdict}) => !verdict.ok)) return undefined;
    return verdicts.find(({verdict}) => verdict.ok &&
      (verdict.source.infrastructure as {reason?: string} | undefined)?.reason === 'billing')?.candidate;
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
  if (ciCauseClauses(fields).some(text => BILLING.test(text))) refuseEmployeeCiBlock();
}
