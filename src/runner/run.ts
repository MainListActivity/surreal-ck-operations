import { join, isAbsolute, dirname } from 'node:path';
import { readFileSync, accessSync, constants, realpathSync } from 'node:fs';
import { installNodeHost } from '../host-node.ts';
import { configureCompanyRuntime, company, noteHost } from './company.ts';
import { startDispatch } from './dispatch.ts';
import { loadNativeOwnerCredential, loadServiceEnv, serviceHome } from './env.ts';
import { NativeRuntime, type NativeProvider } from './native.ts';
import { isLaneProvider, LANE_PROVIDERS, type LaneProvider } from './native-args.ts';
import { julesUsageEntry, readCodexCloudUsage } from './cloud-lane/quota.ts';
import { validateLanes, type LaneConfig } from './cloud-lane/lane.ts';
import { RuntimeEventsBus } from './events.ts';
import type { RuntimeHost } from './host.ts';
import { installZdot, userZshDir, externalPatterns } from './launch-env.ts';
import { nativeEmployeeEnv } from './native-env.ts';
import { employeeModelEnv } from './model-env.ts';
import { writeAgentActivity } from './activity-store.ts';
import { awaitingConfirmation, confirmSwitch, settlePending, type SettleDeps } from '../node-updater.ts';
import { nodeCloud } from '../node-update-sources.ts';
import { startSelfUpdate } from './self-update.ts';
import { startPreviewHost, type PreviewHost } from './preview-host.ts';
import { createOwnerHttp } from './owner-http.ts';

