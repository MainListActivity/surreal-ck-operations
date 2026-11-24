// 原生执行端自更新：常驻进程按周期检查正式发行版本，空闲且无租约时切换 current，随后排空退出由服务管理器拉起新版本。
// 也负责退役旧的 launchd 定时更新器（它通过 Paseo 插件切换版本，执行端接管后不再需要）。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CompanyDatabase } from '../database.ts';
import { DEFAULT_RELEASE_REPO, githubReleaseSource, nodeCloud, packageTools } from '../node-update-sources.ts';
import { runNodeUpdate, updateLockHeld, type UpdateOutcome } from '../node-updater.ts';
import { redactText } from '../ops/redact.ts';

const execFileAsync = promisify(execFile);
/** 首轮检查在启动后 2 分钟：先让派工与心跳稳定下来。 */
const FIRST_DELAY_MS = 2 * 60_000;
/** 与旧定时更新器同频：每 15 分钟一轮。 */
const INTERVAL_MS = 15 * 60_000;
export const LEGACY_UPDATER_LABEL = 'org.surrealck.node-updater';

export interface SelfUpdateOptions {
  home: string;
  nodeId: string;
  db: CompanyDatabase;
  /** 本执行端没有运行中的会话。 */
  idle(): Promise<boolean>;
  /** current 已切到新版本：调用方停止派工并在排空后退出。 */
  onSwitched(): void;
  log(line: string): void;
  env?: NodeJS.ProcessEnv;
  firstDelayMs?: number;
  intervalMs?: number;
  /** 测试注入：替代 runNodeUpdate 与旧更新器退役。 */
  runOnce?: () => Promise<UpdateOutcome>;
  retire?: () => Promise<unknown>;
}

/** 启动自更新循环，返回停止函数。切换成功后不再安排下一轮。 */
export function startSelfUpdate(options: SelfUpdateOptions): () => void {
  const env = options.env ?? process.env;
  const runOnce = options.runOnce ?? (() => runNodeUpdate({
    home: options.home,
    release: githubReleaseSource(env.SCK_RELEASE_REPO || DEFAULT_RELEASE_REPO, env.SCK_GH_BIN || 'gh'),
    tools: packageTools(env.SCK_PNPM_BIN || 'pnpm'),
    cloud: nodeCloud(options.db, options.nodeId),
    idle: options.idle,
    now: () => new Date(),
    log: line => options.log(`[自更新] ${line}`),
  }));
  const retire = options.retire ?? (() => retireLegacyUpdater({ home: options.home, log: options.log }));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(() => void tick(), Math.max(0, Math.round(ms)));
  };
  const tick = async () => {
    timer = undefined;
    await retire().catch(error => options.log(`[自更新] 退役旧定时更新器失败：${errorText(error)}`));
    let outcome: UpdateOutcome;
    try {
      outcome = await runOnce();
    } catch (error) {
      outcome = { kind: 'failed', reason: errorText(error) };
    }
    options.log(`[自更新] ${summarize(outcome)}`);
    if (outcome.kind === 'switched') {
      stopped = true;
      options.onSwitched();
      return;
    }
    schedule(options.intervalMs ?? INTERVAL_MS);
  };
  schedule(options.firstDelayMs ?? FIRST_DELAY_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * 退役旧定时更新器（macOS launchd）：plist 不存在即已退役；它正持有更新锁时等下一轮，避免打断它正在做的切换。
 * 卸载后 plist 移到 <服务目录>/retired/，需要时可以原样恢复。
 */
export async function retireLegacyUpdater(options: {
  home: string;
  log(line: string): void;
  platform?: string;
  userHome?: string;
  uid?: number;
  launchctl?: (args: string[]) => Promise<void>;
}): Promise<'absent' | 'busy' | 'retired' | 'unsupported'> {
  if ((options.platform ?? process.platform) !== 'darwin') return 'unsupported';
  const plist = join(options.userHome ?? homedir(), 'Library', 'LaunchAgents', `${LEGACY_UPDATER_LABEL}.plist`);
  if (!existsSync(plist)) return 'absent';
  if (updateLockHeld(options.home)) return 'busy';
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const launchctl = options.launchctl ?? (async (args: string[]) => { await execFileAsync('/bin/launchctl', args, { timeout: 60_000 }); });
  try {
    await launchctl(['bootout', `gui/${uid}/${LEGACY_UPDATER_LABEL}`]);
  } catch (error) {
    // 没有加载时 bootout 报错，照常移走 plist。
    options.log(`[自更新] 旧定时更新器未在运行或卸载报错：${errorText(error)}`);
  }
  const retired = join(options.home, 'retired');
  mkdirSync(retired, { recursive: true, mode: 0o700 });
  renameSync(plist, join(retired, `${LEGACY_UPDATER_LABEL}.plist`));
  options.log('[自更新] 已退役旧定时更新器：节点更新由执行端自己完成');
  return 'retired';
}

/** 一行中文摘要。 */
export function summarize(outcome: UpdateOutcome): string {
  switch (outcome.kind) {
    case 'current': return `已是最新 版本=${outcome.version}`;
    case 'no_release': return '没有正式发行版本';
    case 'deferred': return `暂缓 原因=${sanitize(outcome.reason)}`;
    case 'refused': return `拒绝 原因=${sanitize(outcome.reason)}`;
    case 'failed': return `失败 原因=${sanitize(outcome.reason)}`;
    case 'switched': return `已切换 版本=${outcome.version} sha=${outcome.sha}，排空后重启确认`;
  }
}

/** 原因文本：去掉地址与 Bearer 令牌，屏蔽 JWT，压缩空白并限制长度。 */
function sanitize(text: string): string {
  return redactText(text)
    .replace(/\b(?:wss?|https?):\/\/\S+/gi, '<地址已隐藏>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <已隐藏>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || '未知错误';
}

function errorText(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}
