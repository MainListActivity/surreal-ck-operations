/**
 * 外壳与首页、项目页共用的数据：运行大盘快照、需求池、任务列表、派工开关。
 * 每份数据整页只读一份；多个组件同时订阅时合并读取，LIVE 变化后统一刷新。
 */
import { useEffect, useState } from 'preact/hooks';
import type { RuntimeDashboard } from '../../../src/runtime-dashboard.ts';
import type { Requirement } from '../../../src/iteration/requirements.ts';
import { outcomeText, readDashboard, runCommand, type Outcome } from './api.ts';
import { useLiveRefresh } from './realtime.ts';

export interface Shared<T> {
  data?: T;
  error: string;
  reload(): Promise<void>;
}

/** 一份共享数据：读取合并，结果广播给所有使用者。 */
function sharedSource<T>(read: () => Promise<Outcome<T>>, fallbackError: string) {
  let data: T | undefined;
  let error = '';
  let running: Promise<void> | undefined;
  let again = false;
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
  return {
    use(tables: string[], enabled = true): Shared<T> {
      const [, setTick] = useState(0);
      useEffect(() => {
        const fn = () => setTick((t) => t + 1);
        subscribers.add(fn);
        if (data === undefined) void load();
        return () => { subscribers.delete(fn); };
      }, []);
      useLiveRefresh(tables, load, enabled);
      return { data, error, reload: load };
    },
    reset() { data = undefined; error = ''; },
  };
}

export const DASHBOARD_TABLES = [
  'agent_activity', 'task', 'project', 'employee', 'audit', 'runner_heartbeat', 'company_meta',
  'outbound_message', 'product_requirement', 'requirement_plan', 'requirement_execution', 'acceptance_evidence',
];

const dashboard = sharedSource<RuntimeDashboard>(readDashboard, '公司运行数据读取失败');
export const useDashboard = (enabled = true) => dashboard.use(DASHBOARD_TABLES, enabled);

const requirements = sharedSource<Requirement[]>(async () => {
  const out = await runCommand<{ requirements: Requirement[] }>('requirement.list');
  return out.kind === 'ok' ? { kind: 'ok', result: out.result.requirements } : out;
}, '需求读取失败');
export const useRequirements = () => requirements.use(['product_requirement', 'requirement_execution']);

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
}, '任务读取失败');
export const useTasks = () => tasks.use(['task']);

const dispatch = sharedSource<{ paused: boolean }>(async () => {
  const out = await runCommand<{ paused?: boolean }>('status');
  return out.kind === 'ok' ? { kind: 'ok', result: { paused: out.result.paused === true } } : out;
}, '派工状态读取失败');
export const useDispatch = () => dispatch.use(['company_meta']);

/** 退出登录时清空缓存，避免下一位登录者看到上一份数据。 */
export function resetShared(): void {
  dashboard.reset();
  requirements.reset();
  tasks.reset();
  dispatch.reset();
}
