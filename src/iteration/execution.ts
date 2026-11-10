import { RecordId, type Surreal } from 'surrealdb';
import { defaultAcceptanceCriteria } from '../acceptance.ts';
import type { CreateTask, TaskView } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { Requirements, type Approval, type ProductPolicy } from './requirements.ts';
import { iterationPlan } from './planning.ts';

export interface Execution { id: string; tasks: string[]; stage: string; note?: string; released_sha?: string }
export interface ExecutionHost { create(input: CreateTask): Promise<Pick<TaskView, 'id'>> }
interface TaskRow { id: RecordId; state: string; acceptance_head?: string; acceptance_attempt?: number }

/** 只有核验过的生产部署证据与独立复核同时存在，才可将需求置为已上线。 */
export async function deployedSha(db: Surreal, task: TaskRow): Promise<string | undefined> {
  if (task.state !== 'done' || !task.acceptance_head) return;
  const [evidence] = await db.query<[Array<{ kind: string; verifier: string; source: { deployment?: { deploymentId?: string } } }>]>(
    `SELECT kind, verifier, source FROM acceptance_evidence WHERE task=$task AND verified=true AND sha=$sha
      AND environment='production' AND attempt=$attempt;`, { task: task.id, sha: task.acceptance_head, attempt: task.acceptance_attempt });
  return evidence.some(e => e.kind === 'machine' && e.verifier === 'github-actions' && e.source.deployment?.deploymentId)
    && evidence.some(e => e.kind === 'human' && e.verifier === 'reviewer') ? task.acceptance_head : undefined;
}

