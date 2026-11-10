import type { RuntimeDashboard, RuntimeAgentView } from '../../src/runtime-dashboard.ts';
import type { DemoStore } from './store.ts';

/** 岗位与数量取自同一份员工数据；示例主机只表示本地/远程执行位置，CI/CD 不占 Agent。 */
export class DemoRuntime {
  private sequence = 0;
  private transferredAt = 0;
  constructor(private store: DemoStore) {}
  reset() {
    this.sequence = 0;
    this.transferredAt = 0;
  }
  transfer() {
    this.sequence++;
    this.transferredAt = Date.now();
  }
  snapshot(): RuntimeDashboard {
    const at = Date.now();
    const rows = this.store.data.agents;
    const engineer = rows.find((a) => a.role === 'engineering' && !a.policy?.disabled);
    const reviewer = rows.find((a) => a.role === 'qa' && !a.policy?.disabled);
    const task =
      this.store.data.tasks.find((t) => t.state === 'doing' && t.executor_role === 'engineering') ??
      this.store.data.tasks[0];
    const taskId = String(task?.id ?? 'design-task');
    const reverse = this.sequence % 2 === 0;
    const active = this.sequence > 0 && !!engineer && !!reviewer;
    const agents: RuntimeAgentView[] = rows.map((row, i) => {
      const id = String(row.employee);
      const isEngineer = id === engineer?.employee;
      const isReviewer = id === reviewer?.employee;
      const working =
        !row.policy?.disabled &&
        (isEngineer
          ? !active || reverse
          : isReviewer
            ? active && !reverse
            : row.role === 'product');
      const current =
        isEngineer || isReviewer
          ? task
          : this.store.data.tasks.find(
              (t) => t.executor_role === row.role && ['doing', 'ready'].includes(t.state),
            );
      const title = isReviewer
        ? '独立复核 PR 与验收标准'
        : String(current?.title ?? '核对需求范围与验收标准');
      const next = isEngineer
        ? '按复核意见修改 PR'
        : isReviewer
          ? '复核下一项已提交任务'
          : '整理下一项已确认需求';
      return {
        id,
        name: row.name,
        role: row.role,
        hostId: isReviewer ? 'design-remote' : 'design-local',
        model: row.model,
        modelSource: row.model ? 'configured' : 'unknown',
        provider: row.provider,
        runtime: 'native',
        observedAt: at,
        state: row.policy?.disabled
          ? 'unknown'
          : working
            ? 'running'
            : isReviewer && !active
              ? 'waiting'
              : 'idle',
        ...(working
          ? {
              activity: {
                agent: `design:${id}`, turn: `design:${this.sequence}`, runtime: 'native', state: 'running',
                startedAt: at - 180000, observedAt: at, lastActivityAt: at - 2000, toolsCompleted: 3, tool: 'Read', toolStartedAt: at - 2000,
                events: [
                  {seq:-3,at:at-75000,kind:'status',text:'【设计案例】原生执行端已绑定本轮任务'},
                  {seq:-2,at:at-65000,kind:'tool_start',text:'开始调用 Read'},
                  {seq:-1,at:at-55000,kind:'tool_end',text:'Read 调用结束'},
                  {seq:0,at:at-45000,kind:'output',text:'【设计案例】已读取验收标准，接下来检查相关实现。'},
                  {seq:1,at:at-25000,kind:'output',text:'【设计案例】已核对任务范围，正在检查受影响的模块与测试。'},
                  {seq:2,at:at-18000,kind:'tool_end',text:'Read 调用结束'},
                  {seq:3,at:at-2000,kind:'tool_start',text:'开始调用 Read'},
                ],
              },
              taskId: String(current?.id ?? taskId),
              taskTitle: title,
              project: {id: String(current?.project ?? 'design-company'), name: String(this.store.data.products.find(p => p.id === current?.project)?.name ?? '【设计案例】公司工作台')},
              phase: isReviewer ? 'review' : 'execute',
              elapsedSeconds: 180 + i * 65,
              estimate: {status: 'estimated' as const, samples: 12, lowerSeconds: 300, upperSeconds: 720},
              action: isReviewer ? '核对 PR head 的实现与 CI 结果' : '按已确认需求实施',
              currentPrompt: {
                context: {source:'dispatched', at, delivery:'design',files:[{name:'task.md',text:`# ${title}\n\n【设计案例】需求：检查实现与验收标准的一致性。\n\n验收：附上测试结果、PR 链接与验证证据。`,truncated:false},{name:'notes.md',text:'【设计案例】PR 合并后由 GitHub 自动部署。',truncated:false}]},
                text: `【设计案例】${title.replace(/^【设计案例】\s*/, '')}。按当前任务验收标准提交实现和测试证据，交现有 QA 独立复核。PR 合并后的构建与生产部署由 GitHub CI/CD 自动完成。`,
                source: 'sent' as const,
                truncated: false,
              },
            }
          : { action: row.policy?.disabled ? '员工已停用' : '等待调度或上游输入' }),
        next: {
          taskId,
          title: next,
          source: 'candidate',
          reason: '设计案例中的候选任务，尚未正式派工',
        },
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
          title: String(task?.title ?? '设计案例任务'),
          from: String(reverse ? reviewer!.employee : engineer!.employee),
          to: String(reverse ? engineer!.employee : reviewer!.employee),
          at: this.transferredAt,
          kind: reverse ? ('rework' as const) : ('review' as const),
          label: reverse ? '退回返工' : '交付独立复核',
        }
      : undefined;
    return {
      at,
      hosts,
      agents,
      transfers: transfer ? [transfer] : [],
      deliveries: Object.values(this.store.data.executions ?? {})
        .filter(run => run.execution?.stage === 'released' && run.execution.released_sha)
        .slice(0,2).map((run,i) => {
          const taskId=String(run.tasks.at(-1));
          return {id:`design-ci-${i}`,taskId,title:String(this.store.data.tasks.find(t=>t.id===taskId)?.title??'【设计案例】交付结果'),
            sha:String(run.execution.released_sha),at,status:'production_verified' as const,current:true,workflow:'GitHub 自动部署（设计案例）'};
        }),
      events: transfer
        ? [
            {
              id: transfer.id,
              at: transfer.at,
              label: transfer.label,
              actor: rows.find((a) => a.employee === transfer.from)?.name ?? transfer.from,
              taskId,
              taskTitle: transfer.title,
            },
          ]
        : [],
      summary: {
        hosts: hosts.length,
        onlineHosts: hosts.length,
        agents: agents.length,
        runningAgents: agents.filter((a) => a.state === 'running').length,
        idleAgents: agents.filter((a) => a.state === 'idle').length,
        tasks: new Set(agents.filter((a) => a.state === 'running').map((a) => a.taskId)).size,
        queued: this.store.data.tasks.filter((t) => ['ready', 'planned'].includes(t.state)).length,
        blocked: this.store.data.tasks.filter((t) => t.state === 'blocked').length,
      },
      warnings: [
        '运行位置、资源与交接为本地设计案例；员工数量与岗位来自同一份预览员工数据。模型未导出时显示未知，不按参考图指定模型。',
      ],
      sample: true,
    };
  }
}
