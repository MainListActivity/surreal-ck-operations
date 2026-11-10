import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from '../core-errors.ts';

export const REQUIREMENT_STATES = ['draft', 'pending', 'queued', 'implementing', 'release_pending', 'released', 'paused', 'rejected', 'merged'] as const;
export type RequirementState = typeof REQUIREMENT_STATES[number];
export interface RequirementContent {
  project: string;
  title: string;
  problem: string;
  acceptance: string;
  priority: number;
}
export interface Requirement extends RequirementContent {
  id: string;
  revision: number;
  state: RequirementState;
  approved_revision?: number;
  root_task?: string;
  planning_error?: string;
  execution_error?: string;
  created_at: string;
  updated_at: string;
}
export interface ProductPolicy {
  enabled: boolean;
  feedbackOrigins: string[];
  autoRelease: boolean;
  releaseInstructions: string;
  verifyInstructions: string;
  rollbackInstructions: string;
}
export interface Approval {
  requirement: string;
  revision: number;
  actor: string;
  content: RequirementContent;
  policy: ProductPolicy;
}
const idOf = (value: unknown): string => value instanceof RecordId ? String(value.id) : String(value);
function text(value: unknown, field: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new CompanyError('invalid', `${field} 内容无效或超出长度限制`);
  return value.trim();
}
export function requirementContent(input: Record<string, unknown>): RequirementContent {
  const project = text(input.project, '产品', 80);
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(project)) throw new CompanyError('invalid', '产品标识无效');
  const priority = input.priority ?? 2;
  if (!Number.isInteger(priority) || Number(priority) < 0 || Number(priority) > 3) throw new CompanyError('invalid', '优先级须为 0–3');
  return { project, title: text(input.title, '标题', 200), problem: text(input.problem, '问题描述', 6000),
    acceptance: text(input.acceptance ?? '', '验收标准', 3000, true), priority: Number(priority) };
}
export function productPolicy(input: Record<string, unknown>): ProductPolicy {
  if (typeof input.enabled !== 'boolean' || typeof input.autoRelease !== 'boolean') throw new CompanyError('invalid', '产品启用与自动发布必须明确设置');
  if (!Array.isArray(input.feedbackOrigins) || input.feedbackOrigins.length > 20) throw new CompanyError('invalid', '反馈来源须为最多 20 个 HTTPS 站点');
  const origins = input.feedbackOrigins.map(value => {
    const raw = text(value, '反馈来源', 300);
    let url: URL;
    try { url = new URL(raw); } catch { throw new CompanyError('invalid', '反馈来源 URL 无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== raw) throw new CompanyError('invalid', '反馈来源须为完整 HTTPS origin，不含路径或凭证');
    return raw;
  });
  const policy = { enabled: input.enabled, autoRelease: input.autoRelease, feedbackOrigins: [...new Set(origins)],
    releaseInstructions: text(input.releaseInstructions ?? '', '发布说明', 2000, true),
    verifyInstructions: text(input.verifyInstructions ?? '', '验证说明', 2000, true),
    rollbackInstructions: text(input.rollbackInstructions ?? '', '回退说明', 2000, true) };
  if (policy.autoRelease && (!policy.releaseInstructions || !policy.verifyInstructions || !policy.rollbackInstructions)) {
    throw new CompanyError('invalid', '自动发布必须配置发布、验证及回退说明');
  }
  return policy;
}
function revisionOf(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new CompanyError('invalid', '需求修订号无效');
  return Number(value);
}
const requirementOf = (row: Record<string, any>): Requirement => ({ ...row, id: idOf(row.id) } as Requirement);

/** 云端需求账本。确认时事务固化内容，后续执行只读确认快照，不读取可变草稿来代替授权。 */
export class Requirements {
  constructor(private readonly db: Surreal) {}
  async configure(project: string, input: Record<string, unknown>, actor: string): Promise<ProductPolicy> {
    await this.project(project);
    const policy = productPolicy(input);
    await this.db.query('UPSERT $id CONTENT { project: $project, enabled: $enabled, policy: $policy, actor: $actor, updated_at: time::now() };',
      { id: new RecordId('product_iteration', project), project, enabled:policy.enabled, policy: JSON.stringify(policy), actor });
    return policy;
  }
  async policy(project: string): Promise<ProductPolicy | undefined> {
    const [rows] = await this.db.query<[Array<{ policy: string }>]>( 'SELECT policy FROM $id;', { id: new RecordId('product_iteration', project) });
    return rows[0] ? productPolicy(JSON.parse(rows[0].policy)) : undefined;
  }
  private async project(project: string): Promise<void> {
    const [rows] = await this.db.query<[unknown[]]>('SELECT id FROM $id;', { id: new RecordId('project', project) });
    if (!rows.length) throw new CompanyError('not_found', '请先登记产品项目');
  }
  async create(input: Record<string, unknown>, actor: string, id = crypto.randomUUID()): Promise<Requirement> {
    const content = requirementContent(input);
    await this.project(content.project);
    const [rows] = await this.db.query<[Record<string, any>[]]>(
      'CREATE $id CONTENT { project: $content.project, title: $content.title, problem: $content.problem, acceptance: $content.acceptance, priority: $content.priority, revision: 1, state: "pending", actor: $actor, created_at: time::now(), updated_at: time::now() } RETURN AFTER;',
      { id: new RecordId('product_requirement', id), content, actor });
    return requirementOf(rows[0]!);
  }
  async get(id: string): Promise<Requirement> {
    const [rows] = await this.db.query<[Record<string, any>[]]>('SELECT * FROM $id;', { id: new RecordId('product_requirement', id) });
    if (!rows[0]) throw new CompanyError('not_found', '需求不存在');
    return requirementOf(rows[0]);
  }
  async list(project?: string, offset = 0): Promise<Requirement[]> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new CompanyError('invalid', '分页偏移无效');
    const [rows] = await this.db.query<[Record<string, any>[]]>(
      'SELECT * FROM product_requirement WHERE $project = NONE OR project = $project ORDER BY updated_at DESC, id LIMIT 100 START $offset;', { project, offset });
    return rows.map(requirementOf);
  }
  async edit(id: string, revision: number, input: Record<string, unknown>, actor: string): Promise<Requirement> {
    const old = await this.get(id);
    const content = requirementContent({ ...old, ...input, project: old.project });
    const [rows] = await this.db.query<[Record<string, any>[]]>(
      `UPDATE $id MERGE { project: $content.project, title: $content.title, problem: $content.problem, acceptance: $content.acceptance, priority: $content.priority, revision: $next, actor: $actor, state: 'pending', updated_at: time::now() }
       WHERE revision = $revision AND state IN ['draft', 'pending', 'rejected'] RETURN AFTER;`,
      { id: new RecordId('product_requirement', id), revision: revisionOf(revision), next: revision + 1, content, actor });
    if (!rows.length) throw new CompanyError('conflict', '需求已被修改或已经开工，请刷新后操作');
    return requirementOf(rows[0]!);
  }
  async control(id: string, revision: number, action: string, actor: string): Promise<Requirement> {
    revisionOf(revision);
    const allowed = ['pause','resume','reject','retry'];
    if (!allowed.includes(action)) throw new CompanyError('invalid', '未知需求操作');
    const ref = new RecordId('product_requirement', id);
    let rows: Record<string, any>[];
    if (action === 'pause') [rows] = await this.db.query<[Record<string, any>[]]>(
      "UPDATE $id SET paused_from=state, state='paused', actor=$actor, updated_at=time::now() WHERE revision=$revision AND state IN ['queued','implementing','release_pending'] AND (execution_busy != true OR execution_until < $now) RETURN AFTER;", {id:ref,revision,actor,now:Date.now()});
    else if (action === 'resume') [rows] = await this.db.query<[Record<string, any>[]]>(
      "UPDATE $id SET state=paused_from, execution_until=NONE, actor=$actor, updated_at=time::now() WHERE revision=$revision AND state='paused' AND paused_from IN ['queued','implementing','release_pending'] RETURN AFTER;", {id:ref,revision,actor});
    else if (action === 'reject') [rows] = await this.db.query<[Record<string, any>[]]>(
      "UPDATE $id SET state='rejected', actor=$actor, updated_at=time::now() WHERE revision=$revision AND state IN ['draft','pending'] RETURN AFTER;", {id:ref,revision,actor});
    else [rows] = await this.db.query<[Record<string, any>[]]>(
      "UPDATE $id SET planning_attempts=0, planning_until=NONE, planning_error=NONE, planning_diagnostic=NONE, actor=$actor, updated_at=time::now() WHERE revision=$revision AND state='queued' AND (planning_until=NONE OR planning_until < $now) RETURN AFTER;", {id:ref,revision,actor,now:Date.now()});
    if (!rows.length) throw new CompanyError('conflict', '需求状态或修订已变更，请刷新后操作');
    return requirementOf(rows[0]!);
  }
  async approveRelease(id: string, revision: number, actor: string, expectedPolicy?: Record<string,unknown>): Promise<void> {
    revisionOf(revision);
    const req = await this.get(id);
    if (req.revision !== revision || req.state !== 'release_pending') throw new CompanyError('conflict','需求尚未到待发布状态');
    const policy = await this.policy(req.project);
    if (expectedPolicy && JSON.stringify(productPolicy(expectedPolicy)) !== JSON.stringify(policy)) throw new CompanyError('conflict','产品策略已变更，请刷新并重新确认');
    if (!policy?.enabled || !policy.releaseInstructions || !policy.verifyInstructions || !policy.rollbackInstructions) throw new CompanyError('not_configured','请先配置发布、生产验证及回退流程');
    const ref = new RecordId('requirement_release_approval', `${id}:${revision}`);
    await this.db.query(`BEGIN TRANSACTION;
      LET $policyRow=SELECT * FROM ONLY $policyId;
      IF $policyRow.policy!=$policy { THROW 'product_policy_changed'; };
      LET $req=SELECT * FROM ONLY $reqId;
      IF $req.revision!=$revision OR $req.state!='release_pending' { THROW 'release_approval_conflict'; };
      IF !record::exists($approval) { THROW 'missing_owner_approval'; };
      IF !record::exists($id) { CREATE $id CONTENT { requirement:$requirement, revision:$revision, policy:$policy, actor:$actor, created_at:time::now() }; };
      COMMIT TRANSACTION;`, {id:ref,reqId:new RecordId('product_requirement',id),approval:new RecordId('requirement_approval',`${id}:${revision}`),requirement:id,revision,policy:JSON.stringify(policy),policyId:new RecordId('product_iteration',req.project),actor}).retry();
  }
  async approve(id: string, revision: number, actor: string, expectedPolicy?: Record<string,unknown>): Promise<Approval> {
    revisionOf(revision);
    const ref = new RecordId('requirement_approval', `${id}:${revision}`);
    const [existing] = await this.db.query<[Array<{ snapshot: string }>]>('SELECT snapshot FROM $id;', { id: ref });
    if (existing[0]) return JSON.parse(existing[0].snapshot) as Approval;
    const req = await this.get(id);
    if (req.revision !== revision) throw new CompanyError('conflict', '需求已被修改，请刷新后重新确认');
    const policy = await this.policy(req.project);
    if (expectedPolicy && JSON.stringify(productPolicy(expectedPolicy)) !== JSON.stringify(policy)) throw new CompanyError('conflict','产品策略已变更，请刷新并重新确认');
    if (!policy?.enabled) throw new CompanyError('not_configured', '请先启用该产品的迭代配置');
    if (!req.acceptance.trim()) throw new CompanyError('invalid', '开工前请补充验收标准');
    // 审批和待规划状态原子提交；重复点击同一修订返回同一快照。
    await this.db.query(`BEGIN TRANSACTION;
      LET $policyRow=SELECT * FROM ONLY $policyId;
      IF $policyRow.policy!=$policy { THROW 'product_policy_changed'; };
      LET $existing = SELECT * FROM $approval;
      IF array::len($existing) = 0 {
        LET $changed = UPDATE $id SET state = 'queued', approved_revision = $revision, updated_at = time::now()
          WHERE revision = $revision AND state IN ['draft', 'pending'] RETURN AFTER;
        IF array::len($changed) != 1 { THROW 'requirement_revision_conflict'; };
        CREATE $approval CONTENT { requirement: $requirement, revision: $revision, actor: $actor,
          snapshot: $snapshot, created_at: time::now() };
      };
      COMMIT TRANSACTION;`, {
      id: new RecordId('product_requirement', id), approval: ref, revision, requirement: id, actor, policyId:new RecordId('product_iteration',req.project), policy:JSON.stringify(policy),
      snapshot: JSON.stringify({ requirement: id, revision, actor, content: requirementContent(req as unknown as Record<string, unknown>), policy }),
    }).retry().catch(async error => {
      // fork 会把事务冲突包装为通用错误；先核对是否另一窗口已完成同一确认。
      const [committed] = await this.db.query<[Array<{snapshot:string}>]>('SELECT snapshot FROM $id;',{id:ref});
      if (committed[0]) return;
      const current = await this.get(id);
      if (current.revision !== revision || !['draft','pending'].includes(current.state)) throw new CompanyError('conflict','需求状态或修订已变更，请刷新后重新确认');
      if (JSON.stringify(await this.policy(req.project)) !== JSON.stringify(policy)) throw new CompanyError('conflict','产品策略已变更，请刷新并重新确认');
      throw error;
    });
    const [rows] = await this.db.query<[Array<{ snapshot: string }>]>( 'SELECT snapshot FROM $id;', { id: ref });
    return JSON.parse(rows[0]!.snapshot) as Approval;
  }
}
