import { DAILY_CRON, MINUTE_CRON, runScheduled } from './cron.ts';
import { sessionsOf } from './db.ts';
import { readConfig, type Env } from './env.ts';
import { readServerEnvironment } from './server-env.ts';

/** 仅供服务管理器单次调用，不开放定时任务 HTTP 入口。 */
export async function runServerCron(cron: string, env: Env, run: typeof runScheduled = runScheduled): Promise<unknown> {
  if (cron !== MINUTE_CRON && cron !== DAILY_CRON) throw Error('仅支持已配置的分钟和每日 cron');
  const config = readConfig(env);
  return run(config, sessionsOf(config), cron);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw Error('需要唯一的 cron 表达式参数');
    const result = await runServerCron(args[0]!, readServerEnvironment(process.env));
    console.log(JSON.stringify({ cron: args[0], result }));
  } catch {
    console.error('owner API cron 执行失败');
    process.exitCode = 1;
  }
  // 数据库 WebSocket 可能仍持有事件循环；单次任务结束即退出，避免占锁到 systemd 超时。
  process.exit();
}
