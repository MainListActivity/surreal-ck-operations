// Synthetic phrasings for the CI billing boundary, written for this suite. No production report, private journal or
// customer text is copied here.

// A current CI billing state written with citation wording or with no punctuation. Each one is a CI cause that must
// enter trusted-source verification and refuse; the citation words never exempt it.
export const citationWordBypassBlockers = [
  '已核对计费页GitHub CI未付款逾期',
  '引文核对GitHub CI未付款逾期，需老板处理',
  '引文核对GitHub CI账单页未付款逾期',
  '核对计费说明GitHub CI未付款问题',
  'GitHub CI 仅作付款卡住旁证',
  '已核对计费页GitHub CI未付款卡住了问题',
];

// Gaps closed by the same boundary: a sentence break between CI and payment, a completed CI joined to a current
// billing wait by a conjunction, and GitHub Actions minute quota.
export const existingGapBlockers = [
  'GitHub CI 未启动。原因：账户付款失败，需老板处理',
  'GitHub CI 已完成，但 CI 等待老板付款',
  'GitHub Actions 免费分钟用尽，需老板购买分钟',
  'GitHub CI 已完成。账户付款卡住，需老板付款。',
];

// A customer invoice beside a completed CI is an unrelated business wait, not a CI cause.
export const customerBillingWaits = [
  'GitHub CI 已完成，客户付款卡住，等待老板处理',
  'GitHub CI 已通过，客户账单需老板付款',
];

// Reported false refusals, rebuilt as synthetic sentences: a descriptive billing sentence that follows a pure citation or
// a CI version sentence. Each one describes a source; none states a current CI payment state.
export const descriptiveBillingAllowed = [
  '本轮重新抓取计费页 billing/self-serve.md、CLI 模型页和 GitHub release 页，引文与报告一致。计费页写明按量计费。',
  '核对 GitHub 上的版本为 1.0。计费页写明按量计费。',
  '核对 GitHub 上的版本为 1.0，计费文档写明按量计费。',
  '核对版本为 1.0。计费文档写明按量计费。',
  'GitHub CI 已完成。引文核对。计费页写明按量计费。',
];

// The reported research shape, rebuilt from synthetic sentences: the descriptive billing sentence sits in the same
// report as a pure citation that names GitHub, so the whole report must not supply CI context to it.
export const reportShapedDescriptiveBilling = [
  '工作结果：受阻',
  '研究资料已核对，当前缺口是内部元数据处置尚未确认，需老板确认处置范围后继续。',
  '本轮重新抓取计费页 billing/self-serve.md、CLI 模型页和 GitHub release 页，引文与报告一致。',
  '计费页写明按量计费，计费文档和 GitHub 仅作为研究旁证，未对任何 CI 作出豁免或成功判定。',
].join('\n');

// Citation links and literature references are side evidence. They pass even when the link carries a billing path.
export const citationLinksAllowed = [
  '旁证：https://docs.github.com/en/billing/managing-billing-for-github-actions',
  'https://docs.github.com/en/billing/managing-billing-for-github-actions',
  '参考文献：GitHub Actions 计费说明（https://docs.github.com/billing）',
  '文献引用：GitHub billing 指南',
];

// A disclaimer or citation marker beside a payment state never removes that state: the state stays a claim.
export const disclaimerKeepsStateBlockers = [
  'GitHub 引文与报告一致，未发现失败，账户付款卡住，需老板付款',
  'GitHub 引文与报告一致，但账单未付',
  '未对任何 CI 作出豁免，账单未付',
  'GitHub 仅作旁证，未发现问题，额度耗尽需老板处理',
];

// A descriptive pricing phrase cannot hide a payment state, whether the state shares its sentence or sits beside CI.
export const descriptiveHidesStateBlockers = [
  '核对 GitHub 上的版本为 1.0。计费页写明按量计费，额度耗尽。',
  'GitHub CI 已完成。计费页写明按量计费，账户付款失败。',
  '核对 GitHub 上的版本为 1.0。按量计费账户付款卡住。',
];

// Customer billing positives: a customer's invoice beside a completed CI, including the continuation clause that names no
// subject of its own. They are business waits and must reach the owner without reading CI sources.
export const customerBillingPositives = [
  'GitHub CI 已完成，客户账单未付，需老板付款。',
  'GitHub PR 已完成；客户账单未付，需老板付款，未申请任何 CI 豁免。',
];

// A continuation of a customer's invoice never carries a CI payment state. An account, a cited document, or a CI cause
// in the same sentence keeps the following payment state attached to CI.
export const customerContinuationBlockers = [
  'GitHub CI 已完成。客户账单未付，账户付款卡住，需老板付款。',
  'GitHub CI 已完成，客户账单未付，计费页写明账户付款失败。',
  'GitHub CI 未启动，客户账单未付，付款卡住。',
];

// A payment state written straight after a citation link, with no space or punctuation. The link ends where its ASCII
// URL syntax ends, so the state stays a claim beside the CI word.
export const urlGluedBypassBlockers = [
  '旁证：https://docs.github.com/en/billing账户付款卡住，需老板付款',
  'GitHub 引文 https://docs.github.com/en/billing未付款逾期，需老板处理',
];

// A citation sentence between a CI status and a payment state frames the claim, it never breaks it. Full-width letters
// spell the same CI word, so no spelling hides it. Each one is a CI cause that must refuse.
export const citationSentenceBreakBlockers = [
  'GitHub CI 已完成。引文核对。账户付款卡住，需老板付款。',
  'GitHub CI 已完成。核对计费页。账户付款卡住',
  'GitHub CI 已完成；引文与报告一致；账户付款卡住',
  'ＣＩ 账户付款卡住，需老板付款',
  'ＧｉｔＨｕｂ Ａｃｔｉｏｎｓ 账户付款卡住，需老板付款',
];

// A zero-width character inside a CI word is invisible to a reader, so it cannot split the word for the check either.
export const invisibleSpellingBlockers = [
  'Git\u200bHub 账户付款卡住，需老板付款',
  '工作\u200b流 账户付款卡住，需老板付款',
];

// A blank line, stray punctuation or a bare link between a CI status and a payment state states nothing, so it cannot
// separate them. Each one is a CI cause that must refuse.
export const silentSentenceBlockers = [
  'GitHub CI 已完成。\n账户付款卡住，需老板付款',
  'GitHub CI 已完成。。账户付款卡住',
  'GitHub CI 已完成；\n\n账户付款卡住，需老板付款',
  'GitHub CI 已完成。——。账户付款卡住',
  'GitHub CI 已完成。https://docs.github.com/en/billing\n账户付款卡住，需老板付款',
  'GitHub CI 已完成。引文核对。\n账户付款卡住，需老板付款',
];

// Six no-punctuation bypasses: a citation word or a cited document glued to a current CI billing state. Each is one
// clause with a CI word, so it must enter source verification and refuse.
export const noPunctuationBypassBlockers = [
  '核对计费页GitHub CI账户付款卡住需老板付款',
  '仅作旁证GitHub Actions欠费需老板充值',
  '摘自计费文档GitHub CI余额不足需老板充值',
  '参考账单页GitHub CI免费分钟用尽需老板购买分钟',
  '节选计费说明GitHub Actions支出上限已达需老板提高上限',
  '引用计费页面GitHub CI已完成账户付款卡住需老板付款',
];
