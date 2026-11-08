import { expect, test } from 'bun:test';
import { latestFindings, requirementOf, taskBrief } from '../src/dispatcher/brief.ts';
import { wake } from '../src/dispatcher/prompts.ts';
import type { ClaimResult, HistoryEntry } from '../src/contracts.ts';

const env = { opsRepo: '/ops', sckBin: '/bin/sck', paseoBin: '/bin/paseo' };
const legacy = '交付项：导出\n需求与验收标准：\n导出 CSV，列头用字段标签。\n\n项目环境（仓库、发布方式、生产地址、红线）见 claim.json 的 project。你不持有任何凭证。\n\n你是工程。按 claim.json.worktree 实现。';
const at = '2026-10-31T00:00:00Z';
const ret = (evidence: string): HistoryEntry => ({ action: 'return', actor: 'employee:r', evidence, at });

test('the requirement is cut out of a delivery leg context; other contexts stay whole', () => {
  expect(requirementOf(legacy)).toBe('导出 CSV，列头用字段标签。');
  expect(requirementOf('写一页调研。')).toBe('写一页调研。');
});

test('a delivery leg keeps the acceptance amendment in its requirement section', () => {
  const amendment = '【验收要求修订 · 2026-11-01T09:00:00Z · gm-1 · audit a1】\n老板原话（逐字）：只收窄守卫范围\n修订说明：其余要求不变。\n';
  expect(requirementOf(`${legacy}\n\n${amendment}`)).toBe(`导出 CSV，列头用字段标签。\n\n${amendment.trim()}`);
  const md = taskBrief({ task: { title: '导出 · 实现', context: `${legacy}\n\n${amendment}`, state: 'doing' } as never });
  expect(md).toContain('老板原话（逐字）：只收窄守卫范围');
  expect(md).toContain('修订说明：其余要求不变。');
  expect(md).not.toContain('## 本环节');
  expect(md).not.toContain('项目环境（');
});

test('findings are the newest return, numbered by the returns so far', () => {
  expect(latestFindings([{ action: 'submit', actor: 'a', at }])).toBeUndefined();
  const f = latestFindings([ret('第一轮'), { action: 'submit', actor: 'a', at }, ret('第二轮'), ret('第三轮：R3-1 空值崩溃')]);
  expect(f).toEqual({ round: 3, file: 'findings/round-03.md', text: '第三轮：R3-1 空值崩溃\n' });
});

test('task.md carries only requirement and acceptance criteria, never company rules', () => {
  const md = taskBrief({ task: { title: '导出 · 实现', context: legacy, state: 'doing' } as never });
  expect(md).toContain('导出 CSV，列头用字段标签。');
  expect(md).not.toContain('## 本环节');
  expect(md).not.toContain('## 复核要点');
  expect(md).not.toContain('## 发布与环境');
  expect(md).not.toContain('claim.json');
  expect(md).not.toContain('凭证');
  const withAc = taskBrief({ task: { title: '导出', context: legacy, requirement: '导出 CSV', acceptanceText: '列头正确', state: 'doing' } as never });
  expect(withAc).toBe('# 导出\n\n## 需求\n\n导出 CSV\n\n## 验收标准\n\n列头正确\n');
});

const claim = (state: string, history: HistoryEntry[], intent: 'code' | 'read' = 'code') => ({
  task: { id: 't1', title: '导出 · 实现', context: legacy, state }, history,
  worktree: { worktreePath: '/w', branch: 'lane/x', intent: { kind: intent } },
}) as unknown as ClaimResult;
const task = (state: string) => ({ id: 't1', title: '导出 · 实现', state, row: {} }) as never;

test('the dispatch message is three sentences: what, finish, which tool', () => {
  const first = wake({ id: 'e1', role: 'engineering' } as never, task('doing'), env, true, { comm: true, claim: claim('doing', []), commDir: '/c' });
  expect(first).toContain('实现 /c/task.md 中的需求');
  expect(first).toContain(`'/bin/sck' call submit '{"text":"…","idempotencyKey":"…"}'`);
  expect(first).not.toContain('工作目录');
  const rework = wake({ id: 'e1', role: 'engineering' } as never, task('doing'), env, false, { comm: true, claim: claim('doing', [ret('a'), ret('b'), ret('c')]), commDir: '/c' });
  expect(rework).toContain('修复 /c/findings/round-03.md 中的问题');
  for (const text of [first, rework]) for (const word of ['AGENTS.md', 'PROTOCOL', 'claim.json', 'checkpoint', 'report_blocker', 'wait_task', '员工编号']) expect(text).not.toContain(word);
  const review = wake({ id: 'e2', role: 'engineering' } as never, task('review'), env, true, { comm: true, claim: claim('review', []), commDir: '/c' });
  expect(review).toContain('先查 /c/task.md 的验收标准第 1 条');
  expect(review).not.toContain('在生产逐条复验');
  expect(review).toContain("call review");
});
