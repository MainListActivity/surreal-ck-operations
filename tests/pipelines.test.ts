import { expect, test } from 'bun:test';
import { goalTemplate } from '../src/flows.ts';

test('a goal is one task: engineering -> qa for software, story-author -> qa for story, concept-design -> owner for video', () => {
  const software = goalTemplate('quick', '导出', '导出 CSV', 'g1');
  expect(software.tasks).toHaveLength(1);
  expect(software.tasks[0]).toMatchObject({ executorRole: 'engineering', reviewerRole: 'qa' });
  expect(JSON.stringify(software.tasks)).not.toContain("'gm'");
  expect(goalTemplate('standard', '写故事', '写完', 'g2', 'story').tasks[0]).toMatchObject({ executorRole: 'story-author', reviewerRole: 'qa' });
  expect(goalTemplate('program', '拍片', '成片', 'g3', 'video').tasks[0]).toMatchObject({ executorRole: 'concept-design', reviewerRole: 'owner' });
});

test('the template requirement comes from the goal brief and acceptance text is explicit', () => {
  const t = goalTemplate('quick', '导出', '导出 CSV，列头用字段标签', 'g1');
  expect(t.tasks[0]!.requirement).toBe('导出 CSV，列头用字段标签');
  expect(t.tasks[0]!.acceptanceText).toContain('逐条验证');
});