/** 由现有 runner tick 调用。任务业务键跨宿主机保持一致，崩溃后重试不重复建单。 */
export async function reconcileIterations(db: Surreal, host: ExecutionHost, now = Date.now()): Promise<{ advanced: number; failed: number }> {
  const result = { advanced: 0, failed: 0 };
  const [requirements] = await db.query<[Array<{ id: RecordId; approved_revision: number }>]>(
    `SELECT * FROM product_requirement WHERE project IN (SELECT VALUE project FROM product_iteration WHERE enabled=true) AND planned=true AND state IN ['queued','implementing','release_pending'] AND (execution_until=NONE OR execution_until < $now)
      ORDER BY updated_at LIMIT 5;`, { now });
  for (const row of requirements) {
    const requirement = String(row.id.id), revision = row.approved_revision;
    if (!Number.isInteger(revision)) continue;
    const claim = crypto.randomUUID();
    const [claimed] = await db.query<[unknown[]]>(`UPDATE $id SET execution_claim=$claim, execution_until=$until, execution_busy=true
      WHERE state IN ['queued','implementing','release_pending'] AND (execution_until=NONE OR execution_until < $now) RETURN AFTER;`,
      { id: row.id, claim, until: now + 120000, now });
    if (!claimed.length) continue;
    const executionId = new RecordId('requirement_execution', `${requirement}:${revision}`);
    try {
      const [approvals] = await db.query<[Array<{ snapshot: string }>]>(`SELECT snapshot FROM $id;`, { id: new RecordId('requirement_approval', `${requirement}:${revision}`) });
      if (!approvals[0]) throw new CompanyError('forbidden', '缺少老板确认快照');
      const approval = JSON.parse(approvals[0].snapshot) as Approval;
      if (approval.requirement !== requirement || approval.revision !== revision) throw new CompanyError('forbidden', '确认快照不匹配');
      const policy = await new Requirements(db).policy(approval.content.project);
      if (!policy?.enabled) continue;
      const [plans] = await db.query<[Array<{ body: string }>]>(`SELECT body FROM $id;`, { id: new RecordId('requirement_plan', `${requirement}:${revision}`) });
      if (!plans[0]) continue;
      const plan = iterationPlan(JSON.parse(plans[0].body));
      const [runs] = await db.query<[Array<{ tasks?: string[] }>]>(`SELECT * FROM $id;`, { id: executionId });
      const tasks = runs[0]?.tasks ?? [];
      const update = async (stage: string, state: string, note: string, sha?: string) => {
        await db.query(`BEGIN TRANSACTION;
          LET $changed=UPDATE $id SET state=$state, root_task=$root, execution_error=NONE, updated_at=time::now()
            WHERE execution_claim=$claim AND state IN ['queued','implementing','release_pending'] RETURN AFTER;
          IF array::len($changed)!=1 { THROW 'execution_claim_lost'; };
          UPSERT $execution CONTENT { requirement:$requirement, revision:$revision, tasks:$tasks, stage:$stage, note:$note,
            released_sha:$sha, updated_at:time::now() };
          COMMIT TRANSACTION;`, { id: row.id, claim, execution: executionId, requirement, revision, tasks, root: tasks[0], stage, state, note, sha }).retry();
      };
      let last: TaskRow | undefined;
      if (tasks.length) {
        const [rows] = await db.query<[TaskRow[]]>('SELECT * FROM $id;', { id: new RecordId('task', tasks.at(-1)!) });
        last = rows[0];
        if (!last) { await update('blocked', 'implementing', '关联任务已不存在，请检查任务记录'); continue; }
        if (last.state !== 'done') {
          await update(last.state === 'blocked' || last.state === 'void' ? 'blocked' : 'running', tasks.length > plan.steps.length + 1 ? 'release_pending' : 'implementing', `任务 ${tasks.at(-1)}：${last.state}`);
          continue;
        }
      }
      const deploymentIndex = plan.steps.length + 1;
      let releasePolicy: ProductPolicy = approval.policy;
      if (tasks.length === deploymentIndex) {
        if (!releasePolicy.autoRelease) {
          const [permits] = await db.query<[Array<{ policy: string }>]>(`SELECT policy FROM $id;`, { id: new RecordId('requirement_release_approval', `${requirement}:${revision}`) });
          if (!permits[0]) { await update('awaiting_release', 'release_pending', '交付已验收，等待老板确认发布'); continue; }
          releasePolicy = JSON.parse(permits[0].policy) as ProductPolicy;
        }
        if (!releasePolicy.releaseInstructions || !releasePolicy.verifyInstructions || !releasePolicy.rollbackInstructions) {
          await update('release_not_configured', 'release_pending', '请配置发布、生产验证与回退流程后确认发布'); continue;
        }
      }
      if (tasks.length === deploymentIndex + 1) {
        const sha = await deployedSha(db, last!);
        if (!sha) { await update('awaiting_evidence', 'release_pending', '发布任务缺少同一提交的生产部署证据或独立 QA 签署'); continue; }
      }
      if (tasks.length === deploymentIndex + 2) {
        const [deployment] = await db.query<[TaskRow[]]>('SELECT * FROM $id;', { id: new RecordId('task', tasks[deploymentIndex]!) });
        const sha = deployment[0] && await deployedSha(db, deployment[0]);
        if (!sha) { await update('awaiting_evidence', 'release_pending', '生产部署证据已失效，请核对'); continue; }
        await update('released', 'released', '部署证据、独立复核与上线回归均已完成', sha); result.advanced++; continue;
      }
      const index = tasks.length, content = approval.content;
      const prefix = `需求 ${requirement} 修订 ${revision}（已由老板确认）。项目 ${content.project}。\n问题：${content.problem}\n整体验收：${content.acceptance}\n`;
      let title: string, context: string, acceptance: string, executor: 'product' | 'engineering' | 'qa', reviewer: 'product' | 'qa';
      let code = false, deploy = false;
      if (index === 0) {
        title = `核对实施计划：${content.title}`;
        context = prefix + '\n核对以下任务是否覆盖验收、是否存在前置阻塞。缺少资料请报告阻塞，范围变更须交老板重新确认；不要自行创建后继任务。\n' + plan.steps.map((s, i) => `${i + 1}. ${s.title}\n${s.context}\n验收：${s.acceptance}`).join('\n');
        acceptance = '确认步骤覆盖老板验收；仓库、测试与依赖可用；未解决的阻塞不能通过。'; executor = 'product'; reviewer = 'qa';
      } else if (index <= plan.steps.length) {
        const step = plan.steps[index - 1]!; title = step.title;
        context = prefix + `\n当前任务：${step.context}\n前置任务：${tasks.at(-1)}。仅实施和测试；提交 PR 供独立评审。不得合并 PR、自行部署或创建后继任务。范围外问题报告阻塞。`;
        acceptance = step.acceptance; executor = 'engineering'; reviewer = 'qa'; code = true;
      } else if (index === deploymentIndex) {
        title = `发布：${content.title}`; context = prefix + `\n实施任务：${tasks.join('、')}\n老板已授权按此快照发布：${releasePolicy.releaseInstructions}\n生产验证：${releasePolicy.verifyInstructions}\n失败回退：${releasePolicy.rollbackInstructions}\n必须记录真实生产环境 production 的部署证据（提交 SHA、GitHub Deployment 与成功 Actions run）。失败则执行已授权回退并报告阻塞，不能声称上线成功。不要创建后继任务。`;
        acceptance = '发布提交可追溯，生产部署证据通过服务核验，QA 独立实测签署。'; executor = 'engineering'; reviewer = 'qa'; code = true; deploy = true;
      } else {
        title = `上线回归：${content.title}`;
        context = prefix + `\n发布任务 ${tasks[deploymentIndex]}，独立读取其部署证据、发布时的验证与回退说明，在生产复测整体验收并记录证据。发现回归请阻塞并请求按发布快照回退；不得将 CI 通过当成上线成功。不要创建后继任务。`;
        acceptance = '确认实际运行版本与发布提交一致，逐项验证用户可见行为，记录生产证据；异常不得通过。'; executor = 'qa'; reviewer = 'product';
      }
      // 超长输入不能静默截断已确认范围或发布说明。
      if (context.length > 20000) throw new CompanyError('invalid', '需求或发布说明过长，请拆分后重新确认');
      const task = await host.create({ title: title.slice(0, 200), context, requirement: context, acceptanceText: acceptance,
        executorRole: executor, reviewerRole: reviewer, project: content.project, parent: tasks.at(-1), tag: `requirement:${requirement}`,
        workIntent: { kind: code ? 'code' : 'read' }, ...(code ? { acceptanceCriteria: defaultAcceptanceCriteria(deploy ? 'deploy' : 'implement') } : {}),
        ...(deploy ? { acceptanceEnvironment: 'production' } : {}), idempotencyKey: `iteration:${requirement}:${revision}:${index}` });
      tasks.push(task.id);
      await update(deploy ? 'deploying' : index > deploymentIndex ? 'verifying' : 'running', index >= deploymentIndex ? 'release_pending' : 'implementing', `已建立任务 ${task.id}`);
      result.advanced++;
    } catch (error) {
      const note = error instanceof CompanyError ? error.message : '推进失败，下一轮重试；请核对执行端与任务服务';
      await db.query('UPDATE $id SET execution_error=$note WHERE execution_claim=$claim;', { id: row.id, claim, note });
      result.failed++;
    } finally {
      await db.query('UPDATE $id SET execution_until=$until, execution_busy=false, updated_at=time::now() WHERE execution_claim=$claim;', { id: row.id, claim, until: now + 30000 });
    }
  }
  return result;
}

