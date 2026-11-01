import { expect, test } from 'bun:test';
import { assertRoleContract, type DisciplineContract } from '../src/role-contract.ts';
import { goalTemplate, isPipeline, PIPELINES } from '../src/flows.ts';

const contract: DisciplineContract = new Map([
  ['原著', ['story-author', 'screenwriter']], ['编剧', ['screenwriter']], ['角色设计', ['concept-design', 'asset-production']], ['审片', undefined],
]);

test('a track that lists roles refuses every other role', () => {
  expect(() => assertRoleContract(contract, 'product', '原著')).toThrow(/may only be carried by story-author、screenwriter/);
  expect(() => assertRoleContract(contract, 'engineering', '角色设计')).toThrow(/cannot take it/);
  expect(() => assertRoleContract(contract, 'screenwriter', '原著')).not.toThrow();
  expect(() => assertRoleContract(contract, 'product', '审片')).not.toThrow();
});

test('a line role must always name its track, coordination roles may stay untracked', () => {
  expect(() => assertRoleContract(contract, 'concept-design')).toThrow(/must set discipline to one of: 角色设计/);
  expect(() => assertRoleContract(contract, 'screenwriter')).toThrow(/原著、编剧/);
  for (const role of ['gm', 'product', 'qa', 'engineering']) expect(() => assertRoleContract(contract, role)).not.toThrow();
});

test('no vocabulary means no contract', () => {
  expect(() => assertRoleContract(undefined, 'product', '原著')).not.toThrow();
});

test('story goals have no product or software tasks: one plan task and no auto-closing gate', () => {
  const t = goalTemplate('program', '长篇小说', '写完它', 'g1', 'story');
  expect(t.tasks.map(x => [x.ref, x.executorRole, x.reviewerRole])).toEqual([['plan', 'gm', 'qa']]);
  expect(t.anchors).toEqual([]); expect(t.refs).toEqual({ plan: 'plan' });
  const text = t.tasks[0]!.context;
  for (const part of ['故事圣经', 'reviewerRole=owner', '[展开下一层]', '[正文]', '[小章节交付]', 'discipline=原著']) expect(text).toContain(part);
  expect(text).not.toContain('create_delivery(');
});

test('video goals plan with the content line and end at the owner gate, without product acceptance', () => {
  const t = goalTemplate('standard', '短剧', '做一集', 'g2', 'video');
  expect(t.tasks.map(x => [x.ref, x.executorRole, x.reviewerRole, x.kind])).toEqual([['plan', 'gm', 'qa', 'task'], ['acceptance', 'gm', 'owner', 'gate']]);
  expect(t.tasks[1]!.deps).toEqual(['plan']); expect(t.anchors).toEqual(['acceptance']);
  expect(t.tasks[0]!.context).toContain('concept-design'); expect(t.tasks.some(x => x.executorRole === 'product')).toBe(false);
});

test('the software line is unchanged', () => {
  const t = goalTemplate('standard', '改个按钮', '按钮错位', 'g3');
  expect(t.tasks.map(x => x.ref)).toEqual(['plan', 'manual', 'acceptance']); expect(t.anchors).toEqual(['manual', 'acceptance']);
  expect(t.tasks.find(x => x.ref === 'manual')!.executorRole).toBe('product');
  expect(goalTemplate('standard', '改个按钮', '按钮错位', 'g3', 'software')).toEqual(t);
  expect(t.tasks[0]!.context).not.toContain('产线 ');
});

test('pipeline ids', () => {
  expect([...PIPELINES]).toEqual(['software', 'video', 'story']);
  expect(isPipeline('story')).toBe(true); expect(isPipeline('novel')).toBe(false); expect(isPipeline(undefined)).toBe(false);
});

test('quick goals write one code lane onto both legs of the merged chain', () => {
  const t = goalTemplate('quick', '修复按钮', '按钮错位', 'g4');
  const legs = t.tasks.filter(x => x.ref !== 'manual');
  expect(legs.map(x => [x.ref, x.kind, x.workIntent?.kind, x.deps])).toEqual([['d0', 'release', 'code', []], ['d1', 'deploy', 'code', ['d0']]]);
  const lane = legs[0]!.workIntent?.lane;
  expect(lane).toMatch(/^delivery-[0-9a-f]{8}$/);
  expect(legs[1]!.workIntent).toEqual({ kind: 'code', lane });
  expect(t.tasks.find(x => x.ref === 'manual')!.workIntent).toBeUndefined();
  // The lane belongs to the goal: the same goal names the same lane, another goal names a different one.
  expect(goalTemplate('quick', '修复按钮', '按钮错位', 'g4').tasks[0]!.workIntent?.lane).toBe(lane);
  expect(goalTemplate('quick', '修复按钮', '按钮错位', 'g5').tasks[0]!.workIntent?.lane).not.toBe(lane);
});

test('standard and program plans carry no intent: create_delivery sets it per leg', () => {
  for (const tier of ['standard', 'program'] as const) {
    expect(goalTemplate(tier, '改个按钮', '按钮错位', 'g6').tasks.some(x => x.workIntent !== undefined)).toBe(false);
  }
});
