import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botMessage, runGrokBotTurn, sendScript, stateScript, turnMarker, type GrokBotDeps } from '../src/runner/grok-bot/turn.ts';
import { taskMaterial, validateLanes } from '../src/runner/cloud-lane/lane.ts';
import { launchPreview, nativeArgs } from '../src/runner/native-args.ts';

const BOT = 'ca9861d7-41ce-47a6-bd3e-b5d8efc5eea4';
let dir = '';
let sends: Array<Record<string, unknown>> = [];
let states: Array<Record<string, unknown> | undefined> = [];
let browsed: string[] = [];
let progress: string[] = [];
let clock = 0;

const deps = (): GrokBotDeps => ({
  browse: async (script) => {
    browsed.push(script);
    if (script.includes('const MSG =')) return sends.length > 1 ? sends.shift() : sends[0];
    return states.length > 1 ? states.shift() : states[0];
  },
  now: () => clock,
  sleep: async (ms) => { clock += ms; },
  progress: (s) => { progress.push(s); },
});
const run = (extra: Partial<Parameters<typeof runGrokBotTurn>[0]> = {}) =>
  runGrokBotTurn({ prompt: '先读 notes.md，完成 task.md', commDir: dir, model: BOT, config: { pollMs: 1000, maxMinutes: 1 }, ...extra }, deps());
const claim = (intent: string) => writeFileSync(join(dir, 'claim.json'), JSON.stringify({ task: { id: '6666cedf-e6f1-4a8c' }, worktree: { intent: { kind: intent } } }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sck-grokbot-'));
  writeFileSync(join(dir, 'task.md'), '# 写一段梗概\n\n## 需求\n\n写 200 字梗概。\n');
  claim('read');
  sends = [{ ok: true }];
  states = [{ ok: true, sent: true, working: false, done: '梗概正文……' }];
  browsed = []; progress = []; clock = 0;
});

describe('grok-bot turn', () => {
  test('sends once, waits for a stable SCK-DONE while idle, returns its text', async () => {
    states = [{ ok: true, sent: true, working: true, done: null }, { ok: true, sent: true, working: false, done: '梗概正文……' }];
    const out = await run();
    expect(out).toMatchObject({ status: 'success', text: '梗概正文……' });
    expect(browsed.filter(s => s.includes('const MSG ='))).toHaveLength(1);
    // two idle polls with the same final text are required before accepting it
    expect(browsed.filter(s => !s.includes('const MSG =')).length).toBeGreaterThanOrEqual(3);
  });

  test('the sent message inlines task.md and never contains this turn\'s DONE marker', () => {
    const material = taskMaterial(dir, 'x');
    const marker = turnMarker('6666cedf-e6f1', 'x');
    const message = botMessage(marker, material);
    expect(message.startsWith(`[SCK-TASK ${marker}]`)).toBe(true);
    expect(message).toContain('写 200 字梗概');
    expect(message).not.toContain(`[SCK-DONE ${marker}]`);
    expect(stateScript({ site: 'grok-bot', botId: BOT }, marker)).toContain(`[SCK-DONE ${marker}]`);
    expect(sendScript({ site: 'grok-bot', botId: BOT }, marker, message)).toContain(JSON.stringify(message));
  });

  test('same turn after a restart gets the same marker; a new round gets a new one', () => {
    expect(turnMarker('6666cedf-x', 'a')).toBe(turnMarker('6666cedf-x', 'a'));
    expect(turnMarker('6666cedf-x', 'a')).not.toBe(turnMarker('6666cedf-x', 'b'));
  });

  test('waits while the bot is busy, then sends', async () => {
    sends = [{ ok: false, code: 'busy' }, { ok: false, code: 'busy' }, { ok: true }];
    expect(await run()).toMatchObject({ status: 'success' });
    expect(progress.some(p => p.includes('正在忙'))).toBe(true);
  });

  test('code tasks are blocked without touching the browser', async () => {
    claim('code');
    const out = await run();
    expect(out.status).toBe('success');
    expect(out.text.startsWith('工作结果：受阻')).toBe(true);
    expect(browsed).toEqual([]);
  });

  test('a question card is reported as blocked, never auto-answered', async () => {
    states = [{ ok: true, sent: true, working: false, done: null, question: true, tail: '你想要哪种风格？' }];
    const out = await run();
    expect(out.text).toContain('工作结果：受阻');
    expect(out.text).toContain('你想要哪种风格');
    expect(browsed.filter(s => s.includes('const MSG ='))).toHaveLength(1);
  });

  test('login wall fails the turn', async () => {
    sends = [{ ok: false, code: 'login_required' }];
    expect(await run()).toMatchObject({ status: 'error' });
  });

  test('a bad bot id fails before any browsing', async () => {
    expect(await run({ model: 'default' })).toMatchObject({ status: 'error' });
    expect(browsed).toEqual([]);
  });

  test('times out while the bot keeps working', async () => {
    states = [{ ok: true, sent: true, working: true, done: null }];
    const out = await run();
    expect(out.status).toBe('error');
    expect(out.text).toContain('上限');
  });

  test('review turns need a 复核结论 first line', async () => {
    writeFileSync(join(dir, 'task.md'), '# 复核\n\n## 待复核成果\n\nxx\n');
    states = [{ ok: true, sent: true, working: false, done: '看起来不错' }];
    expect(await run()).toMatchObject({ status: 'error' });
  });
});

