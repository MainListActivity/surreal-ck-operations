import type {
  RuntimeAgentView,
  RuntimePendingMessage,
} from './runtime-dashboard.ts';
import {
  estimateRemaining,
  type PhaseDuration,
  type RuntimeEstimate,
} from './runtime-timing.ts';

export interface RuntimeProgress {
  done?: number;
  total?: number;
  percent?: number;
  label: string;
  detail: string;
}
export interface RuntimeProjectView {
  id: string;
  name: string;
  progress: RuntimeProgress;
  estimate: RuntimeEstimate;
  estimateReason?: string;
  queued: number;
  blocked: number;
  pendingMessages: RuntimePendingMessage[];
}
type Row = Record<string, any>;
export const recordKey = (v: any): string =>
  String(v && typeof v === 'object' && 'id' in v ? v.id : (v ?? ''))
    .replace(/^(employee|task|project|product_requirement):/, '')
    .replace(/^⟨|⟩$/g, '');
const completionPercent = (done: number, total: number) =>
  done === total ? 100 : Math.min(99, Math.round((done / total) * 100));

export function employeeProgress(
  agent: Pick<RuntimeAgentView, 'activity'>,
): RuntimeProgress {
  const c = agent.activity?.checklist;
  if (
    c &&
    Number.isInteger(c.done) &&
    Number.isInteger(c.total) &&
    c.total > 0 &&
    c.done >= 0 &&
    c.done <= c.total
  ) {
    return {
      done: c.done,
      total: c.total,
      percent: completionPercent(c.done, c.total),
      label: '本轮工作清单',
      detail: '来自 Agent 成功更新的清单；清单完成不等于任务已验收',
    };
  }
  return { label: '本轮工作进度', detail: '尚未上报可量化的工作清单' };
}

