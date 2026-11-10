import type { Surreal } from 'surrealdb';
import { readBoard, RUNNER_STALE_MS, type OwnerBoard } from './board.ts';

/** 可观测性读模型，不导入宿主 SDK；数据不足时保留未知状态。 */
export interface HostMetrics {
  platform: string;
  arch: string;
  cpuModel: string;
  cores: number;
  memoryTotal: number;
  memoryUsed: number;
  cpuPercent?: number;
}
export interface RuntimeHostView {
  id: string;
  name: string;
  runnerIds: string[];
  state: 'online' | 'offline' | 'unknown';
  at?: number;
  metrics?: HostMetrics;
}
export interface RuntimePrompt {
  text: string;
  source: 'sent' | 'template' | 'candidate';
  at?: number;
  truncated: boolean;
}
export interface RuntimeAgentView {
  id: string;
  name: string;
  role: string;
  hostId: string;
  provider?: string;
  model?: string;
  modelSource: 'observed' | 'configured' | 'unknown';
  state: 'running' | 'waiting' | 'idle' | 'error' | 'unknown';
  observedAt?: number;
  taskId?: string;
  taskTitle?: string;
  phase?: string;
  elapsedSeconds?: number;
  action?: string;
  currentPrompt?: RuntimePrompt;
  progress?: { done: number; total: number; label: string };
  next?: {
    taskId: string;
    title: string;
    source: 'candidate';
    prompt?: RuntimePrompt;
    reason: string;
  };
  destination?: { role: string; agentId?: string; source: 'planned'; label: string };
}
export interface RuntimeTransfer {
  id: string;
  taskId: string;
  title: string;
  from: string;
  to: string;
  at: number;
  kind: 'review' | 'rework' | 'handoff';
  label: string;
}
export interface RuntimeEvent {
  id: string;
  at: number;
  label: string;
  actor: string;
  taskId?: string;
  taskTitle?: string;
}
export interface RuntimeDelivery {
  id: string;
  taskId: string;
  title: string;
  sha: string;
  at: number;
  status: 'ci_passed' | 'ci_failed' | 'production_verified' | 'unknown';
  current: boolean;
  workflow?: string;
  runUrl?: string;
}
export interface RuntimeDashboard {
  at: number;
  hosts: RuntimeHostView[];
  agents: RuntimeAgentView[];
  transfers: RuntimeTransfer[];
  events: RuntimeEvent[];
  deliveries: RuntimeDelivery[];
  summary: {
    hosts: number;
    onlineHosts: number;
    agents: number;
    runningAgents: number;
    idleAgents: number;
    tasks: number;
    queued: number;
    blocked: number;
  };
  warnings: string[];
  sample?: boolean;
}
type Row = Record<string, any>;
const key = (v: any): string =>
  String(v && typeof v === 'object' && 'id' in v ? v.id : (v ?? ''))
    .replace(/^(employee|task|runner_heartbeat):/, '')
    .replace(/^⟨|⟩$/g, '');
const time = (v: any): number | undefined => {
  const n = typeof v === 'number' ? v : new Date(v?.toDate?.() ?? v).getTime();
  return Number.isFinite(n) ? n : undefined;
};
const bounded = (
  text: unknown,
  source: RuntimePrompt['source'],
  at?: number,
): RuntimePrompt | undefined =>
  typeof text === 'string' && text
    ? { text: text.slice(0, 16000), source, at, truncated: text.length > 16000 }
    : undefined;
const online = (at: number | undefined, now: number) =>
  at !== undefined && at <= now + 5000 && now - at <= RUNNER_STALE_MS;
export interface DashboardRows {
  board: OwnerBoard;
  employees: Row[];
  beats: Row[];
  telemetry: Row[];
  tasks: Row[];
  sent: Row[];
  current: Row[];
  audits: Row[];
  executions?: Row[];
  evidence?: Row[];
  warnings?: string[];
}

