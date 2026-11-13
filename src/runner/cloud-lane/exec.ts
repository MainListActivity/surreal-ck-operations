/**
 * 通道子进程的真实执行器：bin 配置的命令映射成绝对路径，其所在目录前置进子进程 PATH
 * （node shim 形式的 CLI 需要同目录的 node）。execFile 拿不到进程退出码时
 * （ENOENT、EACCES、超时/被终止）把可读原因写进 stderr，驱动层的失败文案不再空白。
 */
import { execFile } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import type { ExecFn } from './repo.ts';

export interface ExecError extends Error { code?: number | string; killed?: boolean; signal?: string }

export function execErrorText(file: string, error: ExecError, pathEnv: string): string {
  if (error.killed || error.signal === 'SIGTERM') return `执行超时或被终止：${file}`;
  if (error.code === 'ENOENT') return `找不到可执行文件 ${file}（PATH=${pathEnv}）`;
  if (error.code === 'EACCES') return `无执行权限：${file}`;
  return `无法执行 ${file}：${error.message}`;
}

export function laneExecFile(bin: Record<string, string> = {}): ExecFn {
  const dirs = [...new Set(Object.values(bin).map(path => dirname(path)))]
    .filter(dir => isAbsolute(dir) && !(process.env.PATH ?? '').split(':').includes(dir));
  const env = { ...process.env, PATH: [...dirs, process.env.PATH].filter(Boolean).join(':') } as Record<string, string>;
  return (cmd, args, opts) => new Promise(resolve => {
    const file = bin[cmd] ?? cmd;
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 8 * 1024 * 1024, env },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr) || (error ? execErrorText(file, error as ExecError, env.PATH) : ''),
      }));
  });
}
