import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLane, taskMaterial, validateLanes, vendorPrompt, type LaneDeps, type LaneInput } from '../src/runner/cloud-lane/lane.ts';
import { laneExecFile } from '../src/runner/cloud-lane/exec.ts';
import { laneDigest, readInflight, readLaneState, writeLaneState } from '../src/runner/cloud-lane/state.ts';
import { julesUsageCount, julesUsageEntry, whamToUsageEntry } from '../src/runner/cloud-lane/quota.ts';
import { recordJulesUsage } from '../src/runner/cloud-lane/jules.ts';
import type { ExecResult } from '../src/runner/cloud-lane/repo.ts';
import { egoBrowse } from '../src/runner/grok-bot/main.ts';
import { DEVIN_HOME } from '../src/runner/cloud-lane/devin-web.ts';

type Call = { cmd: string; args: string[]; cwd?: string };
type Route = (call: Call) => ExecResult | undefined;

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'boom'): ExecResult => ({ code: 1, stdout: '', stderr });

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function world(opts: { task?: string; prompt?: string; git?: Route; extra?: Route;
    /** 默认把 cwd 当任务工作树写进 claim.json（分支 sck/task-1）；'none' 不写，对象自定义。 */
    claim?: 'none' | { worktreePath: string; branch: string } } = {}) {
  const commDir = mkdtempSync(join(tmpdir(), 'sck-lane-comm-'));
  const cwd = mkdtempSync(join(tmpdir(), 'sck-lane-wt-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'sck-lane-state-'));
  dirs.push(commDir, cwd, stateRoot);
  writeFileSync(join(commDir, 'task.md'), opts.task ?? '# 云端任务\n\n实现需求甲。\n');
  if (opts.claim !== 'none') {
    const wt = opts.claim ?? { worktreePath: cwd, branch: 'sck/task-1' };
    // task.id 与真实 claim.json 一样：同一公司任务换员工目录时靠它认出同一任务（换摘要重派）。
    writeFileSync(join(commDir, 'claim.json'), JSON.stringify({ task: { id: 'task-1' }, worktree: { worktreePath: wt.worktreePath, branch: wt.branch, intent: { kind: 'code' }, mode: 'exclusive' } }));
  }
  const calls: Call[] = [];
  const progress: string[] = [];
  const phases: Array<string | undefined> = [];
  const git: Route = call => {
    const [a, b] = call.args;
    if (call.cmd === 'git' && a === 'rev-parse' && b === '--is-inside-work-tree') return ok('true\n');
    if (call.cmd === 'git' && a === 'remote' && b === 'get-url') return ok('git@github.com:acme/widget.git\n');
    if (call.cmd === 'git' && a === 'rev-parse' && b === '--abbrev-ref') return ok('sck/task-1\n');
    if (call.cmd === 'git' && a === 'rev-parse' && b === 'HEAD') return ok('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
    if (call.cmd === 'gh' && a === 'repo') return ok('main\n');
    if (call.cmd === 'git' && a === 'ls-remote') return ok('');
    if (call.cmd === 'git' && a === 'push') return ok('');
    return undefined;
  };
  const deps: LaneDeps = {
    exec: async (cmd, args, o) => {
      const call: Call = { cmd, args, cwd: o.cwd };
      calls.push(call);
      const r = opts.extra?.(call) ?? opts.git?.(call) ?? git(call);
      if (!r) throw new Error(`unstubbed exec: ${cmd} ${args.join(' ')}`);
      return r;
    },
    fetch: Object.assign(async () => { throw new Error('unstubbed fetch'); }, { preconnect: () => {} }) as unknown as typeof fetch,
    sleep: async () => {},
    now: () => t,
    progress: (s, phase) => { progress.push(s); phases.push(phase); },
  };
  let t = Date.now();
  const input = (over: Partial<LaneInput> = {}): LaneInput => ({
    provider: 'codex-cloud',
    prompt: opts.prompt ?? `实现 $SCK_COMM_DIR/task.md 中的需求，按验收标准逐条自验。完成后直接给出最终答复。`,
    cwd, commDir, stateRoot, config: { pollMs: 1 }, env: {}, ...over,
  });
  const callsOf = (pred: (c: Call) => boolean) => calls.filter(pred);
  return { commDir, cwd, stateRoot, calls, callsOf, progress, phases, deps, input,
    advance: (ms: number) => { t += ms; } };
}

describe('codex-cloud 通道', () => {
  test('提交 → 轮询 → 应用 → 提交推送 → PR → 结果带 PR/SHA 与会话 ID', async () => {
    const w = world({ extra: call => {
      const [a, b, c] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec')
        return ok('https://chatgpt.com/codex/tasks/task_b_abc123\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status')
        return ok('[READY] 实现需求甲\nacme/widget  •  1m ago\n+10 -2 in 1 file\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('diff --git a/x b/x\n+hello\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'apply') return ok('applied\n');
      if (call.cmd === 'git' && a === 'add') return ok('');
      if (call.cmd === 'git' && a === 'diff' && b === '--cached') return ok('x\n');
      if (call.cmd === 'git' && a === 'commit') return ok('');
      if (call.cmd === 'gh' && a === 'pr' && b === 'list') return ok('[]');
      if (call.cmd === 'gh' && a === 'pr' && b === 'create') return ok('https://github.com/acme/widget/pull/7\n');
      return undefined;
    }});
    const out = await runLane(w.input(), w.deps);
    expect(out.status).toBe('success');
    expect(out.sessionId).toMatch(/^lane-/);
    expect(out.text).toContain('PR: https://github.com/acme/widget/pull/7');
    expect(out.text).toContain('SHA: deadbeef');
    // 提交过 exec、应用过补丁、推送过、建了 PR
    expect(w.callsOf(c => c.cmd === 'codex' && c.args[1] === 'exec').length).toBe(1);
    expect(w.callsOf(c => c.cmd === 'codex' && c.args[1] === 'apply').length).toBe(1);
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'push').length).toBeGreaterThan(0);
    expect(w.callsOf(c => c.cmd === 'gh' && c.args[1] === 'create').length).toBe(1);
    // 分支推送（远端缺分支）发生在提交云端任务之前
    const pushed = w.calls.findIndex(c => c.cmd === 'git' && c.args[0] === 'push');
    const execed = w.calls.findIndex(c => c.cmd === 'codex' && c.args[1] === 'exec');
    expect(pushed).toBeLessThan(execed);
    // 进度事件有内容
    expect(w.progress.length).toBeGreaterThan(0);
    // 回合完成后在途任务清空，逻辑会话 ID 保留
    const state = readLaneState(w.commDir)!;
    expect(state.taskId).toBeUndefined();
    expect(state.sessionId).toBe(out.sessionId);
  });

  test('空 diff → 工作结果：受阻（成功回合）', async () => {
    const w = world({ extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_empty\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\nno diff\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('');
      return undefined;
    }});
    const out = await runLane(w.input(), w.deps);
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^工作结果：受阻/);
  });

  test('相同 prompt 的在途任务重连而不重复提交', async () => {
    const w = world({ extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\nno diff\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('');
      return undefined;
    }});
    const input = w.input();
    const repo = { slug: 'acme/widget', owner: 'acme', repo: 'widget', branch: 'sck/task-1', defaultBranch: 'main' };
    const digest = laneDigest('codex-cloud', vendorPrompt(input, repo, taskMaterial(w.commDir, input.prompt)));
    writeLaneState(w.commDir, { sessionId: 'lane-old', taskId: 'task_b_prev',
      taskUrl: 'https://chatgpt.com/codex/tasks/task_b_prev',
      digest, branch: 'sck/task-1', submittedAt: Date.now() });
    const out = await runLane(input, w.deps);
    expect(out.status).toBe('success');
    expect(w.callsOf(c => c.cmd === 'codex' && c.args[1] === 'exec')).toHaveLength(0);
    expect(w.callsOf(c => c.cmd === 'codex' && c.args[1] === 'status')).toHaveLength(1);
    expect(out.sessionId).toBe('lane-old');
  });

  test('在途任务摘要随 task.md 变化：错误回合留下的旧任务不会被新任务重连', async () => {
    // 第一轮的派工消息与第二轮逐字相同（复用 comm 目录时本就如此），只有 task.md 不同。
    const w = world({ extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_new\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\nno diff\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('');
      return undefined;
    }});
    // 上一轮错误收尾：state 里留下旧云端任务与旧摘要（摘要当时覆盖旧 task.md 内容）。
    const input = w.input();
    writeLaneState(w.commDir, { sessionId: 'lane-old', taskId: 'task_b_stale',
      taskUrl: 'https://chatgpt.com/codex/tasks/task_b_stale',
      digest: 'digest-of-old-task-md', branch: 'sck/task-1', submittedAt: Date.now() });
    const out = await runLane(input, w.deps);
    expect(out.status).toBe('success');
    // 新内容 → 新提交，不轮询旧任务状态
    expect(w.callsOf(c => c.cmd === 'codex' && c.args[1] === 'exec')).toHaveLength(1);
    expect(w.callsOf(c => c.cmd === 'codex' && c.args.includes('task_b_stale'))).toHaveLength(0);
    // 对照：摘要不变时在途任务应重连（上面用例已覆盖，这里验证摘要确实随内容走）。
    writeLaneState(w.commDir, { sessionId: 'lane-old', taskId: 'task_b_same',
      digest: readLaneState(w.commDir)!.digest, branch: 'sck/task-1' });
    const again = await runLane(input, w.deps);
    expect(again.sessionId).toBe('lane-old');
    expect(w.callsOf(c => c.cmd === 'codex' && c.args[1] === 'exec')).toHaveLength(1);
  });

  test('轮询超时 → 错误回合，文案含任务 ID 与“可能仍在运行”', async () => {
    const w = world({ extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_slow\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') { w.advance(60_000); return ok('[PENDING] t\nenv  •  now\n'); }
      return undefined;
    }});
    const out = await runLane(w.input({ config: { pollMs: 1, maxMinutes: 1 } }), w.deps);
    expect(out.status).toBe('error');
    expect(out.text).toContain('task_b_slow');
    expect(out.text).toContain('仍在运行');
    // 状态保留在途任务：下次同 prompt 可重连
    expect(readLaneState(w.commDir)?.taskId).toBe('task_b_slow');
  });

  test('复核轮：从 diff 提取 .sck/review.md 并强制首行复核结论', async () => {
    const reviewWorld = (diffText: string) => world({
      task: '# 任务\n\n## 待复核成果\n\n实现已经提交。\n',
      extra: call => {
        const [a, b] = call.args;
        if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_rev\n');
        if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\n+5 in 1 file\n');
        if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok(diffText);
        return undefined;
      },
    });
    const good = reviewWorld('diff --git a/.sck/review.md b/.sck/review.md\nnew file\n+++ b/.sck/review.md\n+复核结论：通过\n+逐条证据。\n');
    const out = await runLane(good.input(), good.deps);
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^复核结论：通过/);
    // 没有 PR/提交动作
    expect(good.callsOf(c => c.cmd === 'gh' && c.args[1] === 'create')).toHaveLength(0);

    const badWorld = reviewWorld('diff --git a/.sck/review.md b/.sck/review.md\n+++ b/.sck/review.md\n+看起来还行\n');
    const err = await runLane(badWorld.input(), badWorld.deps);
    expect(err.status).toBe('error');
    expect(err.text).toContain('复核结论');
  });
});

