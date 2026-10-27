// SYS-INT: versioned acceptance-mapping preview and authorized import for legacy gated rows.
//
// A task created before the gate was enabled (acceptance_legacy=true, criteria empty) never picks up the gate
// retroactively — that is the AC06 rule that keeps old work unblocked. The controlled way out is not a flag flip:
// gm previews the versioned criteria that would apply (old vs new, required flags, per-SYS machine source and human
// sign-off, RB01 coverage, the target task version and every conflict), then imports one registry bundle under an
// explicit digest + expectedVersion CAS with a reason and an audit row. The registry classifies honestly: the only
// machine source a bundle carries is the real CI baseline; every supplementary criterion is a human independent
// sign-off, never prose pretending to be machine-verified.
import { createHash } from 'node:crypto';
import { baselineAcceptanceCriteria, validateAcceptanceCriteria } from './acceptance.ts';
import type { AcceptanceCriterion, AcceptanceLeg } from './contracts.ts';

export const ACCEPTANCE_MAPPING_VERSION = 1;
/** The one registry bundle this version ships; import names the key so a future registry can grow without ambiguity. */
export const ACCEPTANCE_MAPPING_KEY = 'sys-int-implement';

/** Per-SYS required mapping shown by the preview: the machine source and the human sign-off each SYS leg needs, and whether RB01 rollback isolation covers it. Informational — the preview never writes. */
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
  { sys: 'SYS04', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '故障预算隔离；RB01 覆盖' },
  { sys: 'SYS05', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '等待状态机；RB01 覆盖' },
  { sys: 'SYS06', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: false, note: '有效策略执行层；policy 守卫随安装校验' },
  { sys: 'SYS07', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '目标终验图与成果契约；RB01 覆盖' },
  { sys: 'BROWSER', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: true, note: '浏览器注入故障隔离与空间清理；RB01 覆盖' },
  { sys: 'FV06', machineEvidence: 'ci-run', machineVerify: 'ci', humanVerify: 'independent-review', rb01: false, note: '供应商证据契约；实采依赖外部时钟' },
  { sys: 'DEPLOY', machineEvidence: 'ci-run', machineVerify: 'deploy-run', humanVerify: 'qa-production', rb01: true, note: '双面受控发布；生产实测为 QA 独立签署' },
];

/** AC-INT-n: the reviewable criteria of the SYS-INT mapping deliverable itself. All are human sign-offs by design: the only machine source this work has is the real CI baseline carried verbatim in the bundle. */
const intCriterion = (n: number, description: string): AcceptanceCriterion =>
  ({ id: `AC-INT-${n}`, kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'independent-review', risk: 'code', description });

export const INT_CRITERIA: readonly AcceptanceCriterion[] = [
  intCriterion(1, '映射预览只读零写：列旧新 criteria、required、RB01 覆盖、目标任务版本与冲突'),
  intCriterion(2, '授权导入仅 gm：显式 digest/expectedVersion CAS、幂等键、理由与审计'),
  intCriterion(3, '拒绝陈旧映射、降级或删除 required 基线、越权、done/void 历史改写与活动租约'),
  intCriterion(4, '同源覆盖：MCP/sck 与 submit/review/Jev/owner 走同一评估器与同一证据'),
  intCriterion(5, '机器源与人工签核分类真实：仅真实 CI/探针计 machine，叙述文字不伪装 verified'),
  intCriterion(6, '真实公司 fork 回归：CAS 并发、伪造/旧 head/report.md 绕过、Jev 越权签人工均拒绝，合法补证通过'),
  intCriterion(7, 'RB01 旧版兼容演练使用真实上一版固定 release，不用 SYS07 前的非隔离基线'),
  intCriterion(8, '迁移只新增兼容；导入不改写既有验收结论，历史 done/void 不回填'),
];

export interface AcceptanceMappingBundle {
  key: string;
  leg: AcceptanceLeg;
  version: number;
  description: string;
  criteria: AcceptanceCriterion[];
}

const bundle = (key: string, leg: AcceptanceLeg, description: string, criteria: AcceptanceCriterion[]): AcceptanceMappingBundle =>
  ({ key, leg, version: ACCEPTANCE_MAPPING_VERSION, description, criteria: validateAcceptanceCriteria(criteria) });

export const ACCEPTANCE_MAPPING_BUNDLES: readonly AcceptanceMappingBundle[] = [
  bundle('sys-int-implement', 'implement',
    'SYS-INT 实现腿：服务器基线原样保留（机器源=真实 CI），另加 INT-1..8 人工独立复核项',
    [...baselineAcceptanceCriteria('implement'), ...INT_CRITERIA]),
];

export const mappingBundle = (key: string): AcceptanceMappingBundle | undefined =>
  ACCEPTANCE_MAPPING_BUNDLES.find(candidate => candidate.key === key);

/** The digest a preview shows and an import must echo; a registry change invalidates every outstanding preview. */
export const mappingDigest = (candidate: AcceptanceMappingBundle): string =>
  createHash('sha256').update(JSON.stringify({ key: candidate.key, version: candidate.version, criteria: candidate.criteria })).digest('hex');
