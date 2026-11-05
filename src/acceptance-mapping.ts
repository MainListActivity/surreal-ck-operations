// SYS-INT: versioned acceptance-mapping preview and authorized import for legacy gated rows.
//
// A task created before the gate was enabled (acceptance_legacy=true, criteria empty) never picks up the gate
// retroactively — that is the AC06 rule that keeps old work unblocked. The controlled way out is not a flag flip:
// owner previews the versioned criteria that would apply (old vs new, required flags, per-SYS machine source and human
// sign-off, RB01 coverage, the target task version and every conflict), then imports one registry bundle under an
// explicit digest + expectedVersion CAS with a reason and an audit row.
//
// Two registries live here and they must never be confused (ce3906b5 v5):
// - `sys-int-implement` gates the mapping tool's own deliverable: server CI baseline verbatim + the tool's own
//   review items (AC-MAP-n). It says nothing about the source business.
// - `sys-int-source-qa` carries the source business QA contract for the SYS-INT goal's cross-module QA task
//   (the real INT01–INT08 meanings) as required human sign-offs plus one required item per SYS01–07 and the
//   audited per-package RB01 contract. It deliberately carries NO machine baseline of another leg: a source QA
//   task never borrows the implement-leg CI run as business evidence.
// Every bundle declares an audience (leg/executorRole/goalId); preview and import refuse a bundle whose audience
// does not match the target row, so a wrong bundle cannot be smuggled onto a mismatched source task.
import { createHash } from 'node:crypto';
import { baselineAcceptanceCriteria, validateAcceptanceCriteria } from './acceptance.ts';
import type { AcceptanceCriterion, AcceptanceLeg } from './contracts.ts';

export const ACCEPTANCE_MAPPING_VERSION = 2;
/** The mapping tool's own bundle; import names the key so a future registry can grow without ambiguity. */
export const ACCEPTANCE_MAPPING_KEY = 'sys-int-implement';
/** The source business QA bundle for the SYS-INT goal's cross-module QA task. */
export const ACCEPTANCE_MAPPING_SOURCE_KEY = 'sys-int-source-qa';
/** The SYS-INT goal every source-business bundle is bound to (its audited tasks, bind and RB01 audits are the mapping source). */
export const SYS_INT_GOAL_ID = '29e2764898591aae';

/** Per-SYS required mapping shown by the preview: the machine source and the human sign-off each SYS needs, and whether a per-package RB01 rollback-isolation regression covers it. Informational — the preview never writes. */
export interface SysRequiredMapping {
  sys: string;
  machineEvidence: 'ci-run';
  machineVerify: 'ci' | 'deploy-run';
  humanVerify: 'independent-review' | 'independent-release' | 'qa-production';
  rb01: boolean;
  note: string;
}

export const SYS_REQUIRED_MAPPING: readonly SysRequiredMapping[] = [
  { sys: 'SYS01', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: false, note: '分页聚合与 48KiB 预算；机器源=PR CI' },
  { sys: 'SYS02', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '验收门禁与机器证据；RB01 覆盖旧版兼容' },
  { sys: 'SYS03', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '处置通道真实 sck→sidecar→core 重演；RB01=disposition-rollback-isolation' },
  { sys: 'SYS04', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '故障预算隔离；RB01=fault-rollback-isolation' },
  { sys: 'SYS05', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '等待状态机；RB01 覆盖旧版兼容' },
  { sys: 'SYS06', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '有效策略执行层；RB01=rollback-isolation-policy' },
  { sys: 'SYS07', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '目标终验图与成果契约；RB01=goal-rollback-isolation' },
  { sys: 'BROWSER', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '浏览器注入故障隔离与空间清理；RB01 覆盖' },
  { sys: 'FV06', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: false, note: '供应商证据契约；实采依赖外部时钟' },
  { sys: 'DEPLOY', machineEvidence: 'ci-run', machineVerify: 'deploy-run', humanVerify: 'qa-production', rb01: true, note: '双面受控发布；生产实测为 QA 独立签署' },
];

/** The mapping tool's own review items (AC-MAP-n): what the preview/import mechanism itself must do. Not the source business. */
const toolCriterion = (n: number, description: string): AcceptanceCriterion =>
  ({ id: `AC-MAP-${n}`, kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'independent-review', risk: 'code', description });