describe('codex-cloud 状态判定与在途登记', () => {
  test('status 退出码 1 但输出 [PENDING] 仍按进行中轮询，不误判失败', async () => {
    let polls = 0;
    const w = world({ extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_p1\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status')
        return ++polls === 1 ? { code: 1, stdout: '[PENDING] t\nenv  •  now\nno diff\n', stderr: '' } : ok('[READY] t\nenv  •  now\nno diff\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('');
      return undefined;
    }});
    const out = await runLane(w.input(), w.deps);
    expect(out.status).toBe('success');
    expect(polls).toBe(2);
  });

  test('status 无标记且退出码 1 → 错误回合，文案取 stderr', async () => {
    const w = world({ extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_p2\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return bad('boom');
      return undefined;
    }});
    const out = await runLane(w.input(), w.deps);
    expect(out.status).toBe('error');
    expect(out.text).toContain('boom');
  });

  test('换员工实例（不同 comm 目录）按摘要重连在途任务，不重复提交', async () => {
    const task = '# 云端任务\n\n实现需求甲。\n';
    const w1 = world({ task, extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_dup\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return bad('轮询命令失败');
      return undefined;
    }});
    const out1 = await runLane(w1.input(), w1.deps);
    expect(out1.status).toBe('error');
    expect(w1.callsOf(c => c.args[0] === 'cloud' && c.args[1] === 'exec')).toHaveLength(1);

    // 第二个实例：全新 comm 目录，同一 stateRoot，同一份 task.md → 摘要相同 → 直接重连。
    const w2 = world({ task, extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\nno diff\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('');
      return undefined;
    }});
    const out2 = await runLane(w2.input({ stateRoot: w1.stateRoot }), w2.deps);
    expect(out2.status).toBe('success');
    expect(w2.callsOf(c => c.args[0] === 'cloud' && c.args[1] === 'exec')).toHaveLength(0);
    const statuses = w2.callsOf(c => c.args[0] === 'cloud' && c.args[1] === 'status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.args).toContain('task_b_dup');
  });

  test('供应商终态失败（[ERROR]）清除登记，下一实例重新提交', async () => {
    const task = '# 云端任务\n\n实现需求甲。\n';
    const w1 = world({ task, extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_f1\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[ERROR] t\n');
      return undefined;
    }});
    const out1 = await runLane(w1.input(), w1.deps);
    expect(out1.status).toBe('error');

    const w2 = world({ task, extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_f2\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\nno diff\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('');
      return undefined;
    }});
    const out2 = await runLane(w2.input({ stateRoot: w1.stateRoot }), w2.deps);
    expect(out2.status).toBe('success');
    expect(w2.callsOf(c => c.args[0] === 'cloud' && c.args[1] === 'exec')).toHaveLength(1);
  });

  test('任务完成后登记被清除', async () => {
    const w = world({ extra: call => {
      const [a, b] = call.args;
      if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_done\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\nno diff\n');
      if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('');
      return undefined;
    }});
    const out = await runLane(w.input(), w.deps);
    expect(out.status).toBe('success');
    const digest = readLaneState(w.commDir)!.digest!;
    expect(readInflight(w.stateRoot, 'codex-cloud', digest)).toBeUndefined();
  });
});

