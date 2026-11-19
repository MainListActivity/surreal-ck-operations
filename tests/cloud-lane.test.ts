import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLane, taskMaterial, validateLanes, vendorPrompt, type LaneDeps, type LaneInput } from '../src/runner/cloud-lane/lane.ts';
import { laneExecFile } from '../src/runner/cloud-lane/exec.ts';
import { laneDigest, readInflight, readLaneState, writeInflight, writeLaneState } from '../src/runner/cloud-lane/state.ts';
import { julesUsageCount, julesUsageEntry, whamToUsageEntry } from '../src/runner/cloud-lane/quota.ts';
import { recordJulesUsage } from '../src/runner/cloud-lane/jules.ts';
import type { ExecResult } from '../src/runner/cloud-lane/repo.ts';
import { egoBrowse } from '../src/runner/grok-bot/main.ts';
import { DEVIN_HOME, devinRelayGateScript } from '../src/runner/cloud-lane/devin-web.ts';
import { parseNativeResult } from '../src/runner/native.ts';

type Call = { cmd: string; args: string[]; cwd?: string };
type Route = (call: Call) => ExecResult | undefined;

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'boom'): ExecResult => ({ code: 1, stdout: '', stderr });

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function world(opts: { task?: string; prompt?: string; git?: Route; extra?: Route;
    /** 默认把 cwd 当任务工作树写进 claim.json（分支 sck/task-1）；'none' 不写，对象自定义。 */
    claim?: 'none' | { worktreePath: string; branch: string; deliveryId?: string } } = {}) {
  const commDir = mkdtempSync(join(tmpdir(), 'sck-lane-comm-'));
  const cwd = mkdtempSync(join(tmpdir(), 'sck-lane-wt-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'sck-lane-state-'));
  dirs.push(commDir, cwd, stateRoot);
  writeFileSync(join(commDir, 'task.md'), opts.task ?? '# 云端任务\n\n实现需求甲。\n');
  if (opts.claim !== 'none') {
    const wt = opts.claim ?? { worktreePath: cwd, branch: 'sck/task-1' };
    const worktreePath = wt.worktreePath || cwd;
    // task.id 与真实 claim.json 一样：同一公司任务换员工目录时靠它认出同一任务（换摘要重派）。
    writeFileSync(join(commDir, 'claim.json'), JSON.stringify({ task: { id: 'task-1' }, ...(wt.deliveryId ? { deliveryId: wt.deliveryId } : {}), worktree: { worktreePath, branch: wt.branch, intent: { kind: 'code' }, mode: 'exclusive' } }));
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

  test('同一投递键下正文重排：仍恢复在途云会话，不重复提交', async () => {
    const w = world({ claim: { worktreePath: '', branch: 'sck/task-1', deliveryId: 'delivery-stable-1' },
      extra: call => {
        const [a, b] = call.args;
        if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\nno diff\n');
        if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('');
        if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_unexpected\n');
        return undefined;
      }});
    // 上一轮落下的本目录状态：同一投递、旧摘要，在途任务还在。
    writeLaneState(w.commDir, { sessionId: 'lane-stable', taskId: 'task_b_prev',
      taskUrl: 'https://chatgpt.com/codex/tasks/task_b_prev', digest: 'digest-of-old-wording',
      delivery: 'delivery-stable-1', branch: 'sck/task-1', submittedAt: Date.now() });
    const out = await runLane(w.input({ prompt: '重排过的措辞：仍然完成同一件事。' }), w.deps);
    expect(out.status).toBe('success');
    expect(w.callsOf(c => c.cmd === 'codex' && c.args[1] === 'exec')).toHaveLength(0);
    expect(w.callsOf(c => c.cmd === 'codex' && c.args[1] === 'status')).toHaveLength(1);
    expect(out.sessionId).toBe('lane-stable');
  });

  test('同一投递键跨员工目录：只按共享登记恢复，不另建提交', async () => {
    const w1 = world();
    const w2 = world({ claim: { worktreePath: '', branch: 'sck/task-1', deliveryId: 'delivery-stable-2' },
      extra: call => {
        const [a, b] = call.args;
        if (call.cmd === 'codex' && a === 'cloud' && b === 'status') return ok('[READY] t\nenv  •  now\nno diff\n');
        if (call.cmd === 'codex' && a === 'cloud' && b === 'diff') return ok('');
        if (call.cmd === 'codex' && a === 'cloud' && b === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_unexpected\n');
        return undefined;
      }});
    writeInflight(w1.stateRoot, 'codex-cloud', 'delivery-stable-2', { taskId: 'task_b_shared',
      taskUrl: 'https://chatgpt.com/codex/tasks/task_b_shared', submittedAt: Date.now(), task: 'task-1' });
    const out = await runLane(w2.input({ stateRoot: w1.stateRoot, prompt: '换目录后的产物路径变了。' }), w2.deps);
    expect(out.status).toBe('success');
    expect(w2.callsOf(c => c.cmd === 'codex' && c.args[1] === 'exec')).toHaveLength(0);
    expect(w2.callsOf(c => c.cmd === 'codex' && c.args[1] === 'status')).toHaveLength(1);
    expect(out.sessionId).toBeDefined();
  });

  test('环境投递键优先于 claim，登记安全编码并在正文变化后跨目录恢复', async () => {
    for (const variable of ['SCK_DELIVERY_ID', 'SCK_DELIVERY_KEY']) {
      const key = `delivery/${variable}/../stable`;
      const w1 = world({ extra: call => {
        if (call.cmd === 'codex' && call.args[1] === 'exec') return ok('https://chatgpt.com/codex/tasks/task_b_env\n');
        if (call.cmd === 'codex' && call.args[1] === 'status') return bad('transient');
        return undefined;
      } });
      await runLane(w1.input({ env: { [variable]: key } }), w1.deps);
      expect(readInflight(w1.stateRoot, 'codex-cloud', key)?.taskId).toBe('task_b_env');
      const w2 = world({ task: '# 改写过的正文\n', claim: { worktreePath: '', branch: 'sck/task-1', deliveryId: 'stale-claim' },
        extra: call => {
          if (call.cmd === 'codex' && call.args[1] === 'status') return ok('[READY] t\n');
          if (call.cmd === 'codex' && call.args[1] === 'diff') return ok('');
          return undefined;
        } });
      const result = await runLane(w2.input({ stateRoot: w1.stateRoot, env: { [variable]: key } }), w2.deps);
      expect(result.status).toBe('success');
      expect(w2.callsOf(call => call.cmd === 'codex' && call.args[1] === 'exec')).toHaveLength(0);
      expect(w2.callsOf(call => call.cmd === 'codex' && call.args[1] === 'status')[0]?.args).toContain('task_b_env');
    }
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
  type Queues = { send?: Resp[]; follow?: Resp[]; recover?: Resp[]; session?: Resp[]; gate?: Resp[] };
  /** 按脚本特征分流：新会话发送 / 续轮跟进 / 代跑前置可发条件探测 / 受理核对 / 会话轮询。 */
  const MODE = (m: string) => `const MODE = "${m}"`;
  const devinBrowse = (q: Queues) => {
    const calls: string[] = [];
    const pick = (list: Resp[] | undefined): Resp => list && list.length > 1 ? list.shift() : list?.[0];
    // 未指定 gate 队列时默认「现在可发、0/2」：既有中继用例不因新增前置探测而改变语义；
    // 满座/错会话等路径由用例显式给 gate 队列。
    const gateDefault: Resp = { ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } };
    const browse = async (script: string): Promise<Resp> => {
      calls.push(script);
      if (script.includes(MODE('relay-gate'))) return pick(q.gate) ?? gateDefault;
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
    /**
     * 合成兼容用例（非真实页面）：Free 行的角色是 role=menuitem（负责人证据），标签未知。这里用 span 代表一个不在旧选择器
     * （标签 div/button，角色 menuitemradio/option）之内的标签，只验证新选择器按 role 认出 Free 行。span 不代表真实页面标签。
     */
    menuItemRows?: boolean;
    /**
     * 假设 B（未证实）：程序化 element.click() 能打开 Capability 菜单。默认 false，即假设 A：程序化点击不开菜单（同样未证实）。
     * 只影响旧版（0.13.41）的 element.click()；新版从不调用程序化点击，所以这个开关对新版没有影响。
     */
    programmaticCapOpens?: boolean;
    /** 点 Free 后档位与席位晚这么多毫秒才显示（虚拟时钟，由 waitForTimeout 推进）。 */
    capLagMs?: number;
    /** 选中 Free 后详情里没有 "powered by SWE-2"（档位是 Free，但没有 SWE-2 的 powered 文字）。 */
    noPowered?: boolean;
    /** 选中 Free 后详情里没有席位计数 "N/M in use"（读不到席位）。 */
    noSeats?: boolean;
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
   * 首页 Capability 菜单在指针点击（p.click）后打开，按 menuDelayMs 渲染（虚拟时钟由 waitForTimeout 推进）。
   * 两类未证实假设分开建模：程序化点击开不开菜单（programmaticCapOpens：默认假设 A 不开，只记 js cap；假设 B 开），
   * 只影响旧版的 element.click()；Free 行能否被旧选择器命中（menuItemRows）则两版都会遇到。二者各有独立用例，互不依赖。
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
    const detailText = () => [opts.noPowered ? 'Free' : 'Free (powered by SWE-2)', `The plan includes ${seats.total} concurrent sessions`,
      ...(opts.noSeats ? [] : [`${seats.used}/${seats.total} in use`])].join('\n');
    const bodyText = (): string => isSession(st.url)
      ? [...current().blocks.map(b => b.text), current().status].join('\n')
      : ['Organization', detailShown() ? detailText() : ''].filter(Boolean).join('\n');
    const rowNames = [...CAP_ROWS.filter(name => !(opts.noFreeRow && name === 'Free')), ...(opts.duplicateFreeRow ? ['Free'] : [])];
    const trigger = mkEl({ tag: 'button', text: () => capShown(), rect: () => ({ width: 90, height: 28 }),
      disabled: () => isSession(st.url), expanded: () => st.menuOpen,
      onClick: () => {
        st.events.push('js cap');
        // 程序化点击：只有假设 B（未证实）才打开菜单；假设 A 下它什么也不做。
        if (opts.programmaticCapOpens && !isSession(st.url)) { st.menuOpen = true; st.detailOpen = false; st.menuReadyAt = st.clock + (opts.menuDelayMs ?? 0); }
      } });
    const outside = opts.outsideFree ? mkEl({ tag: 'button', text: () => 'Free', rect: () => ({ width: 60, height: 24 }) }) : undefined;
    const menuRows: FakeEl[] = [];
    const capMenu = mkEl({ tag: 'div', attrs: { role: 'menu' }, text: () => rowNames.join('\n'),
      rect: () => ({ width: 200, height: 300 }), children: () => menuRows });
    for (const name of rowNames) menuRows.push(mkEl({ tag: opts.menuItemRows ? 'span' : 'button',
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

  test('Devin 投递键摘要标记稳定且为十六进制，同键正文改写后只轮询不再发送', async () => {
    const w = world({ extra: gitOk });
    const key = 'delivery/same-prefix-001';
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }],
      session: [{ ok: true, markerSeen: true, status: 'blocked', done: null, tail: '' }] });
    await runLane(w.input({ provider: 'devin-cloud', env: { SCK_DELIVERY_ID: key } }), { ...w.deps, browse: b.browse });
    const marker = readLaneState(w.commDir)?.taskId;
    expect(marker).toMatch(/^SCK-[a-f0-9]{10}$/);
    expect(marker).toBe(`SCK-${laneDigest('devin-cloud', key).slice(0, 10)}`);
    const recovered = devinBrowse({ session: [idleDone(PR9)] });
    const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '同一次投递的措辞重排',
      env: { SCK_DELIVERY_ID: key } }), { ...w.deps, browse: recovered.browse });
    expect(out.status).toBe('success');
    expect(recovered.calls.some(script => script.includes(MODE('send')) || script.includes(MODE('follow')))).toBe(false);
    expect(recovered.calls.every(script => script.includes(marker!))).toBe(true);
    expect(laneDigest('devin-cloud', 'delivery/same-prefix-002').slice(0, 10)).not.toBe(marker!.slice(4));
  });

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

  test('超时后同一轮只回执核对不重发：受阻保留会话地址，不丢成无输出错误回合；下轮直接轮询原会话', async () => {
    const working = { ok: true, markerSeen: true, status: 'working', done: null, tail: '' };
    const w1 = world({ extra: gitOk });
    const b1 = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [working] });
    const input1 = w1.input({ provider: 'devin-cloud', config: { pollMs: 1, maxMinutes: 1 } });
    const browse1 = (async (script: string, t: number) => { const r = await b1.browse(script, t); if (!script.includes('const MSG =')) w1.advance(30_000); return r; }) as typeof b1.browse;
    const out1 = await runLane(input1, { ...w1.deps, browse: browse1 });
    // 会话已受理（taskId 已定），超时不是供应商崩溃：按受阻收尾（成功回合、首行「工作结果：受阻」），
    // 带原会话地址与说明，不是裸错误回合——避免执行端把它当空交付回收成 silent-turn，不送审。
    expect(out1.status).toBe('success');
    expect(out1.text.split('\n')[0]).toBe('工作结果：受阻');
    // 回执只带固定原因：不在出站文本回显会话地址，地址只留在内部在途状态。
    expect(out1.text).not.toContain(SESSION);
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

  test('近真实 main→native 链路验证：已受理超时的受阻回合经 main.ts 事件映射与 native.ts 真实 parseNativeResult 解析后是 completed，不是 failed（需求 3：不丢成 silent-turn 的关键一环）', async () => {
    // 复用与上一条用例相同的「已受理、超时」场景，拿到真实 LaneOutcome（status:'success'，首行「工作结果：受阻」）。
    const working = { ok: true, markerSeen: true, status: 'working', done: null, tail: '' };
    const w = world({ extra: gitOk });
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [working] });
    const input = w.input({ provider: 'devin-cloud', config: { pollMs: 1, maxMinutes: 1 } });
    const browse = (async (script: string, t: number) => { const r = await b.browse(script, t); if (!script.includes('const MSG =')) w.advance(30_000); return r; }) as typeof b.browse;
    const outcome = await runLane(input, { ...w.deps, browse });
    expect(outcome.status).toBe('success');
    // runner/cloud-lane/main.ts 收到这个 LaneOutcome 后，原样按它自己的映射打印 Claude 形态事件流（逐行抄自
    // main.ts 现有源码，不是另一套逻辑）：
    //   emit({ type: 'result', subtype: outcome.status === 'success' ? 'success' : 'error',
    //     is_error: outcome.status !== 'success', result: outcome.text, session_id: outcome.sessionId });
    // 下面把这两行事件喂给真实、未改动的 runner/native.ts 的 parseNativeResult，验证受阻回合走的是
    // is_error:false/subtype:'success'，不是修前 fail() 会产生的 is_error:true/subtype:'error'。
    const stdout = [
      JSON.stringify({ type: 'system', session_id: `lane-${crypto.randomUUID()}` }),
      JSON.stringify({
        type: 'result',
        subtype: outcome.status === 'success' ? 'success' : 'error',
        is_error: outcome.status !== 'success',
        result: outcome.text,
        session_id: outcome.sessionId,
      }),
    ].join('\n');
    const native = parseNativeResult('devin-cloud', stdout);
    expect(native.completed).toBe(true);
    expect(native.error).toBeUndefined();
    expect(native.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(native.text).not.toContain(SESSION);
    expect(native.sessionId).toBe(outcome.sessionId);
    // native.ts 的 result.completed 正是 NativeRuntime.launch() 用来算 outcome.kind 的那个布尔量：
    //   const success = ... && result.completed && !!s.nativeSessionId;
    //   outcome: canceled ? { kind: 'canceled' } : success ? { kind: 'completed' } : { kind: 'failed', error: {...} }
    // turn-closeout.ts 的 settleTurn 只在 kind==='completed' 时才走「静默回合给有界唤醒重试」分支；kind!=='completed'
    // 会直接进「回收重派」分支——真实事故 15eaf1b8 正落在这条分支。这两处都不在本次改动范围内、源码未变更，这里
    // 只引用它们既有、未改动的判定逻辑作为同一条链路的下一环证据，不重复声称本 PR 测试或修改了 native.ts/turn-closeout.ts
    // 本身；report.md/blocker.md 是否被写出属于外层回合编排，同样不在本次改动范围。
    // 这条用例到 parseNativeResult 为止：completed:true 之后还要再经 sidecar.ts 的 settleExecution →
    // collectExecution → workResult 才是真正的收尾（提交 block、落盘、不记供应商故障）。那一段不在这个文件里，
    // 在 tests/runner-lifecycle.test.ts 的「云端受阻回合（如 devin-cloud 已受理超时）经真实 settleExecution
    // 收尾为 block...」用例：用同一个 outcome.kind:'completed' 的 TurnEnded 形态，驱动真实（未打桩）的
    // SidecarPool.settleExecution，断言不是 silent、不记 providerFailure、journal 落盘的结果是 block；并有
    // 对照组证明 outcome.kind 不是 completed 时仍然走既有的静默分支，两条路没有被改成同一条。

    // 对照：修前 fail() 会让 main.ts 打 is_error:true/subtype:'error'，parseNativeResult 解出 completed:false——
    // 这正是真实事故「明确超时却被当成失败终态、进而回收成 silent-turn」的那一步；这里只作同一条链路的对照参照。
    const failedStdout = [
      JSON.stringify({ type: 'system', session_id: `lane-${crypto.randomUUID()}` }),
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: outcome.text, session_id: outcome.sessionId }),
    ].join('\n');
    expect(parseNativeResult('devin-cloud', failedStdout).completed).toBe(false);
  });

  test('轮询回执页面停在另一个会话（wrong_session，发布前复核新发现的负例，非生产事故）：不采信该页内容，累计到上限后受阻，不重发、不拉取分支', async () => {
    const w = world({ extra: gitOk });
    // 脚本自己的地址核验会拦下这种情况（见 devin-web.ts），这里直接从驱动层角度构造脚本已经回执 wrong_session
    // 的场景：goto 失败被吞、页面停在另一个合法会话 OTHER 上，驱动层必须不把它当本轮受理证据，也不重发。
    const wrongSession = { ok: false, code: 'wrong_session', url: OTHER };
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [wrongSession] });
    const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1 } }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(out.text).toContain('没能停在本轮轮询的会话地址上');
    expect(out.text).not.toContain(SESSION);
    expect(out.text).not.toContain(OTHER);
    // 只发过一次；受阻之后在途状态保留（taskId 仍有），没有第二次发送、没有拉取分支（没走到收尾）
    expect(b.calls.filter(s => s.includes('const MSG ='))).toHaveLength(1);
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(0);
    expect(readLaneState(w.commDir)?.taskId).toBeDefined();
  });

  test('轮询回执误报 ok:true 却带着另一个会话地址（驱动层地址核验，合成负例）：不采信那份终稿、不拉分支，累计后受阻并保留在途', async () => {
    const w = world({ extra: gitOk });
    // 比上一条更强的负例：回执本身 ok:true，done 里甚至有像样的 PR/SHA，但 location.href 是另一个合法会话。
    // 脚本侧本会按 wrong_session 拒绝，这里验证驱动层自己也按 s.url 与目标会话再核一次，不靠脚本自觉。
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [{ ...idleDone(PR9), url: OTHER }] });
    const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1 } }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(out.text).toContain('没能停在本轮轮询的会话地址上');
    expect(out.text).not.toContain(SESSION);
    expect(out.text).not.toContain(OTHER);
    // 没有把那个会话的 PR 当终稿：没有快进/拉分支，也没有第二次发送
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(0);
    expect(b.calls.filter(s => s.includes('const MSG ='))).toHaveLength(1);
    expect(readLaneState(w.commDir)?.vendorSession).toBe(SESSION);
  });

  test('续轮回执误报 ok:true 但地址是别的会话（驱动层地址核验，合成负例）：不在那页取终稿，回原会话核对后零重发取回', async () => {
    const w = world({ extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
    const b = devinBrowse({
      follow: [{ ok: true, url: OTHER, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true }],
      session: [idleDone(PR9)],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
    // 受理落点仍是原会话（不是回执里那个别的会话），也没有第二次发送/新建会话
    expect(readLaneState(w.commDir)?.vendorSession).toBe(SESSION);
    const sessionCalls = b.calls.filter(s => s.includes(MODE('session')));
    expect(sessionCalls.length).toBeGreaterThan(0);
    expect(sessionCalls.every(s => s.includes(`const TARGET_URL = "${SESSION}"`))).toBe(true);
    expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
    expect(b.calls.some(s => s.includes(MODE('send')))).toBe(false);
  });

  test('受理核对的回执带着别的会话地址（驱动层地址核验，合成负例）：不认那页的本轮标记，核对耗尽后受阻并保留在途', async () => {
    const TASK = '# 云端任务\n\n实现需求甲。\n';
    const REPO = { slug: 'acme/widget', owner: 'acme', repo: 'widget', branch: 'sck/task-1', defaultBranch: 'main' };
    const PROMPT = '继续修复。';
    const digestOf = (w: ReturnType<typeof world>, prompt: string) =>
      laneDigest('devin-cloud', vendorPrompt(w.input({ provider: 'devin-cloud', prompt }), REPO, taskMaterial(w.commDir, prompt)));
    const w1 = world({ task: TASK, extra: gitOk });
    writeLaneState(w1.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
    const a = devinBrowse({ follow: [{ ok: false, code: 'pressed' }], session: [unseen] });
    await runLane(w1.input({ provider: 'devin-cloud', prompt: PROMPT, config: { pollMs: 1 } }), { ...w1.deps, browse: a.browse });
    expect(readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, PROMPT))?.attemptSession).toBe(SESSION);

    const w2 = world({ task: TASK, extra: gitOk });
    const b2 = devinBrowse({ session: [{ ...idleDone(PR9), url: OTHER }] });
    const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: PROMPT, stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2.browse });
    expect(out2.status).toBe('success');
    expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(out2.text).toContain('原会话');
    expect(out2.text).not.toContain(SESSION);
    expect(out2.text).not.toContain(OTHER);
    expect(b2.calls.some(s => s.includes(MODE('send')))).toBe(false);
    expect(b2.calls.some(s => s.includes(MODE('follow')))).toBe(false);
    expect(b2.calls.filter(s => s.includes(MODE('session')))).toHaveLength(4);
    expect(readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, PROMPT))?.attemptSession).toBe(SESSION);
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

  test('续轮跟进脚本回执页面停在另一个会话（wrong_session，发布前复核新发现的负例，非生产事故）：没碰发送按钮，不当已按下、不重发，超时受阻', async () => {
    const w = world({ extra: gitOk });
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
    const b = devinBrowse({ follow: [{ ok: false, code: 'wrong_session', url: OTHER }] });
    // 跟进脚本自己就会在填写/发送之前拦下（sessionGate 排在最前核验地址），这里站在驱动层角度断言它拿到
    // wrong_session 回执后的反应：当「页面未就绪」一样有界重试，不当已按下发送，超时后报错回合而非受阻
    // （此时还没有 state.taskId，不存在"已受理但未终稿"的在途语义）。
    const browse = (async (script: string, t: number) => { const r = await b.browse(script, t); w.advance(10 * 60_000); return r; }) as typeof b.browse;
    const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。', config: { pollMs: 1, maxMinutes: 1 } }), { ...w.deps, browse });
    expect(out.status).toBe('error');
    expect(out.text).toContain('没能停在原会话地址上');
    expect(out.text).not.toContain(OTHER);
    expect(out.text).not.toContain(SESSION);
    // 跟进脚本只跑过一次（第一次回执后时限已到，直接报错，不重试多次、不重发）
    expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
    expect(b.calls.some(s => s.includes(MODE('send')))).toBe(false);
    // 没有按下发送：没有登记在途 attempt 或 taskId
    const st = readLaneState(w.commDir);
    expect(st?.devin?.attempt).toBeUndefined();
    expect(st?.taskId).toBeUndefined();
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

  test('Devin 停下来等用户 → 受阻并只给固定现场，不回显页面正文', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION }],
      session: [{ ok: true, markerSeen: true, status: 'blocked', done: null, tail: '要不要删除旧表？' }],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^工作结果：受阻/);
    expect(out.text).toContain('需要老板在会话里答复');
    expect(out.text).not.toContain('要不要删除旧表');
    expect(out.text).not.toContain(SESSION);
  });

  test('vendorPrompt 对 devin-cloud 执行轮提示 OPS-REQUEST 代跑约定', () => {
    const repo = { slug: 'acme/widget', owner: 'acme', repo: 'widget', branch: 'sck/task-1', defaultBranch: 'main' };
    const text = vendorPrompt({ provider: 'devin-cloud', prompt: '做事' } as never, repo, { task: '实现需求甲。', review: false } as never);
    expect(text).toContain('[OPS-REQUEST]');
    expect(text).toContain('ops_health');
    expect(text).toContain('最多 3 轮');
    const review = vendorPrompt({ provider: 'devin-cloud', prompt: '复核' } as never, repo, { task: '复核', review: true } as never);
    expect(review).not.toContain('[OPS-REQUEST]');
  });

  test('blocked 时 assist 回传同一 sessionUrl 后完成收尾；第 4 次硬熔断', async () => {
    const w = world({ extra: gitOk });
    const assists: Array<{ round: number; transcriptTail: string }> = [];
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION }],
      follow: [{ ok: true, url: SESSION }],
      session: [
        { ok: true, markerSeen: true, status: 'blocked', done: null,
          tail: '[OPS-REQUEST] {"tool":"ops_health","args":{}}', agentTail: '[OPS-REQUEST] {"tool":"ops_health","args":{}}' },
        idleDone(PR9),
        idleDone(PR9),
      ],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), {
      ...w.deps, browse: b.browse,
      assist: async input => {
        assists.push({ round: input.round, transcriptTail: input.transcriptTail });
        return { decision: 'reply', message: 'staging healthy', toolExecuted: 'ops_health' };
      },
    });
    expect(out.status).toBe('success');
    expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
    expect(assists).toHaveLength(1);
    expect(assists[0]!.round).toBe(1);
    expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
    expect(b.calls.filter(s => s.includes(MODE('follow')))[0]).toContain(SESSION);
    expect(readLaneState(w.commDir)?.devin?.assistRounds).toBe(1);
    // 重新跑：assistRounds 已到 3 时第 4 次 blocked 硬熔断
    const w2 = world({ extra: gitOk });
    writeLaneState(w2.commDir, { sessionId: 'lane-1', digest: 'x', vendorSession: SESSION, branch: 'sck/task-1',
      taskId: 'SCK-aaaaaaaaaa', taskUrl: SESSION, submittedAt: Date.now(),
      delivery: 'delivery-assist-cap',
      devin: { assistRounds: 3 } });
    // 让 sameRound：用 delivery 对齐
    const b2 = devinBrowse({
      session: [{ ok: true, markerSeen: true, status: 'blocked', done: null, tail: '还要帮助' }],
    });
    let assistCalls = 0;
    const out2 = await runLane(w2.input({ provider: 'devin-cloud', env: { SCK_DELIVERY_ID: 'delivery-assist-cap' } }), {
      ...w2.deps, browse: b2.browse,
      assist: async () => { assistCalls++; return { decision: 'reply', message: 'should not run' }; },
    });
    expect(out2.status).toBe('success');
    expect(out2.text).toMatch(/^工作结果：受阻/);
    expect(out2.text).toContain('老板');
    expect(assistCalls).toBe(0);
    expect(b2.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
  });

  test('门禁：旧轮/用户正文/工具输出/缺本轮锚点都不能触发代跑', async () => {
    const request = '[OPS-REQUEST] {"tool":"ops_health","args":{}}';
    // 缺本轮锚点（markerSeen:false）：即使 tail/agentTail 里真有请求也不代跑
    {
      const w = world({ extra: gitOk });
      let assistCalls = 0;
      const b = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        session: Array.from({ length: 4 }, () => ({ ok: true, markerSeen: false, status: 'blocked', done: null, tail: request, agentTail: request })),
      });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse,
        assist: async () => { assistCalls++; return { decision: 'reply', message: 'x' }; } });
      expect(out.text).toMatch(/^工作结果：受阻/);
      expect(assistCalls).toBe(0);
      expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
    }
    // 有锚点但本轮 Devin 作者块为空（请求只在用户正文/工具输出里）：不代跑
    {
      const w = world({ extra: gitOk });
      let assistCalls = 0;
      const b = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        session: [{ ok: true, markerSeen: true, status: 'blocked', done: null, tail: `user: ${request}`, agentTail: '' }],
      });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse,
        assist: async () => { assistCalls++; return { decision: 'reply', message: 'x' }; } });
      expect(out.text).toMatch(/^工作结果：受阻/);
      expect(assistCalls).toBe(0);
    }
  });

  test('门禁：代跑来源只取本轮锚点后的 Devin 作者块，不混入整段 tail', async () => {
    const w = world({ extra: gitOk });
    const seen: string[] = [];
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION }],
      follow: [{ ok: true, url: SESSION }],
      session: [
        { ok: true, markerSeen: true, status: 'blocked', done: null,
          tail: 'user: 请查 [OPS-REQUEST] {"tool":"ops_login","args":{"alias":"USER"}}',
          agentTail: 'devin: 我需要健康度 [OPS-REQUEST] {"tool":"ops_health","args":{}}' },
        idleDone(PR9), idleDone(PR9),
      ],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse,
      assist: async input => { seen.push(input.transcriptTail); return { decision: 'reply', message: 'ok' }; } });
    expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('ops_health');
    expect(seen[0]).not.toContain('ops_login');
    expect(seen[0]).not.toContain('user:');
  });

  test('门禁：复核轮把 review 传给协助（写操作由 sidecar 按真实租约再挡）', async () => {
    const review = '# 复核\n\n## 待复核成果\n\n已提交。\n';
    const w = world({ task: review, extra: gitOk });
    const phases: string[] = [];
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION }],
      follow: [{ ok: true, url: SESSION }],
      session: [
        { ok: true, markerSeen: true, status: 'blocked', done: null,
          tail: '需要确认', agentTail: '需要确认 [OPS-REQUEST] {"tool":"ops_info","args":{}}' },
        idleDone('复核结论：通过\n逐条证据。'), idleDone('复核结论：通过\n逐条证据。'),
      ],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse,
      assist: async input => { phases.push(input.phase); return { decision: 'reply', message: '只读信息' }; } });
    expect(out.text).toMatch(/^复核结论：通过/);
    expect(phases).toEqual(['review']);
    expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
  });

  test('门禁：换员工目录恢复时同样只追踪待确认 attempt 与轮数，不再代跑', async () => {
    const w1 = world();
    const w2 = world();
    const PENDING = 'SCK-abcdef1234';
    const key = 'delivery-cross-assist';
    writeInflight(w1.stateRoot, 'devin-cloud', key, {
      attempt: PENDING, attemptAt: Date.now(), attemptSession: SESSION, task: 'task-1', assistRounds: 2,
    });
    let assistCalls = 0;
    const unseen = { ok: true, markerSeen: false, status: 'blocked', done: null, tail: 'waiting', agentTail: 'waiting' };
    const b = devinBrowse({ session: [unseen, unseen, unseen, unseen, unseen] });
    const out = await runLane(w2.input({ provider: 'devin-cloud', stateRoot: w1.stateRoot,
      env: { SCK_DELIVERY_ID: key } }), { ...w2.deps, browse: b.browse,
      assist: async () => { assistCalls++; return { decision: 'reply', message: '不应调用' }; } });
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^工作结果：受阻/);
    expect(assistCalls).toBe(0);
    expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
    expect(b.calls.some(s => s.includes(MODE('session')) && s.includes(PENDING))).toBe(true);
    expect(readLaneState(w2.commDir)?.taskId).toBe(PENDING);
    expect(readLaneState(w2.commDir)?.devin?.assistRounds).toBe(2);
  });

  test('门禁：未确认的代跑回传零重发——恢复只追踪 attempt 与轮数', async () => {
    const w = world({ extra: gitOk });
    const PENDING = 'SCK-abcdef1234';
    writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'x', delivery: 'delivery-pending-assist',
      branch: 'sck/task-1', taskId: 'SCK-aaaaaaaaaa', taskUrl: SESSION, submittedAt: Date.now(),
      vendorSession: SESSION, devin: { attempt: PENDING, attemptAt: Date.now(), attemptSession: SESSION, assistRounds: 1 } });
    let assistCalls = 0;
    // 未回显：转录里看不到 attempt 标记，按「未确认」处理
    const unseen = { ok: true, markerSeen: false, status: 'blocked', done: null, tail: 'still waiting', agentTail: 'still waiting' };
    const b = devinBrowse({ session: [unseen, unseen, unseen, unseen] });
    const out = await runLane(w.input({ provider: 'devin-cloud', env: { SCK_DELIVERY_ID: 'delivery-pending-assist' } }), {
      ...w.deps, browse: b.browse,
      assist: async () => { assistCalls++; return { decision: 'reply', message: '不应调用' }; },
    });
    expect(out.status).toBe('success');
    expect(out.text).toMatch(/^工作结果：受阻/);
    expect(assistCalls).toBe(0);
    expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
    expect(b.calls.some(s => s.includes(MODE('session')) && s.includes(PENDING))).toBe(true);
    expect(readLaneState(w.commDir)?.taskId).toBe(PENDING);
    expect(readLaneState(w.commDir)?.devin?.assistRounds).toBe(1);
  });

  describe('等待指示（Devin is awaiting instructions）里的显式只读 OPS-REQUEST（真实任务 504de3c3 回归）', () => {
    const REQUEST = '[OPS-REQUEST] {"tool":"ops_health","args":{}}';
    /** 本轮已验锚点与 Free 档位、页面停在等待指示、终稿尚未出现；agentTail 是本轮锚点之后的 Devin 作者块。 */
    const waiting = (agentTail: string, over: Record<string, unknown> = {}) =>
      ({ ok: true, markerSeen: true, cap: 'Free', status: 'idle', done: null, tail: 'Devin is awaiting instructions', agentTail, ...over });

    test('本轮作者块有显式只读请求 → 进入既有中继一次，回传同一会话后正常收尾', async () => {
      const w = world({ extra: gitOk });
      const assists: Array<{ round: number; transcriptTail: string }> = [];
      const b = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        follow: [{ ok: true, url: SESSION }],
        session: [
          waiting(`需要先确认环境健康度：\n${REQUEST}`),
          idleDone(PR9),
          idleDone(PR9),
        ],
      });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), {
        ...w.deps, browse: b.browse,
        assist: async input => {
          assists.push({ round: input.round, transcriptTail: input.transcriptTail });
          return { decision: 'reply', message: '{"reachable":true}', toolExecuted: 'ops_health' };
        },
      });
      expect(out.status).toBe('success');
      expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(assists).toHaveLength(1);
      expect(assists[0]!.round).toBe(1);
      expect(assists[0]!.transcriptTail).toContain('ops_health');
      const follows = b.calls.filter(s => s.includes(MODE('follow')));
      expect(follows).toHaveLength(1);
      expect(follows[0]).toContain(SESSION);
      expect(readLaneState(w.commDir)?.devin?.assistRounds).toBe(1);
    });

    test('正确终稿优先：等待指示已带 SCK-DONE 时即使作者块里有请求也不代跑', async () => {
      const w = world({ extra: gitOk });
      let assistCalls = 0;
      const b = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        session: [{ ...idleDone(PR9), cap: 'Free', agentTail: REQUEST }],
      });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse,
        assist: async () => { assistCalls++; return { decision: 'reply', message: 'x' }; } });
      expect(out.status).toBe('success');
      expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(assistCalls).toBe(0);
      expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
    });

    test('普通等待指示、请求只在本轮作者块之外、缺锚点、非 Free、错会话、越权请求都不触发代跑', async () => {
      const cases: Array<{ name: string; reply: Record<string, unknown> }> = [
        { name: '普通 idle 无请求', reply: waiting('本轮先说明一下进展，尚未给出终稿。') },
        { name: '请求不在作者块（只在页面正文/工具输出）', reply: waiting('', { tail: `user: ${REQUEST}` }) },
        { name: '缺本轮用户锚点', reply: waiting(REQUEST, { markerSeen: false }) },
        { name: '非 Free 档位', reply: waiting(REQUEST, { cap: 'Normal' }) },
        { name: '读不出档位', reply: waiting(REQUEST, { cap: undefined }) },
        { name: '页面停在别的会话', reply: waiting(REQUEST, { url: OTHER }) },
        { name: '写/建类越权请求', reply: waiting('[OPS-REQUEST] {"tool":"ops_account_ensure","args":{"alias":"A"}}') },
        { name: '非白名单工具', reply: waiting('[OPS-REQUEST] {"tool":"ops_d1_exec","args":{}}') },
        { name: '损坏的请求 JSON', reply: waiting('[OPS-REQUEST] {"tool":') },
      ];
      for (const item of cases) {
        const w = world({ extra: gitOk });
        let assistCalls = 0;
        // 列表只有一条：每次轮询都返回同一形态，够走到各自的有界上限。
        const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [item.reply] });
        const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1 } }), { ...w.deps, browse: b.browse,
          assist: async () => { assistCalls++; return { decision: 'reply', message: 'x' }; } });
        expect(out.status, item.name).toBe('success');
        expect(out.text.split('\n')[0], item.name).toBe('工作结果：受阻');
        expect(assistCalls, item.name).toBe(0);
        expect(b.calls.filter(s => s.includes(MODE('follow'))).length, item.name).toBe(0);
        expect(b.calls.filter(s => s.includes(MODE('send'))).length, item.name).toBe(1);
      }
    });

    test('已达 3 轮上限：等待指示里的请求也不再代跑，受阻交老板', async () => {
      const w = world({ extra: gitOk });
      writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'x', delivery: 'delivery-idle-cap',
        branch: 'sck/task-1', taskId: 'SCK-aaaaaaaaaa', taskUrl: SESSION, submittedAt: Date.now(),
        devin: { assistRounds: 3 } });
      let assistCalls = 0;
      const b = devinBrowse({ session: [waiting(REQUEST)] });
      const out = await runLane(w.input({ provider: 'devin-cloud', env: { SCK_DELIVERY_ID: 'delivery-idle-cap' } }), {
        ...w.deps, browse: b.browse,
        assist: async () => { assistCalls++; return { decision: 'reply', message: '不应调用' }; },
      });
      expect(out.status).toBe('success');
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('老板');
      expect(assistCalls).toBe(0);
      expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
      expect(readLaneState(w.commDir)?.devin?.assistRounds).toBe(3);
    });

    test('重复轮回：代跑已回传的旧请求在新一轮锚点未出现前不再次触发（不重复代跑）', async () => {
      const w = world({ extra: gitOk });
      let assistCalls = 0;
      const b = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        follow: [{ ok: true, url: SESSION }],
        // 第一轮：等待指示 + 显式请求 → 代跑一次；之后新轮标记尚未回显（markerSeen:false），
        // 页面正文里仍残留旧请求，但本轮作者块不再是可信来源，不得再代跑。
        session: [waiting(REQUEST), waiting(REQUEST, { markerSeen: false })],
      });
      const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1 } }), { ...w.deps, browse: b.browse,
        assist: async () => { assistCalls++; return { decision: 'reply', message: '{}', toolExecuted: 'ops_health' }; } });
      expect(out.status).toBe('success');
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('一直找不到本轮消息');
      expect(assistCalls).toBe(1);
      expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
    });

    test('代跑回执丢失：只核对不重发（发送一次），attempt 与轮数保留；恢复零工具零重发', async () => {
      const w = world({ extra: gitOk });
      let assistCalls = 0;
      const b = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        follow: [{ ok: false, code: 'not_echoed' }],
        session: [waiting(REQUEST)],
      });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse,
        assist: async () => { assistCalls++; return { decision: 'reply', message: '{}', toolExecuted: 'ops_health' }; } });
      expect(out.status).toBe('success');
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('未能确认回传原会话');
      expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
      expect(b.calls.filter(s => s.includes(MODE('send')))).toHaveLength(1);
      const st = readLaneState(w.commDir);
      expect(st?.devin?.assistRounds).toBe(1);
      expect(st?.devin?.attempt).toMatch(/^SCK-/);
      expect(st?.devin?.attemptSession).toBe(SESSION);
      const attempt = st!.devin!.attempt!;

      // 恢复：只追踪这条 attempt 与原会话，绝不再执行工具或重发；在途登记保留。
      const unseen = { ok: true, markerSeen: false, status: 'blocked', done: null, tail: 'still waiting', agentTail: 'still waiting' };
      const resume = devinBrowse({ session: [unseen, unseen, unseen, unseen] });
      const out2 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: resume.browse,
        assist: async () => { assistCalls++; return { decision: 'reply', message: '不应调用' }; } });
      expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(assistCalls).toBe(1);
      expect(resume.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
      expect(resume.calls.filter(s => s.includes(MODE('send')))).toHaveLength(0);
      expect(resume.calls.every(s => s.includes(SESSION))).toBe(true);
      expect(resume.calls.some(s => s.includes(MODE('session')) && s.includes(attempt))).toBe(true);
      expect(readLaneState(w.commDir)?.devin?.attempt).toBe(attempt);
    });

    test('跨租约重派（新投递键、新员工目录）：领养旧受理会话，旧锚点后的只读请求照常进入中继，零发送', async () => {
      // 第一租约模拟 504de3c3 的现场：会话已受理、页面停在等待指示、作者块里有只读请求，但没有中继能力，
      // 回合受阻并保留在途状态。
      const first = world({ extra: gitOk });
      const stuck = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [waiting(REQUEST)] });
      const out1 = await runLane(first.input({ provider: 'devin-cloud', env: { SCK_DELIVERY_ID: 'lease-old' } }),
        { ...first.deps, browse: stuck.browse });
      expect(out1.status).toBe('success');
      expect(out1.text.split('\n')[0]).toBe('工作结果：受阻');
      const prior = readInflight(first.stateRoot, 'devin-cloud', 'lease-old');
      expect(prior?.taskId).toBeDefined();
      expect(prior?.taskUrl).toBe(SESSION);

      // 第二租约正常回复续派：新投递键、新的员工目录。旧会话仍可复用，且不再发出任何用户消息；
      // 独立复验直接从原会话读回旧请求，不靠新一条用户消息生成锚点。
      const second = world({ extra: gitOk });
      const assists: Array<{ round: number; transcriptTail: string }> = [];
      const b = devinBrowse({
        follow: [{ ok: true, url: SESSION }],
        session: [waiting(REQUEST), idleDone(PR9), idleDone(PR9)],
      });
      const out2 = await runLane(second.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
        env: { SCK_DELIVERY_ID: 'lease-new' }, prompt: '老板已回复，继续本轮。' }), {
        ...second.deps, browse: b.browse,
        assist: async input => {
          assists.push({ round: input.round, transcriptTail: input.transcriptTail });
          return { decision: 'reply', message: '{"reachable":true}', toolExecuted: 'ops_health' };
        },
      });
      expect(out2.status).toBe('success');
      expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/9');
      // 零发送：没有新用户消息、没有新会话；轮询与代跑回传都只落在原会话。
      expect(b.calls.filter(s => s.includes(MODE('send')))).toHaveLength(0);
      expect(b.calls.every(s => s.includes(SESSION))).toBe(true);
      expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
      expect(assists).toHaveLength(1);
      expect(assists[0]!.round).toBe(1);
      expect(assists[0]!.transcriptTail).toContain('ops_health');
      // 旧投递键的共享登记只按当前 taskId 精确结清；代跑换标记后它作为已受理地址保留（移植前既有行为），
      // 不影响本轮零发送与独立复验，也不会让后续同任务重派再发一条用户消息。
      expect(readInflight(first.stateRoot, 'devin-cloud', 'lease-old')?.taskUrl).toBe(SESSION);
    });

    test('前置探测脚本本身零填写零发送：原会话 Free、idle、组织首页 2/2 时给出 quota_full', async () => {
      const fake = fakeDevin({
        seats: { used: 2, total: 2 },
        sessions: { [SESSION]: { cap: 'Free', status: 'Devin is awaiting instructions', blocks: [] } },
      });
      const full = await fake.browse(devinRelayGateScript(SESSION, 'SCK-aaaaaaaaaa'));
      expect(full).toMatchObject({ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' });
      expect(fake.st.sent).toHaveLength(0);
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.events.some(e => e.startsWith('send '))).toBe(false);
      expect(fake.st.events.some(e => e.startsWith('visit '))).toBe(true);

      // 同一脚本在空位时只报可发，仍不填写、不按发送；档位选择只走 Free，不碰付费档。
      const free = fakeDevin({
        seats: { used: 0, total: 2 },
        sessions: { [SESSION]: { cap: 'Free', status: 'Devin is awaiting instructions', blocks: [] } },
      });
      const sendable = await free.browse(devinRelayGateScript(SESSION, 'SCK-aaaaaaaaaa'));
      expect(sendable).toMatchObject({ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } });
      expect(free.st.sent).toHaveLength(0);
      expect(free.st.events).not.toContain('fill');
      expect(free.st.events.some(e => e.startsWith('send '))).toBe(false);
    });

    test('已知满座：先探测再决定，零工具调用、零发送；席位空出后恢复只回传一次并正常收尾', async () => {
      const w = world({ extra: gitOk });
      let assistCalls = 0;
      const assist = async () => { assistCalls++; return { decision: 'reply' as const, message: '{"reachable":true}', toolExecuted: 'ops_health' }; };
      const first = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        gate: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(REQUEST)],
      });
      const out1 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: first.browse, assist });
      expect(out1.status).toBe('success');
      expect(out1.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out1.text).toContain('席位已满（2/2 in use）');
      expect(out1.text).toContain('未代跑、未发送');
      // 满座时既不执行只读工具，也不碰发送按钮，也不新建会话。
      expect(assistCalls).toBe(0);
      expect(first.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
      expect(first.calls.filter(s => s.includes(MODE('send')))).toHaveLength(1); // 只有建立会话的那一次
      expect(first.calls.filter(s => s.includes(MODE('relay-gate')))).toHaveLength(1);
      const blockedState = readLaneState(w.commDir);
      expect(blockedState?.devin?.assistRounds).toBeUndefined();
      expect(blockedState?.devin?.attempt).toBeUndefined();
      expect(blockedState?.taskUrl).toBe(SESSION);
      // 未按下发送，共享登记里也不能留下发送意图。
      expect(readInflight(w.stateRoot, 'devin-cloud', blockedState!.digest!)?.attempt).toBeUndefined();

      // 席位空出后恢复：先探测可发，再执行一次工具、只回传一次；之后回到正常 DONE 收尾。
      const second = devinBrowse({
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
        follow: [{ ok: true, url: SESSION }],
        session: [waiting(REQUEST), idleDone(PR9), idleDone(PR9)],
      });
      const out2 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: second.browse, assist });
      expect(out2.status).toBe('success');
      expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(assistCalls).toBe(1);
      expect(second.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
      expect(second.calls.filter(s => s.includes(MODE('send')))).toHaveLength(0);
      expect(second.calls.filter(s => s.includes(MODE('relay-gate')))).toHaveLength(1);
      expect(readLaneState(w.commDir)?.devin?.assistRounds).toBe(1);
    });

    test('检查与发送之间席位被占：回传正文落盘，恢复零工具、只补发一次；满席恢复仍不执行工具', async () => {
      const w = world({ extra: gitOk });
      let assistCalls = 0;
      const assist = async () => { assistCalls++; return { decision: 'reply' as const, message: '{"reachable":true}', toolExecuted: 'ops_health' }; };
      const first = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 1, total: 2 } }],
        follow: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(REQUEST)],
      });
      const out1 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: first.browse, assist });
      expect(out1.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(assistCalls).toBe(1);
      expect(first.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
      const relay = readLaneState(w.commDir)?.devin?.assistRelay;
      expect(relay?.marker).toMatch(/^SCK-/);
      expect(relay?.text).toContain('本地驻场管理员代跑结果');
      expect(readLaneState(w.commDir)?.devin?.attempt).toBeUndefined();

      // 仍满座：复用已产出的回传正文，等下一个可发窗口；零工具、零发送。
      const second = devinBrowse({
        gate: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(REQUEST)],
      });
      const out2 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: second.browse, assist });
      expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(assistCalls).toBe(1);
      expect(second.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
      expect(readLaneState(w.commDir)?.devin?.assistRelay?.marker).toBe(relay!.marker);

      // 空位：直接复用这份正文补发一次（不再执行工具），随后回到正常 DONE 收尾。
      const third = devinBrowse({
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
        follow: [{ ok: true, url: SESSION }],
        session: [waiting(REQUEST), idleDone(PR9), idleDone(PR9)],
      });
      const out3 = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: third.browse, assist });
      expect(out3.status).toBe('success');
      expect(out3.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(assistCalls).toBe(1);
      expect(third.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
      expect(third.calls.filter(s => s.includes(MODE('relay-gate')))).toHaveLength(1);
      // 补发用的是同一份已落盘正文与同一标记：不会生成第二条回执。
      const sent = third.calls.filter(s => s.includes(MODE('follow')))[0]!;
      expect(sent).toContain(relay!.marker);
      expect(readLaneState(w.commDir)?.devin?.assistRelay).toBeUndefined();
    });

    test('跨租约恢复（新 commDir、共享原 stateRoot、新投递键）：检查与发送之间席位被占后空位恢复，同一工具全程只执行一次、只回传一次、零新会话', async () => {
      // 负责人独立反例：前两段与「检查与发送之间席位被占」相同；第三段换新 world（新 commDir）但共享原 stateRoot，
      // 用新的 SCK_DELIVERY_ID 恢复同一公司任务、原 Free 会话与只读请求。回传正文只写 commDir 时，新租约看不到
      // 已执行的工具结果，会再执行一次同一工具（assistCalls 期待 1、实测 2）。
      const first = world({ extra: gitOk });
      let assistCalls = 0;
      const assist = async () => { assistCalls++; return { decision: 'reply' as const, message: '{"reachable":true}', toolExecuted: 'ops_health' }; };
      const a = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 1, total: 2 } }],
        follow: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(REQUEST)],
      });
      const out1 = await runLane(first.input({ provider: 'devin-cloud' }), { ...first.deps, browse: a.browse, assist });
      expect(out1.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(assistCalls).toBe(1);
      const relay = readLaneState(first.commDir)?.devin?.assistRelay;
      expect(relay?.marker).toMatch(/^SCK-/);
      // 工具回执的持久数据：只保留发送所需的最小字段（工具名、正文、轮数与绑定摘要），权限 0600。
      expect(relay?.tool).toBe('ops_health');
      expect(relay?.round).toBe(1);
      expect(relay?.text).toContain('{"reachable":true}');
      expect(relay?.anchor).toMatch(/^[a-f0-9]{16}$/);
      expect(relay?.task).toBe('task-1');
      expect(relay?.phase).toBe('doing');
      expect(relay?.session).toBe(SESSION);
      const firstDigest = readLaneState(first.commDir)!.digest!;
      const inflightPath = join(first.stateRoot, 'devin-cloud', 'inflight', `${encodeURIComponent(firstDigest)}.json`);
      expect(statSync(join(first.commDir, '.lane', 'state.json')).mode & 0o777).toBe(0o600);
      expect(statSync(inflightPath).mode & 0o777).toBe(0o600);
      const shared = JSON.parse(readFileSync(inflightPath, 'utf8'));
      expect(shared.assistRelay.marker).toBe(relay!.marker);
      expect(shared.taskId).toBeDefined();

      // 第二段：同一 world 仍满座，零工具、零发送；回传正文继续保留。
      const b = devinBrowse({
        gate: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(REQUEST)],
      });
      const out2 = await runLane(first.input({ provider: 'devin-cloud' }), { ...first.deps, browse: b.browse, assist });
      expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(assistCalls).toBe(1);

      // 第三段：新世界（新 commDir），共享 first.stateRoot，新投递键恢复。空位后必须复用已落盘的回传正文：
      // 不再执行同一工具，只补发一次原标记；不新建会话、不产生额外付费会话。
      const second = world({ extra: gitOk });
      const c = devinBrowse({
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
        follow: [{ ok: true, url: SESSION }],
        session: [waiting(REQUEST), idleDone(PR9), idleDone(PR9)],
      });
      const out3 = await runLane(second.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
        env: { SCK_DELIVERY_ID: 'lease-new' } }), { ...second.deps, browse: c.browse, assist });
      expect(out3.status).toBe('success');
      expect(out3.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(assistCalls).toBe(1);
      expect(c.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
      expect(c.calls.filter(s => s.includes(MODE('send')))).toHaveLength(0);
      // 补发用同一份已落盘正文与同一标记：原会话只回显一次。
      expect(c.calls.filter(s => s.includes(MODE('follow')))[0]).toContain(relay!.marker);
      expect(readLaneState(second.commDir)?.devin?.assistRelay).toBeUndefined();
      // 回合终态清理：共享在途登记与代跑发送意图都不留到下一回合。
      expect(existsSync(inflightPath)).toBe(false);
    });

    test('跨租约恢复：请求语义一致但页面尾串变化（键序/空白/附加渲染文字）仍复用同一份回传正文，工具不再执行', async () => {
      const first = world({ extra: gitOk });
      let assistCalls = 0;
      const assist = async () => { assistCalls++; return { decision: 'reply' as const, message: '{"reachable":true}', toolExecuted: 'ops_health' }; };
      const a = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 1, total: 2 } }],
        follow: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(`需要先确认环境健康度：\n${REQUEST}`)],
      });
      await runLane(first.input({ provider: 'devin-cloud' }), { ...first.deps, browse: a.browse, assist });
      const relay = readLaneState(first.commDir)!.devin!.assistRelay!;

      const second = world({ extra: gitOk });
      const volatile = '我再确认一次（页面渲染于 10:00）：\n\n[OPS-REQUEST] {"args":{},"tool":"ops_health"}\n（页面尾部的新渲染文字，不是请求本身）';
      const c = devinBrowse({
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
        follow: [{ ok: true, url: SESSION }],
        session: [waiting(volatile), idleDone(PR9), idleDone(PR9)],
      });
      const out = await runLane(second.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
        env: { SCK_DELIVERY_ID: 'lease-tail-changed' } }), { ...second.deps, browse: c.browse, assist });
      expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(assistCalls).toBe(1);
      expect(c.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(1);
      expect(c.calls.filter(s => s.includes(MODE('follow')))[0]).toContain(relay.marker);
    });

    test('跨租约恢复：工具或参数变化不采信旧回执，重新代跑一次且用新标记回传', async () => {
      const first = world({ extra: gitOk });
      let assistCalls = 0;
      const assist = async () => { assistCalls++; return { decision: 'reply' as const, message: '{"reachable":true}', toolExecuted: 'ops_health' }; };
      const a = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 1, total: 2 } }],
        follow: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(REQUEST)],
      });
      await runLane(first.input({ provider: 'devin-cloud' }), { ...first.deps, browse: a.browse, assist });
      const relay = readLaneState(first.commDir)!.devin!.assistRelay!;

      const second = world({ extra: gitOk });
      const changed = '[OPS-REQUEST] {"tool":"ops_info","args":{"scope":"prod"}}';
      const c = devinBrowse({
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
        follow: [{ ok: true, url: SESSION }],
        session: [waiting(changed), idleDone(PR9), idleDone(PR9)],
      });
      const out = await runLane(second.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
        env: { SCK_DELIVERY_ID: 'lease-request-changed' } }), { ...second.deps, browse: c.browse, assist });
      expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
      // 请求变了是新的代跑：旧正文不采信，工具按新请求重新执行一次。
      expect(assistCalls).toBe(2);
      const follows = c.calls.filter(s => s.includes(MODE('follow')));
      expect(follows).toHaveLength(1);
      expect(follows[0]).not.toContain(relay.marker);
    });

    test('跨租约恢复：旧租约 doing 阶段的回传正文不能被复核阶段复用（错阶段不采信）', async () => {
      const first = world({ extra: gitOk });
      const assist = async () => ({ decision: 'reply' as const, message: '{"reachable":true}', toolExecuted: 'ops_health' });
      const a = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 1, total: 2 } }],
        follow: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(REQUEST)],
      });
      await runLane(first.input({ provider: 'devin-cloud' }), { ...first.deps, browse: a.browse, assist });
      const relay = readLaneState(first.commDir)!.devin!.assistRelay!;

      // 复核轮（阶段不同）：共享登记里残留的 doing 回传正文不能拿来发送，必须按复核请求重做一份。
      const review = world({ task: '# 复核\n\n## 待复核成果\n\n已提交。\n', extra: gitOk });
      writeInflight(first.stateRoot, 'devin-cloud', 'lease-review', {
        taskId: relay.marker, taskUrl: SESSION, submittedAt: Date.now(), vendorSession: SESSION, task: 'task-1',
        assistRounds: relay.round, assistRelay: { ...relay, phase: 'doing' },
      });
      let assistCalls = 0;
      const c = devinBrowse({
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
        follow: [{ ok: true, url: SESSION }],
        session: [waiting(REQUEST), idleDone('复核结论：通过\n逐条证据。'), idleDone('复核结论：通过\n逐条证据。')],
      });
      const out = await runLane(review.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
        env: { SCK_DELIVERY_ID: 'lease-review' } }), { ...review.deps, browse: c.browse,
        assist: async input => { assistCalls++; return { decision: 'reply', message: `复核说明（${input.phase}）`, toolExecuted: 'ops_health' }; } });
      expect(out.text).toMatch(/^复核结论：通过/);
      expect(assistCalls).toBe(1);
      const follows = c.calls.filter(s => s.includes(MODE('follow')));
      expect(follows).toHaveLength(1);
      expect(follows[0]).not.toContain(relay.marker);
    });

    test('跨租约恢复不采信绑定到别的任务/别的会话的旧回执：重新代跑并按本会话回传', async () => {
      const cases = [
        { name: '别的任务', tamper: (relay: Record<string, unknown>) => ({ ...relay, task: 'task-other' }) },
        { name: '别的会话', tamper: (relay: Record<string, unknown>) => ({ ...relay, session: OTHER }) },
      ];
      for (const item of cases) {
        const first = world({ extra: gitOk });
        const a = devinBrowse({
          send: [{ ok: true, url: SESSION }],
          gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 1, total: 2 } }],
          follow: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
          session: [waiting(REQUEST)],
        });
        await runLane(first.input({ provider: 'devin-cloud' }), { ...first.deps, browse: a.browse,
          assist: async () => ({ decision: 'reply', message: '{"reachable":true}', toolExecuted: 'ops_health' }) });
        const relay = readLaneState(first.commDir)!.devin!.assistRelay!;

        const second = world({ extra: gitOk });
        writeInflight(first.stateRoot, 'devin-cloud', 'lease-tampered', {
          taskId: relay.marker, taskUrl: SESSION, submittedAt: Date.now(), vendorSession: SESSION, task: 'task-1',
          assistRounds: relay.round, assistRelay: item.tamper({ ...relay }) as typeof relay,
        });
        let assistCalls = 0;
        const c = devinBrowse({
          gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
          follow: [{ ok: true, url: SESSION }],
          session: [waiting(REQUEST), idleDone(PR9), idleDone(PR9)],
        });
        const out = await runLane(second.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
          env: { SCK_DELIVERY_ID: 'lease-tampered' } }), { ...second.deps, browse: c.browse,
          assist: async () => { assistCalls++; return { decision: 'reply', message: 'ok', toolExecuted: 'ops_health' }; } });
        expect(out.text, item.name).toContain('PR: https://github.com/acme/widget/pull/9');
        expect(assistCalls, item.name).toBe(1);
        const follows = c.calls.filter(s => s.includes(MODE('follow')));
        expect(follows, item.name).toHaveLength(1);
        expect(follows[0], item.name).not.toContain(relay.marker);
      }
    });

    test('跨租约恢复：新租约探测确认满额时零工具零发送，已落盘的回传正文保留待下次恢复', async () => {
      const first = world({ extra: gitOk });
      let assistCalls = 0;
      const assist = async () => { assistCalls++; return { decision: 'reply' as const, message: '{"reachable":true}', toolExecuted: 'ops_health' }; };
      const a = devinBrowse({
        send: [{ ok: true, url: SESSION }],
        gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 1, total: 2 } }],
        follow: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(REQUEST)],
      });
      await runLane(first.input({ provider: 'devin-cloud' }), { ...first.deps, browse: a.browse, assist });
      const relay = readLaneState(first.commDir)!.devin!.assistRelay!;

      const second = world({ extra: gitOk });
      const c = devinBrowse({
        gate: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
        session: [waiting(REQUEST)],
      });
      const out = await runLane(second.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
        env: { SCK_DELIVERY_ID: 'lease-still-full' } }), { ...second.deps, browse: c.browse, assist });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('席位已满（2/2 in use）');
      expect(out.text).toContain('未代跑、未发送');
      expect(assistCalls).toBe(1);
      expect(c.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
      expect(c.calls.filter(s => s.includes(MODE('send')))).toHaveLength(0);
      // 正文已从共享登记恢复并继续保留；下次空位恢复可直接补发。
      expect(readLaneState(second.commDir)?.devin?.assistRelay?.marker).toBe(relay.marker);
      expect(readInflight(first.stateRoot, 'devin-cloud', readLaneState(second.commDir)!.digest!)?.assistRelay?.marker).toBe(relay.marker);
    });

    test('跨租约恢复：补发结果不确定（not_echoed / 无回执 / 未知 code）时保留 attempt 与回传正文；同投递与换投递恢复都只核对，零工具零跟进零新会话', async () => {
      for (const uncertain of [
        { name: 'not_echoed', follow: { ok: false, code: 'not_echoed' } },
        { name: '无回执', follow: undefined },
        { name: '未知 code', follow: { ok: false, code: 'unknown_result' } },
      ] as const) {
        const first = world({ extra: gitOk });
        let assistCalls = 0;
        const assist = async () => { assistCalls++; return { decision: 'reply' as const, message: '{"reachable":true}', toolExecuted: 'ops_health' }; };
        const a = devinBrowse({
          send: [{ ok: true, url: SESSION }],
          gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 1, total: 2 } }],
          follow: [{ ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' }],
          session: [waiting(REQUEST)],
        });
        await runLane(first.input({ provider: 'devin-cloud' }), { ...first.deps, browse: a.browse, assist });
        const relay = readLaneState(first.commDir)!.devin!.assistRelay!;

        // 空位后补发一次，但回执不可判读：不能当成未发出，本地与共享 attempt、正文都保留。
        const second = world({ extra: gitOk });
        const b = devinBrowse({
          gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
          follow: [uncertain.follow],
          session: [waiting(REQUEST)],
        });
        const out2 = await runLane(second.input({ provider: 'devin-cloud', stateRoot: first.stateRoot }), {
          ...second.deps, browse: b.browse, assist });
        expect(out2.text.split('\n')[0], uncertain.name).toBe('工作结果：受阻');
        expect(out2.text, uncertain.name).toContain('未能确认回传原会话');
        expect(out2.text, uncertain.name).not.toContain('app.devin.ai');
        expect(assistCalls, uncertain.name).toBe(1);
        expect(b.calls.filter(s => s.includes(MODE('follow'))).length, uncertain.name).toBe(1);
        const pending = readLaneState(second.commDir)!;
        expect(pending.devin?.attempt, uncertain.name).toBe(relay.marker);
        expect(pending.taskId, uncertain.name).toBeDefined();
        // 已受理的 taskId 与待确认的代跑 attempt 在共享登记里共存，普通在途写不能抹掉 attempt。
        const shared = readInflight(first.stateRoot, 'devin-cloud', pending.digest!)!;
        expect(shared.taskId, uncertain.name).toBeDefined();
        expect(shared.attempt, uncertain.name).toBe(relay.marker);
        expect(shared.assistRelay?.marker, uncertain.name).toBe(relay.marker);

        // 同投递键再恢复：只核对这条 attempt，零重发、零工具、零新会话。
        const sameKey = world({ extra: gitOk });
        const seenBlocked = { ok: true, markerSeen: true, cap: 'Free', status: 'blocked', done: null,
          tail: 'BROWSER_TAIL_SENTINEL', url: SESSION, agentTail: REQUEST };
        const same = devinBrowse({ session: [seenBlocked, seenBlocked] });
        const outSame = await runLane(sameKey.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
          env: { SCK_DELIVERY_ID: pending.delivery } }), { ...sameKey.deps, browse: same.browse, assist });
        expect(outSame.text.split('\n')[0], uncertain.name).toBe('工作结果：受阻');
        expect(outSame.text, uncertain.name).toContain('上一轮本地代跑回传');
        expect(outSame.text, uncertain.name).not.toContain('app.devin.ai');
        expect(outSame.text, uncertain.name).not.toContain('BROWSER_TAIL_SENTINEL');
        expect(assistCalls, uncertain.name).toBe(1);
        expect(same.calls.filter(s => s.includes(MODE('follow'))).length, uncertain.name).toBe(0);
        expect(same.calls.filter(s => s.includes(MODE('send'))).length, uncertain.name).toBe(0);

        // 换投递键（新 commDir）恢复：同样只核对，零重发、零工具。
        const third = world({ extra: gitOk });
        const c = devinBrowse({ session: [seenBlocked, seenBlocked] });
        const out3 = await runLane(third.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
          env: { SCK_DELIVERY_ID: `lease-uncertain-${uncertain.name}` } }), {
          ...third.deps, browse: c.browse, assist });
        expect(out3.text.split('\n')[0], uncertain.name).toBe('工作结果：受阻');
        expect(out3.text, uncertain.name).toContain('上一轮本地代跑回传');
        expect(out3.text, uncertain.name).not.toContain('app.devin.ai');
        expect(out3.text, uncertain.name).not.toContain('BROWSER_TAIL_SENTINEL');
        expect(assistCalls, uncertain.name).toBe(1);
        expect(c.calls.filter(s => s.includes(MODE('follow'))).length, uncertain.name).toBe(0);
        expect(c.calls.filter(s => s.includes(MODE('send'))).length, uncertain.name).toBe(0);
        expect(readLaneState(third.commDir)?.taskId, uncertain.name).toBe(relay.marker);
        expect(readInflight(first.stateRoot, 'devin-cloud', pending.digest!)?.attempt, uncertain.name).toBe(relay.marker);
      }
    });

    test('跨租约恢复：较旧已受理快照与较新待确认意图并存时优先核对待确认意图；冲突无法判定时受阻零发送（不依赖目录顺序）', async () => {
      // 较旧：已受理（taskId/taskUrl），没有待确认发送意图。
      // 较新：同一任务的代跑回传已按下、未确认（只有 attempt）。换新投递键恢复必须看见较新意图。
      for (const order of ['older-first', 'newer-first'] as const) {
        const root = mkdtempSync(join(tmpdir(), 'sck-lane-multi-'));
        dirs.push(root);
        const older = { taskId: 'SCK-a1b2c3d4e5', taskUrl: SESSION, submittedAt: 1_000, vendorSession: SESSION, task: 'task-1' };
        const newer = { attempt: 'SCK-0f1e2d3c4b', attemptAt: 2_000, attemptSession: SESSION, task: 'task-1', assistRounds: 1 };
        // 写入顺序对调：恢复不得依赖 readdir 顺序。
        if (order === 'older-first') {
          writeInflight(root, 'devin-cloud', 'lease-older', older);
          writeInflight(root, 'devin-cloud', 'lease-newer', newer);
        } else {
          writeInflight(root, 'devin-cloud', 'lease-newer', newer);
          writeInflight(root, 'devin-cloud', 'lease-older', older);
        }
        let assistCalls = 0;
        const third = world({ extra: gitOk });
        const seenBlocked = { ok: true, markerSeen: true, cap: 'Free', status: 'blocked', done: null, tail: '', agentTail: REQUEST };
        const c = devinBrowse({
          gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
          follow: [{ ok: true, url: SESSION }],
          session: [seenBlocked, idleDone(PR9), idleDone(PR9)],
        });
        const out = await runLane(third.input({ provider: 'devin-cloud', stateRoot: root,
          env: { SCK_DELIVERY_ID: `lease-third-${order}` } }),
          { ...third.deps, browse: c.browse, assist: async () => { assistCalls++; return { decision: 'reply', message: '不应再代跑', toolExecuted: 'ops_health' }; } });
        expect(out.text.split('\n')[0], order).toBe('工作结果：受阻');
        expect(out.text, order).toContain('上一轮本地代跑回传');
        expect(assistCalls, order).toBe(0);
        expect(c.calls.filter(s => s.includes(MODE('follow'))).length, order).toBe(0);
        expect(c.calls.filter(s => s.includes(MODE('send'))).length, order).toBe(0);
        expect(readLaneState(third.commDir)?.taskId, order).toBe('SCK-0f1e2d3c4b');
      }

      // 两条互不相同的未确认意图：无法判定，受阻、零发送。
      {
        const root = mkdtempSync(join(tmpdir(), 'sck-lane-conflict-'));
        dirs.push(root);
        writeInflight(root, 'devin-cloud', 'lease-a', {
          attempt: 'SCK-aaaaaaaaaa', attemptAt: 1_000, attemptSession: SESSION, task: 'task-1', assistRounds: 1 });
        writeInflight(root, 'devin-cloud', 'lease-b', {
          attempt: 'SCK-bbbbbbbbbb', attemptAt: 2_000, attemptSession: SESSION, task: 'task-1', assistRounds: 1 });
        const w = world({ extra: gitOk });
        let assistCalls = 0;
        const b = devinBrowse({
          gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
          follow: [{ ok: true, url: SESSION }],
          session: [waiting(REQUEST), idleDone(PR9)],
        });
        const out = await runLane(w.input({ provider: 'devin-cloud', stateRoot: root,
          env: { SCK_DELIVERY_ID: 'lease-conflict' } }),
          { ...w.deps, browse: b.browse, assist: async () => { assistCalls++; return { decision: 'reply', message: 'x' }; } });
        expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
        expect(out.text).toContain('多条互不相同的 Devin Cloud 未确认发送意图');
        expect(assistCalls).toBe(0);
        expect(b.calls).toHaveLength(0);
      }
    });

    test('探测拒绝的其它路径：错会话、非 Free、忙、未就绪、未登录都不代跑、不发送、不另建会话；受阻文案只含固定原因与席位数字', async () => {
      const cases: Array<{ name: string; gate: Record<string, unknown>; login?: boolean; reason: string }> = [
        { name: '错会话', gate: { ok: false, code: 'wrong_session', url: OTHER }, reason: 'Devin 页面没有停在原会话' },
        { name: '非 Free 档位', gate: { ok: false, code: 'capability', detail: 'BROWSER_DETAIL_SENTINEL 会话 Capability 显示 Normal' },
          reason: 'Devin 页面未能确认 Free 档位或席位计数' },
        { name: '忙', gate: { ok: false, code: 'busy' }, reason: 'Devin 会话还在处理上一轮' },
        { name: '未就绪', gate: { ok: false, code: 'not_ready' }, reason: 'Devin 页面未就绪' },
        { name: '满额', gate: { ok: false, code: 'quota_full', seats: '2/2', cap: 'Free' },
          reason: 'Devin Free 席位已满（2/2 in use）' },
        { name: '未登录', gate: { ok: false, code: 'login_required' }, login: true, reason: '未登录' },
        { name: '未知返回码', gate: { ok: false, code: 'weird_browser_code' }, reason: '页面核对未通过' },
      ];
      for (const item of cases) {
        const w = world({ extra: gitOk });
        let assistCalls = 0;
        const b = devinBrowse({
          send: [{ ok: true, url: SESSION }],
          gate: [item.gate],
          session: [waiting(REQUEST, { tail: 'BROWSER_TAIL_SENTINEL' })],
        });
        const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse,
          assist: async () => { assistCalls++; return { decision: 'reply', message: '不应调用' }; } });
        expect(out.status, item.name).toBe(item.login ? 'error' : 'success');
        expect(out.text, item.name).toContain(item.reason);
        if (!item.login) {
          expect(out.text.split('\n')[0], item.name).toBe('工作结果：受阻');
          expect(out.text, item.name).toContain('本轮未代跑、未发送');
        }
        // 中继受阻只含固定原因与校验后的席位数字：不附会话网址、页面文字或未知返回码原文。
        expect(out.text, item.name).not.toContain('app.devin.ai');
        expect(out.text, item.name).not.toContain('BROWSER_TAIL_SENTINEL');
        expect(out.text, item.name).not.toContain('BROWSER_DETAIL_SENTINEL');
        expect(out.text, item.name).not.toContain('weird_browser_code');
        expect(assistCalls, item.name).toBe(0);
        expect(b.calls.filter(s => s.includes(MODE('follow'))).length, item.name).toBe(0);
        expect(b.calls.filter(s => s.includes(MODE('send'))).length, item.name).toBe(1);
        expect(readLaneState(w.commDir)?.devin?.assistRounds, item.name).toBeUndefined();
        expect(readLaneState(w.commDir)?.devin?.attempt, item.name).toBeUndefined();
      }
    });

    test('中继后续核对与收尾的出站受阻只含固定原因和确认标记：无标记、地址不符、到时、无终稿、转人工都不回显会话 URL、页面正文或协助原因', async () => {
      const TAIL = 'BROWSER_TAIL_SENTINEL 页面正文';
      const REASON = 'FREE_TEXT_ASSIST_REASON_SENTINEL';
      const SESSION_URLS = (text: string) => text.includes(SESSION) || text.includes(OTHER) || text.includes('app.devin.ai');
      /** 走完「首发受理 → 轮询」到指定收尾，返回本轮最终答复。 */
      const pollTo = async (session: Array<Record<string, unknown>>, over: {
        assist?: LaneDeps['assist']; config?: Record<string, number>; advance?: number;
      } = {}) => {
        const w = world({ extra: gitOk });
        const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session });
        const run = (script: string, timeout: number) => {
          if (over.advance) w.advance(over.advance);
          return b.browse(script, timeout);
        };
        const out = await runLane(w.input({ provider: 'devin-cloud', config: over.config ?? { pollMs: 1 } }),
          { ...w.deps, browse: run, ...(over.assist ? { assist: over.assist } : {}) });
        return { out, calls: b.calls };
      };

      // 1) 无标记：待确认中继后换租约恢复，只轮询到 MARKER_MISS_LIMIT。
      {
        const first = world({ extra: gitOk });
        let assistCalls = 0;
        const assist = async () => { assistCalls++; return { decision: 'reply' as const, message: '{"reachable":true}', toolExecuted: 'ops_health' }; };
        const a = devinBrowse({
          send: [{ ok: true, url: SESSION }],
          gate: [{ ok: true, code: 'sendable', cap: 'Free', seats: { used: 0, total: 2 } }],
          follow: [undefined],
          session: [waiting(REQUEST)],
        });
        await runLane(first.input({ provider: 'devin-cloud' }), { ...first.deps, browse: a.browse, assist });
        const relay = readLaneState(first.commDir)!.devin!.assistRelay!;
        const second = world({ extra: gitOk });
        const unseenTail = { ok: true, markerSeen: false, status: 'idle', done: null, tail: TAIL, url: SESSION, cap: 'Free' };
        const b = devinBrowse({ session: [unseenTail, unseenTail, unseenTail, unseenTail] });
        const out = await runLane(second.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
          env: { SCK_DELIVERY_ID: 'lease-marker-miss' } }), { ...second.deps, browse: b.browse, assist });
        expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
        expect(out.text).toContain('一直找不到本轮消息');
        expect(out.text).toContain(relay.marker);
        expect(assistCalls).toBe(1);
        expect(b.calls.filter(s => s.includes(MODE('follow')))).toHaveLength(0);
        expect(b.calls.filter(s => s.includes(MODE('send')))).toHaveLength(0);
        expect(SESSION_URLS(out.text)).toBe(false);
        expect(out.text).not.toContain(TAIL);
      }

      // 2) 地址不符：轮询回到别的合法会话，累计 wrong_session 后受阻。
      {
        const wrong = { ok: true, markerSeen: true, status: 'idle', done: null, tail: TAIL, url: OTHER, cap: 'Free' };
        const { out } = await pollTo([wrong, wrong, wrong, wrong]);
        expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
        expect(out.text).toContain('没能停在本轮轮询的会话地址上');
        expect(SESSION_URLS(out.text)).toBe(false);
        expect(out.text).not.toContain(TAIL);
      }

      // 3) 到时：会话一直在忙，超过配置时限。
      {
        const working = { ok: true, markerSeen: true, status: 'working', done: null, tail: TAIL, url: SESSION, cap: 'Free' };
        const { out } = await pollTo([working, working, working, working],
          { config: { maxMinutes: 1, pollMs: 1 }, advance: 30_000 });
        expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
        expect(out.text).toContain('超过配置时限');
        expect(SESSION_URLS(out.text)).toBe(false);
        expect(out.text).not.toContain(TAIL);
      }

      // 4) 无终稿：一直 idle 且带本轮标记却没有 SCK-DONE 终稿。
      {
        const noDone = { ok: true, markerSeen: true, status: 'idle', done: null, tail: TAIL, agentTail: TAIL, url: SESSION, cap: 'Free' };
        const { out } = await pollTo([noDone, noDone, noDone, noDone]);
        expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
        expect(out.text).toContain('没有按约定');
        expect(SESSION_URLS(out.text)).toBe(false);
        expect(out.text).not.toContain(TAIL);
      }

      // 5) 转人工：协助判定交老板，自由文本原因与页面尾部都不得出现在答复里。
      {
        const blockedSeen = { ok: true, markerSeen: true, status: 'blocked', done: null, tail: TAIL, agentTail: REQUEST, url: SESSION, cap: 'Free' };
        const { out } = await pollTo([blockedSeen, blockedSeen],
          { assist: async () => ({ decision: 'escalate' as const, reason: REASON }) });
        expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
        expect(out.text).toContain('本地协助转交老板裁决');
        expect(out.text).not.toContain(REASON);
        expect(SESSION_URLS(out.text)).toBe(false);
        expect(out.text).not.toContain(TAIL);
      }

      // 6) 转人工（无代跑能力）：只能请老板答复，不带会话 URL 与页面正文。
      {
        const blockedSeen = { ok: true, markerSeen: true, status: 'blocked', done: null, tail: TAIL, url: SESSION, cap: 'Free' };
        const { out } = await pollTo([blockedSeen, blockedSeen]);
        expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
        expect(out.text).toContain('需要老板在会话里答复');
        expect(SESSION_URLS(out.text)).toBe(false);
        expect(out.text).not.toContain(TAIL);
      }
    });
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
    expect(out.text).toContain('Devin 页面未登录');
    expect(out.text).not.toContain('app.devin.ai');
  });

  test('Devin 答复缺 SHA 行时补实际 HEAD', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [idleDone('完成。\nPR: https://github.com/acme/widget/pull/9')] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text).toContain('SHA: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  test('有 DONE 但无 PR 行：查询真实 OPEN PR 补齐 URL', async () => {
    const w = world({ extra: call => {
      if (call.cmd === 'gh' && call.args[0] === 'pr') return ok('[{"url":"https://github.com/acme/widget/pull/9"}]');
      return gitOk(call);
    } });
    const b = devinBrowse({ send: [{ ok: true, url: SESSION }], session: [idleDone('已经实现并测试。')] });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
    expect(out.text).toContain('SHA: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(w.callsOf(c => c.cmd === 'gh' && c.args[0] === 'pr')[0]?.args)
      .toEqual(['pr', 'list', '--repo', 'acme/widget', '--head', 'sck/task-1', '--state', 'open', '--json', 'url']);
  });

  test('idle 无 DONE/PR 行：仅远端确有新提交且有 OPEN PR 时按真实 HEAD 收尾', async () => {
    for (const scenario of ['done', 'no-commits', 'no-pr', 'local-ahead', 'fetch-failed', 'wrong-pr']) {
      const w = world({ extra: call => {
        if (call.cmd === 'git' && call.args[0] === 'rev-parse' && call.args[1] === 'FETCH_HEAD')
          return ok(scenario === 'local-ahead' ? 'a'.repeat(40) : 'deadbeef'.repeat(5));
        if (call.cmd === 'git' && call.args[0] === 'rev-list') return ok(scenario === 'no-commits' ? '0' : '2');
        if (call.cmd === 'git' && call.args[0] === 'fetch' && scenario === 'fetch-failed') return bad('offline');
        if (call.cmd === 'gh' && call.args[0] === 'pr')
          return ok(JSON.stringify(scenario === 'no-pr' ? [] : [{ url: `https://github.com/${scenario === 'wrong-pr' ? 'other/repo' : 'acme/widget'}/pull/9` }]));
        return gitOk(call);
      } });
      const b = devinBrowse({ send: [{ ok: true, url: SESSION }],
        session: [{ ok: true, markerSeen: true, status: 'idle', done: null, tail: '实现需求甲，测试通过。' }] });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
      expect(out.status).toBe('success');
      if (scenario === 'done') {
        expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
        expect(out.text).toContain(`SHA: ${'deadbeef'.repeat(5)}`);
        expect(out.text).toContain('实现需求甲');
        expect(readLaneState(w.commDir)?.taskId).toBeUndefined();
      } else {
        expect(out.text).toStartWith('工作结果：受阻');
        expect(readLaneState(w.commDir)?.taskId).toBeDefined();
      }
      expect(b.calls.filter(s => s.includes(MODE('session')))).toHaveLength(3);
    }
  });

  test('超时受阻后新 delivery/新目录重派：领养旧 taskId/taskUrl/submittedAt，零发送且结清旧登记', async () => {
    const first = world({ extra: gitOk });
    const a = devinBrowse({ send: [{ ok: true, url: SESSION }],
      session: [{ ok: true, markerSeen: true, status: 'working', done: null }] });
    const out1 = await runLane(first.input({ provider: 'devin-cloud', env: { SCK_DELIVERY_ID: 'lease-old' }, config: { maxMinutes: 1, pollMs: 1 } }),
      { ...first.deps, browse: async (script, timeout) => { const r = await a.browse(script, timeout); first.advance(40_000); return r; } });
    expect(out1.text).toStartWith('工作结果：受阻');
    const prior = readInflight(first.stateRoot, 'devin-cloud', 'lease-old')!;
    expect(prior.taskId).toBeDefined();
    expect(prior.taskUrl).toBe(SESSION);
    // 不同供应商发送不能被同任务结清清理误删。
    writeInflight(first.stateRoot, 'devin-cloud', 'unrelated-send',
      { ...prior, taskId: 'SCK-eeeeeeeeee', submittedAt: prior.submittedAt! - 1000 });
    const second = world({ extra: gitOk });
    const b = devinBrowse({ session: [idleDone(PR9)] });
    const out2 = await runLane(second.input({ provider: 'devin-cloud', stateRoot: first.stateRoot,
      env: { SCK_DELIVERY_ID: 'lease-new' }, prompt: '重派同一任务，取回成果。' }), {
      ...second.deps, browse: async (script, timeout) => {
        expect(script).toContain(prior.taskId!);
        expect(script).toContain(SESSION);
        return b.browse(script, timeout);
      },
    });
    expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/9');
    expect(b.calls.every(s => s.includes(MODE('session')))).toBe(true);
    expect(readInflight(first.stateRoot, 'devin-cloud', 'lease-old')).toBeUndefined();
    expect(readInflight(first.stateRoot, 'devin-cloud', 'lease-new')).toBeUndefined();
    expect(readInflight(first.stateRoot, 'devin-cloud', 'unrelated-send')?.taskId).toBe('SCK-eeeeeeeeee');
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

  test('状态 unknown 的答复不收尾：超时按受阻回合（保留会话地址，不丢成无输出错误），不拉取分支', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true }],
      session: [{ ok: true, markerSeen: true, status: 'unknown', done: '残留答复\nPR: https://github.com/acme/widget/pull/9', tail: '' }],
    });
    const browse = (async (script: string, t: number) => { const r = await b.browse(script, t); w.advance(30_000); return r; }) as typeof b.browse;
    const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1, maxMinutes: 1 } }), { ...w.deps, browse });
    // status 一直不是 idle：即使 done 有残留文字也不收尾（不拉分支）；但会话已受理，超时按受阻收尾，不是裸错误。
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(out.text).toContain('超过配置时限');
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(0);
  });

  test('空闲却没有本轮 SCK-DONE 终稿：客观证据不足仍受阻', async () => {
    const w = world({ extra: gitOk });
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true }],
      session: [{ ok: true, markerSeen: true, status: 'idle', done: null, tail: '完成了但没写标记' }],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    expect(b.calls.filter(s => s.includes(MODE('session')))).toHaveLength(3);
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(1);
    expect(readLaneState(w.commDir)?.taskId).toBeDefined();
  });

  test('工具输出含 DONE/PR、助手没有终稿（mock）：不以工具输出代替客观证据', async () => {
    const w = world({ extra: gitOk });
    const toolTail = '工具输出：\n[SCK-DONE SCK-tool-only]\nPR: https://github.com/acme/widget/pull/1\n提交：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nDevin is awaiting instructions';
    const b = devinBrowse({
      send: [{ ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true }],
      session: [{ ok: true, markerSeen: true, status: 'idle', done: null, tail: toolTail }],
    });
    const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: b.browse });
    expect(out.status).toBe('success');
    expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
    // 可以探测远端，但工具输出中的 PR 不足以代替真实远端 HEAD 与 OPEN PR。
    expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(1);
    expect(readLaneState(w.commDir)?.taskId).toBeDefined();
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

    test('续轮发送后页面停在另一个合法会话（同一轮标记块仍在）：受理回执核验地址，回 not_echoed 而不误报已受理（脚本真实执行，合成负例）', async () => {
      const { devinFollowScript } = await import('../src/runner/cloud-lane/devin-web.ts');
      const marker = 'SCK-abc123';
      const msg = `[SCK-ROUND ${marker}]\n\n继续修复。\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE ${marker}]」单独成行开头，随后是完整最终答复。`;
      // 发送本身落在原会话；发送后把页面挪到另一个合法会话，并在那页也摆上本轮同标记的用户/Devin 块——
      // 光看转录内容分不出这不是本轮轮询的会话，必须靠地址核验。
      let fake: ReturnType<typeof fakeDevin>;
      fake = fakeDevin({
        seats: { used: 0, total: 2 },
        sessions: {
          [SESSION]: OLD_ROUND,
          [OTHER]: { cap: 'Free', status: 'Devin is awaiting instructions', blocks: [
            { role: 'user', text: msg },
            { role: 'devin', text: `[SCK-DONE ${marker}]\n${PR9}` },
          ] },
        },
        onSend: () => { fake.st.url = OTHER; },
      });
      const r = await fake.browse(devinFollowScript(SESSION, marker, msg));
      expect(r).toMatchObject({ ok: false, code: 'not_echoed', url: OTHER });
      expect(r?.done).toBeUndefined();
      expect(fake.st.sent).toHaveLength(1);
      expect(fake.st.sent[0]!.url).toBe(SESSION);

      // 对照组：同样发送后仍停在原会话时，照常回 ok 与已受理（证明地址核验不是把所有续轮回执都拒掉）。
      const okFake = fakeDevin({ seats: { used: 0, total: 2 }, sessions: { [SESSION]: OLD_ROUND }, onSend: answer(PR9) });
      const r2 = await okFake.browse(devinFollowScript(SESSION, marker, msg));
      expect(r2).toMatchObject({ ok: true, url: SESSION, echoed: true });
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

    test('真实页面脚本 + 驱动层负例：工具输出含 DONE 与 PR 但客观证据不足 → 仍受阻，只发送一次', async () => {
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
      expect(w.callsOf(c => c.cmd === 'git' && c.args[0] === 'fetch')).toHaveLength(1);
      expect(readLaneState(w.commDir)?.taskId).toBeDefined();
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

    test('假设 A（程序化点击不开菜单，未证实）下新会话：指针打开 Capability、指针点 Free、回读后两次 Escape 收起，再填写与发送；没有程序化点击', async () => {
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
      expect(out.text).toContain('Devin 页面未能确认选中 Free 档位或席位计数');
      expect(out.text).not.toContain('无法确定哪个是 Capability');
      expect(fake.st.events.filter(e => e.startsWith('pointer') || e.startsWith('js'))).toEqual([]);
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.sent).toHaveLength(0);
    });

    test('菜单里有两个 Free 行：无法确定点哪个，不点 Free，有界重试后受阻，零发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ duplicateFreeRow: true, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('Devin 页面未能确认选中 Free 档位或席位计数');
      expect(out.text).not.toContain('2 个 Free 行');
      expect(fake.st.events.filter(e => e.startsWith('pointer') && e !== 'pointer cap')).toEqual([]);
      expect(fake.st.events.filter(e => e.startsWith('js'))).toEqual([]);
      expect(fake.st.sent).toHaveLength(0);
    });

    test('指针点 Free 行没有生效（按钮仍是 Normal）：回读确认不了 Free，零发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ freeRowInert: true, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('Devin 页面未能确认选中 Free 档位或席位计数');
      expect(out.text).not.toContain('按钮=Normal');
      expect(fake.st.events).toContain('pointer Free');
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.sent).toHaveLength(0);
    });

    test('Escape 一直收不起菜单（两层都挡着输入区）：按有界次数后受阻，不填写、不发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ escapeInert: true, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('Devin 页面未能确认选中 Free 档位或席位计数');
      expect(out.text).not.toContain('按 Escape 后仍挡着页面');
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

    // 下面两条只看结果，不检查点击方式（点击方式由假设 A 那条负责）：它们用来分开「点击开不开菜单」与「行定位漏 Free」。
    test('假设 B（程序化点击能开菜单，未证实）+ 旧选择器认得的普通 Free 行（对照）：选中 Free 并发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ programmaticCapOpens: true, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(out.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(fake.st.sent).toHaveLength(1);
    });

    test('假设 B（程序化点击能开菜单，未证实）+ 行定位（合成兼容：Free 行只有 role=menuitem，标签未知，span 只是代表）：旧选择器认不出这一行，新版按 role 认出、指针点中并发送', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ programmaticCapOpens: true, menuItemRows: true, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.status).toBe('success');
      expect(fake.st.events).toContain('pointer Free');
      expect(fake.st.sent).toHaveLength(1);
    });

    test('指针点 Capability 也打不开菜单：不点 Free、不改用程序化点击、零发送，受阻', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ noMenu: true, seats: { used: 0, total: 2 } });
      const out = await runLane(w.input({ provider: 'devin-cloud' }), { ...w.deps, browse: fake.browse });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('Devin 页面未能确认选中 Free 档位或席位计数');
      expect(out.text).not.toContain('菜单里没有可见的 Free 行');
      expect(fake.st.events.filter(e => e.startsWith('pointer') && e !== 'pointer cap')).toEqual([]);
      expect(fake.st.events.filter(e => e.startsWith('js'))).toEqual([]);
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.sent).toHaveLength(0);
    });

    test('新会话：选中 Free 但详情没有 powered by SWE-2（不是 SWE-2 Free）→ 零填写零发送，受阻', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ noPowered: true, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1, maxMinutes: 1 } }),
        { ...w.deps, browse: advancing(w, fake.browse) });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('Devin 页面未能确认选中 Free 档位或席位计数');
      expect(out.text).not.toContain('powered=false');
      expect(fake.st.events).toContain('pointer Free');
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.events).not.toContain('__PRESSED__');
      expect(fake.st.sent).toHaveLength(0);
    });

    test('新会话：选中 Free、powered 都有，但读不到席位计数 → 零填写零发送，受阻', async () => {
      const w = world({ extra: gitOk });
      const fake = fakeDevin({ noSeats: true, seats: { used: 0, total: 2 }, onSend: answer(PR9) });
      const out = await runLane(w.input({ provider: 'devin-cloud', config: { pollMs: 1, maxMinutes: 1 } }),
        { ...w.deps, browse: advancing(w, fake.browse) });
      expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out.text).toContain('Devin 页面未能确认选中 Free 档位或席位计数');
      expect(out.text).not.toContain('读不到 Free 席位计数');
      expect(fake.st.events).not.toContain('fill');
      expect(fake.st.events).not.toContain('__PRESSED__');
      expect(fake.st.sent).toHaveLength(0);
    });

    test('续轮：首页选中 Free 后 powered 或席位读不到 → 不填写、不发送，受阻', async () => {
      for (const flag of [{ noPowered: true }, { noSeats: true }] as const) {
        const w = world({ extra: gitOk });
        writeLaneState(w.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
        const fake = fakeDevin({ ...flag, seats: { used: 1, total: 2 }, sessions: { [SESSION]: OLD_ROUND }, onSend: answer(PR9) });
        const out = await runLane(w.input({ provider: 'devin-cloud', prompt: '继续修复。', config: { pollMs: 1, maxMinutes: 1 } }),
          { ...w.deps, browse: advancing(w, fake.browse) });
        const home = fake.st.events.indexOf(`visit ${HOME}`);
        expect(home).toBeGreaterThan(-1);
        expect(out.text.split('\n')[0]).toBe('工作结果：受阻');
        expect(out.text).toContain('Devin 页面未能确认选中 Free 档位或席位计数');
        expect(out.text).not.toContain('powered=false');
        expect(out.text).not.toContain('读不到 Free 席位计数');
        expect(fake.st.events.slice(home)).toContain('pointer Free');
        expect(fake.st.events).not.toContain('fill');
        expect(fake.st.sent).toHaveLength(0);
      }
    });
  });

  test('派工提示：devin-cloud 代码轮写明同会话可换仓库、以本轮仓库与分支为准；不一致时先找到或复用本轮仓库的正确工作树，取不到才受阻；PR 只开在本轮仓库；复核轮与其它通道不带这一段', () => {
    const repo = { slug: 'acme/widget', branch: 'sck/task-1', defaultBranch: 'main' } as never;
    const code = vendorPrompt({ provider: 'devin-cloud', prompt: '做事' } as never, repo, { task: '实现需求甲。', review: false } as never);
    expect(code).toContain('同一个供应商会话可以先后处理不同仓库，但以本轮为准：仓库 acme/widget、分支 sck/task-1。');
    expect(code).toContain('写文件或提交前，核对当前工作树的 origin 远端与当前分支是否与本轮一致');
    expect(code).toContain('不一致时，先找到、克隆或复用本轮仓库 acme/widget 的正确任务工作树，核对它的 origin 与分支 sck/task-1 一致后再继续；只有取不到正确工作树时，才以「工作结果：受阻」收尾');
    expect(code).not.toContain('不一致就停下');
    expect(code).toContain('最终 PR 只开在本轮仓库 acme/widget，head 为本轮分支 sck/task-1，目标分支 main。');
    // 仓库、分支、目标分支都从本轮字段取值，换一组字段就换一组文字，不写死任何仓库名。
    const other = vendorPrompt({ provider: 'devin-cloud', prompt: '做事' } as never,
      { slug: 'other-org/other-repo', branch: 'feat/x', defaultBranch: 'dev' } as never, { task: '实现需求甲。', review: false } as never);
    expect(other).toContain('仓库 other-org/other-repo、分支 feat/x。');
    expect(other).toContain('最终 PR 只开在本轮仓库 other-org/other-repo，head 为本轮分支 feat/x，目标分支 dev。');
    expect(other).not.toContain('acme/widget');
    expect(code.indexOf('同一个供应商会话')).toBeLessThan(code.indexOf('实现需求甲。'));
    expect(code.endsWith('实现需求甲。')).toBe(true);
    expect(vendorPrompt({ provider: 'devin-cloud', prompt: '做事' } as never, repo, { task: '复核', review: true } as never))
      .not.toContain('同一个供应商会话');
    for (const provider of ['codex-cloud', 'jules'] as const)
      expect(vendorPrompt({ provider, prompt: '做事' } as never, repo, { task: '实现需求甲。', review: false } as never))
        .not.toContain('同一个供应商会话');
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

    test('已受理后重启/换员工目录，真实虚拟化 DOM 下仍零重发取回终稿（需求 2：续接走的是这次修复影响的同一条真实读取路径，不是另一套纯状态 mock）', async () => {
      const w1 = world({ task, extra: gitOk });
      writeLaneState(w1.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const a = (async (script: string) => {
        if (script.includes(MODE('follow'))) return { ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true };
        throw new Error('bridge killed while polling');
      }) as NonNullable<LaneDeps['browse']>;
      await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: a });
      expect(readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, FOLLOW))?.taskUrl).toBe(SESSION);

      // 换员工目录/进程重启后的第二个驱动：不是 devinBrowse 纯状态 mock，而是真的执行 devin-web.ts 生成的脚本，
      // 对着一个与「本轮用户消息被虚拟化滚出 DOM」描述块同构的假页面（常驻只剩 Devin 作者块，本轮用户锚点要
      // 滚动到顶才挂载得出来）——证明续接复用走的正是这次有界滚动恢复修复影响的那条真实读取路径，不是另一条
      // 从来不受虚拟化影响的假路径；且全程只跑会话轮询脚本，一次发送/续轮/找回脚本都不该跑到。
      type Blk = { author: 'user' | 'devin' | 'tool'; text: string };
      // SHA 用 gitOk 假路由里 `git rev-parse HEAD` 会报的那个真实值：收尾会拿 Devin 自报的 SHA 核对实际
      // git HEAD，不一致时改写成实际值并附注说明——这里让两者一致，专注验证虚拟化 DOM 读取与零重发，不节外生枝
      // 到 SHA 核对这条无关分支。
      const DONE_TEXT = '完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      const g = globalThis as unknown as Record<string, unknown>;
      const sendLikeCalls: string[] = [];
      const b2 = (async (script: string) => {
        if (script.includes(MODE('send')) || script.includes(MODE('follow')) || script.includes(MODE('recover'))) {
          sendLikeCalls.push(script);
          throw new Error('不该走到这里：已受理会话续接不应该再发送/再找新会话');
        }
        const marker = /\[SCK-ROUND (SCK-[0-9a-f]+)\]/.exec(script)?.[1] ?? 'SCK-none';
        const userBlock: Blk = { author: 'user', text: `[SCK-ROUND ${marker}]\n\n任务\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE ${marker}]」单独成行开头，随后是完整最终答复。` };
        const devinBlock1: Blk = { author: 'devin', text: '已读取仓库现状，开始核对工单。' };
        const devinBlock2: Blk = { author: 'devin', text: `[SCK-DONE ${marker}]\n${DONE_TEXT}` };
        const mounted: Blk[] = [devinBlock1, devinBlock2];
        const atTopBlocks: Blk[] = [userBlock, devinBlock1, devinBlock2];
        let scrolledTop = false;
        const scroller = { scrollHeight: 2107, clientHeight: 713, _top: 1394,
          get scrollTop() { return this._top; }, set scrollTop(v: number) { this._top = v; scrolledTop = v === 0; } };
        const current = () => (scrolledTop ? atTopBlocks : mounted);
        // 状态短语只挂在滚动前（自然/常驻）那次快照上，和「本轮用户消息被虚拟化滚出 DOM」描述块里 readScrolled
        // 的默认约定一致：恢复阶段临时滚到顶那次快照不带它，判定不会错误地采用那次快照。
        const text = () => [...current().map(b => b.text), ...(scrolledTop ? [] : ['Devin is awaiting instructions'])].join('\n');
        const mkEl = (b: Blk) => ({ getAttribute: (n: string) => (n === 'data-message-author' ? b.author : null), innerText: b.text, parentElement: scroller });
        const doc = {
          documentElement: {},
          get body() { return { innerText: text() }; },
          querySelector: (sel: string) => (sel === 'main' ? { innerText: text() }
            : sel === '[data-sck-cap-trigger]' ? null
            : sel === '[data-message-author]' ? (current().filter(x => x.author !== 'tool').map(mkEl)[0] ?? null)
            : {}),
          querySelectorAll: (sel: string) => (sel === '[data-message-author]' ? current().filter(x => x.author !== 'tool').map(mkEl) : sel === '[role=menu]' ? [] : [{ innerText: 'Free' }]),
        };
        const page = {
          goto: async () => {}, waitForTimeout: async () => {},
          evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
            g.document = doc; g.location = { href: SESSION, hostname: 'app.devin.ai' };
            return fn(arg);
          },
        };
        let result: Record<string, unknown> | undefined;
        const fakeConsole = { log: (line: string) => { if (line.startsWith('__RESULT__')) result = JSON.parse(line.slice('__RESULT__'.length)); } };
        const run = new Function('taskSpace', 'console', 'process', `return (async () => {${script}})()`);
        try {
          await run(async () => ({ pages: async () => [page] }), fakeConsole, { exit() { throw new Error('unexpected exit'); } });
        } catch (error) {
          if (result === undefined) throw error;
        } finally {
          delete g.document; delete g.location;
        }
        return result;
      }) as NonNullable<LaneDeps['browse']>;

      const w2 = world({ task, extra: gitOk });
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: FOLLOW, stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2 });
      expect(out2.status).toBe('success');
      expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/9');
      expect(out2.text).toContain('SHA: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      expect(sendLikeCalls).toHaveLength(0);
    });

    test('已受理后转录很长，本轮用户锚点要滚到中段检查点才挂载：有界多检查点遍历命中中段、零重发取回终稿（需求 2 的合成正例——顶部挂载的是更早轮次、自然位置只有本轮 Devin 回复没有用户块，与下面"一直找不到"反例同构；只有算出来的那个中段检查点才挂载本轮用户锚点，证明多检查点遍历真的会系统地试到中段并在那里命中，不是只有顶部命中才算数。真实 DOM 从未采样过中段命中，这里用标明为合成的夹具证明算法本身确有这个能力，不是文档空话）', async () => {
      const w1 = world({ task, extra: gitOk });
      writeLaneState(w1.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const a = (async (script: string) => {
        if (script.includes(MODE('follow'))) return { ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true };
        throw new Error('bridge killed while polling');
      }) as NonNullable<LaneDeps['browse']>;
      await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: a });
      expect(readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, FOLLOW))?.taskUrl).toBe(SESSION);

      type Blk = { author: 'user' | 'devin' | 'tool'; text: string };
      const DONE_TEXT = '完成。\nPR: https://github.com/acme/widget/pull/42\nSHA: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      const sendLikeCalls: string[] = [];
      // 和 devin-web.ts 的 SCROLL_RECOVER_POINTS=5 公式算同一个中段检查点的 scrollTop 值：0、
      // maxTop/4、maxTop*2/4（中段，即这里要命中的那个）、maxTop*3/4、maxTop。写死在测试里而不是导入
      // 实现常量——这正是要白盒验证"算法确实会滚到这个具体位置"；公式一旦改了检查点间距，这里会因为
      // 再也滚不到 MID_TOP 而失败，不会假装通过。
      const SCROLL_HEIGHT = 2107, CLIENT_HEIGHT = 713, POINTS = 5;
      const MAX_TOP = SCROLL_HEIGHT - CLIENT_HEIGHT;
      const MID_TOP = Math.round((MAX_TOP * 2) / (POINTS - 1));
      const b2 = (async (script: string) => {
        if (script.includes(MODE('send')) || script.includes(MODE('follow')) || script.includes(MODE('recover'))) {
          sendLikeCalls.push(script);
          throw new Error('不该走到这里：已受理会话续接不应该再发送/再找新会话');
        }
        const marker = /\[SCK-ROUND (SCK-[0-9a-f]+)\]/.exec(script)?.[1] ?? 'SCK-none';
        const round1User: Blk = { author: 'user', text: '[SCK-ROUND SCK-old111]\n\n第一轮\n\n收尾约定：「[SCK-DONE SCK-old111]」。' };
        const round1Devin: Blk = { author: 'devin', text: '[SCK-DONE SCK-old111]\n第一轮完成。' };
        const myUser: Blk = { author: 'user', text: `[SCK-ROUND ${marker}]\n\n本轮\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE ${marker}]」单独成行开头，随后是完整最终答复。` };
        const myDevin: Blk = { author: 'devin', text: `[SCK-DONE ${marker}]\n${DONE_TEXT}` };
        // 自然（常驻）位置只挂载本轮 Devin 回复、没有用户块——与"15eaf1b8 真实事故"同一种虚拟化缺口
        // （真实采样证实过的那种形态），只是这里嵌在更长的转录里；绝对顶部挂载的是更早的第一轮（不是
        // 本轮）；只有 MID_TOP 这一个中段检查点才挂载本轮用户块。
        const bucketAt = (top: number): Blk[] => (top === 0 ? [round1User, round1Devin]
          : top === MID_TOP ? [myUser, myDevin]
          : [myDevin]);
        const scroller = { scrollHeight: SCROLL_HEIGHT, clientHeight: CLIENT_HEIGHT, _top: MAX_TOP,
          get scrollTop() { return this._top; }, set scrollTop(v: number) { this._top = v; } };
        const current = () => bucketAt(scroller.scrollTop);
        // 状态短语只挂在自然/常驻快照上（与"本轮用户消息被虚拟化滚出 DOM"描述块同一约定）：恢复阶段任何
        // 检查点临时滚动的快照都不带它，判定不会错误地借用它们。
        const text = () => [...current().map(b => b.text), ...(scroller.scrollTop === MAX_TOP ? ['Devin is awaiting instructions'] : [])].join('\n');
        const mkEl = (b: Blk) => ({ getAttribute: (n: string) => (n === 'data-message-author' ? b.author : null), innerText: b.text, parentElement: scroller });
        const doc = {
          documentElement: {},
          get body() { return { innerText: text() }; },
          querySelector: (sel: string) => (sel === 'main' ? { innerText: text() }
            : sel === '[data-sck-cap-trigger]' ? null
            : sel === '[data-message-author]' ? (current().filter(x => x.author !== 'tool').map(mkEl)[0] ?? null)
            : {}),
          querySelectorAll: (sel: string) => (sel === '[data-message-author]' ? current().filter(x => x.author !== 'tool').map(mkEl) : sel === '[role=menu]' ? [] : [{ innerText: 'Free' }]),
        };
        const page = {
          goto: async () => {}, waitForTimeout: async () => {},
          evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
            g.document = doc; g.location = { href: SESSION, hostname: 'app.devin.ai' };
            return fn(arg);
          },
        };
        let result: Record<string, unknown> | undefined;
        const fakeConsole = { log: (line: string) => { if (line.startsWith('__RESULT__')) result = JSON.parse(line.slice('__RESULT__'.length)); } };
        const run = new Function('taskSpace', 'console', 'process', `return (async () => {${script}})()`);
        try {
          await run(async () => ({ pages: async () => [page] }), fakeConsole, { exit() { throw new Error('unexpected exit'); } });
        } catch (error) {
          if (result === undefined) throw error;
        } finally {
          delete g.document; delete g.location;
        }
        return result;
      }) as NonNullable<LaneDeps['browse']>;

      const w2 = world({ task, extra: gitOk });
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: FOLLOW, stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2 });
      expect(out2.status).toBe('success');
      expect(out2.text).toContain('PR: https://github.com/acme/widget/pull/42');
      expect(out2.text).toContain('SHA: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      expect(sendLikeCalls).toHaveLength(0);
    });

    test('已受理后转录很长，本轮用户锚点真的不在任何检查点上：多检查点遍历全部落空仍不误判已受理，保持受阻并保留会话地址（需求 2 的反例对照——证明上面那条"中段检查点命中"的正例不是把"找不到就放弃"放宽成"随便找到点什么就算数"，遍历确实耗尽、安全兜底依然成立）', async () => {
      const w1 = world({ task, extra: gitOk });
      writeLaneState(w1.commDir, { sessionId: 'lane-1', digest: 'old-digest', vendorSession: SESSION, branch: 'sck/task-1' });
      const a = (async (script: string) => {
        if (script.includes(MODE('follow'))) return { ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true };
        throw new Error('bridge killed while polling');
      }) as NonNullable<LaneDeps['browse']>;
      await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: a });
      expect(readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, FOLLOW))?.taskUrl).toBe(SESSION);

      // 本轮是第 N 轮续轮，本轮用户消息是转录里最新内容，自然位置停在更早的第二轮（不是本轮），绝对顶部
      // 只露出更早的第一轮（更不是本轮）——这个二值 mock（只分顶部/非顶部两种内容）意味着 SCROLL_RECOVER_POINTS
      // 个检查点里，除了 p=0（顶部）之外全部落在"非顶部"桶，统统是第二轮，全程找不到本轮标记，是真的遍历
      // 耗尽，不是只试了一次就放弃。断言的是安全兜底：不静默、不误判已受理、不重发，受阻文本保留会话地址，
      // 与 devin.ts 里已有的"转录里一直看不到本轮标记"驱动层测试（纯状态 mock）同一结论，这里走的是真实
      // devin-web.ts 生成脚本在假页面里执行的那条路径，不是另一套纯状态 mock。
      type Blk = { author: 'user' | 'devin' | 'tool'; text: string };
      const sendLikeCalls: string[] = [];
      const b2 = (async (script: string) => {
        if (script.includes(MODE('send')) || script.includes(MODE('follow')) || script.includes(MODE('recover'))) {
          sendLikeCalls.push(script);
          throw new Error('不该走到这里：找不到本轮锚点时只受阻，绝不重发或新建会话');
        }
        const round2User: Blk = { author: 'user', text: '[SCK-ROUND SCK-old222]\n\n第二轮\n\n收尾约定：「[SCK-DONE SCK-old222]」。' };
        const round2Devin: Blk = { author: 'devin', text: '[SCK-DONE SCK-old222]\n第二轮完成。' };
        const round1User: Blk = { author: 'user', text: '[SCK-ROUND SCK-old111]\n\n第一轮\n\n收尾约定：「[SCK-DONE SCK-old111]」。' };
        const round1Devin: Blk = { author: 'devin', text: '[SCK-DONE SCK-old111]\n第一轮完成。' };
        // 自然（常驻）位置停在第二轮；滚到顶只会露出第一轮——本轮（marker）两处都不在，模拟锚点在底部/中段。
        const mounted: Blk[] = [round2User, round2Devin];
        const atTopBlocks: Blk[] = [round1User, round1Devin];
        let scrolledTop = false;
        const scroller = { scrollHeight: 2107, clientHeight: 713, _top: 1394,
          get scrollTop() { return this._top; }, set scrollTop(v: number) { this._top = v; scrolledTop = v === 0; } };
        const current = () => (scrolledTop ? atTopBlocks : mounted);
        const text = () => current().map(b => b.text).join('\n');
        const mkEl = (b: Blk) => ({ getAttribute: (n: string) => (n === 'data-message-author' ? b.author : null), innerText: b.text, parentElement: scroller });
        const doc = {
          documentElement: {},
          get body() { return { innerText: text() }; },
          querySelector: (sel: string) => (sel === 'main' ? { innerText: text() }
            : sel === '[data-sck-cap-trigger]' ? null
            : sel === '[data-message-author]' ? (current().filter(x => x.author !== 'tool').map(mkEl)[0] ?? null)
            : {}),
          querySelectorAll: (sel: string) => (sel === '[data-message-author]' ? current().filter(x => x.author !== 'tool').map(mkEl) : sel === '[role=menu]' ? [] : [{ innerText: 'Free' }]),
        };
        const page = {
          goto: async () => {}, waitForTimeout: async () => {},
          evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
            g.document = doc; g.location = { href: SESSION, hostname: 'app.devin.ai' };
            return fn(arg);
          },
        };
        let result: Record<string, unknown> | undefined;
        const fakeConsole = { log: (line: string) => { if (line.startsWith('__RESULT__')) result = JSON.parse(line.slice('__RESULT__'.length)); } };
        const run = new Function('taskSpace', 'console', 'process', `return (async () => {${script}})()`);
        try {
          await run(async () => ({ pages: async () => [page] }), fakeConsole, { exit() { throw new Error('unexpected exit'); } });
        } catch (error) {
          if (result === undefined) throw error;
        } finally {
          delete g.document; delete g.location;
        }
        return result;
      }) as NonNullable<LaneDeps['browse']>;

      const w2 = world({ task, extra: gitOk });
      const out2 = await runLane(w2.input({ provider: 'devin-cloud', prompt: FOLLOW, stateRoot: w1.stateRoot }), { ...w2.deps, browse: b2 });
      expect(out2.status).toBe('success');
      expect(out2.text.split('\n')[0]).toBe('工作结果：受阻');
      expect(out2.text).toContain('一直找不到本轮消息');
      expect(out2.text).toContain('未重发');
      expect(out2.text).not.toContain(SESSION);
      expect(sendLikeCalls).toHaveLength(0);
      const st = readLaneState(w2.commDir);
      expect(st?.taskUrl).toBe(SESSION);
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

    test('有 findings 的返工重派：仍在途的旧会话只复用地址，发返工跟进而非领养旧终稿', async () => {
      const w1 = world({ task, extra: gitOk });
      const a = (async (script: string) => {
        if (script.includes(MODE('send'))) return { ok: true, url: SESSION, cap: 'Free', seats: { used: 0, total: 2 }, echoed: true };
        throw new Error('bridge killed while polling');
      }) as NonNullable<LaneDeps['browse']>;
      await runLane(w1.input({ provider: 'devin-cloud', prompt: FOLLOW }), { ...w1.deps, browse: a });
      expect(readInflight(w1.stateRoot, 'devin-cloud', digestOf(w1, FOLLOW))?.taskUrl).toBe(SESSION);

      const w2 = world({ task, extra: gitOk });
      mkdirSync(join(w2.commDir, 'findings'));
      writeFileSync(join(w2.commDir, 'findings', 'round-01.md'), '补上失败用例。');
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
    /** href 默认等于 devinSessionScript 轮询的目标会话（SESSION）；传别的地址用于模拟 goto 失败被吞、停在另一个会话。 */
    const runPage = async (doc: Record<string, unknown>, marker = M, href = SESSION) => {
      const { devinSessionScript } = await import('../src/runner/cloud-lane/devin-web.ts');
      const page = {
        goto: async () => {}, waitForTimeout: async () => {},
        evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
          g.document = doc;
          g.location = { href, hostname: 'app.devin.ai' };
          return fn(arg);
        },
      };
      let result: Record<string, unknown> | undefined;
      const fakeConsole = { log: (line: string) => { if (line.startsWith('__RESULT__')) result = JSON.parse(line.slice('__RESULT__'.length)); } };
      const run = new Function('taskSpace', 'console', 'process', `return (async () => {${devinSessionScript(SESSION, marker)}})()`);
      try {
        // emit() 后紧跟 process.exit(0) 是真实脚本里每条早退码（login_required/not_ready/wrong_session……）
        // 共用的正常收尾写法：已经拿到回执（result 已被 emit 写入）时的 exit 不算测试异常，按正常提前返回处理；
        // 没有任何回执就退出才是真的「意外退出」，继续往外抛，不吞掉。
        await run(async () => ({ pages: async () => [page] }), fakeConsole, { exit() { throw new Error('unexpected exit'); } });
      } catch (error) {
        if (result === undefined) throw error;
      } finally {
        delete g.document;
        delete g.location;
      }
      return result;
    };
    const readPage = async (blocks: Block[], rest = '', marker = M, href = SESSION) => {
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
      return runPage(doc, marker, href);
    };

    test('代跑来源只含本轮用户锚点之后的 Devin 作者块：旧轮/用户/工具输出不进 agentTail', async () => {
      const OLD = 'SCK-old999';
      const blocks: Block[] = [
        { author: 'user', text: `[SCK-ROUND ${OLD}]\n\n上一轮\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE ${OLD}]」单独成行开头。` },
        { author: 'devin', text: '上一轮：旧请求 [OPS-REQUEST] {"tool":"ops_login","args":{"alias":"OLD"}}' },
        { author: 'user', text: `[SCK-ROUND ${M}]\n\n本轮\n\n${CONV}` },
        { author: 'devin', text: '本轮：需要健康度 [OPS-REQUEST] {"tool":"ops_health","args":{}}' },
        { author: 'tool', text: '工具输出：[OPS-REQUEST] {"tool":"ops_account_ensure","args":{"alias":"TOOL"}}' },
      ];
      const r = await readPage(blocks, 'user 正文：[OPS-REQUEST] {"tool":"ops_workspace_ensure","args":{}}');
      expect(r).toMatchObject({ ok: true, markerSeen: true });
      const agentTail = String(r?.agentTail ?? '');
      expect(agentTail).toContain('ops_health');
      expect(agentTail).not.toContain('ops_login');
      expect(agentTail).not.toContain('ops_account_ensure');
      expect(agentTail).not.toContain('ops_workspace_ensure');
      expect(agentTail).not.toContain('SCK-old999');
    });

    test('没有本轮用户锚点时 agentTail 为空（标记只出现在工具输出/旧轮不算）', async () => {
      const r = await readPage(
        [{ author: 'user', text: '[SCK-ROUND SCK-old999]\n\n上一轮' }, { author: 'devin', text: '上一轮答复' }],
        `工具输出：[SCK-ROUND ${M}]\n[OPS-REQUEST] {"tool":"ops_health","args":{}}`,
      );
      expect(r?.markerSeen).toBe(false);
      expect(r?.agentTail).toBe('');
    });

    test('等待指示 + 本轮作者块里的显式请求：页面读出 idle/Free 并只把本轮请求放进 agentTail（旧轮请求不进）', async () => {
      const OLD = 'SCK-old999';
      const r = await readPage([
        { author: 'user', text: `[SCK-ROUND ${OLD}]\n\n上一轮\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE ${OLD}]」单独成行开头。` },
        { author: 'devin', text: '旧轮请求 [OPS-REQUEST] {"tool":"ops_login","args":{"alias":"OLD"}}' },
        { author: 'user', text: `[SCK-ROUND ${M}]\n\n本轮\n\n${CONV}` },
        { author: 'devin', text: '需要先确认健康度\n[OPS-REQUEST] {"tool":"ops_health","args":{}}' },
      ], 'Devin is awaiting instructions');
      expect(r).toMatchObject({ ok: true, markerSeen: true, status: 'idle', cap: 'Free' });
      expect(r?.done).toBeNull();
      expect(String(r?.agentTail)).toContain('ops_health');
      expect(String(r?.agentTail)).not.toContain('ops_login');
    });

    test('请求只出现在用户正文或工具输出（作者不是 Devin）：agentTail 为空，不代跑', async () => {
      const r = await readPage([
        { author: 'user', text: `[SCK-ROUND ${M}]\n\n本轮\n\n${CONV}\n[OPS-REQUEST] {"tool":"ops_health","args":{}}` },
        { author: 'tool', text: '工具输出：[OPS-REQUEST] {"tool":"ops_health","args":{}}' },
      ], 'Devin is awaiting instructions');
      expect(r).toMatchObject({ ok: true, markerSeen: true, status: 'idle' });
      expect(r?.agentTail).toBe('');
    });

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

    describe('本轮用户消息被虚拟化滚出 DOM（15eaf1b8 真实事故回归：有界滚动恢复转录上下文）', () => {
      /**
       * DOM 形态与数值取自负责人 2026-11-17 的真实只读采样（非本任务采集，路径见下）：
       * - free-delivery-closeout-dom-structure.json：常驻（未滚动）状态下 devinAuthorBlocks=2、userAuthorBlocks=0。
       * - free-delivery-closeout-scroll-probe.json：同一会话把转录容器 scrollTop 设为 0 后
       *   userAuthorBlocks=1、devinAuthorBlocks 仍是 2；还原 scrollTop 后又变回 userAuthorBlocks=0——证明内容
       *   还在只是没挂载，且这个过程可逆。
       * - free-delivery-closeout-dom-evidence.json 的 lastDevinBlockText：真实业务 15eaf1b8 的终稿
       *   （会话 51eb95d7616a41a081da5648192a1c7d、标记 SCK-b7c92fe64c、PR255、SHA 107222e5...）。
       *   REAL_DONE_BODY 是这段终稿的压缩摘录（保留标记行、PR、SHA 等判定要用到的字段），不是逐字原文。
       * 用户块（REAL_USER）的具体文字是合成重建：证据文件只采样了它在/不在 DOM 里的计数，没有采样其原文，
       * 这里按已知的标记与收尾约定格式重建，足以驱动 roundStart 的锚点匹配。
       * readScrolled 模拟这套虚拟化：mountedAtRest 是常驻（底部）时渲染的作者块，allBlocks 是滚动容器
       * scrollTop 归零后真实挂载出来的完整作者块集合；withScroller=false 时不给任何元素挂可滚动的
       * parentElement，等价于「找不到可滚动祖先」——这时 devin-web.ts 的恢复分支整段跳过，落回与本次修复前
       * （以及任何更早版本，因为它们从未尝试过这道恢复）完全相同的公式，可以直接当「修前」对照用，不需要
       * 另外跑一份旧代码。
       */
      const REAL_MARKER = 'SCK-b7c92fe64c';
      const REAL_DONE_BODY = '[SCK-DONE SCK-b7c92fe64c]\n\n工作结果：完成。改动仅 TODOS.md。\n\nPR: \u2060surreal_ck#255\nSHA: 107222e536d1a7a678e2d23314569ee732be63ff';
      const REAL_USER: Block = { author: 'user', text: `[SCK-ROUND ${REAL_MARKER}]\n\n更新 surreal_ck TODO 索引\n\n收尾约定：本轮的最后一条答复以「[SCK-DONE ${REAL_MARKER}]」单独成行开头，随后是完整最终答复。` };
      const REAL_DEVIN_1: Block = { author: 'devin', text: '已读取仓库现状，开始核对工单。' };
      const REAL_DEVIN_2: Block = { author: 'devin', text: REAL_DONE_BODY };
      const mountedAtRest: Block[] = [REAL_DEVIN_1, REAL_DEVIN_2];
      const allBlocks: Block[] = [REAL_USER, REAL_DEVIN_1, REAL_DEVIN_2];
      const STATUS_TEXT = 'Devin is awaiting instructions';

      /**
       * statusAt 默认 'natural'：状态短语只挂在滚动前（自然/常驻）那次快照上，恢复阶段临时滚到顶那次快照
       * 完全没有它——这才是与常驻采样一致的形态（devinAuthorBlocks 常驻就有，状态短语是页面持续渲染的 chrome，
       * 不是虚拟化列表项，没有证据证明它会随「滚到顶」这个临时动作消失或出现在别处）。不论滚动到哪里都无条件
       * 附带状态短语的旧版 text()，结构上测不出「如果判定错误地采用了恢复循环最后一次留下的快照」这种回归：
       * default 改成只在自然位置出现后，下面三个既有用例若改回从恢复循环的快照取状态就会读错，才具备这道
       * 回归检测能力。'top' 用于下面专门验证「不会误读那次临时快照」的反向用例。
       */
      const readScrolled = async (
        mounted: Block[], atTopBlocks: Block[],
        opts: { withScroller?: boolean; statusAt?: 'natural' | 'top' | 'none' } = {},
        marker = REAL_MARKER,
      ) => {
        const withScroller = opts.withScroller ?? true;
        const statusAt = opts.statusAt ?? 'natural';
        let atTop = false;
        const scroller = { scrollHeight: 2107, clientHeight: 713, _top: 1394,
          get scrollTop() { return this._top; }, set scrollTop(v: number) { this._top = v; atTop = v === 0; } };
        const current = () => (atTop ? atTopBlocks : mounted);
        const showStatus = () => (statusAt === 'natural' ? !atTop : statusAt === 'top' ? atTop : false);
        const text = () => [...current().map(b => b.text), ...(showStatus() ? [STATUS_TEXT] : [])].filter(Boolean).join('\n');
        const mkAuthorEl = (b: Block) => ({
          getAttribute: (name: string) => (name === 'data-message-author' ? b.author : null),
          innerText: b.text,
          parentElement: withScroller ? scroller : undefined,
        });
        const authorEls = () => current().filter(b => b.author !== 'tool').map(mkAuthorEl);
        const doc = {
          documentElement: {},
          // 取值要跟 main 一样实时反映当前挂载状态（真实 document.body.innerText 本就是活的），
          // 否则 waitReady() 的两次连续读数一致检查永远通不过（len 会一直是冻结的空字符串长度）。
          get body() { return { innerText: text() }; },
          querySelector: (sel: string) => (sel === 'main' ? { innerText: text() }
            : sel === '[data-sck-cap-trigger]' ? null
            : sel === '[data-message-author]' ? (authorEls()[0] ?? null)
            : {}),
          querySelectorAll: (sel: string) => (sel === '[data-message-author]' ? authorEls() : sel === '[role=menu]' ? [] : [{ innerText: 'Free' }]),
        };
        return runPage(doc, marker);
      };

      test('真实事故形态：常驻只剩 Devin 作者块与本轮 DONE；找不到可滚动祖先时保持修前的误判，可滚动恢复时读出修后的正确终稿与状态', async () => {
        // 对照（等价于修前/任何更早版本）：同一份常驻 DOM，没有可滚动祖先可恢复 —— 和没有这道恢复时一样误判。
        const before = await readScrolled(mountedAtRest, allBlocks, { withScroller: false });
        expect(before?.done).toBeNull();
        expect(before).toMatchObject({ markerSeen: false, status: 'unknown', source: 'roles' });
        // 本修复：同一份常驻 DOM，承载作者块的最近可滚动祖先滚到顶后能恢复出本轮用户锚点。
        const after = await readScrolled(mountedAtRest, allBlocks, { withScroller: true });
        expect(after).toMatchObject({ ok: true, markerSeen: true, status: 'idle', source: 'roles' });
        expect(after?.done).toContain('SHA: 107222e536d1a7a678e2d23314569ee732be63ff');
        expect(after?.done).toContain('surreal_ck#255');
      });

      test('状态短语只认滚动前的自然快照：即使那次临时滚到顶的快照里才有状态短语，判定也不会借用它（覆盖"顶部快照是否连带挂载状态短语未经验证"这道结构性漏判）', async () => {
        // 和上一个用例反过来：状态短语只挂在"滚到顶"之后的快照上（statusAt: 'top'），自然（未滚动）快照完全
        // 没有它。如果判定错误地采用了恢复循环最后一次留下的快照（而不是滚动前的自然快照），这里就会错误地
        // 读出 status:'idle'；真实只读采样从未证实状态短语会出现在那次临时滚动的快照里，所以正确答案是 unknown——
        // 锚点恢复（markerSeen、done）不受影响，只有状态判定必须保持不采信那次快照。
        const r = await readScrolled(mountedAtRest, allBlocks, { withScroller: true, statusAt: 'top' });
        expect(r?.markerSeen).toBe(true);
        expect(r?.done).toContain('SHA: 107222e536d1a7a678e2d23314569ee732be63ff');
        expect(r?.status).toBe('unknown');
      });

      test('滚动恢复出的用户块若是旧轮（标记不同），仍不算本轮锚点：不把旧轮当本轮，重试耗尽后照样拒绝终稿', async () => {
        const oldRoundUser: Block = { author: 'user', text: '[SCK-ROUND SCK-old999]\n\n旧任务\n\n收尾约定：「[SCK-DONE SCK-old999]」。' };
        const r = await readScrolled(mountedAtRest, [oldRoundUser, REAL_DEVIN_1, REAL_DEVIN_2], { withScroller: true });
        // done 与 markerSeen 是收尾判定实际依赖的两道门（devin.ts 收尾要求 status===idle && seen && answer 三者皆真），
        // 旧轮标记不等于本轮标记，这两道门必须保持拒绝——这里不断言 status，因为 CONV_OPEN 锚点本身不分标记
        // （只认「最近一次收尾约定」的位置，不检查它引述的是哪个标记），这是基线既有行为，不是本次改动引入的。
        expect(r?.done).toBeNull();
        expect(r?.markerSeen).toBe(false);
      });

      test('滚动恢复出的仍然只是工具/旧轮文本、没有本轮用户块时：不靠标记在别处出现过或存在某条 DONE 文本冒充已受理', async () => {
        const unrelatedTop: Block[] = [REAL_DEVIN_1, REAL_DEVIN_2];
        const r = await readScrolled(mountedAtRest, unrelatedTop, { withScroller: true });
        expect(r?.done).toBeNull();
        expect(r).toMatchObject({ markerSeen: false, status: 'unknown' });
      });
    });

    describe('错误会话：goto 失败被自己的 catch 吞掉，页面留在另一个合法会话上（发布前复核新发现的负例，非生产事故）', () => {
      /**
       * openPage 的 `await p.goto(target).catch(() => {})` 会吞掉导航失败：页面可能还留在上一个地址上。
       * 这里构造的「另一个会话」是合成场景（给 location.href 换一个不同的、同样合法形态的 app.devin.ai/sessions/
       * 地址），不是生产里真的发生过的事故；验证的是脚本自己的地址核验，不依赖它凑巧没有同标记内容——下面特意让
       * 这个「错误会话」页面仍带着本轮同标记的用户/Devin 作者块，证明光靠转录内容分不出这是不是本轮轮询的那个
       * 会话，必须另外核对 location.href。
       */
      const OTHER_SESSION = 'https://app.devin.ai/sessions/ffffffffffffffffffffffffffffffff';
      const DONE_TEXT = '完成。\nPR: https://github.com/acme/widget/pull/9\nSHA: cafecafe';
      const sameRoundBlocks: Block[] = [
        { author: 'user', text: `[SCK-ROUND ${M}]\n\n任务\n\n${CONV}` },
        { author: 'devin', text: `[SCK-DONE ${M}]\n${DONE_TEXT}` },
      ];

      test('页面停在另一个合法会话（同标记用户/Devin 块仍在）：按 wrong_session 拒绝，不把它当本轮受理或终稿', async () => {
        const r = await readPage(sameRoundBlocks, 'Devin chose to stop working', M, OTHER_SESSION);
        expect(r).toMatchObject({ ok: false, code: 'wrong_session', url: OTHER_SESSION });
        // ok:false 回执不带 done/markerSeen/status：不能被当成已受理或终稿读出。
        expect(r?.done).toBeUndefined();
        expect(r?.markerSeen).toBeUndefined();
      });

      test('页面确实停在目标会话上：地址核验通过，照常读出受理与终稿（对照组，证明核验不是误拦所有读数）', async () => {
        const r = await readPage(sameRoundBlocks, 'Devin chose to stop working', M, SESSION);
        expect(r).toMatchObject({ ok: true, markerSeen: true, status: 'idle' });
        expect(r?.done).toBe(DONE_TEXT);
      });

      test('会话地址的 query/hash 不参与核验：带查询串或锚点的同一会话地址仍算命中（"可规范化 query/hash"）', async () => {
        const r = await readPage(sameRoundBlocks, 'Devin chose to stop working', M, `${SESSION}?tab=files#latest`);
        expect(r).toMatchObject({ ok: true, markerSeen: true, status: 'idle' });
        expect(r?.done).toBe(DONE_TEXT);
      });
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
