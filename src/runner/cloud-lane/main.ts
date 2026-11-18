/**
 * 云端员工通道桥接进程入口：执行端把它当普通原生 CLI 启动（sandbox/launch.sh bun …/main.ts <provider>），
 * prompt 走 stdin，逐行输出 Claude 格式事件：system(session_id) → lane_status* → result。
 * 不打印凭证与供应商原始转录；Jules key 等私密经 run.ts 在沙箱外注入环境变量。
 */
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { runLane, type LaneConfig, type LaneDeps } from './lane.ts';
import { laneExecFile } from './exec.ts';
import { egoBrowse } from '../grok-bot/main.ts';
import { isLaneProvider } from '../native-args.ts';
import { reqDir, resDir, writeFileAtomic, readJsonFile, type CommResponse } from '../../comm.ts';

function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** 经 comm 目录向 sidecar 发起 steward_lane_assist；超时或不完整配置时返回 escalate，不触碰 private/。 */
function makeAssist(commDir: string, key: string): NonNullable<LaneDeps['assist']> {
  return async input => {
    const name = `assist-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
    const reqPath = join(reqDir(commDir), name);
    const resPath = join(resDir(commDir), name);
    writeFileAtomic(reqPath, JSON.stringify({
      key, tool: 'steward_lane_assist',
      args: {
        provider: input.provider, phase: input.phase,
        transcriptTail: input.transcriptTail, round: input.round,
      },
    }));
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const res = readJsonFile<CommResponse>(resPath);
      if (res) {
        try { unlinkSync(resPath); } catch { /* 已消费 */ }
        if (!res.ok) return { decision: 'escalate' as const, reason: String(res.error ?? 'sidecar 拒绝协助') };
        const data = (res.data ?? {}) as { decision?: string; message?: string; reason?: string; toolExecuted?: string };
        if (data.decision === 'reply' && typeof data.message === 'string') {
          return { decision: 'reply' as const, message: data.message, toolExecuted: data.toolExecuted };
        }
        return { decision: 'escalate' as const, reason: typeof data.reason === 'string' ? data.reason : '协助结论无法处理' };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return { decision: 'escalate' as const, reason: '本地代跑协助超时，转交老板裁决' };
  };
}

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
  const deps: LaneDeps = { exec: laneExecFile(config.bin), fetch, sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now(),
    progress: (status, phase) => emit({ type: 'lane_status', status, ...(phase ? { phase } : {}) }),
    // devin-cloud 的网页入口需要 ego-browser；其它通道不会调用 browse。
    browse: egoBrowse(config.bin?.['ego-browser'] ?? join(process.env.HOME ?? '/nonexistent', '.local/bin/ego-browser')) };
  const commKey = process.env.SCK_COMM_KEY?.trim();
  if (commKey) deps.assist = makeAssist(commDir, commKey);
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
