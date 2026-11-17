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
