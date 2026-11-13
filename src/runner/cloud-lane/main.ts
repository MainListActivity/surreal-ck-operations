/**
 * 云端员工通道桥接进程入口：执行端把它当普通原生 CLI 启动（sandbox/launch.sh bun …/main.ts <provider>），
 * prompt 走 stdin，逐行输出 Claude 格式事件：system(session_id) → lane_status* → result。
 * 不打印凭证与供应商原始转录；Jules key 等私密经 run.ts 在沙箱外注入环境变量。
 */
import { execFile } from 'node:child_process';
import { runLane, type LaneConfig, type LaneDeps } from './lane.ts';
import { isLaneProvider } from '../native-args.ts';

function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const exec: LaneDeps['exec'] = (cmd, args, opts) => new Promise(resolve => {
  execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 8 * 1024 * 1024, env: process.env },
    (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      stdout: String(stdout), stderr: String(stderr),
    }));
});

async function main(): Promise<number> {
  const [provider, ...rest] = process.argv.slice(2);
  if (!provider || !isLaneProvider(provider)) {
    emit({ type: 'result', subtype: 'error', is_error: true, session_id: `lane-${crypto.randomUUID()}`,
      result: `用法：main.ts <codex-cloud|devin-cloud|jules> [--resume <id>] [--model <m>]` });
    return 0;
  }
  let resumeId: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    // --model 已由 nativeArgs 约定好但云端任务不需要；照参数表跳过取值即可。
    if (rest[i] === '--resume') resumeId = rest[++i];
    else if (rest[i] === '--model') i++;
  }
  const sessionStart = `lane-${crypto.randomUUID()}`;
  const commDir = process.env.SCK_COMM_DIR;
  const prompt = await readStdin();
  if (!commDir) {
    emit({ type: 'system', session_id: sessionStart });
    emit({ type: 'result', subtype: 'error', is_error: true, session_id: sessionStart, result: '缺少 SCK_COMM_DIR 环境变量' });
    return 0;
  }
  let config: LaneConfig = {};
  try { config = JSON.parse(process.env.SCK_LANE_CONFIG ?? '{}') as LaneConfig; }
  catch { config = {}; }
  const deps: LaneDeps = { exec, fetch, sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now(),
    progress: status => emit({ type: 'lane_status', status }) };
  emit({ type: 'system', session_id: resumeId ?? sessionStart });
  let outcome: { sessionId: string; status: 'success' | 'error'; text: string };
  try {
    outcome = await runLane({ provider, prompt, cwd: process.cwd(), commDir,
      stateRoot: process.env.SCK_LANE_STATE_ROOT, config, resumeId, env: process.env }, deps);
  } catch (error) {
    outcome = { sessionId: resumeId ?? sessionStart, status: 'error' as const, text: (error as Error).message };
  }
  emit({ type: 'result', subtype: outcome.status === 'success' ? 'success' : 'error',
    is_error: outcome.status !== 'success', result: outcome.text, session_id: outcome.sessionId });
  return 0;
}

process.exitCode = await main();