export function buildRuntimeDashboard(input: DashboardRows, now = Date.now()): RuntimeDashboard {
  const warnings = [...(input.warnings ?? [])];
  const telemetry = new Map(input.telemetry.map((t) => [String(t.runner), t]));
  const hosts = new Map<string, RuntimeHostView>();
  const runnerHost = new Map<string, string>();
  for (const b of input.beats) {
    const runner = String(b.runner);
    const t = telemetry.get(runner);
    const id = typeof t?.node === 'string' ? t.node : runner;
    const at = time(b.at);
    runnerHost.set(runner, id);
    const h = hosts.get(id) ?? {
      id,
      name: String(b.host || runner),
      runnerIds: [],
      state: 'unknown' as const,
    };
    h.runnerIds.push(runner);
    if (h.at === undefined || (at ?? 0) > h.at) {
      h.at = at;
      h.state = online(at, now) ? 'online' : 'offline';
      h.name = String(b.host || runner);
    }
    if (online(time(t?.at), now) && t?.metrics && typeof t.metrics === 'object')
      h.metrics = t.metrics as HostMetrics;
    hosts.set(id, h);
  }
  const taskMap = new Map(input.tasks.map((t) => [key(t.id), t]));
  const employeeMap = new Map(input.employees.map((e) => [key(e.id), e]));
  const agents: RuntimeAgentView[] = input.board.employees.map((e) => {
    const row = employeeMap.get(e.id);
    const hostId =
      runnerHost.get(String(row?.runner_id)) ??
      (row?.runner_id ? String(row.runner_id) : 'unassigned');
    if (!hosts.has(hostId))
      hosts.set(hostId, {
        id: hostId,
        name: hostId === 'unassigned' ? '未上报主机归属' : '等待主机心跳',
        runnerIds: row?.runner_id ? [row.runner_id] : [],
        state: 'unknown',
      });
    const host = hosts.get(hostId)!;
    const observedAt = time(row?.runtime_at);
    const fresh = host.state === 'online' && online(observedAt, now);
    const leased = e.now.state === 'leased' ? e.now : undefined;
    const task = leased ? taskMap.get(leased.taskId) : undefined;
    const state: RuntimeAgentView['state'] = !fresh
      ? 'unknown'
      : ['running', 'starting'].includes(row?.runtime_state)
        ? 'running'
        : row?.runtime_state === 'error'
          ? 'error'
          : row?.runtime_state === 'idle'
            ? leased
              ? 'waiting'
              : 'idle'
            : 'waiting';
    const sent = input.current
      .filter((m) => key(m.sent_to) === e.id && key(m.task) === leased?.taskId)
      .sort((a, b) => (time(b.sent_at) ?? 0) - (time(a.sent_at) ?? 0))[0];
    const eligibleSent =
      sent && (!leased?.leaseStartedAt || (time(sent.sent_at) ?? 0) >= leased.leaseStartedAt - 1000)
        ? sent
        : undefined;
    const next = e.next[0];
    const draft = next ? e.outbox.find((m) => m.taskId === next.taskId) : undefined;
    // parent 是前置任务，不能误当子任务。百分比只能来自已落地的需求执行清单。
    const execution = leased
      ? input.executions?.find(
          (x) => Array.isArray(x.tasks) && x.tasks.some((id: unknown) => key(id) === leased.taskId),
        )
      : undefined;
    const steps: Row[] = execution
      ? execution.tasks
          .map((id: unknown) => taskMap.get(key(id)))
          .filter((t: Row | undefined): t is Row => !!t && t.state !== 'void')
      : [];
    const completePlan = execution && execution.tasks.every((id: unknown) => taskMap.has(key(id)));
    const role = leased?.phase === 'review' ? task?.executor_role : task?.reviewer_role;
    const successor =
      leased?.phase === 'review'
        ? input.tasks.find(
            (t) => key(t.parent) === leased.taskId && ['planned', 'ready'].includes(t.state),
          )
        : undefined;
    const destinationRole =
      leased?.phase === 'review'
        ? successor?.executor_role
        : typeof role === 'string'
          ? role
          : undefined;
    const candidates = input.board.employees.filter(
      (a) => a.role === destinationRole && a.id !== e.id,
    );
    return {
      id: e.id,
      name: e.name,
      role: e.role,
      hostId,
      provider: e.provider,
      model: fresh && row?.runtime_model ? row.runtime_model : e.model,
      modelSource: fresh && row?.runtime_model ? 'observed' : e.model ? 'configured' : 'unknown',
      state,
      observedAt,
      ...(leased
        ? {
            taskId: leased.taskId,
            taskTitle: leased.title,
            phase: leased.phase,
            elapsedSeconds: leased.elapsedSeconds,
            action: leased.progress?.summary || leased.progress?.label,
          }
        : {}),
      ...(eligibleSent
        ? {
            currentPrompt: bounded(
              eligibleSent.sent_body ?? eligibleSent.body,
              eligibleSent.sent_body ? 'sent' : 'template',
              time(eligibleSent.sent_at),
            ),
          }
        : {}),
      ...(completePlan && steps.length
        ? {
            progress: {
              done: steps.filter((t) => t.state === 'done').length,
              total: steps.length,
              label: '所属需求已验收任务',
            },
          }
        : {}),
      ...(next
        ? {
            next: {
              taskId: next.taskId,
              title: next.title,
              source: 'candidate' as const,
              reason: next.reason,
              prompt: bounded(
                draft?.translation?.status === 'ready' ? draft.translation.text : draft?.body,
                'candidate',
              ),
            },
          }
        : {}),
      ...(destinationRole
        ? {
            destination: {
              role: destinationRole,
              agentId: candidates.length === 1 ? candidates[0]!.id : undefined,
              source: 'planned' as const,
              label: destinationRole === 'owner' ? '老板验收' : '提交后交付复核，接收人待调度',
            },
          }
        : {}),
    };
  });
  const transfers: RuntimeTransfer[] = [];
  // 仅已确认送达的派工消息构成交接；草稿、候选与租约变化不会触发动画。
  const previous = new Map<string, Row>();
  for (const m of [...input.sent].sort(
    (a, b) => (time(a.sent_at) ?? 0) - (time(b.sent_at) ?? 0) || key(a.id).localeCompare(key(b.id)),
  )) {
    if (!['execute', 'review', 'rework'].includes(m.step)) continue;
    const taskId = key(m.task),
      from = previous.get(taskId) ?? previous.get(key(taskMap.get(taskId)?.parent));
    const to = key(m.sent_to);
    if (from && key(from.sent_to) !== to && to) {
      const kind = m.step === 'review' ? 'review' : m.step === 'rework' ? 'rework' : 'handoff';
      transfers.push({
        id: key(m.id),
        taskId,
        title: String(taskMap.get(taskId)?.title ?? taskId),
        from: key(from.sent_to),
        to,
        at: time(m.sent_at) ?? 0,
        kind,
        label: kind === 'review' ? '交付复核' : kind === 'rework' ? '退回返工' : '任务交接',
      });
    }
    if (['execute', 'review', 'rework'].includes(m.step)) previous.set(taskId, m);
  }
  const events: RuntimeEvent[] = input.audits.map((a) => ({
    id: key(a.id),
    at: time(a.at) ?? 0,
    label:
      (
        {
          claim: '领取任务',
          checkpoint: '更新进展',
          submit: '提交成果',
          return: '退回返工',
          accept: '验收通过',
          block: '报告阻塞',
          owner_approve: '老板批准',
        } as Record<string, string>
      )[a.action] ?? String(a.action),
    actor: input.board.employees.find((e) => e.id === key(a.actor))?.name ?? key(a.actor),
    taskId: key(a.task),
    taskTitle: taskMap.get(key(a.task))?.title,
  }));
  const list = [...hosts.values()].sort((a, b) => a.id.localeCompare(b.id));
  const deliveries = new Map<string, RuntimeDelivery>();
  for (const e of input.evidence ?? []) {
    if (e.verified !== true || e.verifier !== 'github-actions' || typeof e.sha !== 'string')
      continue;
    const taskId = key(e.task),
      task = taskMap.get(taskId),
      source = e.source ?? {};
    const runUrl =
      typeof source.runUrl === 'string' &&
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(source.runUrl)
        ? source.runUrl
        : undefined;
    const status: RuntimeDelivery['status'] =
      e.environment === 'production' &&
      source.conclusion === 'success' &&
      source.deployment?.deploymentId &&
      ['success', 'succeeded'].includes(source.deployment.status)
        ? 'production_verified'
        : source.conclusion === 'success'
          ? 'ci_passed'
          : ['failure', 'cancelled', 'timed_out'].includes(source.conclusion)
            ? 'ci_failed'
            : 'unknown';
    const delivery = {
      id: key(e.id),
      taskId,
      title: String(task?.title ?? taskId),
      sha: e.sha,
      at: time(e.at) ?? 0,
      status,
      current: !!task && e.sha === task.acceptance_head && e.attempt === task.acceptance_attempt,
      workflow: typeof source.workflowName === 'string' ? source.workflowName : undefined,
      runUrl,
    };
    const identity = `${taskId}:${e.sha}:${runUrl ?? e.id}:${e.environment ?? ''}`;
    const previous = deliveries.get(identity);
    if (!previous || delivery.at > previous.at) deliveries.set(identity, delivery);
  }
  agents.sort((a, b) => a.id.localeCompare(b.id));
  if (agents.some((a) => a.state === 'unknown'))
    warnings.push('部分 Agent 尚无新鲜运行观测；任务租约不等于模型正在运行。');
  if (list.some((h) => h.state === 'online' && !h.metrics))
    warnings.push('部分主机尚未上报资源指标，请更新对应执行端。');
  const blocked = new Set(input.tasks.filter((t) => t.state === 'blocked').map((t) => key(t.id)));
  for (const q of input.board.unassigned) if (q.blocked) blocked.add(q.taskId);
  return {
    at: now,
    hosts: list,
    agents,
    transfers: transfers.slice(-60),
    events: events.slice(0, 40),
    deliveries: [...deliveries.values()].sort((a, b) => b.at - a.at).slice(0, 12),
    warnings,
    summary: {
      hosts: list.filter((h) => h.id !== 'unassigned').length,
      onlineHosts: list.filter((h) => h.state === 'online').length,
      agents: agents.length,
      runningAgents: agents.filter((a) => a.state === 'running').length,
      idleAgents: agents.filter((a) => a.state === 'idle').length,
      tasks: input.tasks.filter((t) => ['doing', 'review'].includes(t.state)).length,
      queued: input.tasks.filter((t) => ['ready', 'planned'].includes(t.state)).length,
      blocked: blocked.size,
    },
  };
}

