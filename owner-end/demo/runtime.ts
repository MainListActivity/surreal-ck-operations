import type {
  RuntimeDashboard,
  RuntimeAgentView,
  RuntimePendingMessage,
  RuntimeTransfer,
} from '../../src/runtime-dashboard.ts';
import { buildProjectRooms, recordKey } from '../../src/runtime-projects.ts';
import type { PhaseDuration } from '../../src/runtime-timing.ts';
import type { WorkContext } from '../../src/work-context.ts';
import type { Row } from './data.ts';
import type { DemoStore } from './store.ts';

const CROWD = 'design-crowd';
/** 岗位与数量取自同一份员工数据；示例主机只表示本地/远程执行位置，CI/CD 不占 Agent。 */
export class DemoRuntime {
  private sequence = 0;
  private transferredAt = 0;
  private crowdCount = 0;
  constructor(private store: DemoStore) {}
  reset() {
    this.sequence = 0;
    this.transferredAt = 0;
    this.crowdCount = 0;
  }
  transfer() {
    this.sequence++;
    this.transferredAt = Date.now();
  }
  /** 仅增删明确标注的内存案例；不会修改导出的生产快照，也不创建真实会话。 */
  crowd() {
    this.crowdCount = this.crowdCount === 4 ? 8 : 4;
    const data = this.store.data;
    data.agents = data.agents.filter(
      (a) => !String(a.employee).startsWith(`${CROWD}-`),
    );
    data.tasks = data.tasks.filter((t) => t.project !== CROWD);
    this.store.messages = this.store.messages.filter(
      (m) => !String(m.messageId).startsWith(`${CROWD}-`),
    );
    if (!data.products.some((p) => p.id === CROWD))
      data.products.push({ id: CROWD, name: '【设计案例】并行协作项目' });
    const roles = [
      'product',
      'engineering',
      'qa',
      'engineering',
      'engineering',
      'engineering',
      'qa',
      'engineering',
    ];
    const titles = [
      '梳理搜索交互与验收边界',
      '实现搜索输入与筛选条件',
      '独立复核搜索接口',
      '补齐移动端验收资料',
      '实现搜索结果分页',
      '补充权限边界测试',
      '复核无障碍交互',
      '优化搜索索引查询',
    ];
    for (let i = 0; i < this.crowdCount; i++) {
      const employee = `${CROWD}-employee-${i + 1}`,
        taskId = `${CROWD}-task-${i + 1}`;
      const role = roles[i]!;
      data.agents.push({
        employee,
        name: `【设计案例】${role === 'engineering' ? '工程' : role === 'qa' ? '验收' : '产品'}员工 ${i + 1}`,
        role,
        definitionId: `design-${role}-${i % 2 ? 'factory' : 'claude'}`,
        provider: i % 2 ? 'factory-droid' : 'claude',
        model: i % 2 ? 'Factory · 示例模型' : 'Claude · 示例模型',
        designTask: taskId,
        policy: { disabled: false },
      });
      data.tasks.push({
        id: taskId,
        title: `【设计案例】${titles[i]}`,
        project: CROWD,
        state: i === 3 ? 'blocked' : role === 'qa' ? 'review' : 'doing',
        executor_role: role,
        reviewer_role: 'qa',
        kind: 'design',
        blocked_reason:
          i === 3
            ? '【设计案例】缺少手机端验收账号，等待老板补充授权资料'
            : undefined,
        requirement: `【设计案例】${titles[i]}。这是一条独立任务，与同项目其他任务并行执行。`,
        acceptanceText: '覆盖成功、空状态、失败与重试；提交测试记录和 PR。',
      });
      const nextTaskId = `${CROWD}-next-${i + 1}`;
      const nextTitle = `【设计案例】${role === 'qa' ? '独立复核' : '完善'}搜索${i % 2 ? '历史记录' : '空状态'} ${i + 1}`;
      data.tasks.push({
        id: nextTaskId,
        title: nextTitle,
        project: CROWD,
        state: i === 3 ? 'planned' : role === 'qa' ? 'review' : 'ready',
        executor_role: role === 'qa' ? 'engineering' : role,
        reviewer_role: 'qa',
        kind: 'design',
        requirement: `【设计案例】${nextTitle.replace('【设计案例】', '')}，与当前正在执行的任务分别验收。`,
        acceptanceText: '核对空状态、历史记录与窄屏行为，并记录验证证据。',
      });
      this.store.messages.push({
        messageId: `${CROWD}-message-${i + 1}`,
        taskId: nextTaskId,
        title: nextTitle,
        candidateEmployeeId: employee,
        step: role === 'qa' ? 'review' : 'execute',
        state: 'draft',
        hold: false,
        editable: true,
        body: `【设计案例】${nextTitle.replace('【设计案例】', '')}。按 task.md 的验收标准完成工作并提交验证证据。这是候选派工正文，实际接收人由调度确定。`,
      });
    }
    // 仅作为交接来源保留身份：没有当前任务、项目或候选派工，不占现场工位。
    data.agents.push({
      employee: `${CROWD}-previous-engineer`,
      name: '【设计案例】前序工程员工',
      role: 'engineering',
      definitionId: 'design-engineering-claude',
      provider: 'claude',
      model: 'Claude · 示例模型',
      policy: { disabled: false },
    });
    // 已验收范围和未完成范围来自同一份任务数据，不用员工百分比替代项目进度。
    for (let i = 0; i < 2; i++)
      data.tasks.push({
        id: `${CROWD}-done-${i}`,
        title: `【设计案例】已验收基础工作 ${i + 1}`,
        project: CROWD,
        state: 'done',
        executor_role: 'engineering',
        reviewer_role: 'qa',
        kind: 'design',
      });
    return { employees: this.crowdCount, project: CROWD };
  }
  private context(
    task: Row | undefined,
    at: number,
    source: WorkContext['source'] = 'dispatched',
  ): WorkContext {
    return {
      source,
      at,
      ...(source === 'dispatched' ? { delivery: 'design' } : {}),
      files: [
        {
          name: 'task.md',
          text: `# ${task?.title ?? '【设计案例】任务说明'}\n\n${task?.requirement ?? '【设计案例】按当前任务范围执行。'}\n\n验收：${task?.acceptanceText ?? '提交测试与验证证据。'}`,
          truncated: false,
        },
        {
          name: 'notes.md',
          text: '【设计案例】PR 合并后由 GitHub 自动部署，不另设构建或部署员工。',
          truncated: false,
        },
      ],
    };
  }
  snapshot(): RuntimeDashboard {
    const at = Date.now(),
      rows = this.store.data.agents,
      tasks = this.store.data.tasks;
    const engineer = rows.find(
      (a) => a.role === 'engineering' && !a.policy?.disabled,
    );
    const reviewer = rows.find((a) => a.role === 'qa' && !a.policy?.disabled);
    const task =
      tasks.find(
        (t) => t.state === 'doing' && t.executor_role === 'engineering',
      ) ?? tasks[0];
    const taskId = recordKey(task?.id ?? 'design-task');
    const reverse = this.sequence % 2 === 0;
    const active = this.sequence > 0 && !!engineer && !!reviewer;
    const latestDrafts = new Map<string, Row>();
    for (const message of this.store.messages) {
      const task = tasks.find((t) => t.id === message.taskId);
      if (message.state === 'sent' || !['execute','review','rework'].includes(message.step) ||
        !task || !['planned','ready','doing','review','blocked'].includes(task.state)) continue;
      latestDrafts.set(`${message.taskId}:${message.step}`, message);
    }
    const pending: RuntimePendingMessage[] = [...latestDrafts.values()]
      .map((m) => ({
        messageId: String(m.messageId),
        taskId: recordKey(m.taskId),
        title: String(m.title),
        body: String(m.body),
        preview: String(m.body),
        hold: !!m.hold,
        assignment: m.candidateEmployeeId ? 'candidate' : 'unassigned',
        stage: ['planned','blocked'].includes(tasks.find((t) => t.id === m.taskId)!.state) ||
          (m.step === 'review' && tasks.find((t) => t.id === m.taskId)!.state !== 'review') ? 'later' : 'next',
        context: this.context(
          tasks.find((t) => t.id === m.taskId),
          at,
          'preview',
        ),
      }));
    const agents: RuntimeAgentView[] = rows.map((row, i) => {
      const id = String(row.employee),
        isEngineer = id === engineer?.employee,
        isReviewer = id === reviewer?.employee;
      const assigned = tasks.find((t) => t.id === row.designTask);
      const working =
        !row.policy?.disabled &&
        (assigned
          ? assigned.state !== 'blocked' &&
            !['done', 'void'].includes(assigned.state)
          : isEngineer
            ? !active || reverse
            : isReviewer
              ? active && !reverse
              : row.role === 'product');
      const current =
        assigned ??
        (isEngineer || isReviewer
          ? task
          : tasks.find(
              (t) =>
                t.executor_role === row.role &&
                ['doing', 'ready'].includes(t.state),
            ));
      const blocked = assigned?.state === 'blocked';
      const title = assigned
        ? String(assigned.title)
        : isReviewer
          ? '【设计案例】独立复核 PR 与验收标准'
          : String(current?.title ?? '【设计案例】核对需求范围与验收标准');
      const currentTaskId = recordKey(current?.id ?? taskId);
      const ownMessages = pending
        .filter((m) => {
          const source = this.store.messages.find(
            (row) => row.messageId === m.messageId,
          );
          return source?.candidateEmployeeId === id;
        })
        .map((m) => ({ ...m, assignment: 'candidate' as const }));
      return {
        id,
        definitionId: row.definitionId,
        name: row.name,
        role: row.role,
        hostId: isReviewer || i % 2 === 1 ? 'design-remote' : 'design-local',
        model: row.model,
        modelSource: row.model ? 'configured' : 'unknown',
        provider: row.provider,
        runtime: 'native',
        observedAt: at,
        state: row.policy?.disabled
          ? 'unknown'
          : blocked
            ? 'waiting'
            : working
              ? 'running'
              : isReviewer && !active
                ? 'waiting'
                : 'idle',
        pendingMessages: ownMessages,
        ...(working || blocked
          ? {
              taskId: currentTaskId,
              taskTitle: title,
              taskState: current?.state,
              blockedReason: blocked
                ? String(current?.blocked_reason)
                : undefined,
              project: {
                id: recordKey(current?.project ?? 'company-unassigned'),
                name: String(
                  this.store.data.products.find(
                    (p) => p.id === current?.project,
                  )?.name ?? '公司公共事务',
                ),
              },
              phase:
                assigned?.state === 'review' || (!assigned && isReviewer)
                  ? 'review'
                  : 'execute',
              elapsedSeconds: 180 + i * 65,
              estimate: blocked
                ? { status: 'unavailable' as const, samples: 0 }
                : {
                    status: 'estimated' as const,
                    samples: 12,
                    lowerSeconds: 300,
                    upperSeconds: 720,
                  },
              action: blocked
                ? '等待老板补充验收资料'
                : isReviewer
                  ? '核对 PR head 的实现与 CI 结果'
                  : '按已确认需求实施',
              activity: {
                agent: `design:${id}`,
                turn: `design:${this.sequence}`,
                runtime: 'native' as const,
                state: blocked ? ('completed' as const) : ('running' as const),
                startedAt: at - 180000,
                observedAt: at,
                lastActivityAt: at - 2000,
                toolsCompleted: 3,
                ...(blocked ? {} : { tool: 'Read', toolStartedAt: at - 2000 }),
                checklist: { done: 2 + (i % 4), total: 7, at: at - 25000 },
                events: [
                  {
                    seq: 1,
                    at: at - 75000,
                    kind: 'status' as const,
                    text: '【设计案例】原生执行端已绑定本轮任务',
                  },
                  {
                    seq: 2,
                    at: at - 55000,
                    kind: 'tool_end' as const,
                    text: 'Read 调用结束',
                  },
                  {
                    seq: 3,
                    at: at - 45000,
                    kind: 'output' as const,
                    text: '【设计案例】已读取验收标准，接下来检查相关实现。',
                  },
                  {
                    seq: 4,
                    at: at - 25000,
                    kind: 'output' as const,
                    text: '【设计案例】已核对任务范围，正在检查受影响的模块与测试。',
                  },
                  {
                    seq: 5,
                    at: at - 2000,
                    kind: blocked
                      ? ('output' as const)
                      : ('tool_start' as const),
                    text: blocked
                      ? String(current?.blocked_reason)
                      : '开始调用 Read',
                  },
                ],
              },
              currentPrompt: {
                context: this.context(current, at),
                text: `【设计案例】${title.replace(/^【设计案例】\s*/, '')}。按当前任务验收标准提交实现和测试证据，交现有 QA 独立复核。PR 合并后由 GitHub CI/CD 自动部署。`,
                source: 'sent' as const,
                truncated: false,
              },
            }
          : {
              action: row.policy?.disabled
                ? '员工已停用'
                : '等待调度或上游输入',
            }),
        next: ownMessages[0] ? {
          taskId: ownMessages[0].taskId,
          title: ownMessages[0].title,
          source: 'candidate' as const,
          reason: ownMessages[0].stage === 'later' ? '稍后阶段的候选模板，前置条件满足后再由调度派发' : '候选派工，实际接收人由调度确定',
        } : undefined,
        ...(working && isEngineer && reviewer
          ? {
              destination: {
                role: 'qa',
                agentId: String(reviewer.employee),
                source: 'planned' as const,
                label: '交付现有 QA 独立复核',
              },
            }
          : {}),
      };
    });
    const hosts = [
      {
        id: 'design-local',
        name: '本地开发机',
        platform: 'darwin',
        cores: 8,
        memory: 16,
        cpu: 42,
        used: 58,
      },
      {
        id: 'design-remote',
        name: '远程开发机',
        platform: 'linux',
        cores: 16,
        memory: 32,
        cpu: 36,
        used: 49,
      },
    ]
      .filter((h) => agents.some((a) => a.hostId === h.id))
      .map((h) => ({
        id: h.id,
        name: h.name,
        runnerIds: [h.id],
        state: 'online' as const,
        at,
        metrics: {
          platform: h.platform,
          arch: '示例',
          cpuModel: '设计案例',
          cores: h.cores,
          memoryTotal: h.memory * 2 ** 30,
          memoryUsed: (h.memory * 2 ** 30 * h.used) / 100,
          cpuPercent: h.cpu,
        },
      }));
    const transfer = active
      ? {
          id: `design-transfer-${this.sequence}`,
          taskId,
          projectId: recordKey(task?.project) || 'company-unassigned',
          title: String(task?.title ?? '设计案例任务'),
          from: String(reverse ? reviewer!.employee : engineer!.employee),
          to: String(reverse ? engineer!.employee : reviewer!.employee),
          at: this.transferredAt,
          kind: reverse ? ('rework' as const) : ('review' as const),
          label: reverse ? '退回返工' : '交付独立复核',
        }
      : undefined;
    const transfers: RuntimeTransfer[] = transfer ? [transfer] : [];
    if (this.sequence > 0 && this.crowdCount > 0) {
      const employee = (position: number) => `${CROWD}-employee-${position}`;
      // 三条独立任务关系足以检查隔人工位、窄屏换行与离场头像，避免画成杂乱线网。
      const examples = [
        { from: employee(1), to: employee(3), label: '补交验收边界' },
        {
          from: employee(2),
          to: employee(this.crowdCount === 8 ? 7 : 4),
          label: this.crowdCount === 8 ? '交接无障碍资料' : '交接移动端资料',
        },
        {
          from: `${CROWD}-previous-engineer`,
          to: employee(this.crowdCount === 8 ? 8 : 2),
          label: '交接前序实现',
        },
      ];
      for (const [index, example] of examples.entries()) {
        const receiver = agents.find((a) => a.id === example.to);
        if (!receiver?.taskId || !agents.some((a) => a.id === example.from)) continue;
        transfers.push({
          id: `${CROWD}-transfer-${this.crowdCount}-${this.sequence}-${index + 1}`,
          taskId: receiver.taskId,
          projectId: CROWD,
          title: receiver.taskTitle ?? '【设计案例】并行协作交接',
          from: example.from,
          to: example.to,
          at: this.transferredAt,
          kind: 'handoff',
          label: example.label,
        });
      }
    }
    const plans: Row[] = [],
      executions: Row[] = [];
    for (const [requirement, run] of this.store.executions) {
      const revision = this.store.data.requirements.find(
        (r) => r.id === requirement,
      )?.approved_revision;
      if (run.plan)
        plans.push({ requirement, revision, body: JSON.stringify(run.plan) });
      executions.push({ requirement, revision, tasks: run.tasks ?? [] });
    }
    const history: PhaseDuration[] = [];
    // 明确的设计样本只供本地 ETA 演示；真实环境由审计事件计算。
    for (const p of this.store.data.products)
      for (let i = 0; i < 12; i++)
        history.push({
          task: `design-history-${p.id}-${i}`,
          project: recordKey(p.id),
          phase: 'review',
          role: 'qa',
          kind: 'design',
          seconds: 180 + i * 20,
          at: at - i * 100000,
        });
    const projects = buildProjectRooms({
      projects: this.store.data.products,
      tasks,
      requirements: this.store.data.requirements,
      plans,
      executions,
      agents,
      messages: pending,
      history,
    });
    return {
      at,
      hosts,
      agents,
      projects,
      transfers,
      deliveries: [...this.store.executions.values()]
        .filter(
          (run) =>
            run.execution?.stage === 'released' && run.execution.released_sha,
        )
        .slice(0, 2)
        .map((run, i) => {
          const id = String(run.tasks.at(-1));
          return {
            id: `design-ci-${i}`,
            taskId: id,
            title: String(
              tasks.find((t) => t.id === id)?.title ?? '【设计案例】交付结果',
            ),
            sha: String(run.execution.released_sha),
            at,
            status: 'production_verified' as const,
            current: true,
            workflow: 'GitHub 自动部署（设计案例）',
          };
        }),
      events: transfers.map((item) => ({
        id: item.id,
        at: item.at,
        label: item.label,
        actor: rows.find((a) => a.employee === item.from)?.name ?? item.from,
        taskId: item.taskId,
        taskTitle: item.title,
      })),
      summary: {
        hosts: hosts.length,
        onlineHosts: hosts.length,
        agents: agents.length,
        runningAgents: agents.filter((a) => a.state === 'running').length,
        idleAgents: agents.filter((a) => a.state === 'idle').length,
        tasks: new Set(
          agents.filter((a) => a.state === 'running').map((a) => a.taskId),
        ).size,
        queued: tasks.filter((t) => ['ready', 'planned'].includes(t.state))
          .length,
        blocked: tasks.filter((t) => t.state === 'blocked').length,
      },
      warnings: [
        '运行位置、资源、进度和 ETA 为本地设计案例；员工、项目、任务和待发消息来自同一份内存数据。模型未导出时显示未知。',
      ],
      sample: true,
    };
  }
}
