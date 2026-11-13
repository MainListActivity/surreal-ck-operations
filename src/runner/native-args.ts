/**
 * 员工会话的启动参数：原生 CLI 的参数（nativeArgs）与无人值守模式。纯函数、不引入任何 Node 模块，
 * 执行端（native.ts、paseo.ts）与老板端页面（员工定义的启动命令预览）共用这一份，预览与实际启动不会走样。
 */

/** 云端员工通道：本地桥接进程把回合转交给供应商云端 agent（Codex Cloud、Devin Cloud、Jules）。 */
// 通道桥接进程（bun main.ts 启动）：云端三家 + warp 本地 agent，事件形状相同（system → lane_status → result）。
export const LANE_PROVIDERS = ['codex-cloud', 'devin-cloud', 'jules', 'warp'] as const;
export type LaneProvider = (typeof LANE_PROVIDERS)[number];
export const isLaneProvider = (provider: string): provider is LaneProvider =>
  (LANE_PROVIDERS as readonly string[]).includes(provider);

export type NativeProvider = 'factory-droid' | 'claude' | 'codex' | LaneProvider;

/** 由执行端原生启动的 CLI；其余 provider（antigravity、devin、grok）经 Paseo 启动。 */
export const NATIVE_PROVIDERS: readonly NativeProvider[] = ['claude', 'factory-droid', 'codex', ...LANE_PROVIDERS];

export const isNativeProvider = (provider: string): provider is NativeProvider => (NATIVE_PROVIDERS as readonly string[]).includes(provider);

/** Paseo mode needed for unattended work; grok exposes no modes. 原生启动沿用同一模式。 */
export const UNATTENDED_MODE: Record<string, string | undefined> = { codex: 'full-access', claude: 'bypassPermissions', devin: 'bypass', 'factory-droid': 'auto-high', 'factory-paseo': 'auto-high' };

/** CLI 参数来自原生非交互入口，不经 ACP，不把 prompt 放在进程参数中。 */
export function nativeArgs(s: { provider: NativeProvider; nativeSessionId?: string; model: string; thinking?: string; mode?: string }): string[] {
  // 云端通道：桥接进程参数（云端任务凭任务 ID 续接，逻辑会话 ID 只标会话）。
  if (isLaneProvider(s.provider)) return [
    ...(s.nativeSessionId ? ['--resume', s.nativeSessionId] : []),
    ...(s.model && s.model !== 'default' ? ['--model', s.model] : [])];
  const model = s.model ? ['--model', s.model] : [];
  if (s.provider === 'factory-droid') return ['exec', '--output-format', 'stream-json', ...model,
    ...(s.mode === 'auto-high' ? ['--auto', 'high'] : []),
    ...(s.thinking ? ['--reasoning-effort', s.thinking] : []),
    ...(s.nativeSessionId ? ['--session-id', s.nativeSessionId] : [])];
  if (s.provider === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', ...model,
    ...(s.thinking ? ['--effort', s.thinking] : []),
    ...(s.mode === 'bypassPermissions' ? ['--permission-mode', 'bypassPermissions'] : []),
    ...(s.nativeSessionId ? ['--resume', s.nativeSessionId] : [])];
  return ['exec', ...(s.nativeSessionId ? ['resume', s.nativeSessionId] : []), '--json', '--skip-git-repo-check', ...model,
    ...(s.thinking ? ['-c', `model_reasoning_effort=${JSON.stringify(s.thinking)}`] : []),
    // 无人值守权限由外层员工沙箱承担，沿用已授权的 full-access 模式。
    ...(s.mode === 'full-access' ? ['--dangerously-bypass-approvals-and-sandbox'] : []), '-'];
}

/** 原生 CLI 的可执行文件名（执行端配置里是绝对路径，经员工沙箱脚本启动）。 */
const NATIVE_BINARY: Record<NativeProvider, string> = { claude: 'claude', 'factory-droid': 'droid', codex: 'codex',
  'codex-cloud': 'bun', 'devin-cloud': 'bun', jules: 'bun', warp: 'bun' };

export interface LaunchPreview {
  /** native：执行端经员工沙箱直接启动这条命令；paseo：交给 Paseo 按 provider 启动，没有可预览的命令行。 */
  via: 'native' | 'paseo';
  /** native 时为实际参数（可执行文件名 + nativeArgs），paseo 时为空。 */
  argv: string[];
}

/** 员工定义新开会话时的启动命令（首轮，没有续接的会话编号）。`auto:<family>` 模型在派工时才解析成具体型号，这里原样显示。 */
export function launchPreview(def: { provider: string; model: string; thinking?: string }): LaunchPreview {
  if (!isNativeProvider(def.provider)) return { via: 'paseo', argv: [] };
  if (isLaneProvider(def.provider)) return {
    via: 'native',
    argv: ['bun', def.provider === 'warp' ? 'src/runner/warp/main.ts' : 'src/runner/cloud-lane/main.ts', def.provider,
      ...nativeArgs({ provider: def.provider, model: def.model, thinking: def.thinking || undefined, mode: UNATTENDED_MODE[def.provider] })],
  };
  return {
    via: 'native',
    argv: [NATIVE_BINARY[def.provider], ...nativeArgs({ provider: def.provider, model: def.model, thinking: def.thinking || undefined, mode: UNATTENDED_MODE[def.provider] })],
  };
}
