import { cpus, freemem, totalmem, platform, arch } from 'node:os';
import type { Surreal } from 'surrealdb';
import type { HostMetrics } from '../runtime-dashboard.ts';

export interface CpuSample {
  idle: number;
  total: number;
}
export function cpuPercent(
  previous: CpuSample | undefined,
  current: CpuSample,
): number | undefined {
  if (!previous || current.total <= previous.total || current.idle < previous.idle)
    return undefined;
  return Math.max(
    0,
    Math.min(100, 100 * (1 - (current.idle - previous.idle) / (current.total - previous.total))),
  );
}
/** 累积 CPU 时间差；首样本不伪造百分比。内存为系统 used/total（含操作系统缓存）。 */
export function createHostSampler() {
  let previous: CpuSample | undefined;
  return (): HostMetrics => {
    const list = cpus();
    const sample = list.reduce(
      (v, c) => ({
        idle: v.idle + c.times.idle,
        total: v.total + Object.values(c.times).reduce((a, b) => a + b, 0),
      }),
      { idle: 0, total: 0 },
    );
    const percent = cpuPercent(previous, sample);
    previous = sample;
    const memoryTotal = totalmem();
    return {
      platform: platform(),
      arch: arch(),
      cpuModel: list[0]?.model ?? '未知',
      cores: list.length,
      memoryTotal,
      memoryUsed: Math.max(0, memoryTotal - freemem()),
      ...(percent === undefined ? {} : { cpuPercent: percent }),
    };
  };
}
export async function writeRuntimeObservation(
  db: Surreal,
  agent: string,
  state: string,
  at: number,
  model?: string,
) {
  await db.query(
    'UPDATE employee SET runtime_state = $state, runtime_at = $at, runtime_model = $model WHERE paseo_agent_id = $agent AND retired != true AND (runtime_at = NONE OR runtime_at <= $at);',
    { agent, state, at, model },
  );
}
export async function writeHostTelemetry(
  db: Surreal,
  runner: string,
  node: string,
  metrics: HostMetrics,
) {
  await db.query(
    'UPSERT type::record("company_meta", $key) CONTENT {kind: "runner_telemetry", runner: $runner, node: $node, at: time::now(), metrics: $metrics};',
    { key: `telemetry:${runner}`, runner, node, metrics },
  );
}