describe('devin-cloud 通道（网页 Free 入口）', () => {
  const SESSION = 'https://app.devin.ai/sessions/abcd1234abcd1234abcd1234abcd1234';
  type Resp = Record<string, unknown> | undefined;
  type Queues = { send?: Resp[]; follow?: Resp[]; recover?: Resp[]; session?: Resp[] };
  /** 按脚本特征分流：新会话发送 / 续轮跟进 / 受理核对 / 会话轮询。 */
  const MODE = (m: string) => `const MODE = "${m}"`;
  const devinBrowse = (q: Queues) => {
    const calls: string[] = [];
    const pick = (list: Resp[] | undefined): Resp => list && list.length > 1 ? list.shift() : list?.[0];
    const browse = async (script: string): Promise<Resp> => {
      calls.push(script);
      if (script.includes(MODE('send'))) return pick(q.send);
      if (script.includes(MODE('recover'))) return pick(q.recover);
      if (script.includes(MODE('follow'))) return pick(q.follow);
      return pick(q.session);
    };
    return { browse: browse as NonNullable<LaneDeps['browse']>, calls };
  };
  const gitOk: Route = call => {
    if (call.cmd === 'git' && call.args[0] === 'fetch') return ok('');
    if (call.cmd === 'git' && call.args[0] === 'merge') return ok('');
    return undefined;
  };
  const idleDone = (text: string) => ({ ok: true, markerSeen: true, status: 'idle', done: text, tail: '' });
  const unseen = { ok: true, markerSeen: false, status: 'idle', done: null, tail: '' };
  const PR9 = '完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe';
  const HOME = DEVIN_HOME;
  const NEW_SESSION = 'https://app.devin.ai/sessions/0123456789abcdef0123456789abcdef';
  const OTHER = 'https://app.devin.ai/sessions/fedcba9876543210fedcba9876543210';
  const CAP_ROWS = ['Capability', 'Fusion', 'Ultra', 'Normal', 'Lite', 'Free', 'Connect your ChatGPT…', 'Previews', 'SWE-2 Lightning', 'SWE-2 Flash', 'Fable 5.2'];
  const g = globalThis as unknown as Record<string, unknown>;
  type FakeBlock = { role: 'user' | 'devin' | 'tool'; text: string };
  type FakeSession = { cap: string; status: string; blocks: FakeBlock[] };
  interface FakeOpts {
    seats?: { used: number; total: number };
    sessions?: Record<string, Partial<FakeSession>>;
    sidebar?: Array<{ href: string; title: string }>;
    /** 首页发送时新会话的地址。 */
    newSession?: string;
    /** 首页 Capability 菜单里没有 Free 行（页面改版等）。 */
    noFreeRow?: boolean;
    /** 指针点击 Capability 按钮也打不开菜单（页面改版等）。 */
    noMenu?: boolean;
    /** 菜单在指针点击后这么多毫秒才渲染（虚拟时钟，由 waitForTimeout 推进）。 */
    menuDelayMs?: number;
    /** 文档里排在前面的第一个 [role=menu] 是隐藏的账户菜单。 */
    staleMenu?: boolean;
    /** 页头另有一个文字为 Free 的按钮（第二个 Capability 候选）。 */
    outsideFree?: boolean;
    /** 菜单里出现两个 Free 行。 */
    duplicateFreeRow?: boolean;
    /** 指针点 Free 行没有生效（按钮仍是 Normal）。 */
    freeRowInert?: boolean;
    /** Escape 收不起菜单（它仍挡着输入区）。 */
    escapeInert?: boolean;
    /** 选中 Free 后菜单只有一层：一次 Escape 就全部收起（对照真实页面的两层）。 */
    singleLayer?: boolean;
    /** Escape 生效要等这么多毫秒（虚拟时钟，由 waitForTimeout 推进）：模拟 DOM 更新慢。 */
    escapeLagMs?: number;
    /** 菜单项改成 role=menuitem 的链接（真实页面 Free 项的角色；标签不是 button）。 */
    menuItemRows?: boolean;
    /** 点 Free 后档位与席位晚这么多毫秒才显示（虚拟时钟，由 waitForTimeout 推进）。 */
    capLagMs?: number;
    onVisit?: (url: string, sessions: Record<string, FakeSession>) => void;
    onSend?: (url: string, text: string, sessions: Record<string, FakeSession>) => void;
  }
  class FakeExit extends Error {}
  const markerOf = (text: string) => /\[SCK-ROUND (SCK-[0-9a-f]+)\]/.exec(text)?.[1] ?? 'SCK-none';
  /** 发送后 Devin 的回答：助手发言块以收尾标记单独成行开头，tail 是它之后的工具输出（没有作者属性）。 */
  const answer = (reply: string, tail: (marker: string) => FakeBlock[] = () => []): NonNullable<FakeOpts['onSend']> =>
    (url, text, sessions) => {
      const m = markerOf(text);
      sessions[url]!.blocks.push({ role: 'devin', text: `[SCK-DONE ${m}]\n${reply}` }, ...tail(m));
      sessions[url]!.status = 'Devin is awaiting instructions';
    };
  /** 上一轮已结束的会话：用户消息带收尾约定（与派工消息同一模板），Devin 已给出终稿。 */
  const OLD_ROUND = { cap: 'Free', status: 'Devin is awaiting instructions', blocks: [
    { role: 'user' as const, text: '[SCK-ROUND SCK-old999]\n\n第一轮任务\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE SCK-old999]」单独成行开头，随后是完整最终答复。' },
    { role: 'devin' as const, text: '[SCK-DONE SCK-old999]\n第一轮完成' },
  ] };
  /**
   * 假 Devin 网页：ego-browser 脚本真的在 new Function 里执行，页面结构按只读实测（见 devin-web.ts 文件头）。
   * 首页 Capability 菜单只响应真实指针点击（p.click）：程序化 element.click() 只派发 click 事件，不开菜单、不改档位
   * （推断，与 2026-11-17 失败签名一致）。菜单在指针点击后按 menuDelayMs 渲染（虚拟时钟由 waitForTimeout 推进）。
   * 选中 Free 后菜单是两层（负责人 2026-11-17 真实页面实测）：第一层 Capability 列表仍开，第二层 Free 详情才有
   * "Free (powered by SWE-2)" 与 "N/M in use"。Escape 每次只收一层：第一次收详情，第二次收列表；singleLayer 时一次全收；
   * escapeLagMs 时收起要等 DOM 更新。escLog 记录每次 Escape 生效后仍可见的菜单层数。
   * 会话页：Capability 按钮 disabled、菜单打不开，正文没有席位文字。
   * events 按顺序记录导航、指针点击（pointer）、程序化点击（js）、Escape、填写、按下与发送。
   */
  interface FakeEl {
    readonly innerText: string;
    readonly disabled: boolean;
    readonly tagName: string;
    readonly attrs: Record<string, string>;
    readonly parent: FakeEl | undefined;
    click(): void;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    closest(selector: string): FakeEl | null;
    contains(other: FakeEl): boolean;
    getBoundingClientRect(): { width: number; height: number };
    querySelectorAll(selector: string): FakeEl[];
  }
  /** 假页面只认两种简单选择器：标签名与 [role=x]（子元素查询按逗号分隔的选择器表过滤）。 */
  const simpleMatch = (e: FakeEl, sel: string): boolean => {
    const role = /^\[role=([\w-]+)\]$/.exec(sel)?.[1];
    return role !== undefined ? e.attrs.role === role : e.tagName === sel;
  };
  const mkEl = (o: { tag: string; text: () => string; rect: () => { width: number; height: number };
    attrs?: Record<string, string>; parent?: FakeEl; disabled?: () => boolean; expanded?: () => boolean;
    children?: () => FakeEl[]; onClick?: () => void }): FakeEl => {
    const attrs: Record<string, string> = { ...o.attrs };
    const el: FakeEl = {
      tagName: o.tag, attrs, parent: o.parent,
      get innerText() { return o.text(); },
      get disabled() { return o.disabled?.() ?? false; },
      click: () => o.onClick?.(),
      getAttribute: (name) => {
        if (name === 'aria-expanded' && o.expanded) return String(o.expanded());
        if (name === 'aria-disabled' && o.disabled?.()) return 'true';
        return name in attrs ? attrs[name]! : null;
      },
      setAttribute: (name, value) => { attrs[name] = value; },
      removeAttribute: (name) => { delete attrs[name]; },
      closest: (selector) => {
        for (let x: FakeEl | undefined = el; x; x = x.parent) if (selector === '[role=menu]' && x.attrs.role === 'menu') return x;
        return null;
      },
      contains: (other) => {
        for (let x: FakeEl | undefined = other; x; x = x.parent) if (x === el) return true;
        return false;
      },
      getBoundingClientRect: () => o.rect(),
      querySelectorAll: (selector: string) => (o.children?.() ?? []).filter(c => selector.split(',').some(s => simpleMatch(c, s.trim()))),
    };
    return el;
  };
  const fakeDevin = (opts: FakeOpts = {}) => {
    const seats = opts.seats ?? { used: 0, total: 2 };
    const sessions: Record<string, FakeSession> = {};
    for (const [url, s] of Object.entries(opts.sessions ?? {}))
      sessions[url] = { cap: 'Free', status: 'Devin is awaiting instructions', ...s, blocks: (s.blocks ?? []).map(b => ({ ...b })) };
    const st = { url: HOME, cap: 'Normal', capBefore: 'Normal', capAt: 0, draft: '', clock: 0, menuOpen: false, menuReadyAt: 0,
      detailOpen: false, pending: [] as Array<{ at: number; run: () => void }>, escLog: [] as number[],
      events: [] as string[], sent: [] as Array<{ url: string; text: string }> };
    const isSession = (url: string) => /\/sessions\//.test(url);
    const current = () => sessions[st.url]!;
    /** 首页 Capability 菜单此刻可见：已被指针打开，并过了渲染延迟。会话页没有这个菜单。 */
    const menuShown = () => !isSession(st.url) && st.menuOpen && st.clock >= st.menuReadyAt;
    /** 页面上显示的档位：选中 Free 后可能还要等 capLagMs 才变。 */
    const capShown = () => (st.clock >= st.capAt ? st.cap : st.capBefore);
    /** 第二层 Free 详情：菜单开着、页面档位已是 Free，且它还没被 Escape 收掉。 */
    const detailShown = () => menuShown() && st.detailOpen && capShown() === 'Free';
    /** 当前可见的菜单层数（列表 + 详情），即 DOM 里可见 [role=menu] 的个数。 */
    const visibleMenus = () => (menuShown() ? 1 : 0) + (detailShown() ? 1 : 0);
    const selectFree = () => { st.capBefore = capShown(); st.cap = 'Free'; st.capAt = st.clock + (opts.capLagMs ?? 0); st.detailOpen = true; };
    const detailText = () => `Free (powered by SWE-2)\nThe plan includes ${seats.total} concurrent sessions\n${seats.used}/${seats.total} in use`;
    const bodyText = (): string => isSession(st.url)
      ? [...current().blocks.map(b => b.text), current().status].join('\n')
      : ['Organization', detailShown() ? detailText() : ''].filter(Boolean).join('\n');
    const rowNames = [...CAP_ROWS.filter(name => !(opts.noFreeRow && name === 'Free')), ...(opts.duplicateFreeRow ? ['Free'] : [])];
    const trigger = mkEl({ tag: 'button', text: () => capShown(), rect: () => ({ width: 90, height: 28 }),
      disabled: () => isSession(st.url), expanded: () => st.menuOpen,
      onClick: () => { st.events.push('js cap'); } });
    const outside = opts.outsideFree ? mkEl({ tag: 'button', text: () => 'Free', rect: () => ({ width: 60, height: 24 }) }) : undefined;
    const menuRows: FakeEl[] = [];
    const capMenu = mkEl({ tag: 'div', attrs: { role: 'menu' }, text: () => rowNames.join('\n'),
      rect: () => ({ width: 200, height: 300 }), children: () => menuRows });
    for (const name of rowNames) menuRows.push(mkEl({ tag: opts.menuItemRows ? 'a' : 'button',
      attrs: { role: opts.menuItemRows ? 'menuitem' : 'menuitemradio' }, parent: capMenu,
      text: () => name, rect: () => (menuShown() ? { width: 160, height: 32 } : { width: 0, height: 0 }),
      onClick: () => { st.events.push(`js ${name}`); if (name === 'Free' && menuShown() && !opts.freeRowInert) selectFree(); } }));
    const detailMenu = mkEl({ tag: 'div', attrs: { role: 'menu' }, text: detailText, rect: () => ({ width: 220, height: 64 }), children: () => [] });
    const staleRows: FakeEl[] = [];
    const staleMenu = opts.staleMenu ? mkEl({ tag: 'div', attrs: { role: 'menu' }, text: () => 'Account\nLog out',
      rect: () => ({ width: 0, height: 0 }), children: () => staleRows }) : undefined;
    if (staleMenu) staleRows.push(mkEl({ tag: 'div', parent: staleMenu, text: () => 'Log out', rect: () => ({ width: 0, height: 0 }) }));
    /** 文档顺序：头部按钮、触发按钮、隐藏菜单，最后是渲染出来的 Capability 菜单。 */
    const inDom = (): FakeEl[] => [
      ...(outside ? [outside] : []), trigger,
      ...(staleMenu ? [staleMenu, ...staleRows] : []),
      ...(menuShown() ? [capMenu, ...menuRows] : []),
      ...(detailShown() ? [detailMenu] : []),
    ];
    const known = (): FakeEl[] => [trigger, capMenu, ...menuRows, ...staleRows, ...(outside ? [outside] : []), ...(staleMenu ? [staleMenu] : [])];
    const matches = (e: FakeEl, sel: string): boolean => {
      if (sel === 'button') return e.tagName === 'button';
      if (sel === '[role=menu]') return e.attrs.role === 'menu';
      const name = /^\[([\w-]+)\]$/.exec(sel)?.[1];
      return name !== undefined && e.attrs[name] !== undefined;
    };
    const docFor = () => {
      const session = isSession(st.url);
      const text = bodyText();
      const authors = session ? current().blocks.filter(b => b.role !== 'tool').map(b => ({
        getAttribute: (name: string) => (name === 'data-message-author' ? b.role : null),
        innerText: b.text,
      })) : [];
      const links = (opts.sidebar ?? []).map(l => ({ href: l.href, innerText: l.title }));
      const queryAll = (sel: string): unknown[] => (sel === 'a[href^="/sessions/"]' ? links
        : sel === '[data-message-author]' ? authors : inDom().filter(e => matches(e, sel)));
      return {
        body: { innerText: text },
        querySelector: (sel: string) => (sel === 'div[role=textbox][aria-label="Prompt"]' ? { innerText: '' }
          : sel === 'main' ? { innerText: text } : (queryAll(sel)[0] ?? null)),
        querySelectorAll: queryAll,
      };
    };
    const page = {
      goto: async (url: string) => {
        st.url = url; st.menuOpen = false; st.detailOpen = false; st.pending = []; st.events.push(`visit ${url}`);
        st.cap = isSession(url) ? (sessions[url]?.cap ?? 'Free') : 'Normal';
        st.capAt = 0;
        // 导航重建页面：上一页写进 DOM 的标记随之消失。
        for (const e of known()) { delete e.attrs['data-sck-cap-trigger']; delete e.attrs['data-sck-free-row']; }
        opts.onVisit?.(url, sessions);
      },
      waitForTimeout: async (ms = 0) => {
        st.clock += ms;
        const due = st.pending.filter(j => j.at <= st.clock);
        st.pending = st.pending.filter(j => j.at > st.clock);
        for (const j of due) j.run();
      },
      keyboard: {
        press: async (key: string) => {
          st.events.push(`press ${key}`);
          if (key !== 'Escape' || opts.escapeInert) return;
          // 两层：第一次只收 Free 详情（列表仍开），第二次收列表；singleLayer 时一次全收。
          const close = () => {
            if (!opts.singleLayer && detailShown()) st.detailOpen = false;
            else { st.menuOpen = false; st.detailOpen = false; }
            st.escLog.push(visibleMenus());
          };
          if (opts.escapeLagMs) st.pending.push({ at: st.clock + opts.escapeLagMs, run: close });
          else close();
        },
      },
      evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
        g.document = docFor(); g.location = { href: st.url, hostname: 'app.devin.ai' };
        g.getComputedStyle = () => ({ visibility: 'visible' });
        return fn(arg);
      },
      fill: async (_selector: string, text: string) => { st.draft = text; st.events.push('fill'); },
      click: async (selector: string) => {
        const sel = selector.replace(/^(loc=)?css:/, '');
        if (sel === 'button[aria-label="Send"]') {
          const created = !isSession(st.url);
          const url = created ? (opts.newSession ?? NEW_SESSION) : st.url;
          if (created) { sessions[url] = { cap: 'Free', status: 'Devin is working', blocks: [] }; }
          sessions[url]!.blocks.push({ role: 'user', text: st.draft });
          sessions[url]!.status = 'Devin is working';
          st.sent.push({ url, text: st.draft }); st.events.push(`send ${url}`);
          if (created) { st.url = url; st.cap = 'Free'; st.capAt = 0; st.menuOpen = false; }
          opts.onSend?.(url, st.draft, sessions);
          return;
        }
        const marker = /^\[(data-sck-[\w-]+)\]$/.exec(sel);
        if (!marker) { st.events.push(`click ${sel}`); return; }
        // 指针点击只作用于此刻 DOM 里的元素：标记不存在或菜单未渲染，真实页面也点不到。
        const target = inDom().find(e => e.attrs[marker[1]!] !== undefined);
        if (!target) throw new Error(`no element matches ${selector}`);
        if (target === trigger) {
          if (trigger.disabled) throw new Error('element is disabled');
          st.events.push('pointer cap');
          if (!opts.noMenu) { st.menuOpen = true; st.detailOpen = false; st.menuReadyAt = st.clock + (opts.menuDelayMs ?? 0); }
          return;
        }
        if (target === outside) { st.events.push('pointer outside'); return; }
        st.events.push(`pointer ${target.innerText}`);
        if (target.innerText === 'Free' && !opts.freeRowInert) selectFree();
      },
    };
    const run = async (script: string): Promise<Record<string, unknown> | undefined> => {
      let result: Record<string, unknown> | undefined;
      const log = (line: string) => {
        if (line.startsWith('__RESULT__')) result = JSON.parse(line.slice('__RESULT__'.length)) as Record<string, unknown>;
        else st.events.push(line);
      };
      const fn = new Function('taskSpace', 'console', 'process', `return (async () => {${script}})()`);
      try {
        await fn(async () => ({ pages: async () => [page] }), { log }, { exit: () => { throw new FakeExit(); } });
      } catch (error) {
        if (!(error instanceof FakeExit)) throw error;
      } finally {
        delete g.document; delete g.location; delete g.getComputedStyle;
      }
      return result;
    };
    return { st, sessions, browse: (script: string) => run(script) };
  };
  /** 每次脚本调用推进 30 秒：让「席位满/忙」这类有时限的等待能在测试里结束。 */
  const advancing = (w: { advance(ms: number): void }, browse: NonNullable<LaneDeps['browse']>) =>
    (script: string, timeoutMs: number) => { w.advance(30_000); return browse(script, timeoutMs); };

  test('发送脚本先核验 Capability Free 与席位再发送；全程不调用 devin CLI', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe')] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
    expect(out.text).toContain(`SHA: ${'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'}`);
    expect(out.text).toContain('声明的 SHA cafecafe 与远端分支实际 HEAD 不一致');
    // 整条链路没有跑过 devin 子进程：入口不是 CLI 的 --cloud --model free
    expect(w.callsOf(c => c.cmd === 'devin')).toHaveLength(0);
    const send = b.calls.find(s => s.includes('quota_full'))!;
    // 页面核验发生在按下发送之前：Free 菜单、powered-by 文字、席位解析都在脚本里、在 PRESSED 之前
    expect(send).toContain('[role=menu]');
    expect(send).toContain('powered by SWE-2');
    expect(send).toContain('in use');
    expect(send.indexOf('capability')).toBeLessThan(send.indexOf('quota_full'));
    expect(send.indexOf('quota_full')).toBeLessThan(send.indexOf('__PRESSED__'));
    expect(send.indexOf('__PRESSED__')).toBeLessThan(send.indexOf('aria-label=\\"Send\\"'));
    // 消息带本轮标记与 SCK-DONE 收尾约定，会话地址入状态供续轮复用
    expect(send).toContain('[SCK-ROUND ');
    expect(send).toContain('[SCK-DONE ');
    expect(readLaneState(w.commDir)?.vendorSession).toBe(SESSION);
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'merge')).toHaveLength(1);
  });

  test('页面脚本 DOM 契约：Prompt 输入框、Send 按钮、状态短语与受理核对', async () => {
    const { devinSendScript, devinFollowScript, devinSessionScript, devinRecoverScript, parseSeats, devinStatus, DEVIN_SESSION_RE } =
      await import('../src/runner/cloud-lane/devin-web.ts');
    const send = devinSendScript('https://app.devin.ai/org/mainlistactivity', 'SCK-abc123', 'msg');
    expect(send).toContain('div[role=textbox][aria-label=\\"Prompt\\"]');
    expect(send).toContain('button[aria-label=\\"Send\\"]');
    expect(send).toContain('a[href^="/sessions/"]');
    const follow = devinFollowScript(SESSION, 'SCK-abc123', 'msg');
    expect(follow).toContain(SESSION);
    expect(follow).toContain("'busy'");
    const state = devinSessionScript(SESSION, 'SCK-abc123');
    expect(state).toContain('Devin is working');
    expect(state).toContain('awaiting instructions');
    expect(state).toContain('blocked on the user');
    const recover = devinRecoverScript('https://app.devin.ai/org/mainlistactivity', 'SCK-abc123');
    expect(recover).toContain('a[href^="/sessions/"]');
    expect(DEVIN_SESSION_RE.test(SESSION)).toBe(true);
    expect(DEVIN_SESSION_RE.test('https://app.devin.ai/org/mainlistactivity')).toBe(false);
    expect(parseSeats('The plan includes 2 concurrent sessions 1/2 in use')).toEqual({ used: 1, total: 2 });
    expect(parseSeats('no seats')).toBeUndefined();
    expect(devinStatus('Devin is working on it')).toBe('working');
    expect(devinStatus('Devin is awaiting instructions')).toBe('idle');
    expect(devinStatus('blocked on the user.')).toBe('blocked');
  });

  test('配置校验：devin-cloud 只接受 free；其它值、空白、空串与其它通道的 model 一律拒绝', async () => {
    const { validateLanes } = await import('../src/runner/cloud-lane/lane.ts');
    expect(() => validateLanes({ 'devin-cloud': {} })).not.toThrow();
    expect(() => validateLanes({ 'devin-cloud': { model: 'free' } })).not.toThrow();
    for (const bad of ['default', 'adaptive', 'gpt-5', '', ' ', ' free', 'free ', 'FREE', 'free\n', null, 1]) {
      expect(() => validateLanes({ 'devin-cloud': { model: bad } })).toThrow(/只能是 "free"/);
    }
    expect(() => validateLanes({ jules: { model: 'free' } })).toThrow(/不接受 model/);
    expect(() => validateLanes({ 'codex-cloud': { model: 'free' } })).toThrow(/不接受 model/);
  });

  test('绕过配置校验直接进执行入口：非 free 不做任何页面动作或推送，回合报错', async () => {
    for (const model of ['gpt-5', '', ' free', null]) {
      const w = world({ extra: gitOk });
      const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [idleDone('done')] });
      const out = await runLane(w.input({ provider: 'devin-cloud', config: { model: model as unknown as 'free', pollMs: 1 } }), { ...w.deps, browse: b.browse });
      expect(out.status).toBe('error');
      expect(out.text).toContain('只能是 "free"');
      expect(b.calls).toHaveLength(0);
      expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'push')).toHaveLength(0);
      expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'merge')).toHaveLength(0);
    }
  });

  test('缺少 ego-browser 通道 → 明确错误，不发出任何页面动作', async () => {
    const w = world({ extra: gitOk });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), w.deps);
    expect(out.status).toBe('error');
    expect(out.text).toContain('ego-browser');
  });

  test('席位满 → 等待且不发送；席位空出后同一轮发送', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({ send: [{ ok: false, code: 'quota_full', seats: '2/2' }, { ok: true, url: SESSION }], session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9')] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(w.progress.some(s => s.includes('席位已满'))).toBe(true);
    expect(b.calls.filter(s => s.includes('quota_full'))).toHaveLength(2);
  });

  test('席位持续满到时限 → 受阻且未发出，不算通道故障', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({ send: [{ ok: false, code: 'quota_full', seats: '2/2' }] });
    const browse = (async (script: string, t: number) => { const r = await b.browse(script, t); w.advance(30_000); return r; }) as typeof b.browse;
    const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1, maxMinutes: 1 } }), { ...w.deps, browse });
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^工作结果：受阻/);
    expect(out.text).toContain('2/2');
    expect(readLaneState(w.commDir)?.taskId).toBeUndefined();
  });

  test('Capability 无法确认 Free → 有界重试后受阻，绝不发送，不切付费档', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({ send: [{ ok: false, code: 'capability', detail: '按钮=Normal' }] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(out.text).toContain('Free');
    expect(b.calls.filter(s => s.includes(MODE('send')))).toHaveLength(3);
    expect(readLaneState(w.commDir)?.taskId).toBeUndefined();
    expect(readLaneState(w.commDir)?.devin?.attempt).toBeUndefined();
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(0);
  });

  test('上一轮按下发送且受理未确认、无会话地址时换 prompt → 受阻，不另建会话，在途登记保留', async () => {
    const w = world({ extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', taskId: 'SCK-old-marker', branch: 'sck/task-1',
      submittedAt: Date.now() });
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9')] });
    const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1 } }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(out.text).toContain('未发出');
    expect(b.calls).toHaveLength(0);
    expect(readLaneState(w.commDir)?.taskId).toBe('SCK-old-marker');
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'push')).toHaveLength(0);
  });

  test('发送中途进程中断（attempt 残留、没有 taskId）后换 prompt → 受阻，不另建会话，attempt 保留', async () => {
    const w = world({ extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', devin: { attempt: 'SCK-old-marker', attemptAt: Date.now() },
      branch: 'sck/task-1' });
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9')] });
    const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1 } }), { ...w.deps, browse: b.browse });
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(b.calls).toHaveLength(0);
    expect(readLaneState(w.commDir)?.devin?.attempt).toBe('SCK-old-marker');
  });

  test('egoBrowse：超时被杀但已打出按下标记 → pressed；静默退出且无标记 → undefined（未按下）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-ego-fake-'));
    dirs.push(dir);
    const pressed = join(dir, 'ego-pressed');
    // 脚本带 warm 分支，计时前先空跑一次：macOS 对新写出的可执行文件首次执行要做安全扫描（实测 0.5–2 秒），
    // 这段时间不该算进超时窗口；之后再执行只要约 20 毫秒。超时只用来杀进程，标记必须在被杀之前写进管道。
    writeFileSync(pressed, '#!/bin/sh\n[ "$1" = warm ] && exit 0\necho __PRESSED__\nexec sleep 30\n');
    chmodSync(pressed, 0o755);
    spawnSync(pressed, ['warm']);
    expect(await egoBrowse(pressed)('x', 6_000)).toEqual({ ok: false, code: 'pressed' });
    const silent = join(dir, 'ego-silent');
    writeFileSync(silent, '#!/bin/sh\nexit 1\n');
    chmodSync(silent, 0o755);
    spawnSync(silent);
    expect(await egoBrowse(silent)('x', 5_000)).toBeUndefined();
  }, 20_000);

  test('egoBrowse：孙进程占着管道、close 迟迟不来 → 5 秒兜底后保守报 pressed（去掉宽限就会超时）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-ego-hold-'));
    dirs.push(dir);
    const hold = join(dir, 'ego-hold');
    // 后台 sleep 继承了 stdout；exec 之后的前台 sleep 被 SIGKILL 杀掉，但后台那个仍占着管道，close 要等 60 秒。
    // 窗口给 3 秒，确保 kill 时后台子进程已经起来（否则管道立即关闭，用例就没有测到兜底）。
    // 兜底约 5 秒；若去掉它，这个用例要等后台的 sleep 60 结束才 close，远超 25 秒的测试预算而失败。
    writeFileSync(hold, '#!/bin/sh\n[ "$1" = warm ] && exit 0\n(sleep 60) &\nexec sleep 60\n');
    chmodSync(hold, 0o755);
    spawnSync(hold, ['warm']);
    const started = Date.now();
    expect(await egoBrowse(hold)('x', 3_000)).toEqual({ ok: false, code: 'pressed' });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 25_000);

  test('超时后同一轮只回执核对不重发：状态留在途，下轮直接轮询原会话', async () => {
    const working = { ok: true, markerSeen: true, status: 'working', done: null, tail: '' };
    const w1 = world({ extra: gitOk });
    const b1 = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [working] });
    const input1 = w1.input({ provider: 'devin-cloud', config: { pollMs: 1, maxMinutes: 1 } });
    const browse1 = (async (script: string, t: number) => { const r = await b1.browse(script, t); if (!script.includes('const MSG =')) w1.advance(30_000); return r; }) as typeof b1.browse;
    const out1 = await runLane(input1, { ...w1.deps, browse: browse1 });
    expect(out1.status).toBe('error');
    expect(out1.text).toContain(SESSION);
    expect(out1.text).toContain('仍在运行');
    expect(readLaneState(w1.commDir)?.taskUrl).toBe(SESSION);
    // 第二轮：同 prompt 同摘要 → 不再跑发送脚本，直接轮询原会话地址
    const b2 = devinBrowse({ session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe')] });
    const out2 = await runLane(input1, { ...w1.deps, browse: b2.browse });
    expect(out2.status).toBe('success');
    expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/9');
    expect(b2.calls.some(s => s.includes('const MSG ='))).toBe(false);
    expect(b2.calls.length).toBeGreaterThan(0);
    expect(b2.calls.every(s => s.includes(SESSION))).toBe(true);
  });

  test('按下发送后脚本中断：先回会话列表核对受理，找到了就接管该会话', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: false, code: 'pressed' }],
      recover: [{ ok: true, found: SESSION }],
      session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9')],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(b.calls.filter(s => s.includes('const MSG ='))).toHaveLength(1);
    expect(b.calls.filter(s => s.includes('probed'))).toHaveLength(1);
    expect(readLaneState(w.commDir)?.vendorSession).toBe(SESSION);
  });

  test('按下发送后受理未确认 → 只核对不重发，明确受阻并保留在途状态；恢复时接管原会话', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: false, code: 'pressed' }],
      recover: [{ ok: true, found: null, listed: 6, probed: 6 }],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(out.text).toContain('未自动重发');
    // 发送脚本只跑过一次；核对跑满上限后受阻；在途标记保留，没有新会话、没有第二次发送
    expect(b.calls.filter(s => s.includes(MODE('send')))).toHaveLength(1);
    expect(b.calls.filter(s => s.includes(MODE('recover')))).toHaveLength(4);
    expect(w.phases).not.toContain('accepted');
    const st = readLaneState(w.commDir);
    expect(st?.taskId).toMatch(/^SCK-/);
    expect(st?.devin?.attempt).toBeUndefined();
    // 恢复本任务（同一 prompt）：只核对；找到了就接管原会话，不再发送
    const b2 = devinBrowse({
      recover: [{ ok: true, found: SESSION }],
      session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe')],
    });
    const out2 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b2.browse });
    expect(out2.status).toBe('success');
    expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/9');
    expect(b2.calls.some(s => s.includes(MODE('send')))).toBe(false);
    expect(b2.calls.some(s => s.includes(MODE('follow')))).toBe(false);
  });

  test('续轮/返工/复核复用原 Devin 会话：发跟进消息，不新建会话不占新席位', async () => {
    const w = world({ extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
    const b = devinBrowse({ follow: [{ ok: true, url: SESSION }], session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9')] });
    const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    // 没用新会话发送脚本（不会碰席位），跟进脚本落在原会话地址上并核验会话档位
    expect(b.calls.some(s => s.includes(MODE('send')))).toBe(false);
    const follow = b.calls.find(s => s.includes(MODE('follow')))!;
    expect(follow).toContain(SESSION);
    expect(follow).toContain("'Free'");
  });

  test('复核轮要求复核结论首行；非 free 的复核轮也不做任何页面动作', async () => {
    const review = '# 复核\n\n## 待复核成果\n\n已提交 abc123。\n\n## 验收标准\n\n- 逐条复验\n';
    const w = world({ task: review, extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old', vendorSession: SESSION, branch: 'sck/task-1' });
    const b = devinBrowse({ follow: [{ ok: true, url: SESSION }], session: [idleDone('复核结论：通过\n逐条证据。')] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^复核结论：通过/);

    const bad = world({ task: review, extra: gitOk });
    const bb = devinBrowse({ follow: [{ ok: true, url: SESSION }], session: [idleDone('复核结论：通过')] });
    const bout = await runLane(bad.input({ provider: 'devin-cloud', config: { model: 'gpt-5' as unknown as 'free', pollMs: 1 } }), { ...bad.deps, browse: bb.browse });
    expect(bout.status).toBe('error');
    expect(bb.calls).toHaveLength(0);
  });

  test('复核答复首行不是复核结论 → 错误回合', async () => {
    const w = world({ task: '# 复核\n\n## 待复核成果\n\n已提交。\n', extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old', vendorSession: SESSION, branch: 'sck/task-1' });
    const b = devinBrowse({ follow: [{ ok: true, url: SESSION }], session: [idleDone('看起来不错')] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('error');
    expect(out.text).toContain('复核结论');
  });

  test('Devin 停下来等用户 → 受阻并带回答复现场', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION }],
      session: [{ ok: true, markerSeen: true, status: 'blocked', done: null, tail: '要不要删除旧表？' }],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^工作结果：受阻/);
    expect(out.text).toContain('要不要删除旧表');
  });

  test('转录里一直看不到本轮标记 → 不补发、不另建会话，明确受阻并保留在途状态', async () => {
    const w = world({ extra: gitOk });
    const missing = { ok: true, markerSeen: false, status: 'idle', done: null, tail: '' };
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [missing, missing, missing] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(out.text).toContain('未重发');
    expect(b.calls.filter(s => s.includes(MODE('send')))).toHaveLength(1);
    expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
    expect(b.calls.filter(s => s.includes(MODE('session')))).toHaveLength(3);
    const st = readLaneState(w.commDir);
    expect(st?.taskId).toMatch(/^SCK-/);
    expect(st?.taskUrl).toBe(SESSION);
  });

  test('登录失效 → 错误回合', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({ send: [{ ok: false, code: 'login_required' }] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('error');
    expect(out.text).toContain('app.devin.ai');
  });

  test('Devin 答复缺 SHA 行时补实际 HEAD', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9')] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text).toContain('SHA: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  test('非快进合并 → 错误回合且不 reset', async () => {
    const w = world({ extra: call => {
      if (call.cmd === 'git' && call.args[0] === 'merge') return bad('Not possible to fast-forward');
      return gitOk(call);
    }});
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe')] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('error');
    expect(out.text).toContain('快进');
  });

  test('Devin 没有推送任何改动 → 受阻', async () => {
    const w = world({ extra: call => {
      if (call.cmd === 'git' && call.args[0] === 'fetch') return ok('');
      if (call.cmd === 'git' && call.args[0] === 'merge') return bad('nothing to merge');
      return gitOk(call);
    }});
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [idleDone('我做不了这个。')] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^工作结果：受阻/);
  });
  test('续轮前核验席位：满座等待不发；空出后发送，并把档位与席位读数记入状态', async () => {
    const w = world({ extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
    const b = devinBrowse({
      follow: [
        { ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' },
        { ok: true, url: SESSION, cap: 'Free', seats: { used: 1, total: 2 }, echoed: true },
      ],
      session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe')],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(2);
    expect(b.calls.some(s => s.includes(MODE('send')))).toBe(false);
    expect(w.progress.some(s => s.includes('席位已满'))).toBe(true);
    expect(readLaneState(w.commDir)?.devin?.seats).toMatchObject({ step: 'follow', cap: 'Free', used: 1, total: 2 });
  });

  test('续轮读不到 Free 席位 → 不发送，有界重试后受阻', async () => {
    const w = world({ extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
    const b = devinBrowse({ follow: [{ ok: false, code: 'capability', detail: '会话页读不到 N/M in use' }] });
    const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(3);
    expect(readLaneState(w.commDir)?.taskId).toBeUndefined();
  });

  test('续轮脚本顺序：原会话核验 → 首页选 Free 读席位 → 回原会话复核 → 按下发送（PRESSED 先于点击）', async () => {
    const { devinFollowScript } = await import('../src/runner/cloud-lane/devin-web.ts');
    const f = devinFollowScript(SESSION, 'SCK-abc123', 'msg');
    const at = (s: string, from = 0) => {
      const i = f.indexOf(s, from);
      expect(i).toBeGreaterThanOrEqual(from);
      return i;
    };
    const gate1 = at('const firstStop = sessionGate(s)');
    const home = at(`await openPage(${JSON.stringify(HOME)})`, gate1);
    const picked = at('await pickFree()', home);
    const homeGate = at('const homeStop = homeGate(s)', picked);
    const seats = at('const pre = s.seats', homeGate);
    const back = at(`await openPage(${JSON.stringify(SESSION)})`, seats);
    const gate2 = at('const againStop = sessionGate(s)', back);
    const fill = at('await p.fill(target, MSG)', gate2);
    const pressed = at("console.log('__PRESSED__')", fill);
    expect(at("await p.click('loc=css:' + ", pressed)).toBeGreaterThan(pressed);
  });

  test('进展阶段：先报尝试，真正受理后才报已受理，不把尝试写成已派', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true }],
      session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe')],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    const attempt = w.phases.indexOf('attempt');
    const accepted = w.phases.indexOf('accepted');
    expect(attempt).toBeGreaterThanOrEqual(0);
    expect(accepted).toBeGreaterThan(attempt);
    expect(w.progress[accepted]).toContain('已受理');
    expect(w.progress.some(s => s.includes('已发给'))).toBe(false);
  });

  test('发送中途进程中断（attempt 已落盘）→ 重启只核对不重发，找到则接管原会话', async () => {
    const w = world({ extra: gitOk });
    const first = devinBrowse({});
    const crashing = (async (script: string, t: number) => {
      if (script.includes(MODE('send'))) throw new Error('bridge interrupted');
      return first.browse(script, t);
    }) as typeof first.browse;
    const out1 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: crashing });
    expect(out1.status).toBe('error');
    expect(readLaneState(w.commDir)?.devin?.attempt).toMatch(/^SCK-/);
    expect(readLaneState(w.commDir)?.taskId).toBeUndefined();

    const b2 = devinBrowse({
      recover: [{ ok: true, found: SESSION }],
      session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe')],
    });
    const out2 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b2.browse });
    expect(out2.status).toBe('success');
    expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/9');
    expect(b2.calls.some(s => s.includes(MODE('send')))).toBe(false);
    expect(b2.calls.filter(s => s.includes(MODE('recover')))).toHaveLength(1);
  });

  test('发送中途进程中断且核对找不到 → 受阻，不重发，不另建会话', async () => {
    const w = world({ extra: gitOk });
    const first = devinBrowse({});
    const crashing = (async (script: string, t: number) => {
      if (script.includes(MODE('send'))) throw new Error('bridge interrupted');
      return first.browse(script, t);
    }) as typeof first.browse;
    await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: crashing });
    const b2 = devinBrowse({ recover: [{ ok: true, found: null, listed: 0, probed: 0 }] });
    const out2 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b2.browse });
    expect(out2.status).toBe('success');
    expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(b2.calls.some(s => s.includes(MODE('send')))).toBe(false);
    // 在途标记保留（不清掉），下一次恢复仍只核对
    expect(readLaneState(w.commDir)?.taskId).toMatch(/^SCK-/);
  });

  test('状态 unknown 的答复不收尾：超时按错误回合，不拉取分支', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true }],
      session: [{ ok: true, markerSeen: true, status: 'unknown', done: '残留答复\nPR: https://github.com/acme/widget/pull/9', tail: '' }],
    });
    const browse = (async (script: string, t: number) => { const r = await b.browse(script, t); w.advance(30_000); return r; }) as typeof b.browse;
    const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1, maxMinutes: 1 } }), { ...w.deps, browse });
    expect(out.status).toBe('error');
    expect(out.text).toContain('超过配置时限');
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(0);
  });

  test('空闲却没有本轮 SCK-DONE 终稿：连续确认后受阻交人工核对，不收尾', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true }],
      session: [{ ok: true, markerSeen: true, status: 'idle', done: null, tail: '完成了但没写标记' }],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(b.calls.filter(s => s.includes(MODE('session')))).toHaveLength(3);
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(0);
  });

  test('工具输出含 DONE/PR、助手没有终稿（mock）：不以工具输出收尾，受阻且不拉取分支', async () => {
    const w = world({ extra: gitOk });
    const toolTail = '工具输出：\n[SCK-DONE SCK-tool-only]\nPR: https://github.com/acme/widget/pull/1\n提交：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nDevin is awaiting instructions';
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true }],
      session: [{ ok: true, markerSeen: true, status: 'idle', done: null, tail: toolTail }],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    // 工具输出只出现在人工核对的现场里，没有被当成助手终稿收尾（没有拉取分支、没有 PR 结果行）。
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(0);
    expect(b.calls.filter(s => s.includes(MODE('session')))).toHaveLength(3);
  });

  test('真终稿后紧跟工具输出 DONE（mock）：收尾只用助手终稿，不采信工具输出里的 PR', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true }],
      session: [{
        ok: true, markerSeen: true, status: 'idle',
        done: '完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe',
        tail: '工具输出：\n[SCK-DONE SCK-real]\nPR: https://github.com/acme/widget/pull/999\nSHA: bbbbbbbb',
      }],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
    expect(out.text).not.toContain('/pull/999');
  });

  test('换员工目录重派同一任务：共享 attempt 让新目录只核对、不再按下发送', async () => {
    const task = '# 云端任务\n\n实现需求甲。\n';
    const w1 = world({ task, extra: gitOk });
    // 第一次：attempt 已写本目录与共享登记，但发送脚本还没跑就被中断。
    const crashBrowse = (async (script: string) => {
      if (script.includes(MODE('send'))) throw new Error('bridge interrupted before script');
      return undefined;
    }) as NonNullable<LaneDeps['browse']>;
    const input1 = w1.input({ provider: 'devin-cloud' });
    const out1 = await runLane(input1, { ...w1.deps, browse: crashBrowse });
    expect(out1.status).toBe('error');
    const repo = { slug: 'acme/widget', owner: 'acme', repo: 'widget', branch: 'sck/task-1', defaultBranch: 'main' };
    const digest = laneDigest('devin-cloud', vendorPrompt(input1, repo, taskMaterial(w1.commDir, input1.prompt)));
    const reg = readInflight(w1.stateRoot, 'devin-cloud', digest);
    expect(reg?.attempt).toMatch(/^SCK-/);
    expect(reg?.taskId).toBeUndefined();

    // 第二个员工目录，同一 stateRoot、同一 task.md（同一摘要）：只核对，绝不按发送。
    const w2 = world({ task, extra: gitOk });
    const b2 = devinBrowse({ recover: [{ ok: true, found: null, listed: 0, probed: 0 }] });
    const out2 = await runLane(w2.input({ provider: 'devin-cloud', stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2.browse });
    expect(out2.status).toBe('success');
    expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(b2.calls.some(s => s.includes(MODE('send')))).toBe(false);
    expect(b2.calls.some(s => s.includes(MODE('follow')))).toBe(false);
    expect(b2.calls.filter(s => s.includes(MODE('recover')))).toHaveLength(4);
  });

  describe('假 Devin 网页上的续轮与新会话（脚本真实执行）', () => {
    test('续轮端到端：原会话核验 → 首页选 Free 读席位 → 回原会话复核 → 发送；受理后只轮询原会话', async () => {
      const w = world({ extra: gitOk });
      writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const fake = fakeDevin({ seats: { used: 1, total: 2 }, sessions: { [SESSION]: OLD_ROUND }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(fake.st.events.slice(0, 10)).toEqual([
        `visit ${SESSION}`, `visit ${HOME}`, 'pointer cap', 'pointer Free', 'press Escape', 'press Escape', `visit ${SESSION}`, 'fill', '__PRESSED__', `send ${SESSION}`,
      ]);
      expect(fake.st.events).not.toContain('js cap');
      expect(fake.st.events.filter(e => e.startsWith('send'))).toHaveLength(1);
      expect(readLaneState(w.commDir)?.devin?.seats).toMatchObject({ step: 'follow', cap: 'Free', used: 1, total: 2 });
      expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'merge')).toHaveLength(1);
    });

    test('续轮席位满：首页读到 2/2 就不回原会话、不填写、不按下发送，有界等待后受阻', async () => {
      const w = world({ extra: gitOk });
      writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const fake = fakeDevin({ seats: { used: 2, total: 2 }, sessions: { [SESSION]: OLD_ROUND } });
      const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。', config: { pollMs: 1, maxMinutes: 1 } }),
        { ...w.deps, browse: advancing(w, fake.browse) });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('2/2');
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.events).not.toContain('__PRESSED__');
      expect(fake.st.sent).toHaveLength(0);
      expect(readLaneState(w.commDir)?.taskId).toBeUndefined();
    });

    test('续轮时原会话正忙：不去首页、不发送，等到时限后受阻', async () => {
      const w = world({ extra: gitOk });
      writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const fake = fakeDevin({ seats: { used: 0, total: 2 }, sessions: { [SESSION]: { ...OLD_ROUND, status: 'Devin is working' } } });
      const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。', config: { pollMs: 1, maxMinutes: 1 } }),
        { ...w.deps, browse: advancing(w, fake.browse) });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('一直在处理上一轮');
      expect(fake.st.events).not.toContain(`visit ${HOME}`);
      expect(fake.st.sent).toHaveLength(0);
    });

    test('续轮时原会话在首页选 Free 期间变忙：回原会话复核时拒绝，不发送', async () => {
      const w = world({ extra: gitOk });
      writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const fake = fakeDevin({
        seats: { used: 0, total: 2 }, sessions: { [SESSION]: OLD_ROUND },
        onVisit: (url, sessions) => { if (url === HOME) sessions[SESSION]!.status = 'Devin is working'; },
      });
      const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。', config: { pollMs: 1, maxMinutes: 1 } }),
        { ...w.deps, browse: advancing(w, fake.browse) });
      const home = fake.st.events.indexOf(`visit ${HOME}`);
      expect(home).toBeGreaterThan(-1);
      expect(fake.st.events.slice(home)).toContain('pointer Free');
      expect(fake.st.events.slice(home)).toContain(`visit ${SESSION}`);
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.sent).toHaveLength(0);
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    });

    test('续轮时首页菜单没有 Free 行：确认不了 Free，有界重试后受阻，不点其它档位、不发送', async () => {
      const w = world({ extra: gitOk });
      writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const fake = fakeDevin({ noFreeRow: true, seats: { used: 0, total: 2 }, sessions: { [SESSION]: OLD_ROUND } });
      const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('Free');
      expect(fake.st.events.filter(e => e.startsWith('pointer') && e !== 'pointer cap')).toEqual([]);
      expect(fake.st.sent).toHaveLength(0);
    });

    test('新会话：侧栏已有本轮标记就直接接管，不点 Capability、不发送', async () => {
      const { devinSendScript } = await import('../src/runner/cloud-lane/devin-web.ts');
      const fake = fakeDevin({ sidebar: [{ href: SESSION, title: '[SCK-ROUND SCK-abc123] 任务' }] });
      const r = await fake.browse(devinSendScript(HOME, 'SCK-abc123', 'msg'));
      expect(r).toMatchObject({ ok: true, recovered: SESSION });
      expect(fake.st.events).toEqual([`visit ${HOME}`]);
      expect(fake.st.sent).toHaveLength(0);
    });

    test('新会话：首页读到席位已满，不点发送按钮', async () => {
      const { devinSendScript } = await import('../src/runner/cloud-lane/devin-web.ts');
      const fake = fakeDevin({ seats: { used: 2, total: 2 } });
      const r = await fake.browse(devinSendScript(HOME, 'SCK-abc123', 'msg'));
      expect(r).toEqual({ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' });
      expect(fake.st.events).toEqual([`visit ${HOME}`, 'pointer cap', 'pointer Free', 'press Escape', 'press Escape']);
      expect(fake.st.sent).toHaveLength(0);
    });

    test('新会话：选不上 Free 就报 capability，不填写、不按下发送', async () => {
      const { devinSendScript } = await import('../src/runner/cloud-lane/devin-web.ts');
      const fake = fakeDevin({ noFreeRow: true });
      const r = await fake.browse(devinSendScript(HOME, 'SCK-abc123', 'msg'));
      expect(r).toMatchObject({ ok: false, code: 'capability' });
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.events).not.toContain('__PRESSED__');
    });

    test('真实页面脚本 + 驱动层负例：工具输出含 DONE 与 PR、助手没有发言块 → 受阻，不拉取分支、不合并，只发送一次', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({
        seats: { used: 0, total: 2 },
        onSend: (url, text, sessions) => {
          sessions[url]!.blocks.push({ role: 'tool', text: `工具输出：\n[SCK-DONE ${markerOf(text)}]\nPR: https://github.com/acme/widget/pull/1\n提交：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` });
          sessions[url]!.status = 'Devin is awaiting instructions';
        },
      });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(fake.st.sent).toHaveLength(1);
      expect(w.callsOf(c => c.cmd === 'git' && (c.args[0] === 'fetch' || c.args[0] === 'merge'))).toHaveLength(0);
    });

    test('真实页面脚本 + 驱动层正例：助手终稿后紧跟工具输出的 DONE 与 PR → 收尾只用助手终稿', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({
        seats: { used: 0, total: 2 },
        onSend: answer(PR9, m => [{ role: 'tool', text: `工具输出：\n[SCK-DONE ${m}]\nPR: https://github.com/acme/widget/pull/999\nSHA: bbbbbbbb` }]),
      });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(out.text).not.toContain('/pull/999');
      expect(fake.st.sent).toHaveLength(1);
    });
  });

  describe('首页选中 Free：指针点击、有界等待与回读（假页面区分指针点击与程序化点击）', () => {
    /** 选 Free 的步骤：指针打开 Capability、指针点 Free、两次 Escape 逐层收起（真实页面是两层）。 */
    const PICK = ['pointer cap', 'pointer Free', 'press Escape', 'press Escape'];
    const pickOf = (events: string[]) => {
      const at = events.indexOf('pointer cap');
      return at < 0 ? [] : events.slice(at, at + PICK.length);
    };

    test('新会话：指针打开 Capability、指针点 Free、回读后 Escape 收起，再填写与发送；没有程序化点击', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(fake.st.events.slice(0, 8)).toEqual([`visit ${HOME}`, ...PICK, 'fill', '__PRESSED__', `send ${NEW_SESSION}`]);
      expect(fake.st.events.filter(e => e.startsWith('js'))).toEqual([]);
      expect(fake.st.sent).toHaveLength(1);
    });

    test('初次与续轮选中 Free 的步骤一致：同样是指针打开、指针点 Free、Escape 收起', async () => {
      const newW = world({ extra: gitOk });
      const newFake = fakeDevin({ seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      await runLane(newW.input({ provider: 'devin-cloud' }), { ...newW.deps, browse: newFake.browse });
      const followW = world({ extra: gitOk });
      writeLaneState(followW.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const followFake = fakeDevin({ seats: { used: 1, total: 2 }, sessions: { [SESSION]: OLD_ROUND }, onSend: answer(PR9) });
      await runLane(followW.input({ provider: 'devin-cloud', prompt: '继续修复。' }), { ...followW.deps, browse: followFake.browse });
      expect(pickOf(newFake.st.events)).toEqual(PICK);
      expect(pickOf(followFake.st.events)).toEqual(PICK);
      expect(newFake.st.sent).toHaveLength(1);
      expect(followFake.st.sent).toHaveLength(1);
    });

    test('菜单渲染晚于固定等待：有界轮询到唯一的 Free 行出现后再点，不误报受阻', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ menuDelayMs: 4000, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(pickOf(fake.st.events)).toEqual(PICK);
      expect(fake.st.sent).toHaveLength(1);
    });

    test('点 Free 后档位与席位晚一点才显示：有界轮询读到，再收起菜单并发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ capLagMs: 1500, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(fake.st.events.slice(0, 8)).toEqual([`visit ${HOME}`, ...PICK, 'fill', '__PRESSED__', `send ${NEW_SESSION}`]);
    });

    test('点 Free 后档位一直不变（回读超时）：零发送，受阻', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ capLagMs: 600_000, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.sent).toHaveLength(0);
    });

    test('页面先有一个隐藏的账户菜单（文档靠前）：只认可见的 Capability 菜单', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ staleMenu: true, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(pickOf(fake.st.events)).toEqual(PICK);
    });

    test('页头另有一个文字为 Free 的按钮：分不清哪个是 Capability，不点任何按钮，有界重试后受阻，零发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ outsideFree: true, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('无法确定哪个是 Capability');
      expect(fake.st.events.filter(e => e.startsWith('pointer') || e.startsWith('js'))).toEqual([]);
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.sent).toHaveLength(0);
    });

    test('菜单里有两个 Free 行：无法确定点哪个，不点 Free，有界重试后受阻，零发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ duplicateFreeRow: true, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('2 个 Free 行');
      expect(fake.st.events.filter(e => e.startsWith('pointer') && e !== 'pointer cap')).toEqual([]);
      expect(fake.st.events.filter(e => e.startsWith('js'))).toEqual([]);
      expect(fake.st.sent).toHaveLength(0);
    });

    test('指针点 Free 行没有生效（按钮仍是 Normal）：回读确认不了 Free，零发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ freeRowInert: true, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('按钮=Normal');
      expect(fake.st.events).toContain('pointer Free');
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.sent).toHaveLength(0);
    });

    test('Escape 一直收不起菜单（两层都挡着输入区）：按有界次数后受阻，不填写、不发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ escapeInert: true, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('按 Escape 后仍挡着页面');
      // 驱动层会整段重试；每次重试都从首页重新开始，单次尝试里的 Escape 次数都必须有界。
      const perAttempt: number[] = [];
      for (const e of fake.st.events) {
        if (e === `visit ${HOME}`) perAttempt.push(0);
        else if (e === 'press Escape' && perAttempt.length > 0) perAttempt[perAttempt.length - 1]!++;
      }
      expect(perAttempt.length).toBeGreaterThan(0);
      expect(perAttempt.every(n => n > 0 && n <= 4)).toBe(true);
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.events).not.toContain('__PRESSED__');
      expect(fake.st.sent).toHaveLength(0);
    });

    test('选中 Free 后菜单是两层：第一次 Escape 只收 Free 详情、列表仍开；第二次收起列表后才填写并发送（修前单次 Escape 会误拦发送）', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(fake.st.escLog).toEqual([1, 0]);
      expect(pickOf(fake.st.events)).toEqual(PICK);
      expect(fake.st.events.indexOf('fill')).toBeGreaterThan(fake.st.events.lastIndexOf('press Escape'));
      expect(fake.st.sent).toHaveLength(1);
    });

    test('菜单只有一层：一次 Escape 就全部收起，收起后即停，不再多按', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ singleLayer: true, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(fake.st.escLog).toEqual([0]);
      expect(fake.st.events.slice(fake.st.events.indexOf('pointer cap'), fake.st.events.indexOf('fill')))
        .toEqual(['pointer cap', 'pointer Free', 'press Escape']);
      expect(fake.st.sent).toHaveLength(1);
    });

    test('Escape 生效慢一拍（DOM 500ms 后才更新）：等它变化再决定，菜单还在时不重复按', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ escapeLagMs: 500, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(fake.st.escLog).toEqual([1, 0]);
      expect(pickOf(fake.st.events)).toEqual(PICK);
      expect(fake.st.sent).toHaveLength(1);
    });

    test('Free 项是 role=menuitem 的链接（真实页面的菜单项角色，标签不是 button）：照样认出、指针点中、回读并发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ menuItemRows: true, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(pickOf(fake.st.events)).toEqual(PICK);
      expect(fake.st.events.filter(e => e.startsWith('js'))).toEqual([]);
      expect(fake.st.sent).toHaveLength(1);
    });

    test('指针点 Capability 也打不开菜单：不点 Free、不改用程序化点击、零发送，受阻', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ noMenu: true, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('菜单里没有可见的 Free 行');
      expect(fake.st.events.filter(e => e.startsWith('pointer') && e !== 'pointer cap')).toEqual([]);
      expect(fake.st.events.filter(e => e.startsWith('js'))).toEqual([]);
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.sent).toHaveLength(0);
    });
  });

  describe('跨员工目录的发送意图（同一 stateRoot、同一任务）', () => {
    const task = '# 云端任务\n\n实现需求甲。\n';
    const REPO = { slug: 'acme/widget', owner: 'acme', repo: 'widget', branch: 'sck/task-1', defaultBranch: 'main' };
    const FOLLOW = '继续修复。';
    const sendOf = (s: string) => s.includes(MODE('send')) || s.includes(MODE('follow'));
    /** 同一 prompt 与 task.md 算出的回合摘要相同，两个员工目录共享的登记键也相同。 */
    const digestOf = (w: ReturnType<typeof world>, prompt: string) =>
      laneDigest('devin-cloud', vendorPrompt(w.input({ provider: 'devin-cloud', prompt }), REPO, taskMaterial(w.commDir, prompt)));
    const killedBefore = (name: string) => (async (script: string) => {
      if (script.includes(MODE(name))) throw new Error(`bridge killed (${name})`);
      return undefined;
    }) as NonNullable<LaneDeps['browse']>;

    test('E（续轮）：A 落下续轮发送意图后脚本没跑到就被杀；B 只核对原会话，找不到就受阻，不发送', async () => {
      const w1 = world({ task, extra: gitOk });
      writeLaneState(w1.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const out1 = await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: killedBefore('follow') });
      expect(out1.status).toBe('error');
      const digest = digestOf(w1, FOLLOW);
      expect(readInflight(w1.stateRoot, 'devin-cloud', digest)?.attemptSession).toBe(SESSION);

      const w2 = world({ task, extra: gitOk });
      const b2 = devinBrowse({ session: [unseen] });
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: FOLLOW, stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2.browse });
      expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(b2.calls.some(sendOf)).toBe(false);
      expect(b2.calls).toHaveLength(4);
      expect(b2.calls.every(s => s.includes(SESSION))).toBe(true);
      // 登记仍是在途：带着原会话地址，之后也只核对
      const reg = readInflight(w1.stateRoot, 'devin-cloud', digest);
      expect(reg?.taskId).toMatch(/^SCK-/);
      expect(reg?.attemptSession).toBe(SESSION);
    });

    test('B（续轮）：A 已按下后被杀；B 在原会话里核对到本轮标记就接管，不发送，也不轮询 B 本地记着的其它会话', async () => {
      const w1 = world({ task, extra: gitOk });
      writeLaneState(w1.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: killedBefore('follow') });

      const w2 = world({ task, extra: gitOk });
      writeLaneState(w2.commDir, { sessionId: 'lane-2', digest: 'other-digest', vendorSession: OTHER, branch: 'sck/task-1' });
      const b2 = devinBrowse({ session: [idleDone(PR9)] });
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: FOLLOW, stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2.browse });
      expect(out2.status).toBe('success');
      expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(b2.calls.some(sendOf)).toBe(false);
      expect(b2.calls.every(s => s.includes(SESSION))).toBe(true);
      expect(b2.calls.some(s => s.includes(OTHER))).toBe(false);
    });

    test('D（续轮）：A 已按下但没拿到会话地址，登记只剩 taskId 与原会话；B 只核对原会话，不再发送', async () => {
      const w1 = world({ task, extra: gitOk });
      writeLaneState(w1.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const a = devinBrowse({ follow: [{ ok: false, code: 'pressed' }], session: [unseen] });
      const out1 = await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW, config: { pollMs: 1 } }), { ...w1.deps, browse: a.browse });
      expect(out1.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(a.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
      expect(readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, FOLLOW))?.attemptSession).toBe(SESSION);

      const w2 = world({ task, extra: gitOk });
      const b2 = devinBrowse({ session: [idleDone(PR9)] });
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: FOLLOW, stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2.browse });
      expect(out2.status).toBe('success');
      expect(b2.calls.some(sendOf)).toBe(false);
      expect(b2.calls.every(s => s.includes(SESSION))).toBe(true);
    });

    test('已受理后 A 在轮询时被杀：B 按登记的 taskUrl 只轮询，不发送', async () => {
      const w1 = world({ task, extra: gitOk });
      writeLaneState(w1.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const a = (async (script: string) => {
        if (script.includes(MODE('follow'))) return { ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true };
        throw new Error('bridge killed while polling');
      }) as NonNullable<LaneDeps['browse']>;
      const out1 = await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: a });
      expect(out1.status).toBe('error');
      expect(readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, FOLLOW))?.taskUrl).toBe(SESSION);

      const w2 = world({ task, extra: gitOk });
      const b2 = devinBrowse({ session: [idleDone(PR9)] });
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: FOLLOW, stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2.browse });
      expect(out2.status).toBe('success');
      expect(b2.calls.some(sendOf)).toBe(false);
      expect(b2.calls.every(s => s.includes(SESSION))).toBe(true);
    });

    test('新会话的发送意图未确认：B 本地残留的旧会话地址不用来核对，只按标记在会话列表里找', async () => {
      const w1 = world({ task, extra: gitOk });
      await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: killedBefore('send') });
      const reg = readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, FOLLOW));
      expect(reg?.attempt).toMatch(/^SCK-/);
      expect(reg?.attemptSession).toBeUndefined();

      const w2 = world({ task, extra: gitOk });
      writeLaneState(w2.commDir, { sessionId: 'lane-2', digest: 'other-digest', vendorSession: OTHER, branch: 'sck/task-1' });
      const b2 = devinBrowse({ recover: [{ ok: true, found: null, listed: 0, probed: 0 }] });
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: FOLLOW, stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2.browse });
      expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(b2.calls.some(s => s.includes(OTHER))).toBe(false);
      expect(b2.calls.filter(s => s.includes(MODE('recover')))).toHaveLength(4);
      expect(b2.calls.some(sendOf)).toBe(false);
    });

    test('续轮同目录重启：未确认的落点会话只核对，找到就接管，不再发送', async () => {
      const w = world({ task, extra: gitOk });
      writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      await runLane(w.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w.deps, browse: killedBefore('follow') });
      expect(readLaneState(w.commDir)?.devin?.attemptSession).toBe(SESSION);

      const b = devinBrowse({ session: [idleDone(PR9)] });
      const out = await runLane(w.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w.deps, browse: b.browse });
      expect(out.status).toBe('success');
      expect(b.calls.some(sendOf)).toBe(false);
      expect(b.calls.every(s => s.includes(SESSION))).toBe(true);
      expect(readLaneState(w.commDir)?.devin?.attempt).toBeUndefined();
    });

    test('换摘要重派（返工改了 findings）：同一任务在另一目录有未确认受理的新会话发送 → 受阻，不发送、不另建，登记保留', async () => {
      const w1 = world({ task, extra: gitOk });
      await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: killedBefore('send') });
      const d1 = digestOf(w1, FOLLOW);
      expect(readInflight(w1.stateRoot, 'devin-cloud', d1)).toMatchObject({ task: 'task-1' });

      const w2 = world({ task, extra: gitOk });
      const b2 = devinBrowse({ send: [{ ok: true, url: NEW_SESSION }], recover: [{ ok: true, found: NEW_SESSION }] });
      // 回归时（没有这条判定）会去新建会话，页面不就绪就会一直重试；advancing 让假时钟走到时限，测试快速失败而不挂起。
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: `${FOLLOW}\n返工：补上失败用例。`, stateRoot: w1.stateRoot }),
        { ...w2.deps, browse: advancing(w2, b2.browse) });
      expect(out2.status).toBe('success');
      expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(b2.calls).toHaveLength(0);
      expect(readInflight(w1.stateRoot, 'devin-cloud', d1)?.attempt).toMatch(/^SCK-/);
    });

    test('换摘要重派：同一任务在另一目录的会话仍在途（已受理、未收尾）→ 跟进同一会话并标明是后续轮次，不另建会话', async () => {
      const w1 = world({ task, extra: gitOk });
      const a = (async (script: string) => {
        if (script.includes(MODE('send'))) return { ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true };
        throw new Error('bridge killed while polling');
      }) as NonNullable<LaneDeps['browse']>;
      await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: a });
      expect(readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, FOLLOW))?.taskUrl).toBe(SESSION);

      const w2 = world({ task, extra: gitOk });
      const b2 = devinBrowse({
        follow: [{ ok: true, url: SESSION, cap: 'Free', seats: { used: 1, total: 2 }, echoed: true }],
        session: [idleDone(PR9)],
      });
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: `${FOLLOW}\n返工：补上失败用例。`, stateRoot: w1.stateRoot }),
        { ...w2.deps, browse: advancing(w2, b2.browse) });
      expect(out2.status).toBe('success');
      expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(b2.calls.some(s => s.includes(MODE('send')))).toBe(false);
      expect(b2.calls.some(s => s.includes(MODE('follow')) && s.includes('这是同一任务的后续轮次'))).toBe(true);
      expect(b2.calls.every(s => s.includes(SESSION))).toBe(true);
    });
  });

  describe('终稿与状态判定（页面读取脚本在假页面里执行）', () => {
    const M = 'SCK-abc123';
    const CONV = `收尾约定：本轮的最后一条答复以「[SCK-DONE ${M}]」单独成行开头，随后是完整最终答复。`;
    const g = globalThis as unknown as Record<string, unknown>;
    type Block = { author: 'user' | 'devin' | 'tool'; text: string };
    /**
     * 真实 Devin 转录的角色契约（2026-11-16 只读实测）：Devin 回答是 [data-message-author="devin"]，
     * 用户/自动化消息是 [data-message-author="user"]；工具输出与 worklog 没有作者属性。
     * tool 块只进 main/body 文字，不进 [data-message-author]，对应真实页面的工具输出。
     */
    const runPage = async (doc: Record<string, unknown>, marker = M) => {
      const { devinSessionScript } = await import('../src/runner/cloud-lane/devin-web.ts');
      const page = {
        goto: async () => {}, waitForTimeout: async () => {},
        evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
          g.document = doc;
          g.location = { href: SESSION, hostname: 'app.devin.ai' };
          return fn(arg);
        },
      };
      let result: Record<string, unknown> | undefined;
      const fakeConsole = { log: (line: string) => { if (line.startsWith('__RESULT__')) result = JSON.parse(line.slice('__RESULT__'.length)); } };
      const run = new Function('taskSpace', 'console', 'process', `return (async () => {${devinSessionScript(SESSION, marker)}})()`);
      try {
        await run(async () => ({ pages: async () => [page] }), fakeConsole, { exit() { throw new Error('unexpected exit'); } });
      } finally {
        delete g.document;
        delete g.location;
      }
      return result;
    };
    const readPage = async (blocks: Block[], rest = '', marker = M) => {
      const text = [...blocks.map(b => b.text), rest].filter(Boolean).join('\n');
      const elements = blocks.filter(b => b.author !== 'tool').map(b => ({
        getAttribute: (name: string) => (name === 'data-message-author' ? b.author : null),
        innerText: b.text,
      }));
      const doc = {
        body: { innerText: text },
        querySelector: (sel: string) => (sel === 'main' ? { innerText: text } : sel === '[data-sck-cap-trigger]' ? null : {}),
        // 终稿与状态判定不涉及 Capability 菜单：页面上没有可见菜单。
        querySelectorAll: (sel: string) => (sel === '[data-message-author]' ? elements : sel === '[role=menu]' ? [] : [{ innerText: 'Free' }]),
      };
      return runPage(doc, marker);
    };

    test('只有用户消息、没有助手答复（DOM 反例）：没有终稿，状态 unknown', async () => {
      const r = await readPage([{ author: 'user', text: `[SCK-ROUND ${M}]\n\n只读的合成任务\n\n${CONV}` }]);
      expect(r).toMatchObject({ ok: true, markerSeen: true, status: 'unknown', source: 'roles' });
      expect(r?.done).toBeNull();
    });

    test('用户提示词里的结束标记（例子）不算终稿', async () => {
      const r = await readPage([{ author: 'user', text: `[SCK-ROUND ${M}]\n\n例子：\n[SCK-DONE ${M}]\n这是例子，不是答复\n\n${CONV}` }]);
      expect(r?.done).toBeNull();
      expect(r?.status).toBe('unknown');
    });

    test('工具输出含 DONE 与 PR、但没有助手答复（负责人 51b234ff 反例）：done 保持 null', async () => {
      const r = await readPage(
        [{ author: 'user', text: `[SCK-ROUND ${M}]\n\n只读的合成任务\n\n${CONV}` }],
        `工具输出：\n[SCK-DONE ${M}]\nPR: https://github.com/example/repo/pull/1\n提交：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nDevin is awaiting instructions`,
      );
      expect(r?.status).toBe('idle');
      expect(r?.done).toBeNull();
      expect(r?.source).toBe('roles');
    });

    test('真终稿后紧跟工具输出 DONE：只认助手发言块里的终稿', async () => {
      const r = await readPage(
        [
          { author: 'user', text: `[SCK-ROUND ${M}]\n\n任务\n\n${CONV}` },
          { author: 'devin', text: `[SCK-DONE ${M}]\n完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe` },
        ],
        `工具输出：\n[SCK-DONE ${M}]\nPR: https://github.com/acme/widget/pull/999\nSHA: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nDevin chose to stop working`,
      );
      expect(r?.status).toBe('idle');
      expect(r?.done).toBe('完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe');
    });

    test('收尾约定后的用户例子含 DONE：不算助手终稿', async () => {
      const r = await readPage([{
        author: 'user',
        text: `[SCK-ROUND ${M}]\n\n任务\n\n${CONV}\n例子：\n[SCK-DONE ${M}]\n这是例子\nPR: https://github.com/example/repo/pull/1`,
      }]);
      expect(r?.done).toBeNull();
      expect(r?.status).toBe('unknown');
    });

    test('上一轮残留的 DONE 与状态短语不串入本轮', async () => {
      const OLD = 'SCK-old999';
      const r = await readPage([
        { author: 'user', text: `[SCK-ROUND ${OLD}]\n\n第一轮\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE ${OLD}]」单独成行开头。` },
        { author: 'devin', text: `[SCK-DONE ${OLD}]\n旧答复\nPR: https://github.com/acme/widget/pull/1` },
        { author: 'tool', text: 'Devin is working\nblocked on the user\nDevin chose to stop working' },
        { author: 'user', text: `[SCK-ROUND ${M}]\n\n第二轮\n\n${CONV}` },
      ]);
      expect(r?.done).toBeNull();
      expect(r?.status).toBe('unknown');
    });

    test('残留的 Devin is working 或 blocked on the user 不会误判本轮状态，本轮答复可读出', async () => {
      const OLD = 'SCK-old999';
      const r = await readPage([
        { author: 'user', text: `[SCK-ROUND ${OLD}]\n\n第一轮\n\n收尾约定：「[SCK-DONE ${OLD}]」。` },
        { author: 'tool', text: 'Devin is working\nblocked on the user' },
        { author: 'user', text: `[SCK-ROUND ${M}]\n\n第二轮\n\n${CONV}` },
        { author: 'devin', text: `[SCK-DONE ${M}]\n完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe` },
      ], 'Devin chose to stop working');
      expect(r?.status).toBe('idle');
      expect(r?.done).toBe('完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe');
    });

    test('续轮前上一轮还在工作（它的收尾约定之后是 Devin is working）：状态 working，会话判忙', async () => {
      const r = await readPage([
        { author: 'user', text: `[SCK-ROUND SCK-old999]\n\n第一轮\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE SCK-old999]」单独成行开头。` },
        { author: 'devin', text: '正在改代码' },
      ], 'Devin is working');
      expect(r).toMatchObject({ ok: true, markerSeen: false, status: 'working' });
    });

    test('真实转录结构：sr-only 的 Devin 标签与 Worked for 行在作者块之外，终稿仍从助手作者块首行读出', async () => {
      const userText = `[SCK-ROUND ${M}]\n\n只读的合成任务\n\n${CONV}`;
      const reply = `[SCK-DONE ${M}]\n完成。\nPR: https://github.com/acme/widget/pull/9`;
      // 页面正文里有 "Devin:" 标签与 worklog 行，但它们不在 data-message-author 元素里（2026-11-16 实测结构）。
      const main = [userText, `Worked for 1m 16s\nDevin:\n\n${reply}`, 'Devin chose to stop working'].join('\n');
      const authors = [{ author: 'user', text: userText }, { author: 'devin', text: reply }];
      const doc = {
        body: { innerText: main },
        querySelector: (sel: string) => (sel === 'main' ? { innerText: main } : sel === '[data-sck-cap-trigger]' ? null : {}),
        querySelectorAll: (sel: string) => (sel === '[data-message-author]'
          ? authors.map(b => ({ getAttribute: (name: string) => (name === 'data-message-author' ? b.author : null), innerText: b.text }))
          : sel === '[role=menu]' ? [] : [{ innerText: 'Free' }]),
      };
      const r = await runPage(doc);
      expect(r).toMatchObject({ ok: true, markerSeen: true, status: 'idle', source: 'roles' });
      expect(r?.done).toBe('完成。\nPR: https://github.com/acme/widget/pull/9');
    });

    test('续轮前更早轮次残留的 Devin is working 在上一轮收尾约定之前：不把空闲的会话判忙', async () => {
      const r = await readPage([
        { author: 'tool', text: 'Devin is working' },
        { author: 'user', text: `[SCK-ROUND SCK-old999]\n\n第一轮\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE SCK-old999]」单独成行开头。` },
        { author: 'devin', text: '[SCK-DONE SCK-old999]\n第一轮完成' },
      ], 'Devin is awaiting instructions');
      expect(r).toMatchObject({ ok: true, markerSeen: false, status: 'idle' });
    });

    test('空闲但没有 SCK-DONE 行：终稿为空，状态 idle', async () => {
      const r = await readPage([
        { author: 'user', text: `[SCK-ROUND ${M}]\n\n任务\n\n${CONV}` },
        { author: 'devin', text: '完成了但没写标记' },
      ], 'Devin chose to stop working');
      expect(r?.status).toBe('idle');
      expect(r?.done).toBeNull();
    });

    test('答复有 SCK-DONE 行但页面没有状态短语：终稿可读出，状态 unknown（驱动层不收尾）', async () => {
      const r = await readPage([
        { author: 'user', text: `[SCK-ROUND ${M}]\n\n任务\n\n${CONV}` },
        { author: 'devin', text: `[SCK-DONE ${M}]\n完成` },
      ]);
      expect(r?.status).toBe('unknown');
      expect(r?.done).toBe('完成');
    });

    test('页面没有作者块（未水合或旧探针）时终稿保持 null，不拿整段 main 文本冒充助手回答', async () => {
      const text = `[SCK-ROUND ${M}]\n\n任务\n\n${CONV}\n[SCK-DONE ${M}]\nPR: https://github.com/example/repo/pull/1\nDevin is awaiting instructions`;
      const doc = {
        body: { innerText: text },
        querySelector: (sel: string) => (sel === 'main' ? { innerText: text } : {}),
        querySelectorAll: (sel: string) => (sel === '[role=menu]' ? [] : [{ innerText: 'Free' }]),
      };
      const r = await runPage(doc);
      expect(r?.source).toBe('text-only');
      expect(r?.status).toBe('idle');
      expect(r?.done).toBeNull();
    });
  });
});

