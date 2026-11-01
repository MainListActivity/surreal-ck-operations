import { expect, test } from 'bun:test';
import { latestFindings, requirementOf, taskBrief } from '../src/dispatcher/brief.ts';
import { wake, gmAttention } from '../src/dispatcher/prompts.ts';
import type { ClaimResult, HistoryEntry } from '../src/contracts.ts';

const env = { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' };
const legacy = '交付项：导出\n需求与验收标准：\n导出 CSV，列头用字段标签。\n\n项目环境（仓库、发布方式、生产地址、红线）见 claim.json 的 project。你不持有任何凭证。\n\n你是工程。按 claim.json.worktree 实现。';
const at = '2026-10-31T00:00:00Z';
const ret = (evidence: string): HistoryEntry => ({ action: 'return', actor: 'employee:r', evidence, at });

test('the requirement is cut out of a delivery leg context; other contexts stay whole', () => {
  expect(requirementOf(legacy)).toBe('导出 CSV，列头用字段标签。');
  expect(requirementOf('写一页调研。')).toBe('写一页调研。');
});

test('findings are the newest return, numbered by the returns so far', () => {
  expect(latestFindings([{ action: 'submit', actor: 'a', at }])).toBeUndefined();
  const f = latestFindings([ret('第一轮'), { action: 'submit', actor: 'a', at }, ret('第二轮'), ret('第三轮：R3-1 空值崩溃')]);
  expect(f).toEqual({ round: 3, file: 'findings/round-03.md', text: '第三轮：R3-1 空值崩溃\n' });
});

test('task.md carries the requirement and the leg job, never company rules', () => {
  const md = taskBrief({ task: { title: '导出 · 实现', context: legacy, state: 'doing' } as never });
  expect(md).toContain('导出 CSV，列头用字段标签。');
  expect(md).toContain('推送分支并创建 PR');
  expect(md).not.toContain('claim.json');
  expect(md).not.toContain('凭证');
  const deploy = taskBrief({ task: { title: '导出 · 合入部署与生产实测', context: legacy, state: 'doing' } as never,
    project: { release: 'Deploy production', rollback: '回滚上一版', envs: [{ name: 'production', url: 'https://x', secrets: [] }] } as never });
  expect(deploy).toContain('发布方式：Deploy production');
  expect(deploy).toContain('production：https://x');
});

const claim = (state: string, history: HistoryEntry[], intent: 'code' | 'read' = 'code') => ({
  task: { id: 't1', title: '导出 · 实现', context: legacy, state }, history,
  worktree: { worktreePath: '/w', branch: 'lane/x', intent: { kind: intent } },
}) as unknown as ClaimResult;
const task = (state: string) => ({ id: 't1', title: '导出 · 实现', state, row: {} }) as never;

test('the dispatch message is three sentences: what, finish, which tool', () => {
  const first = wake({ id: 'e1', role: 'engineering' } as never, task('doing'), env, true, { comm: true, claim: claim('doing', []), commDir: '/c' });
  expect(first).toBe([
    '【派工】任务 t1',
    '工作目录：/w（分支 lane/x）',
    '完成 /c/task.md 中的需求。',
    '完成必要自测，提交并推送。',
    `将结果与发布材料用 '/bin/sck' call submit '{"text":"…","idempotencyKey":"…"}' 写入。`,
  ].join('\n'));
  const rework = wake({ id: 'e1', role: 'engineering' } as never, task('doing'), env, false, { comm: true, claim: claim('doing', [ret('a'), ret('b'), ret('c')]), commDir: '/c' });
  expect(rework).toContain('修复 /c/findings/round-03.md 中记录的问题');
  for (const text of [first, rework]) for (const word of ['AGENTS.md', 'PROTOCOL', 'claim.json', 'checkpoint', 'report_blocker', 'wait_task', '员工编号']) expect(text).not.toContain(word);
  const review = wake({ id: 'e2', role: 'engineering' } as never, task('review'), env, true, { comm: true, claim: claim('review', []), commDir: '/c' });
  expect(review).toContain('按 /c/task.md 复核交付。');
  expect(review).toContain("call review");
});

test('manager first contact carries only task actions, reasons and the tool entry', () => {
  const text = gmAttention({ id: 'gm1', role: 'gm' } as never, [
    { task: { id: 'blocked-1', title: '导出', executorRole: 'engineering' }, action: 'resume', expectedVersion: 4 },
    { task: { id: 'ready-1', title: '修复', executorRole: 'engineering' }, action: 'implementer_takeover', expectedVersion: 7 },
  ] as never, env, true, { comm: true });
  expect(text).toContain('blocked-1');
  expect(text).toContain('resume_task');
  expect(text).toContain('ready-1');
  expect(text).toContain('implementer_takeover');
  expect(text).toContain('expectedVersion=7');
  expect(text).toContain("'/bin/sck' call");
  for (const word of ['AGENTS.md', 'PROTOCOL', '公司唯一真人', '你有决定权', '只有花钱', 'response_too_large']) expect(text).not.toContain(word);
});
