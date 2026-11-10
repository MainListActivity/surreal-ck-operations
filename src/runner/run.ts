import { join, isAbsolute } from 'node:path';
import { readFileSync, accessSync, constants } from 'node:fs';
import { installNodeHost } from '../host-node.ts';
import { configureCompanyRuntime, company, noteHost } from './company.ts';
import { startDispatch } from './dispatch.ts';
import { loadServiceEnv, serviceHome } from './env.ts';
import { NativeRuntime, type NativeProvider } from './native.ts';
import { RuntimeEventsBus } from './events.ts';
import type { RuntimeHost } from './host.ts';
import { scrubEnv, SANDBOX_MARKER, installZdot, userZshDir, externalPatterns } from './launch-env.ts';
import { employeeModelEnv } from './model-env.ts';

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
};
for (const [provider, command] of Object.entries(config.commands ?? {})) {
  if (!['factory-droid', 'claude', 'codex'].includes(provider) || !Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string') || !isAbsolute(command[0]!)) {
    throw new Error('原生执行端 commands 配置无效；每个命令必须是以绝对路径开头的参数数组');
  }
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
const zdotdir = join(serviceHome(), 'zdot');
installZdot(zdotdir, userZshDir(zdotdir), externalPatterns());
let bus: RuntimeEventsBus;
const runtime = new NativeRuntime({ root: join(serviceHome(), 'native', hostId), host: hostId,
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
    const modelEnv = employeeModelEnv({ agentId: session.id, provider: session.provider, env: channel }, ctx.sidecar, serviceHome());
    const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return { ...inherited, ...scrubEnv(channel), ...SANDBOX_MARKER, ...modelEnv, PASEO_AGENT_ID: "", ZDOTDIR: zdotdir };
  },
  onStarted: session => { void bus.emit('agent.turn_started', { agent: session, turnId: session.turnId }).catch(() => console.warn('回合开始事件处理失败')); },
  onEnded: event => bus.emit('agent.turn_ended', event),
});
const host: RuntimeHost = {
  providers: {
    // 原生 CLI 没有统一订阅查询入口；额度继续由现有 Magpie 观测链提供，未知时不伪造数值。
    listUsage: async () => ({ providers: [] }),
    listModels: async provider => ({ models: (config.models?.[provider as NativeProvider] ?? []).map(id => ({ id })) }),
  },
  agents: { ref: id => ({ send: prompt => runtime.send(id, prompt),
    refresh: async () => ({ agent: runtime.describe(id) }),
    respondToPermission: async () => { throw new Error('原生单轮执行不支持交互权限应答；按 CLI 终态报错'); },
  }) },
};
bus = new RuntimeEventsBus(host);
configureCompanyRuntime({ gateway: runtime, native: true, providers: Object.keys(config.commands), runner: { id: `native:${hostId}`, adoptLegacy: false } });
noteHost(host);
let stop: import('./dispatch.ts').RunnerControl | undefined;
try {
  const ctx = await company();
  stop = startDispatch(bus);
  await runtime.recoverFinishedTurns();
  console.log(`原生执行端 ${hostId} 已启动；支持 ${Object.keys(config.commands).join(', ')}`);
  await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  stop();
  await stop.done;
  await runtime.close();
  ctx.sidecar.close();
  await ctx.db.close();
} finally { stop?.(); await runtime.close(); }