export async function readRuntimeDashboard(db: Surreal): Promise<RuntimeDashboard> {
  const read = async (sql: string, vars?: Record<string, unknown>): Promise<Row[]> =>
    (await db.query<[Row[]]>(sql, vars))[0] ?? [];
  // 核心数据失败则整次失败，让页面保留旧快照并明确报错；不把失败伪装为零。
  const [board, employees, beats, telemetry, tasks, sent, audits, executions, evidence] =
    await Promise.all([
      readBoard(db),
      read(
        'SELECT id, runner_id, runtime_at, runtime_state, runtime_model FROM employee WHERE revoked != true AND retired != true;',
      ),
      read('SELECT runner, host, version, at FROM runner_heartbeat;'),
      read('SELECT runner, node, at, metrics FROM company_meta WHERE kind = "runner_telemetry";'),
      read(
        'SELECT id, title, state, parent, executor_role, reviewer_role, acceptance_head, acceptance_attempt FROM task;',
      ),
      read(
        'SELECT id, task, sent_to, sent_at, step FROM outbound_message WHERE state = "sent" AND step IN ["execute", "review", "rework"] ORDER BY sent_at DESC LIMIT 240;',
      ),
      read(
        'SELECT id, task, actor, action, at FROM audit WHERE action IN ["claim", "checkpoint", "submit", "return", "accept", "block", "owner_approve"] ORDER BY at DESC LIMIT 40;',
      ),
      read('SELECT tasks FROM requirement_execution;'),
      read(
        'SELECT id, task, sha, attempt, environment, source, verified, verifier, at FROM acceptance_evidence WHERE verified = true AND verifier = "github-actions" ORDER BY at DESC LIMIT 100;',
      ),
    ]);
  const ids = board.employees.filter((e) => e.now.state === 'leased').map((e) => e.id);
  const current = ids.length
    ? (
        await Promise.all(
          ids.map((employee) =>
            read(
              'SELECT id, task, sent_to, sent_at, body, sent_body FROM outbound_message WHERE state = "sent" AND sent_to = $employee ORDER BY sent_at DESC LIMIT 1;',
              { employee },
            ),
          ),
        )
      ).flat()
    : [];
  return buildRuntimeDashboard({
    board,
    employees,
    beats,
    telemetry,
    tasks,
    sent,
    current,
    audits,
    executions,
    evidence,
  });
}
