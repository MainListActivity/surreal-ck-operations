/**
 * Warp 本地员工通道桥接入口：执行端以 `bun …/warp/main.ts warp [--resume <conversationId>] [--model <m>]` 启动，
 * prompt 走 stdin，事件输出与云端通道一致：system(session_id) → lane_status* → result。
 * oz 的 prompt 只能经 --prompt 参数传，正文先写进 commDir 的文件、参数只带路径。
 */
import { runWarpTurn, type WarpConfig, type WarpDeps } from './turn.ts';

function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(): Promise<number> {
  const [provider, ...rest] = process.argv.slice(2);
  if (provider !== 'warp') {
    emit({ type: 'result', subtype: 'error', is_error: true, session_id: `warp-${crypto.randomUUID()}`,
      result: '用法：main.ts warp [--resume <conversationId>] [--model <m>]' });
    return 0;
  }
  let resumeId: string | undefined, model: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--resume') resumeId = rest[++i];
    else if (rest[i] === '--model') model = rest[++i];
  }
  const sessionStart = `warp-${crypto.randomUUID()}`;
  const commDir = process.env.SCK_COMM_DIR;
  const prompt = await readStdin();
  if (!commDir) {
    emit({ type: 'system', session_id: sessionStart });
    emit({ type: 'result', subtype: 'error', is_error: true, session_id: sessionStart, result: '缺少 SCK_COMM_DIR 环境变量' });
    return 0;
  }
  let config: WarpConfig = {};
  try { config = JSON.parse(process.env.SCK_LANE_CONFIG ?? '{}') as WarpConfig; }
  catch { config = {}; }
  const deps: WarpDeps = {
    spawn: (cmd, args, opts) => Bun.spawn([cmd, ...args], { cwd: opts.cwd, env: opts.env, stdout: 'pipe', stderr: 'pipe' }) as unknown as import('./turn.ts').WarpProcess,
    now: () => Date.now(),
    progress: status => emit({ type: 'lane_status', status }),
  };
  emit({ type: 'system', session_id: resumeId ?? sessionStart });
  let outcome: { sessionId: string; status: 'success' | 'error'; text: string };
  try {
    outcome = await runWarpTurn({ prompt, cwd: process.cwd(), commDir, resumeId, model, config, env: process.env }, deps);
  } catch (error) {
    outcome = { sessionId: resumeId ?? sessionStart, status: 'error', text: (error as Error).message };
  }
  emit({ type: 'result', subtype: outcome.status === 'success' ? 'success' : 'error',
    is_error: outcome.status !== 'success', result: outcome.text, session_id: outcome.sessionId });
  return 0;
}

process.exitCode = await main();