export const TOOL_CRITERIA: readonly AcceptanceCriterion[] = [
  toolCriterion(1, '映射预览只读零写：列旧新 criteria、required、RB01 覆盖、目标任务版本与冲突'),
  toolCriterion(2, '授权导入仅 owner：显式 digest/expectedVersion CAS、幂等键、理由与审计'),
  toolCriterion(3, '拒绝陈旧映射、降级或删除 required 基线、越权、done/void 历史改写与活动租约'),
  toolCriterion(4, '同源覆盖：MCP/sck 与 submit/review/Jev/owner 走同一评估器与同一证据'),
  toolCriterion(5, '机器源与人工签核分类真实：仅真实 CI/探针计 machine，叙述文字不伪装 verified'),
  toolCriterion(6, '真实公司 fork 回归：CAS 并发、伪造/旧 head/report.md 绕过、Jev 越权签人工均拒绝，合法补证通过'),
  toolCriterion(7, 'RB01 旧版兼容演练使用真实上一版固定 release，不用 SYS07 前的非隔离基线'),
  toolCriterion(8, '迁移只新增兼容；导入不改写既有验收结论，历史 done/void 不回填'),
];

/** The source business QA items: the real INT01–INT08 meanings of the SYS-INT source task, mapped to the per-SYS deliverables they verify. Required human QA sign-offs over verifiable production evidence — never prose as machine pass, never a mechanism gate ok counted as business pass. */
const sourceCriterion = (n: number, description: string): AcceptanceCriterion =>
  ({ id: `AC-SRC-INT-${n}`, kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'qa-production', risk: 'runtime', description });

const sysCriterion = (sys: string, description: string): AcceptanceCriterion =>
  ({ id: `AC-SRC-${sys}`, kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'qa-production', risk: 'runtime', description });

export const SOURCE_CRITERIA: readonly AcceptanceCriterion[] = [
  sourceCriterion(1, 'INT01 双面受控部署与兼容回滚：active 与插件面同版本切换、SOURCE/DIRECTORY 核验、R3 repoint 恢复、RW06/SYS02/IR06/SYS06 守卫与逐包 RB01 旧版兼容【DEPLOY/SYS02】'),
  sourceCriterion(2, 'INT02 结构化 required 同源评估：MCP/sck/report.md/submit/review/Jev/owner 走同一评估器与同一证据，机器证据服务端核验【SYS02】'),
  sourceCriterion(3, 'INT03 故障预算：并发、真实 TLS 传输、403、持久预算与 episode 隔离【SYS04】'),
  sourceCriterion(4, 'INT04 等待状态机：真实回执、一次释放、到期清理与零派工窗口【SYS05】'),
  sourceCriterion(5, 'INT05 有效策略：写权、执行层强制与人工关口不被提示词绕过【SYS06】'),
  sourceCriterion(6, 'INT06 终验图：成果契约、大中文/emoji 分页在 API、网页控制台与每日简报一致呈现【SYS07】'),
  sourceCriterion(7, 'INT07 真实双入口（MCP 与 sck）或合法自动探针产物取证，不由单一入口自证【SYS02/SYS03】'),
  sourceCriterion(8, 'INT08 可复算窗口指标：分母/排除/coverage/unknown 成本可独立复算，token 与成本不互算【SYS07】'),
  sysCriterion('SYS01', 'SYS01 交付回归：查询分页/预算门禁（query-paging、response-budget 回归）在上 releases 实测'),
  sysCriterion('SYS02', 'SYS02 交付回归：验收门禁与机器证据（acceptance-gate 回归）在上 releases 实测'),
  sysCriterion('SYS03', 'SYS03 交付回归：处置通道真实重演（disposition-rehearsal）在上 releases 实测'),
  sysCriterion('SYS04', 'SYS04 交付回归：故障预算与 episode（faults/fault-budget/fault-transport）在上 releases 实测'),
  sysCriterion('SYS05', 'SYS05 交付回归：等待状态机（waits/wait-dispatch/wait-cleanup/wait-store）在上 releases 实测'),
  sysCriterion('SYS06', 'SYS06 交付回归：有效策略（effective-policy）在上 releases 实测'),
  sysCriterion('SYS07', 'SYS07 交付回归：目标终验图与治理看板（goal-governance）在上 releases 实测'),
  sysCriterion('RB01', '受审逐包 RB01 契约：每个包用真实上一版固定 release 演练零误派/零写入，oracle 假设偏离如实披露（rollback-isolation* 族）'),
];

/** Who a bundle may attach to. Preview and import both verify it; a mismatch is a refusal, not a silent fit. */
export interface AcceptanceMappingAudience {
  leg?: AcceptanceLeg;
  executorRole?: string;
  goalId?: string;
}

export const bundleAppliesTo = (
  bundle: AcceptanceMappingBundle,
  subject: { leg: AcceptanceLeg; executorRole?: string; goalId?: string },
): boolean => {
  const audience = bundle.appliesTo;
  if (!audience) return true;
  if (audience.leg !== undefined && audience.leg !== subject.leg) return false;
  if (audience.executorRole !== undefined && audience.executorRole !== subject.executorRole) return false;
  if (audience.goalId !== undefined && audience.goalId !== subject.goalId) return false;
  return true;
};

