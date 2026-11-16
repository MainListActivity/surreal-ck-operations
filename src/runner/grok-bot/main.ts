/**
 * 网页 agent 员工通道桥接入口（Grok Bot、muse.ai、ChatGPT、Gemini）：执行端以 `bun …/grok-bot/main.ts <站点> [--resume <id>] [--model <m>]` 启动，
 * prompt 走 stdin，事件输出与其它通道一致：system(session_id) → lane_status* → result。
 * 浏览器脚本经 `ego-browser nodejs -e` 执行；脚本只回 `__RESULT__{json}` 一行，失败信息不回显页面内容。
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { isWebSite, PRESSED, runGrokBotTurn, WEB_SITES, type Browse, type GrokBotConfig } from './turn.ts';

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
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const settle = (value: Record<string, unknown> | undefined) => {
    if (settled) return;
    settled = true; clearTimeout(timer); clearTimeout(fallback); resolve(value);
  };
  // 脚本没给结果就结束（超时、崩溃）：若已打出「按下发送」标记，报 pressed，执行端不再重发。
  const unfinished = () => (out.includes(PRESSED) ? { ok: false, code: 'pressed' } : undefined);
  const finish = () => {
    const line = out.split('\n').filter(l => l.startsWith('__RESULT__')).pop();
    try { return line ? JSON.parse(line.slice('__RESULT__'.length)) as Record<string, unknown> : unfinished(); }
    catch { return unfinished(); }
  };
  // 超时：杀掉子进程后等 close 把管道里剩下的输出读完再判定，否则「已按下发送」的标记可能还没读到就丢了。
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    fallback = setTimeout(() => settle(finish()), 5_000);
  }, timeoutMs);
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  child.on('error', () => settle(undefined));
  child.on('close', () => settle(finish()));
});

async function main(): Promise<number> {
  const [provider, ...rest] = process.argv.slice(2);
  if (!isWebSite(provider)) {
    emit({ type: 'result', subtype: 'error', is_error: true, session_id: `web-agent-${crypto.randomUUID()}`,
      result: `用法：main.ts <${WEB_SITES.join('|')}> [--resume <id>] [--model <botUUID|default>]` });
    return 0;
  }
  let resumeId: string | undefined, model: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--resume') resumeId = rest[++i];
    else if (rest[i] === '--model') model = rest[++i];
  }
  const sessionStart = resumeId ?? `${provider}-${crypto.randomUUID()}`;
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
    outcome = await runGrokBotTurn({ prompt, commDir, site: provider, model, resumeId: resumeId ?? sessionStart, config }, {
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