describe('grok-bot wiring', () => {
  test('lane config accepts bin/maxMinutes/pollMs only', () => {
    expect(() => validateLanes({ 'grok-bot': { bin: { 'ego-browser': '/x/ego-browser' }, maxMinutes: 60, pollMs: 20000 } })).not.toThrow();
    expect(() => validateLanes({ 'grok-bot': { dailyLimit: 3 } })).toThrow();
  });

  test('launch preview runs the grok-bot bridge with the bot id as model', () => {
    expect(launchPreview({ provider: 'grok-bot', model: BOT }).argv).toEqual(['bun', 'src/runner/grok-bot/main.ts', 'grok-bot', '--model', BOT]);
    expect(nativeArgs({ provider: 'grok-bot', model: BOT, nativeSessionId: 's1' })).toEqual(['--resume', 's1', '--model', BOT]);
  });
});

describe('muse-web site', () => {
  const THREAD = 'https://muse.ai/thread/c2508d0b-c3d6-4d71-85b5-924b3dd52e17';
  const runMuse = () => runGrokBotTurn({ prompt: '完成 task.md', commDir: dir, site: 'muse-web', model: 'default', config: { pollMs: 1000, maxMinutes: 1 } }, deps());

  test('first send opens a new side chat and records its URL; later scripts go straight to it', async () => {
    sends = [{ ok: true, url: THREAD }];
    expect(await runMuse()).toMatchObject({ status: 'success', text: '梗概正文……' });
    const first = browsed.find(s => s.includes('const MSG ='))!;
    expect(first).toContain('New side chat');
    expect(first).not.toContain('grok.com');
    expect(browsed.filter(s => !s.includes('const MSG =')).every(s => s.includes(THREAD))).toBe(true);
    const files = require('node:fs').readdirSync(join(dir, '.webchat'));
    expect(JSON.parse(readFileSync(join(dir, '.webchat', files[0]), 'utf8')).url).toBe(THREAD);
  });

  test('an unconfirmed send retries in the same side chat instead of opening another', async () => {
    sends = [{ ok: false, code: 'not_echoed', url: THREAD }, { ok: true, already: true, url: THREAD }];
    await runMuse();
    const sendScripts = browsed.filter(s => s.includes('const MSG ='));
    expect(sendScripts).toHaveLength(2);
    expect(sendScripts[1]).not.toContain('New side chat');
    expect(sendScripts[1]).toContain(THREAD);
  });

  test('muse does not need a bot UUID and still refuses code tasks', async () => {
    claim('code');
    const out = await runMuse();
    expect(out.text.startsWith('工作结果：受阻')).toBe(true);
    expect(existsSync(join(dir, '.webchat'))).toBe(false);
  });
});