/** 迭代任务分离提交与发布，覆盖旧软件任务默认“先合入再复核”的消息文案。 */
export function iterationMessages(input: CreateTask): { execute: string; review: string; includeSent: true } {
  const release = input.acceptanceEnvironment === 'production';
  const code = input.workIntent?.kind === 'code';
  const scope = release
    ? '按 task.md 内老板已确认的发布策略执行，记录 production 的真实部署提交和可核验的 GitHub Deployment/Actions 证据；出现异常按该快照回退并报告阻塞。'
    : code ? '按 task.md 实施、自测并提交 PR，保留 PR head 和 CI 证据。不要合并 PR 或发布；合入与部署由后续已授权的发布任务执行。'
    : '按 task.md 完成当前步骤，记录可验证证据；有前置缺口请报告阻塞。';
  return {
    includeSent: true,
    execute: `${scope} 使用派工消息中的 sck 命令记录 checkpoint / submit。不要创建后继任务，由迭代流程统一推进。提交后结束本轮。`,
    review: `${release ? '在生产独立复测 task.md 验收，核对部署 SHA 和生产部署证据。' : code ? '在 PR head 上独立复验需求与 CI，不合并 PR、不发布。' : '独立复验 task.md 的验收与证据。'} 使用 sck call review 提交 accept 或 return；未满足标准不得通过。不要创建后继任务，评审后结束本轮。`,
  };
}
