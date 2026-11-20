/**
 * 子进程尚未创建即被拒的启动失败：会话落盘为 error + notStarted，派工器据此回收派工屏障。
 * 独立成无依赖模块：dispatcher 经由插件打包图到达这里，若放在 native.ts 会把 bun:ffi 拖进插件包。
 */
export class ActivationRefusedError extends Error {
  readonly code = 'activation_refused';
  constructor(message: string) { super(message); this.name = 'ActivationRefusedError'; }
}
export const isActivationRefused = (error: unknown): error is ActivationRefusedError =>
  error instanceof ActivationRefusedError || (error instanceof Error && (error as { code?: string }).code === 'activation_refused');
