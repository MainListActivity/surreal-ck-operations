import { join, isAbsolute, dirname } from 'node:path';
import { readFileSync, accessSync, constants, realpathSync } from 'node:fs';
import { installNodeHost } from '../host-node.ts';
import { configureCompanyRuntime, company, noteHost } from './company.ts';
import { startDispatch } from './dispatch.ts';
import { loadNativeOwnerCredential, loadServiceEnv, serviceHome } from './env.ts';
import { NativeRuntime, type NativeProvider } from './native.ts';
import { isLaneProvider, LANE_PROVIDERS, type LaneProvider } from './native-args.ts';
import { julesUsageEntry, readCodexCloudUsage } from './cloud-lane/quota.ts';
import type { LaneConfig } from './cloud-lane/lane.ts';
import { RuntimeEventsBus } from './events.ts';
import type { RuntimeHost } from './host.ts';
import { scrubEnv, SANDBOX_MARKER, installZdot, userZshDir, externalPatterns } from './launch-env.ts';
import { employeeModelEnv } from './model-env.ts';
import { writeAgentActivity } from './activity-store.ts';

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
for (const [provider, lane] of Object.entries(config.lanes ?? {})) {
  if (!isLaneProvider(provider) || !lane || typeof lane !== 'object')
    throw new Error('原生执行端 lanes 配置无效：只允许 codex-cloud、devin-cloud、jules');
  for (const [key, value] of Object.entries(lane)) {
    if (key === 'environments') {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.entries(value as Record<string, unknown>).some(([repo, env]) => !/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof env !== 'string' || !env))
        throw new Error(`lanes.${provider}.environments 必须是 "owner/repo" → 环境 ID/标签 的映射`);
    } else if (!['dailyLimit', 'maxConcurrent', 'maxMinutes', 'pollMs'].includes(key) || typeof value !== 'number' || !(value > 0))
      throw new Error(`lanes.${provider}.${key} 必须是正数`);
  }
}
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
const installedPath = installed ? realpathSync(join(serviceHome(), 'current')) : undefined;
const release = installedPath ? JSON.parse(readFileSync(join(dirname(installedPath), 'release.json'), 'utf8')) : undefined;
let draining = false;
let endService!: () => void;
const serviceEnded = new Promise<void>(resolve => { endService = resolve; });
const runtime = new NativeRuntime({ root: join(serviceHome(), 'native', hostId), host: hostId,
  onHeartbeat: async () => {
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
    const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const lane = isLaneProvider(session.provider) ? {
      SCK_LANE_CONFIG: JSON.stringify(config.lanes?.[session.provider as LaneProvider] ?? {}),
      SCK_LANE_STATE_ROOT: laneStateRoot,
      ...laneSecretEnv(session.provider),
    } : {};
    return { ...inherited, ...scrubEnv(channel), ...SANDBOX_MARKER, ...modelEnv, ...lane, PASEO_AGENT_ID: "", ZDOTDIR: zdotdir };
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
try {
  ctx = await company();
  const principal = await ctx.core.authenticate(process.env.SCK_OWNER_TOKEN!);
  if (principal.role !== 'owner') throw new Error('原生执行端老板凭证身份不匹配，拒绝启动');
  stop = startDispatch(bus);
  await runtime.recoverFinishedTurns();
  console.log(`原生执行端 ${hostId} 已启动；支持 ${Object.keys(config.commands).join(', ')}`);
  process.once('SIGTERM', endService); process.once('SIGINT', endService);
  await serviceEnded;
} finally {
  stop?.();
  await stop?.done;
  await runtime.close();
  ctx?.sidecar.close();
  await ctx?.db.close();
}