describe('jules 通道', () => {
  const julesFetch = (sequence: any[]) => {
    let i = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      const body = sequence[Math.min(i++, sequence.length - 1)];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  };

  test('创建 → 轮询 COMPLETED → 取 PR → 快进 → 结果带 PR/SHA', async () => {
    const { fetchImpl, calls } = julesFetch([
      { name: 'sessions/42' },
      { name: 'sessions/42', state: 'IN_PROGRESS' },
      { name: 'sessions/42', state: 'COMPLETED', outputs: [{ pullRequest: { url: 'https://github.com/acme/widget/pull/11' } }] },
      { name: 'sessions/42', state: 'COMPLETED', outputs: [{ pullRequest: { url: 'https://github.com/acme/widget/pull/11' } }] },
    ]);
    const w = world({ extra: call => {
      if (call.cmd === 'git' && call.args[0] === 'fetch') return ok('');
      if (call.cmd === 'git' && call.args[0] === 'merge') return ok('');
      return undefined;
    }});
    const deps: LaneDeps = { ...w.deps, fetch: fetchImpl };
    const out = await runLane(w.input({ provider: 'jules', env: { JULES_API_KEY: 'k' } }), deps);
    expect(out.status).toBe('success');
    expect(out.text).toContain('PR: https://github.com/acme/widget/pull/11');
    expect(calls[0]!.url).toContain('/v1alpha/sessions');
    expect((calls[0]!.init?.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('k');
    expect(julesUsageCount(w.stateRoot, Date.now())).toBe(1);
  });

  test('AWAITING_USER_FEEDBACK → 受阻并把问题带回来', async () => {
    const { fetchImpl } = julesFetch([
      { name: 'sessions/77' },
      { name: 'sessions/77', state: 'AWAITING_USER_FEEDBACK' },
      { activities: [{ originator: 'agent', progressUpdated: { title: '需要确认是否删除旧表？' } }] },
    ]);
    const w = world({});
    const out = await runLane(w.input({ provider: 'jules', env: { JULES_API_KEY: 'k' } }), { ...w.deps, fetch: fetchImpl });
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^工作结果：受阻/);
    expect(out.text).toContain('需要确认是否删除旧表');
  });

  test('缺少 JULES_API_KEY → 明确错误', async () => {
    const w = world({});
    const out = await runLane(w.input({ provider: 'jules', env: {} }), w.deps);
    expect(out.status).toBe('error');
    expect(out.text).toContain('JULES_API_KEY');
  });

  test('续轮走 sendMessage 复用同一会话', async () => {
    const { fetchImpl, calls } = julesFetch([
      { name: 'sessions/55' },
      { name: 'sessions/55', state: 'COMPLETED', outputs: [{ pullRequest: { url: 'https://github.com/acme/widget/pull/12' } }] },
    ]);
    const w = world({ extra: call => {
      if (call.cmd === 'git' && call.args[0] === 'fetch') return ok('');
      if (call.cmd === 'git' && call.args[0] === 'merge') return ok('');
      return undefined;
    }});
    const first = await runLane(w.input({ provider: 'jules', env: { JULES_API_KEY: 'k' } }), { ...w.deps, fetch: fetchImpl });
    expect(first.status).toBe('success');
    // 首轮是创建会话：vendorSession 已保存，下一轮应走 sendMessage
    expect(readLaneState(w.commDir)?.vendorSession).toBe('sessions/55');
    const follow = await runLane(w.input({ provider: 'jules', env: { JULES_API_KEY: 'k' }, resumeId: first.sessionId, prompt: '继续修改。' }), { ...w.deps, fetch: fetchImpl });
    expect(follow.status).toBe('success');
    expect(calls.filter(c => c.url.includes(':sendMessage')).length).toBe(1);
    expect(follow.sessionId).toBe(first.sessionId);
  });
});

test('非 GitHub 工作目录 → 受阻成功回合', async () => {
  const w = world({ git: call => {
    if (call.cmd === 'git' && call.args[0] === 'remote') return ok('git@gitlab.com:acme/widget.git\n');
    return undefined;
  }});
  const out = await runLane(w.input(), w.deps);
  expect(out.status).toBe('success');
  expect(out.text).toMatch(/^工作结果：受阻/);
});

describe('额度映射', () => {
  test('wham/usage → five_hour/weekly 窗口', () => {
    const entry = whamToUsageEntry({
      plan_type: 'pro', email: 'boss@example.com',
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: '2026-11-13T06:00:00Z' },
        secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: '2026-11-20T00:00:00Z' },
      },
    });
    expect(entry?.providerId).toBe('codex-cloud');
    expect(entry?.planLabel).toBe('pro');
    expect(entry?.windows?.map(w => w.id)).toEqual(['five_hour', 'weekly']);
    expect(entry?.windows?.[0]?.remainingPct).toBe(60);
    expect(whamToUsageEntry({})).toBeUndefined();
  });

  test('jules 滚动 24 小时计数与额度项', () => {
    const root = mkdtempSync(join(tmpdir(), 'sck-jules-q-'));
    dirs.push(root);
    recordJulesUsage(root, Date.now() - 25 * 3600_000);
    recordJulesUsage(root, Date.now() - 3600_000);
    recordJulesUsage(root, Date.now());
    expect(julesUsageCount(root)).toBe(2);
    const entry = julesUsageEntry(root, 100);
    expect(entry.providerId).toBe('jules');
    expect(entry.windows?.[0]?.remainingPct).toBe(98);
  });
});

