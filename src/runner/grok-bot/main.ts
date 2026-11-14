/**
 * Grok Bot 网页员工通道桥接入口：执行端以 `bun …/grok-bot/main.ts grok-bot [--resume <id>] [--model <botUUID>]` 启动，
 * prompt 走 stdin，事件输出与其它通道一致：system(session_id) → lane_status* → result。
 * 浏览器脚本经 `ego-browser nodejs -e` 执行；脚本只回 `__RESULT__{json}` 一行，失败信息不回显页面内容。
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { runGrokBotTurn, type Browse, type GrokBotConfig } from './turn.ts';

function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** 跑一个 ego-browser 脚本，取最后一行 __RESULT__；超时、非零退出、没有结果都返回 undefined。 */
export const egoBrowse = (bin: string): Browse => (script, timeoutMs) => new Promise((resolve) => {
  const child = spawn(bin, ['nodejs', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let settled = false;
  const settle = (value: Record<string, unknown> | undefined) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
  const timer = setTimeout(() => { child.kill('SIGKILL'); settle(undefined); }, timeoutMs);
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  child.on('error', () => settle(undefined));
  child.on('close', (code) => {
    if (code !== 0) { settle(undefined); return; }
    const line = out.split('\n').filter(l => l.startsWith('__RESULT__')).pop();
    try { settle(line ? JSON.parse(line.slice('__RESULT__'.length)) as Record<string, unknown> : undefined); }
    catch { settle(undefined); }
  });
});

async function main(): Promise<number> {
  const [provider, ...rest] = process.argv.slice(2);
  if (provider !== 'grok-bot') {
    emit({ type: 'result', subtype: 'error', is_error: true, session_id: `grok-bot-${crypto.randomUUID()}`,
      result: '用法：main.ts grok-bot [--resume <id>] [--model <botUUID>]' });
    return 0;
  }
  let resumeId: string | undefined, model: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--resume') resumeId = rest[++i];
    else if (rest[i] === '--model') model = rest[++i];
  }
  const sessionStart = resumeId ?? `grok-bot-${crypto.randomUUID()}`;
  const commDir = process.env.SCK_COMM_DIR;
  const prompt = await readStdin();
  emit({ type: 'system', session_id: sessionStart });
  if (!commDir) {
    emit({ type: 'result', subtype: 'error', is_error: true, session_id: sessionStart, result: '缺少 SCK_COMM_DIR 环境变量' });
    return 0;
  }
  let config: GrokBotConfig = {};
  try { config = JSON.parse(process.env.SCK_LANE_CONFIG ?? '{}') as GrokBotConfig; }
  catch { config = {}; }
  const bin = config.bin?.['ego-browser'] ?? join(process.env.HOME ?? '/nonexistent', '.local/bin/ego-browser');
  let outcome: { sessionId: string; status: 'success' | 'error'; text: string };
  try {
    outcome = await runGrokBotTurn({ prompt, commDir, model, resumeId, config }, {
      browse: egoBrowse(bin), now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)),
      progress: status => emit({ type: 'lane_status', status }),
    });
  } catch (error) {
    outcome = { sessionId: sessionStart, status: 'error', text: (error as Error).message };
  }
  emit({ type: 'result', subtype: outcome.status === 'success' ? 'success' : 'error',
    is_error: outcome.status !== 'success', result: outcome.text, session_id: outcome.sessionId });
  return 0;
}

if (import.meta.main) process.exitCode = await main();
