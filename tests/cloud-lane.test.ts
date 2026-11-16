import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLane, taskMaterial, validateLanes, vendorPrompt, type LaneDeps, type LaneInput } from '../src/runner/cloud-lane/lane.ts';
import { laneExecFile } from '../src/runner/cloud-lane/exec.ts';
import { laneDigest, readInflight, readLaneState, writeLaneState } from '../src/runner/cloud-lane/state.ts';
import { julesUsageCount, julesUsageEntry, whamToUsageEntry } from '../src/runner/cloud-lane/quota.ts';
import { recordJulesUsage } from '../src/runner/cloud-lane/jules.ts';
import type { ExecResult } from '../src/runner/cloud-lane/repo.ts';

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
    writeFileSync(join(commDir, 'claim.json'), JSON.stringify({ worktree: { worktreePath: wt.worktreePath, branch: wt.branch, intent: { kind: 'code' }, mode: 'exclusive' } }));
  }
  const calls: Call[] = [];
  const progress: string[] = [];
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
    progress: s => progress.push(s),
  };
  let t = Date.now();
  const input = (over: Partial<LaneInput> = {}): LaneInput => ({
    provider: 'codex-cloud',
    prompt: opts.prompt ?? `实现 $SCK_COMM_DIR/task.md 中的需求，按验收标准逐条自验。完成后直接给出最终答复。`,
    cwd, commDir, stateRoot, config: { pollMs: 1 }, env: {}, ...over,
  });
  const callsOf = (pred: (c: Call) => boolean) => calls.filter(pred);
  return { commDir, cwd, stateRoot, calls, callsOf, progress, deps, input,
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
  const devinBrowse = (q: Queues) => {
    const calls: string[] = [];
    const pick = (list: Resp[] | undefined): Resp => list && list.length > 1 ? list.shift() : list?.[0];
    const browse = async (script: string): Promise<Resp> => {
      calls.push(script);
      if (script.includes('quota_full')) return pick(q.send);
      if (script.includes('probed')) return pick(q.recover);
      if (script.includes('const MSG =')) return pick(q.follow);
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

  test('Capability 无法确认 Free → 错误回合，绝不发送', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({ send: [{ ok: false, code: 'capability', detail: '按钮=Normal' }] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('error');
    expect(out.text).toContain('Free');
    expect(readLaneState(w.commDir)?.taskId).toBeUndefined();
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(0);
  });

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

  test('受理核对确认未发出 → 允许重新发送一次', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: false, code: 'pressed' }, { ok: true, url: SESSION }],
      recover: [{ ok: true, found: null, probed: 6 }],
      session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9')],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    // 连续核对 4 次都未见标记后，第二次发送脚本才放行
    expect(b.calls.filter(s => s.includes('probed'))).toHaveLength(4);
    expect(b.calls.filter(s => s.includes('const MSG ='))).toHaveLength(2);
  });

  test('续轮/返工/复核复用原 Devin 会话：发跟进消息，不新建会话不占新席位', async () => {
    const w = world({ extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
    const b = devinBrowse({ follow: [{ ok: true, url: SESSION }], session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9')] });
    const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    // 没用新会话发送脚本（不会碰席位），跟进脚本落在原会话地址上并核验会话档位
    expect(b.calls.some(s => s.includes('quota_full'))).toBe(false);
    const follow = b.calls.find(s => s.includes('const MSG ='))!;
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

  test('消息发出但会话里始终没受理（空闲且无标记）→ 回到原会话补发，不新建会话', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION }],
      session: [
        { ok: true, markerSeen: false, status: 'idle', done: null, tail: '' },
        { ok: true, markerSeen: false, status: 'idle', done: null, tail: '' },
        { ok: true, markerSeen: false, status: 'idle', done: null, tail: '' },
        idleDone('完成。\nPR: https://github.com/acme/widget/pull/9'),
      ],
      follow: [{ ok: true, already: true, url: SESSION }],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    // 补发走的是原会话的跟进脚本；新会话发送脚本只跑过最初一次
    expect(b.calls.filter(s => s.includes('const MSG ='))).toHaveLength(2);
    expect(b.calls.filter(s => s.includes('quota_full'))).toHaveLength(1);
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