describe('通道子进程执行器', () => {
  test('ENOENT（PATH 里没有该命令）→ 非零退出且 stderr 带可读原因', async () => {
    const r = await laneExecFile()('sck-no-such-binary-xyz', [], {});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('找不到可执行文件 sck-no-such-binary-xyz');
    expect(r.stderr).toContain('PATH=');
  });

  test('bin 映射：命令名换成绝对路径执行，其目录前置进子进程 PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-lane-bin-'));
    dirs.push(dir);
    const probe = join(dir, 'probe');
    writeFileSync(probe, '#!/bin/sh\necho "$PATH"\n');
    chmodSync(probe, 0o755);
    const exec = laneExecFile({ probe });
    const mapped = await exec('probe', [], {});
    expect(mapped.code).toBe(0);
    expect(mapped.stdout.trim().split(':')[0]).toBe(dir);
    // 未配置的命令名不受影响
    const plain = await laneExecFile({ probe })('/bin/echo', ['ok'], {});
    expect(plain.stdout.trim()).toBe('ok');
  });
});

describe('lanes.bin 配置校验', () => {
  test('合法 bin 通过；相对路径、非法命令名、未知通道拒绝', () => {
    expect(() => validateLanes({ 'codex-cloud': { bin: { codex: '/abs/codex', gh: '/opt/homebrew/bin/gh' } } })).not.toThrow();
    expect(() => validateLanes({ 'codex-cloud': { bin: { codex: 'codex' } } })).toThrow(/bin/);
    expect(() => validateLanes({ 'codex-cloud': { bin: { 'a b': '/abs/x' } } })).toThrow(/bin/);
    expect(() => validateLanes({ 'codex-cloud': { bin: [] } })).toThrow(/bin/);
    expect(() => validateLanes({ nope: { bin: { x: '/abs/x' } } })).toThrow(/lanes/);
  });
});

