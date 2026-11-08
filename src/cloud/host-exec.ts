// 经 ssh 在受限主机执行命令。不经 shell 启动，远端命令作为 ssh 的单个参数传入。
import { spawn } from 'node:child_process';
import { redactText } from '../ops/redact.ts';

// 允许的执行主机白名单；不在其中的主机直接拒绝，不调用 ssh。
export const RUNNER_HOSTS = {
  'arm-free-1': { user: 'sck-agent', address: '129.146.179.37' },
} as const;

type RunnerHostName = keyof typeof RUNNER_HOSTS;

const SSH_OPTIONS = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes'];
const MAX_COMMAND_BYTES = 8192;
const MAX_TIMEOUT_SEC = 900;
const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MAX_OUTPUT_BYTES = 65536;

export interface HostExecInput {
  host: string;
  command: string;
  timeoutSec?: number;
}

export interface HostExecResult {
  host: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface HostExecOptions {
  keyPath: string; // 私钥路径，本模块不读取其内容
  sshBin?: string; // 默认 'ssh'
  maxOutputBytes?: number; // 默认 65536
  redact?: (text: string) => string;
}

function runnerOf(host: string): (typeof RUNNER_HOSTS)[RunnerHostName] {
  if (!Object.prototype.hasOwnProperty.call(RUNNER_HOSTS, host)) throw new Error('主机不在允许名单内');
  return RUNNER_HOSTS[host as RunnerHostName];
}

/** 组装 ssh 参数；远端命令位于 `--` 之后，不会被 ssh 当作选项解析。 */
export function sshArgs(host: string, keyPath: string, command: string): string[] {
  const { user, address } = runnerOf(host);
  return [...SSH_OPTIONS, '-i', keyPath, '--', `${user}@${address}`, command];
}

/** 收集输出字节，超过上限后丢弃并标记截断。 */
class OutputBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const room = this.max - this.size;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return;
    }
    if (room > 0) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
    }
    this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export async function hostExec(input: HostExecInput, options: HostExecOptions): Promise<HostExecResult> {
  const { host, command } = input;
  const timeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT_SEC;

  // 先校验再 spawn：白名单外主机绝不启动进程。
  runnerOf(host);
  if (typeof command !== 'string' || command.trim() === '') throw new Error('命令不能为空');
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) throw new Error(`命令超过 ${MAX_COMMAND_BYTES} 字节`);
  if (command.includes('\0')) throw new Error('命令包含非法字符');
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) {
    throw new Error(`超时时间必须为 1..${MAX_TIMEOUT_SEC} 秒的整数`);
  }

  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new Error('输出上限必须为非负整数');
  const redact = options.redact ?? ((text: string) => redactText(text));
  const args = sshArgs(host, options.keyPath, command);

  return new Promise<HostExecResult>((resolve, reject) => {
    const child = spawn(options.sshBin ?? 'ssh', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = new OutputBuffer(maxBytes);
    const stderr = new OutputBuffer(maxBytes);
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        host,
        exitCode,
        timedOut,
        stdout: redact(stdout.text()),
        stderr: redact(stderr.text()),
        truncated: stdout.truncated || stderr.truncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // 超时后不再等待管道关闭，避免孙进程占住管道导致挂起。
      finish(null);
    }, timeoutSec * 1000);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('无法启动 ssh'));
    });
    child.on('close', code => finish(code));
  });
}
