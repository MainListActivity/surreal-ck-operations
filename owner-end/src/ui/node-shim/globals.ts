/**
 * 共享核心在服务端依赖 Node 的全局 Buffer 与 process（Worker 由 nodejs_compat 提供）。
 * 页面直连执行老板命令时由本模块补上；必须是 main.tsx 的第一个导入，先于任何共享核心模块求值。
 */
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: unknown; process?: { env: Record<string, string | undefined> } };
g.Buffer ??= Buffer;
g.process ??= { env: {} };