/** A project includes confirmed scope, including planned steps not materialized as task records yet. */
export function buildProjectRooms(input: {
  projects?: Row[];
  tasks: Row[];
  requirements?: Row[];
  plans?: Row[];
  executions?: Row[];
  agents: RuntimeAgentView[];
  messages: RuntimePendingMessage[];
  history: PhaseDuration[];
}): RuntimeProjectView[] {
  const groups = new Map<string, { name: string; tasks: Row[] }>();
  for (const p of input.projects ?? [])
    groups.set(recordKey(p.id), {
      name: String(p.name || recordKey(p.id)),
      tasks: [],
    });
  for (const t of input.tasks) {
    // Submitted proposals are not confirmed scope until independent review activates them.
    if (t.state === 'void' || (t.state === 'planned' && t.proposed_in))
      continue;
    const id = recordKey(t.project_ref ?? t.project) || 'company-unassigned';
    const g = groups.get(id) ?? {
      name: String(
        t.project_name || (id === 'company-unassigned' ? '公司公共事务' : id),
      ),
      tasks: [],
    };
    g.tasks.push(t);
    groups.set(id, g);
  }
  for (const a of input.agents) {
    const onDuty =
      a.taskState === 'blocked' ||
      ['running', 'error'].includes(a.state) ||
      (a.state === 'waiting' && !!a.taskId) ||
      (a.state === 'unknown' && !!a.taskId);
    if (!onDuty) continue;
    const id = a.project?.id ?? 'company-unassigned';
    if (!groups.has(id))
      groups.set(id, { name: a.project?.name ?? '公司公共事务', tasks: [] });
  }
  const approved = (input.requirements ?? []).filter(
    (r) =>
      r.approved_revision != null &&
      [
        'queued',
        'implementing',
        'release_pending',
        'released',
        'paused',
      ].includes(r.state),
  );
  for (const r of approved) {
    const id = recordKey(r.project);
    if (id && !groups.has(id)) groups.set(id, { name: id, tasks: [] });
  }
  return [...groups]
    .map(([id, g]) => {
      const requirements = approved.filter((r) => recordKey(r.project) === id);
      let missing = 0,
        incompleteScope = false,
        brokenScope = 0;
      for (const r of requirements) {
        const plan = input.plans?.find(
          (p) =>
            recordKey(p.requirement) === recordKey(r.id) &&
            p.revision === r.approved_revision,
        );
        const execution = input.executions?.find(
          (e) =>
            recordKey(e.requirement) === recordKey(r.id) &&
            e.revision === r.approved_revision,
        );
        try {
          const steps = JSON.parse(plan?.body ?? '{}').steps;
          if (!Array.isArray(steps) || !steps.length) {
            incompleteScope = true;
            continue;
          }
          const executionIds = [
            ...new Set((execution?.tasks ?? []).map(recordKey)),
          ];
          const materialized = executionIds.filter((t) =>
            g.tasks.some((row) => recordKey(row.id) === t),
          );
          // A deleted/voided step already in the execution chain cannot be treated as ordinary future work.
          if (materialized.length < executionIds.length) brokenScope++;
          missing += Math.max(0, steps.length + 2 - materialized.length); // plan check + steps + merge/production verification
        } catch {
          incompleteScope = true;
        }
      }
      const total = g.tasks.length + missing,
        done = g.tasks.filter((t) => t.state === 'done').length;
      const pending = g.tasks.filter((t) => t.state !== 'done');
      const blocked =
        pending.filter((t) => t.state === 'blocked').length + brokenScope;
      const queued =
        pending.filter((t) => ['ready', 'planned'].includes(t.state)).length +
        missing;
      const progress: RuntimeProgress = {
        done,
        total,
        label: '已确认范围 · 验收进度',
        percent:
          !incompleteScope && total > 0
            ? completionPercent(done, total)
            : undefined,
        detail: incompleteScope
          ? '已确认需求尚未完成拆解，范围仍在确定'
          : total
            ? `${done}/${total} 项已验收${missing ? `，含 ${missing} 项尚未派工的计划` : ''}`
            : '尚无已确认的任务',
      };
      let estimate: RuntimeEstimate = { status: 'unavailable', samples: 0 };
      let estimateReason = incompleteScope
        ? '范围未确定'
        : brokenScope
          ? '实施链包含缺失或已作废任务'
          : blocked
            ? '存在阻塞'
            : requirements.some((r) => r.state === 'paused')
              ? '需求已暂停'
              : queued
                ? '包含排队或尚未创建的任务'
                : !total
                  ? '尚无任务'
                  : undefined;
      if (!estimateReason && pending.length) {
        const ranges: RuntimeEstimate[] = [];
        for (const t of pending) {
          const a = input.agents.find((a) => a.taskId === recordKey(t.id));
          if (
            !a ||
            a.state !== 'running' ||
            (a.activity && a.activity.state !== 'running') ||
            a.estimate?.status !== 'estimated'
          ) {
            estimateReason = '执行状态或历史样本不足';
            break;
          }
          let range = { ...a.estimate };
          if (a.phase !== 'review') {
            const review = estimateRemaining(
              {
                task: recordKey(t.id),
                phase: 'review',
                project: id,
                role: t.reviewer_role ?? '',
                kind: t.kind ?? '',
              },
              0,
              input.history,
            );
            if (review.status !== 'estimated') {
              estimateReason = '后续独立复核耗时尚无法估计';
              break;
            }
            range = {
              status: 'estimated',
              samples: Math.min(range.samples, review.samples),
              lowerSeconds: range.lowerSeconds! + review.lowerSeconds!,
              upperSeconds: range.upperSeconds! + review.upperSeconds!,
            };
          }
          ranges.push(range);
        }
        // Best case parallel, conservative serial upper bound; never average employee percentages/ETAs.
        if (!estimateReason && ranges.length)
          estimate = {
            status: 'estimated',
            samples: Math.min(...ranges.map((r) => r.samples)),
            lowerSeconds: Math.max(...ranges.map((r) => r.lowerSeconds!)),
            upperSeconds: ranges.reduce((sum, r) => sum + r.upperSeconds!, 0),
          };
      } else if (!estimateReason && !pending.length)
        estimateReason = '当前范围已验收';
      const taskIds = new Set(g.tasks.map((t) => recordKey(t.id)));
      return {
        id,
        name: g.name,
        progress,
        estimate,
        estimateReason,
        queued,
        blocked,
        pendingMessages: input.messages.filter((m) => taskIds.has(m.taskId)),
      };
    })
    .sort((a, b) => b.blocked - a.blocked || a.name.localeCompare(b.name));
}