/** Traceability shown by the preview: every required item, the SYS packages it covers and the evidence class behind it. */
export interface MappingCoverageEntry {
  criteriaId: string;
  item: string;
  sys: readonly string[];
  machineSource: string;
  humanSignoff: string;
}

export interface AcceptanceMappingBundle {
  key: string;
  leg: AcceptanceLeg;
  version: number;
  description: string;
  criteria: AcceptanceCriterion[];
  appliesTo?: AcceptanceMappingAudience;
  coverage?: readonly MappingCoverageEntry[];
}

const bundle = (
  key: string, leg: AcceptanceLeg, description: string, criteria: readonly AcceptanceCriterion[],
  extra: { appliesTo?: AcceptanceMappingAudience; coverage?: readonly MappingCoverageEntry[] } = {},
): AcceptanceMappingBundle =>
  ({ key, leg, version: ACCEPTANCE_MAPPING_VERSION, description, criteria: validateAcceptanceCriteria([...criteria]), ...extra });

const toolCoverage: readonly MappingCoverageEntry[] = TOOL_CRITERIA.map(criterion => ({
  criteriaId: criterion.id, item: criterion.description ?? '', sys: ['SYS02'],
  machineSource: '仅真实 CI 基线 AC-BASE-IMPL-1（约束本工具交付自身，不代表源业务）',
  humanSignoff: 'independent-review',
}));

const SOURCE_SYS: Record<string, readonly string[]> = {
  'AC-SRC-INT-1': ['DEPLOY', 'SYS02'],
  'AC-SRC-INT-2': ['SYS02'],
  'AC-SRC-INT-3': ['SYS04'],
  'AC-SRC-INT-4': ['SYS05'],
  'AC-SRC-INT-5': ['SYS06'],
  'AC-SRC-INT-6': ['SYS07'],
  'AC-SRC-INT-7': ['SYS02', 'SYS03'],
  'AC-SRC-INT-8': ['SYS07'],
  'AC-SRC-SYS01': ['SYS01'],
  'AC-SRC-SYS02': ['SYS02'],
  'AC-SRC-SYS03': ['SYS03'],
  'AC-SRC-SYS04': ['SYS04'],
  'AC-SRC-SYS05': ['SYS05'],
  'AC-SRC-SYS06': ['SYS06'],
  'AC-SRC-SYS07': ['SYS07'],
  'AC-SRC-RB01': ['SYS01', 'SYS02', 'SYS03', 'SYS04', 'SYS05', 'SYS06', 'SYS07'],
};

const sourceCoverage: readonly MappingCoverageEntry[] = SOURCE_CRITERIA.map(criterion => ({
  criteriaId: criterion.id, item: criterion.description ?? '',
  sys: SOURCE_SYS[criterion.id] ?? [],
  machineSource: '无业务机器源：业务项由 QA 对真实生产证据独立签核；承载任务自身的服务器基线（如部署门禁）照常生效但不充当业务覆盖',
  humanSignoff: 'qa-production',
}));

export const ACCEPTANCE_MAPPING_BUNDLES: readonly AcceptanceMappingBundle[] = [
  bundle('sys-int-implement', 'implement',
    'SYS-INT 映射工具自身：服务器基线原样保留（机器源=真实 CI），另加工具机制复核项 AC-MAP-1..8；与源业务无关',
    [...baselineAcceptanceCriteria('implement'), ...TOOL_CRITERIA],
    { appliesTo: { leg: 'implement', executorRole: 'engineering' }, coverage: toolCoverage }),
  bundle('sys-int-source-qa', 'deploy',
    'SYS-INT 源业务跨模块 QA：INT01–08 业务原义 + 逐 SYS01–07 + 受审逐包 RB01，全部为对真实生产证据的 QA 独立签核；不携带任何别腿机器基线',
    SOURCE_CRITERIA,
    { appliesTo: { goalId: SYS_INT_GOAL_ID, executorRole: 'qa' }, coverage: sourceCoverage }),
];

export const mappingBundle = (key: string): AcceptanceMappingBundle | undefined =>
  ACCEPTANCE_MAPPING_BUNDLES.find(candidate => candidate.key === key);

/** The digest a preview shows and an import must echo; any registry change (criteria, version, audience) invalidates every outstanding preview. */
export const mappingDigest = (candidate: AcceptanceMappingBundle): string =>
  createHash('sha256').update(JSON.stringify({
    key: candidate.key, version: candidate.version, appliesTo: candidate.appliesTo ?? null, criteria: candidate.criteria,
  })).digest('hex');
