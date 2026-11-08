// 执行端状态（老板面板的 runner.status）：只汇报连接、令牌到期、最近心跳、执行中作业数与在岗员工数，不做业务判断。
import type { RunnerStatus } from "../shared/runner-status";
import type { Company } from "./company";
import { lastRunnerBeatAt } from "./dispatch";

/** 本机模式没有连接状态可读：心跳每 30 秒一次，两个周期内仍有心跳即视为在线。 */
const LOCAL_ONLINE_MS = 90_000;

export async function runnerStatusOf(ctx: Company, now = Date.now()): Promise<RunnerStatus> {
  const cloud = ctx.db.config.cloud;
  const session = ctx.db.connectionStatus();
  const beatAt = lastRunnerBeatAt();
  let runningJobs = 0;
  try {
    const [rows] = await ctx.db.db.query<[Array<{ n?: number }>]>("SELECT count() AS n FROM ops_job WHERE state = 'running' GROUP ALL;");
    runningJobs = Number(rows?.[0]?.n ?? 0);
  } catch {
    // 作业表读不到时按 0 计，面板其余字段照常显示。
  }
  return {
    mode: cloud ? "token" : "root",
    connected: cloud ? session.connected : beatAt !== undefined && now - beatAt < LOCAL_ONLINE_MS,
    tokenExpiresAt: session.tokenExpiresAt === undefined ? undefined : new Date(session.tokenExpiresAt).toISOString(),
    lastHeartbeatAt: beatAt === undefined ? undefined : new Date(beatAt).toISOString(),
    runningJobs,
    onDutyEmployees: ctx.sidecar.liveInstanceIds().size,
    ownerEndUrl: cloud?.ownerEndUrl,
  };
}
