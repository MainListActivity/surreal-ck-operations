// 执行端装 release：调用 scripts/release-install.sh <sha>。失败安全由脚本保证（切换前失败保持现役版本，
// 切换后失败用 company-service.sh 恢复上一版本）。本模块只做：校验 sha、确认派工已暂停、限时、
// 只保留输出尾部并脱敏，再把脚本结论变成作业结果（成功）或带原因的错误（失败）。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { redactText } from '../ops/redact.ts';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ReleaseInstallOptions {
  /** 运营仓检出目录；脚本位于其 scripts/release-install.sh。 */
  repo: string;
  /** 服务目录，经 SCK_SERVICE_HOME 传给脚本。 */
  serviceHome: string;
  /** 老板是否已暂停派工（company_meta:config.paused）。未暂停则拒绝执行，不改动任何东西。 */
  dispatchPaused: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  shell?: string; // 默认 'sh'
}

export interface ReleaseInstallResult {
  sha: string;
  /** 脚本输出的尾部（已脱敏、已截断）。 */
  output: string;
  truncated: boolean;
  /** 脚本最后一行的 `结果: ...` 结论；没有则为空串。 */
  conclusion: string;
}

/** 只保留最后 limit 字节的输出收集器。 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    // 超出的部分从最前面丢弃：整块丢弃，或截掉块的前半段。
    while (this.bytes > this.limit) {
      const excess = this.bytes - this.limit;
      const first = this.chunks[0]!;
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
      this.truncated = true;
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** 结束整个进程组（负的 pid）；组已不存在时忽略。 */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程组已经结束。
  }
}

/** 脚本输出里最后一条 `结果:` 行；脚本只在收尾时输出它。 */
function conclusionOf(output: string): string {
  const lines = output.split('\n').map(line => line.trim()).filter(line => line.startsWith('结果:'));
  return lines.length ? lines[lines.length - 1]! : '';
}

export async function releaseInstall(input: { sha: string }, options: ReleaseInstallOptions): Promise<ReleaseInstallResult> {
  const sha = input.sha;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw coded('invalid', 'sha 必须是 40 位小写十六进制提交号');
  if (!options.dispatchPaused) throw coded('conflict', '派工尚未暂停，拒绝装 release；请老板先暂停派工');

  const script = join(options.repo, 'scripts', 'release-install.sh');
  // 脚本要求老板侧已暂停派工：这里只在库里确认暂停后才设置该变量，不替老板设置。
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    SCK_SERVICE_HOME: options.serviceHome,
    SCK_OPS_REPO: options.repo,
    SCK_RELEASE_DISPATCH_PAUSED: '1',
  };
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { code, timedOut, output, truncated } = await new Promise<{
    code: number | null; timedOut: boolean; output: string; truncated: boolean;
  }>((resolve, reject) => {
    // 独立进程组启动：超时要连脚本派生的子进程一起结束，否则它们占着输出管道，子进程退出前拿不到 close。
    const child = spawn(options.shell ?? 'sh', [script, sha], { cwd: options.repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const buffer = new TailBuffer(maxOutput);
    let timedOutFlag = false;
    const timer = setTimeout(() => {
      timedOutFlag = true;
      killGroup(child.pid);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => buffer.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => buffer.push(chunk));
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', exitCode => {
      clearTimeout(timer);
      resolve({ code: exitCode, timedOut: timedOutFlag, output: buffer.text(), truncated: buffer.truncated });
    });
  });

  const redacted = redactText(output);
  const conclusion = conclusionOf(redacted);
  if (timedOut) throw coded('upstream_error', `装 release 超时，已终止脚本${conclusion ? `（${conclusion}）` : ''}`);
  if (code !== 0) throw coded('upstream_error', `装 release 失败：${conclusion || `脚本退出码 ${code}`}`);
  return { sha, output: redacted, truncated, conclusion };
}
