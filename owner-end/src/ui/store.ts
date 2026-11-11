/**
 * 外壳与首页、项目页共用的数据：运行大盘快照、需求池、任务列表、派工开关。
 * 每份数据整页只读一份；多个组件同时订阅时合并读取，LIVE 变化后统一刷新。
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RuntimeDashboard } from '../../../src/runtime-dashboard.ts';
import type { Requirement } from '../../../src/iteration/requirements.ts';
import { outcomeText, readDashboard, runCommand, type Outcome } from './api.ts';
import { subscribeLive } from './realtime.ts';
import { expireObservations, useObservationClock } from './runtime-state.ts';

export interface Shared<T> {
  data?: T;
  error: string;
  reload(): Promise<void>;
}

/**
 * 一份共享数据：读取合并，结果广播给所有使用者。整份数据只挂一条实时监听（不论有几个组件在用），
 * 相关表变化时读一次；最后一个使用者离开时撤掉监听。
 */
export function sharedSource<T>(read: () => Promise<Outcome<T>>, fallbackError: string, tables: readonly string[]) {
  let data: T | undefined;
  let error = '';
  let running: Promise<void> | undefined;
  let again = false;
  let off: (() => void) | undefined;
  const subscribers = new Set<() => void>();
  const notify = () => { for (const fn of subscribers) fn(); };
  const load = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          const out = await read().catch(() => undefined);
          if (!out) error = fallbackError;
          else if (out.kind === 'ok') { data = out.result; error = ''; }
          else error = outcomeText(out, '') || fallbackError;
          notify();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  /** 加入一个使用者；返回离开函数。第一个使用者挂上实时监听，并在还没有数据时读取一次。 */
  const attach = (fn: () => void): (() => void) => {
    subscribers.add(fn);
    off ??= subscribeLive((changed) => {
      if (changed.includes('*') || tables.some((t) => changed.includes(t))) void load();
    });
    if (data === undefined && !running) void load();
    return () => {
      subscribers.delete(fn);
      if (!subscribers.size) { off?.(); off = undefined; }
    };
  };
  return {
    attach,
    use(): Shared<T> {
      const [, setTick] = useState(0);
      useEffect(() => attach(() => setTick((t) => t + 1)), []);
      return { data, error, reload: load };
    },
    reset() { data = undefined; error = ''; },
  };
}

export const DASHBOARD_TABLES = [
  'agent_activity', 'task', 'project', 'employee', 'audit', 'runner_heartbeat', 'company_meta',
  'outbound_message', 'product_requirement', 'requirement_plan', 'requirement_execution', 'acceptance_evidence',
];

const dashboard = sharedSource<RuntimeDashboard>(readDashboard, '公司运行数据读取失败', DASHBOARD_TABLES);
export const useDashboard = () => dashboard.use();

/**
 * 大盘快照加上观测过期：心跳超过有效期的电脑与员工显示为离线/未知。
 * 执行端掉线时不会再有 LIVE 事件，所以按心跳截止时间本地重绘，不发请求。
 */
export function useLiveDashboard(): Shared<RuntimeDashboard> {
  const shared = dashboard.use();
  const raw = shared.data;
  const now = useObservationClock(raw ? [...raw.hosts.map((h) => h.at), ...raw.agents.map((a) => a.observedAt)] : [], raw?.sample);
  const data = useMemo(() => (raw ? expireObservations(raw, now) : undefined), [raw, now]);
  return { ...shared, data };
}

/** 需求加上执行阶段（只对实施中与上线核验中的需求读取），用于区分受阻与正常推进，与需求池列表的口径一致。 */
export type RequirementRow = Requirement & { stage?: string };
const requirements = sharedSource<RequirementRow[]>(async () => {
  const out = await runCommand<{ requirements: Requirement[] }>('requirement.list');
  if (out.kind !== 'ok') return out;
  const rows: RequirementRow[] = out.result.requirements.map((r) => ({ ...r }));
  const active = rows.filter((r) => r.state === 'release_pending' || r.state === 'implementing').slice(0, 20);
  await Promise.all(active.map(async (r) => {
    const ex = await runCommand<{ execution: { stage: string } | null }>('requirement.execution', { id: r.id }).catch(() => undefined);
    if (ex?.kind === 'ok' && ex.result.execution?.stage) r.stage = ex.result.execution.stage;
  }));
  return { kind: 'ok', result: rows };
}, '需求读取失败', ['product_requirement', 'requirement_execution']);
export const useRequirements = () => requirements.use();

export interface TaskSummary {
  id?: unknown;
  title?: string;
  state?: string;
  executor_role?: string;
  reviewer_role?: string;
  [key: string]: unknown;
}
const tasks = sharedSource<TaskSummary[]>(async () => {
  const out = await runCommand<{ tasks?: TaskSummary[] }>('task.list');
  return out.kind === 'ok' ? { kind: 'ok', result: out.result.tasks ?? [] } : out;
}, '任务读取失败', ['task']);
export const useTasks = () => tasks.use();

const dispatch = sharedSource<{ paused: boolean }>(async () => {
  const out = await runCommand<{ paused?: boolean }>('status');
  return out.kind === 'ok' ? { kind: 'ok', result: { paused: out.result.paused === true } } : out;
}, '派工状态读取失败', ['company_meta']);
export const useDispatch = () => dispatch.use();

/** 退出登录时清空缓存，避免下一位登录者看到上一份数据。 */
export function resetShared(): void {
  dashboard.reset();
  requirements.reset();
  tasks.reset();
  dispatch.reset();
}