installNodeHost();
loadServiceEnv();
const hostId = process.env.SCK_RUNNER_ID;
if (!hostId || !/^[a-zA-Z0-9_-]+$/.test(hostId)) throw new Error('原生执行端要求稳定且唯一的 SCK_RUNNER_ID（字母、数字、_、-）');
// 与兼容插件分开通道/草稿/回收目录，两个执行端不会清扫彼此仍在使用的文件。
process.env.SCK_COMM_ROOT = join(serviceHome(), 'native', hostId, 'comm');
const configPath = process.env.SCK_NATIVE_CONFIG;
if (!configPath || !isAbsolute(configPath)) throw new Error('SCK_NATIVE_CONFIG 必须指向原生执行端配置的绝对路径');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  commands: Partial<Record<NativeProvider, string[]>>;
  isolation?: "external";
  models?: Partial<Record<NativeProvider, string[]>>;
  lanes?: Partial<Record<LaneProvider, LaneConfig>>;
};
for (const [provider, command] of Object.entries(config.commands ?? {})) {
  if (!['factory-droid', 'claude', 'codex', ...LANE_PROVIDERS].includes(provider) || !Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string') || !isAbsolute(command[0]!)) {
    throw new Error('原生执行端 commands 配置无效；每个命令必须是以绝对路径开头的参数数组');
  }
}
validateLanes(config.lanes);
// 通道级状态目录：桥接进程（沙箱内可写）与额度读取（沙箱外可读）共用。
const laneStateRoot = join(serviceHome(), 'native', hostId, 'lanes');
/** 通道供应商的私密环境变量：沙箱外由执行端读取 private/lanes/<provider>.env（KEY=VALUE），桥接进程只继承变量不读文件。 */
function laneSecretEnv(provider: string): Record<string, string> {
  if (!isLaneProvider(provider)) return {};
  try {
    const env: Record<string, string> = {};
    for (const line of readFileSync(join(serviceHome(), 'private', 'lanes', `${provider}.env`), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m?.[2]) env[m[1]] = m[2];
    }
    return env;
  } catch { return {}; }
}
if (process.platform === 'darwin') {
  for (const command of Object.values(config.commands)) {
    if (command?.[0] !== join(serviceHome(), 'sandbox', 'launch.sh') || !command[1] || !isAbsolute(command[1]))
      throw new Error('Mac 原生执行必须通过已安装的员工 sandbox/launch.sh 启动绝对路径 CLI');
  }
  accessSync(join(serviceHome(), 'sandbox', 'employee.sb'), constants.R_OK);
} else if (config.isolation !== 'external') {
  throw new Error('远程原生执行要求显式配置 isolation=external，并由容器或沙箱启动命令提供员工隔离');
}
if (!Object.keys(config.commands ?? {}).length) throw new Error('至少配置一个原生执行命令');
loadNativeOwnerCredential();
const zdotdir = join(serviceHome(), 'zdot');
installZdot(zdotdir, userZshDir(zdotdir), externalPatterns());
let bus: RuntimeEventsBus;
// Installed services follow the already verified current release; development runs remain pinned to their checkout.
const installed = process.env.SCK_NATIVE_FOLLOW_CURRENT === '1';
// 自更新切换后的首次启动：限定时间内没完成确认就退出，交给启动脚本计数，连续失败后由它指回旧版本。
const CONFIRM_WATCHDOG_MS = 15 * 60_000;
let awaitingConfirm = installed && awaitingConfirmation(serviceHome());
const confirmWatchdog = awaitingConfirm ? setTimeout(() => {
  console.error('新版本未在 15 分钟内完成启动确认，退出交给启动脚本处理');
  process.exit(1);
}, CONFIRM_WATCHDOG_MS) : undefined;
let settleDeps: SettleDeps | undefined;
const installedPath = installed ? realpathSync(join(serviceHome(), 'current')) : undefined;
const release = installedPath ? JSON.parse(readFileSync(join(dirname(installedPath), 'release.json'), 'utf8')) : undefined;
let draining = false;
let endService!: () => void;
const serviceEnded = new Promise<void>(resolve => { endService = resolve; });
const runtime = new NativeRuntime({ root: join(serviceHome(), 'native', hostId), host: hostId,
  // 本机公司工具 MCP：claude/codex 员工经 `sck mcp` stdio 子进程拿到同名工具（droid/lane 不注入）。
  companyMcp: { command: process.env.SCK_TOOL_BIN ?? join(serviceHome(), 'bin', 'sck') },
  onHeartbeat: async () => {
    // 首个心跳说明已连上云端且派工在跑：确认这次切换（schema 不满足时 confirmSwitch 自己指回旧版本，下面随即排空）。
    if (awaitingConfirm && settleDeps) {
      awaitingConfirm = false;
      const confirmed = await confirmSwitch(settleDeps).catch(error => { console.error(`切换确认失败：${(error as Error).message}`); return 'none' as const; });
      if (confirmWatchdog) clearTimeout(confirmWatchdog);
      console.log(`[自更新] 启动确认：${confirmed}`);
    }
    if (!installedPath || realpathSync(join(serviceHome(), 'current')) === installedPath) return;
    draining = true;
    const agents = await runtime.list();
    if ([...agents.values()].some(a => ['running', 'starting', 'unknown'].includes(a.status))) return;
    const ctx = await company();
    const ids = (await ctx.workforce.insts()).map(i => i.id);
    const [held] = await ctx.db.db.query<[unknown[]]>(`SELECT id FROM task WHERE current_employee IN $ids AND lease_expires_at > time::unix(time::now()) LIMIT 1;`, {ids});
    if (!held?.length) endService();
  },
  command(provider) {
    const command = config.commands[provider];
    if (!command) throw new Error(`本节点没有配置 ${provider} 的员工沙箱命令`);
    return command;
  },
  environment: async session => {
    const ctx = await company();
    const inst = (await ctx.workforce.insts()).find(i => i.id === session.labels.employee_id);
    if (!inst || !ctx.sidecar.canReuse(inst)) throw new Error('员工身份或 sidecar 通道不可用');
    const channel = ctx.sidecar.env(inst);
    const modelEnv = employeeModelEnv({ agentId: session.id, provider: session.provider, env: channel, runtime: 'native' }, ctx.sidecar, serviceHome());
    const lane = isLaneProvider(session.provider) ? {
      SCK_LANE_CONFIG: JSON.stringify(config.lanes?.[session.provider as LaneProvider] ?? {}),
      SCK_LANE_STATE_ROOT: laneStateRoot,
      ...laneSecretEnv(session.provider),
    } : {};
    return nativeEmployeeEnv({ inherited: process.env, channel, modelEnv, lane, zdotdir });
  },
  onStarted: async session => { await bus.emit('agent.turn_started', { agent: session, turnId: session.turnId }); await uploadActivity(); },
  onEnded: async event => { await uploadActivity(); await bus.emit('agent.turn_ended', event); },
});
async function uploadActivity(): Promise<void> {
  try {
    const ctx = await company();
    const saved = await writeAgentActivity(ctx.db.db, `native:${hostId}`, runtime.activity());
    for (const value of saved) runtime.acknowledgeActivity(value.agent, value.turn);
  } catch { console.warn('agent activity upload deferred to heartbeat'); }
}
const host: RuntimeHost = {
  providers: {
    // 本地 CLI 没有统一订阅查询入口；云端通道按各自渠道读。读取失败一律 fail open（缺行不等于额度为零）。
    listUsage: async () => {
      const providers: import('./host.ts').ProviderUsage[] = [];
      if (config.commands['codex-cloud']) {
        const entry = await readCodexCloudUsage().catch(() => undefined);
        if (entry) providers.push(entry);
      }
      if (config.commands.jules)
        providers.push(julesUsageEntry(laneStateRoot, config.lanes?.jules?.dailyLimit ?? 100));
      return { fetchedAt: new Date().toISOString(), providers };
    },
    listModels: async provider => ({ models: (config.models?.[provider as NativeProvider] ?? []).map(id => ({ id })) }),
  },
  agents: { ref: id => ({ send: prompt => runtime.send(id, prompt),
    refresh: async () => ({ agent: runtime.describe(id) }),
    respondToPermission: async () => { throw new Error('原生单轮执行不支持交互权限应答；按 CLI 终态报错'); },
  }) },
};
bus = new RuntimeEventsBus(host);
configureCompanyRuntime({ gateway: runtime, native: true, release, requireProviderRoute: installed, dispatchAllowed: () => !draining, providers: Object.keys(config.commands), runner: { id: `native:${hostId}`, adoptLegacy: false } });
noteHost(host);
let stop: import('./dispatch.ts').RunnerControl | undefined;
let ctx: Awaited<ReturnType<typeof company>> | undefined;
let stopSelfUpdate: (() => void) | undefined;
let preview: PreviewHost | undefined;
const runtimeIdle = async () => ![...(await runtime.list()).values()].some(a => ['running', 'starting', 'unknown'].includes(a.status));
try {
  ctx = await company();
  const principal = await ctx.core.authenticate(process.env.SCK_OWNER_TOKEN!);
  if (principal.role !== 'owner') throw new Error('原生执行端老板凭证身份不匹配，拒绝启动');
  if (installed) {
    const home = serviceHome();
    settleDeps = { home, cloud: nodeCloud(ctx.db, ctx.nodeId), now: () => new Date(), log: line => console.log(`[自更新] ${line}`) };
    const settled = await settlePending(settleDeps);
    if (settled.kind !== 'confirming') {
      awaitingConfirm = false;
      if (confirmWatchdog) clearTimeout(confirmWatchdog);
    }
  }
  stop = startDispatch(bus);
  if (installed && process.env.SCK_SELF_UPDATE !== '0') {
    const db = ctx.db, nodeId = ctx.nodeId;
    stopSelfUpdate = startSelfUpdate({ home: serviceHome(), nodeId, db, idle: runtimeIdle,
      onSwitched: () => { draining = true; }, log: line => console.log(line) });
  }
  // 交付预览与老板接口（18777/18778）：sck owner、交付链接与公网隧道都指向这里。
  if (installed && process.env.SCK_PREVIEW_HOST !== '0') {
    const owner = createOwnerHttp({ home: serviceHome(), company });
    preview = startPreviewHost({ home: serviceHome(), ownerFetch: owner,
      statusFetch: async request => (await company()).ops.proofStatus(request) });
  }
  await runtime.recoverFinishedTurns();
  console.log(`原生执行端 ${hostId} 已启动；支持 ${Object.keys(config.commands).join(', ')}`);
  process.once('SIGTERM', endService); process.once('SIGINT', endService);
  await serviceEnded;
} finally {
  stopSelfUpdate?.();
  await preview?.stop();
  stop?.();
  await stop?.done;
  await runtime.close();
  ctx?.sidecar.close();
  await ctx?.db.close();
}
