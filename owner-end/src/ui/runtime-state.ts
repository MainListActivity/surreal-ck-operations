import { useEffect, useState } from 'preact/hooks';
import type { RuntimeDashboard } from '../../../src/runtime-dashboard.ts';

// 与执行端 RUNNER_STALE_MS 一致；到期只重绘，不请求任何接口。
export const OBSERVATION_TTL = 90_000;
export function useObservationClock(timestamps: Array<number | undefined>, paused = false) {
  const [now, setNow] = useState(Date.now);
  const deadlines = timestamps
    .filter((v): v is number => v !== undefined)
    .map((at) => at + OBSERVATION_TTL + 1);
  const key = deadlines.join(',');
  useEffect(() => {
    if (!paused) setNow(Date.now());
  }, [key, paused]);
  useEffect(() => {
    if (paused) return;
    const next = Math.min(...deadlines.filter((at) => at > now));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [key, now, paused]);
  return now;
}

export function expireObservations(data: RuntimeDashboard, now: number): RuntimeDashboard {
  if (data.sample) return data;
  const stale = (at?: number) => at === undefined || now - at > OBSERVATION_TTL;
  const hosts = data.hosts.map((h) =>
    h.state === 'online' && stale(h.at)
      ? { ...h, state: 'offline' as const, metrics: undefined }
      : h,
  );
  const online = new Set(hosts.filter((h) => h.state === 'online').map((h) => h.id));
  const agents = data.agents.map((a) =>
    stale(a.observedAt) || !online.has(a.hostId) ? { ...a, state: 'unknown' as const } : a,
  );
  return {
    ...data,
    hosts,
    agents,
    summary: {
      ...data.summary,
      onlineHosts: online.size,
      runningAgents: agents.filter((a) => a.state === 'running').length,
      idleAgents: agents.filter((a) => a.state === 'idle').length,
    },
  };
}