describe('任务工作树边界', () => {
  const happyCodex: Route = call => {
    const [a, b] = call.args;
    if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_wt\n');
    if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\nno diff\n');
    if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('diff --git a/README.md b/README.md\n+line\n');
    if (call.cmd === 'codex' && a === 'cloud' && b === 'apply') return ok('applied\n');
    if (call.cmd === 'git' && a === 'add') return ok('');
    if (call.cmd === 'git' && a === 'diff' && b === '--cached') return ok('README.md\n');
    if (call.cmd === 'git' && a === 'commit') return ok('');
    if (call.cmd === 'gh' && a === 'pr' && b === 'list') return ok('[]');
    if (call.cmd === 'gh' && a === 'pr' && b === 'create') return ok('https://github.com/acme/widget/pull/8\n');
    return undefined;
  };

  test('全部命令在 claim 指定的任务工作树执行，不碰会话 cwd', async () => {
    // input.cwd 是共享 checkout（可能正被老板使用），claim.json 指向任务工作树 B（分支 task/x）。
    const worktree = mkdtempSync(join(tmpdir(), 'sck-lane-task-wt-'));
    dirs.push(worktree);
    const w = world({ claim: { worktreePath: worktree, branch: 'task/x' }, extra: happyCodex,
      git: call => {
        if (call.cmd === 'git' && call.args[0] === 'rev-parse' && call.args[1] === '--abbrev-ref') return ok('task/x\n');
        return undefined;
      }});
    const out = await runLane(w.input(), w.deps);
    expect(out.status).toBe('success');
    // 任何一次 git/gh/codex 调用都不许落在共享 cwd 上。
    expect(w.calls.every(c => c.cwd === worktree)).toBe(true);
    const push = w.callsOf(c => c.cmd === 'git' && c.args[0] === 'push');
    expect(push.some(c => c.args.includes('HEAD:task/x'))).toBe(true);
  });

  test('没有 claim.json → 受阻，且一个供应商/git 命令都不发', async () => {
    const w = world({ claim: 'none', extra: happyCodex });
    const out = await runLane(w.input(), w.deps);
    expect(out.status).toBe('success');
    expect(out.text).toContain('工作结果：受阻');
    expect(out.text).toContain('任务工作树');
    expect(w.calls.filter(c => c.cmd === 'codex' || c.cmd === 'gh' ||
      (c.cmd === 'git' && ['commit', 'push', 'add'].includes(c.args[0]!)))).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
  });

  test('工作树当前分支与 claim 分支不一致 → 受阻，无提交类调用', async () => {
    const w = world({ claim: { worktreePath: '', branch: 'task/x' }, extra: happyCodex });
    // claim 指向一个真实目录但分支要求 task/x，而工作树检出的是 design/foo。
    const wt = w.cwd;
    writeFileSync(join(w.commDir, 'claim.json'), JSON.stringify({ worktree: { worktreePath: wt, branch: 'task/x', intent: { kind: 'code' } } }));
    const w2 = world({ claim: { worktreePath: wt, branch: 'task/x' }, extra: happyCodex,
      git: call => {
        if (call.cmd === 'git' && call.args[0] === 'rev-parse' && call.args[1] === '--abbrev-ref') return ok('design/foo\n');
        return undefined;
      }});
    const out = await runLane(w2.input(), w2.deps);
    expect(out.status).toBe('success');
    expect(out.text).toContain('design/foo');
    expect(w2.callsOf(c => c.cmd === 'codex' || (c.cmd === 'git' && ['commit', 'push', 'add'].includes(c.args[0]!)))).toHaveLength(0);
  });

  test('只暂存补丁内路径：补丁外的暂存项被 reset 取消暂存', async () => {
    const w = world({ extra: call => {
      if (call.cmd === 'git' && call.args[0] === 'diff' && call.args[1] === '--cached')
        return ok('README.md\nerror.log\n');
      if (call.cmd === 'git' && call.args[0] === 'reset') return ok('');
      return happyCodex(call);
    }});
    const out = await runLane(w.input(), w.deps);
    expect(out.status).toBe('success');
    const add = w.callsOf(c => c.cmd === 'git' && c.args[0] === 'add');
    expect(add).toHaveLength(1);
    expect(add[0]!.args).toEqual(['add', '-A', '--', 'README.md']);
    const reset = w.callsOf(c => c.cmd === 'git' && c.args[0] === 'reset');
    expect(reset).toHaveLength(1);
    expect(reset[0]!.args).toContain('error.log');
    expect(out.text).toContain('取消暂存');
  });
});
