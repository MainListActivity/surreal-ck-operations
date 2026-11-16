import { expect, test } from 'bun:test';
import { parseActionRuns } from '../src/ci-runs.ts';

const URL_OF = (id: number) => `https://github.com/MainListActivity/surreal_ck/actions/runs/${id}`;
const row = (status: string, conclusion: string, id: number) => `${status}\t${conclusion}\t${URL_OF(id)}`;

test('只有完成且成功的 run 计为成功；排队与运行中计为等待；完成但失败的计为失败', () => {
  expect(parseActionRuns([row('completed', 'success', 1), row('queued', '', 2), row('in_progress', '', 3), row('completed', 'failure', 4)].join('\n')))
    .toEqual({ success: [URL_OF(1)], waiting: 2, failed: [URL_OF(4)] });
});
test('没有任何 run 时既不成功也不失败：等待 CI 出现', () => {
  expect(parseActionRuns('')).toEqual({ success: [], waiting: 0, failed: [] });
});
test('无法识别的行不计数，成功的 run 最多保留 5 个', () => {
  const many = Array.from({ length: 7 }, (_, index) => row('completed', 'success', index + 1));
  const parsed = parseActionRuns([...many, 'garbage line', 'completed\tsuccess\thttp://not-github.example/x'].join('\n'));
  expect(parsed.success).toHaveLength(5);
  expect(parsed.waiting + parsed.failed.length).toBe(0);
});
test('重跑中的 run 只要还没成功就继续等待，不因为旧失败而判定 CI 失败', () => {
  const parsed = parseActionRuns([row('completed', 'failure', 9), row('queued', '', 10)].join('\n'));
  expect(parsed.success).toEqual([]);
  expect(parsed.waiting).toBe(1);
  expect(parsed.failed).toEqual([URL_OF(9)]);
});
