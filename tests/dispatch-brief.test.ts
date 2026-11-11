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

test('派工说明只描述工作与结果，不要求生命周期命令', () => {
  const first = wake({ id: 'e1', role: 'engineering' } as never, task('doing'), env, true, { claim: claim('doing', []), commDir: '/c' });
  expect(first).toContain('实现 /c/task.md 中的需求');
  expect(first).toContain('执行端自动保存');
  expect(first).not.toContain('call submit');
  expect(first).not.toContain('工作目录');
  const rework = wake({ id: 'e1', role: 'engineering' } as never, task('doing'), env, false, { claim: claim('doing', [ret('a'), ret('b'), ret('c')]), commDir: '/c' });
  expect(rework).toContain('修复 /c/findings/round-03.md 中的问题');
  for (const text of [first, rework]) for (const word of ['AGENTS.md', 'PROTOCOL', 'claim.json', 'checkpoint', 'report_blocker', 'wait_task', '员工编号']) expect(text).not.toContain(word);
  const review = wake({ id: 'e2', role: 'engineering' } as never, task('review'), env, true, { claim: claim('review', []), commDir: '/c' });
  expect(review).toContain('先查 /c/task.md 的验收标准第 1 条');
  expect(review).not.toContain('在生产逐条复验');
  expect(review).toContain('复核结论：通过');
  expect(review).not.toContain('call review');
});

test('老板看到的派工文件与实际任务正文同源，当前预览不冒充已派工快照', async () => {
  const {workContext}=await import('../src/work-context.ts');
  const claim={task:{id:'t',title:'任务',context:'实际需求',state:'doing'},deliveryId:'delivery',laneNotes:'本线笔记',history:[{action:'return',evidence:'补充边界用例'}]} as any;
  const saved=workContext(claim,'dispatched',100);
  expect(saved.delivery).toBe('delivery');expect(saved.files[0]!.text).toBe(taskBrief(claim));
  expect(saved.files.map(f=>f.name)).toEqual(['task.md','notes.md','findings/round-01.md']);
  expect(workContext({task:claim.task},'preview',100).files).toHaveLength(1);
  claim.task.context='x'.repeat(20000);
  expect(workContext(claim,'dispatched').files[0]).toMatchObject({truncated:true});
});

test('复核任务自动交接本任务最新提交原文、提交者和产物路径，老板快照同源', async () => {
  const { workContext } = await import('../src/work-context.ts');
  const report = '工作结果：完成\n31 项通过，0 项失败。\n报告：/evidence/t1/report.md\n原始输出：/evidence/t1/tests.log';
  const handed = claim('review', [
    { action: 'submit', actor: 'old-author', at, evidence: '已被替代的旧成果' },
    ret('补充原始输出'),
    { action: 'owner_submit', actor: 'author', at, evidence: report },
    { action: 'claim', actor: 'reviewer', at },
  ]);
  const md = taskBrief(handed);
  expect(md).toContain('## 待复核成果');
  expect(md).toContain(report);
  expect(md).toContain('提交者：author');
  expect(md).toContain(at);
  expect(md).not.toContain('已被替代的旧成果');
  expect(md).not.toContain('read_task_text');
  expect(workContext(handed, 'dispatched').files[0]!.text).toBe(md);
  handed.task.state = 'doing';
  expect(taskBrief(handed)).not.toContain(report);
});

test('复核交接缺失或截断时明确标示，不以旧提交冒充当前成果', () => {
  expect(taskBrief(claim('review', []))).toContain('执行端未取得提交成果');
  const old = { action: 'submit', actor: 'old', at, evidence: '旧成果' };
  expect(taskBrief(claim('review', [old, { action: 'submit', actor: 'new', at }]))).not.toContain('旧成果');
  const md = taskBrief(claim('review', [{ action: 'submit', actor: 'author', at, evidence: '片段', evidenceTruncated: true }]));
  expect(md).toContain('提交成果不完整');
  expect(md).not.toContain('sck call');
});
