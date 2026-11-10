import { RecordId, type Surreal } from 'surrealdb';
import { defaultAcceptanceCriteria } from '../acceptance.ts';
import type { CreateTask, TaskView } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { Requirements, type Approval } from './requirements.ts';
import { iterationPlan } from './planning.ts';

export interface Execution { id: string; tasks: string[]; stage: string; note?: string; released_sha?: string }
export interface ExecutionHost { create(input: CreateTask): Promise<Pick<TaskView, 'id'>> }
interface TaskRow { id: RecordId; state: string; acceptance_head?: string; acceptance_attempt?: number }

/** 只有核验过的生产部署证据与独立复核同时存在，才可将需求置为已上线。 */
export async function deployedSha(db: Surreal, task: TaskRow): Promise<string | undefined> {
  if (task.state !== 'done' || !task.acceptance_head) return;
  const [evidence] = await db.query<[Array<{ kind: string; verifier: string; source: { conclusion?: string; deployment?: { deploymentId?: string; status?: string } } }>]>(
    `SELECT kind, verifier, source FROM acceptance_evidence WHERE task=$task AND verified=true AND sha=$sha
      AND environment='production' AND attempt=$attempt;`, { task: task.id, sha: task.acceptance_head, attempt: task.acceptance_attempt });
  return evidence.some(e => e.kind === 'machine' && e.verifier === 'github-actions' && e.source.conclusion === 'success' && e.source.deployment?.deploymentId && e.source.deployment.status === 'success')
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
          await update(last.state === 'blocked' || last.state === 'void' ? 'blocked' : tasks.length > plan.steps.length + 1 ? 'verifying' : 'running', tasks.length > plan.steps.length + 1 ? 'release_pending' : 'implementing', `任务 ${tasks.at(-1)}：${last.state}`);
          continue;
        }
      }
      const deploymentIndex = plan.steps.length + 1;
      // 开工确认同时授权独立复核后的 PR 合并；旧 autoRelease=false 不再形成二次审批。
      // 逐项复查前置任务，不能仅凭最后一项完成越过未验收/被作废的交付。
      if (tasks.length >= deploymentIndex) {
        const [prerequisites] = await db.query<[TaskRow[]]>(
          'SELECT id, state FROM task WHERE id IN $tasks;',
          { tasks: tasks.slice(0, deploymentIndex).map(id => new RecordId('task', id)) });
        if (prerequisites.length !== deploymentIndex || prerequisites.some(task => task.state !== 'done')) {
          await update('blocked', 'implementing', '实施任务尚未全部通过独立复核，不能合并 PR'); continue;
        }
      }
      if (tasks.length >= deploymentIndex + 1) {
        // 旧版已派出的额外上线回归单仍须完成；不改其任务或审批历史。
        const [deployment] = await db.query<[TaskRow[]]>('SELECT * FROM $id;', { id: new RecordId('task', tasks[deploymentIndex]!) });
        const sha = deployment[0] && await deployedSha(db, deployment[0]);
        if (!sha) { await update('awaiting_evidence', 'release_pending', '等待同一提交的 GitHub 生产部署证据及独立 QA 线上验收'); continue; }
        await update('released', 'released', 'PR 合并后的 GitHub 自动部署已核验，QA 线上验收通过', sha); result.advanced++; continue;
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
      } else {
        const releasePolicy = approval.policy;
        title = `合并 PR 与上线核验：${content.title}`;
        context = prefix + `
已独立复核的实施任务：${tasks.join('、')}
需求确认已授权复核通过后的 PR 合并，无需再次请老板确认发布。先逐项核对任务的验收记录、PR 与已复核 head SHA，确认当前 PR head 未改变且 GitHub 必需检查通过，遵守仓库分支保护再合并；head 改变或检查失败必须停止并返回独立复核，不能强制合并或绕过保护。多 PR 按依赖顺序处理，前一项失败立即停止。
合并会触发仓库现有 GitHub CI/CD 自动部署生产。不得手工构建/部署、另建发布流水线或创建构建/部署 Agent。已合并的 PR 不重复合并，恢复后继续检查对应流水线。
项目流水线说明：${releasePolicy.releaseInstructions || '从项目现有 GitHub 工作流读取主分支、必需检查及 production 部署记录；入口缺失则报告阻塞。'}
生产验证：${releasePolicy.verifyInstructions || '按本需求整体验收逐项验证实际线上行为与版本。'}
失败处理：${releasePolicy.rollbackInstructions || '停止后续合并并报告阻塞；核对项目现有回退方案，缺少明确授权时请求老板处理。'}
必须记录实际合并提交 SHA（不能用合并前 PR head 代替）、成功 Actions run 与对应 production GitHub Deployment 证据，交 QA 独立线上验收；CI 通过不等于上线成功。产品补充说明不能覆盖前述合并门禁和自动部署约束。不要创建后继任务。`;
        acceptance = '已复核 PR 按仓库规则合并，GitHub 自动部署的生产证据通过服务核验，QA 按需求整体验收独立线上实测签署。';
        executor = 'engineering'; reviewer = 'qa'; code = true; deploy = true;
      }
      // 超长输入不能静默截断已确认范围或发布说明。
      if (context.length > 20000) throw new CompanyError('invalid', '需求或发布说明过长，请拆分后重新确认');
      const task = await host.create({ title: title.slice(0, 200), context, requirement: context, acceptanceText: acceptance,
        executorRole: executor, reviewerRole: reviewer, project: content.project, parent: tasks.at(-1), tag: `requirement:${requirement}`,
        workIntent: { kind: code ? 'code' : 'read' }, ...(code ? { acceptanceCriteria: defaultAcceptanceCriteria(deploy ? 'deploy' : 'implement') } : {}),
        ...(deploy ? { acceptanceEnvironment: 'production' } : {}), idempotencyKey: `iteration:${requirement}:${revision}:${index}` });
      tasks.push(task.id);
      await update(deploy ? 'verifying' : 'running', index >= deploymentIndex ? 'release_pending' : 'implementing', `已建立任务 ${task.id}`);
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

/** 先独立复核 PR，再由既有工程岗合并并核验 GitHub 自动部署；QA 在同一收尾任务验收线上效果。 */
export function iterationMessages(input: CreateTask): { execute: string; review: string; includeSent: true } {
  const release = input.acceptanceEnvironment === 'production';
  const code = input.workIntent?.kind === 'code';
  const scope = release
    ? '按 task.md 核对独立复核记录、PR head 与必需检查后合并 PR；无需二次老板审批。GitHub CI/CD 自动部署，不得手工构建或部署。记录 production 的真实部署提交和可核验的 GitHub Deployment/Actions 证据；异常停止推进并报告阻塞。'
    : code ? '按 task.md 实施、自测并提交 PR，保留 PR head 和 CI 证据。不要合并 PR 或发布；独立复核通过后由既有工程岗完成合并，GitHub CI/CD 自动部署。'
    : '按 task.md 完成当前步骤，记录可验证证据；有前置缺口请报告阻塞。';
  return {
    includeSent: true,
    execute: `${scope} 使用派工消息中的 sck 命令记录 checkpoint / submit。不要创建后继任务，由迭代流程统一推进。提交后结束本轮。`,
    review: `${release ? '在生产独立复测 task.md 验收，核对部署 SHA 和生产部署证据。' : code ? '在 PR head 上独立复验需求与 CI，不合并 PR、不发布。' : '独立复验 task.md 的验收与证据。'} 使用 sck call review 提交 accept 或 return；未满足标准不得通过。不要创建后继任务，评审后结束本轮。`,
  };
}
