import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { hrefOf, pageOf, routeOf } from '../src/ui/model.ts';
import {
  approveBlockers, flowIndex, milestones, nextStep, sameDraft, stateOf, taskProgress, taskTone, validateRequirement, EMPTY_DRAFT,
} from '../src/ui/iteration.ts';
import { DESIGN_TAG, parseSnapshot, withDesignCases } from '../demo/data.ts';
import { DemoStore } from '../demo/store.ts';

const enabled = { enabled: true, autoRelease: false, feedbackOrigins: [], releaseInstructions: '', verifyInstructions: '', rollbackInstructions: '' };

test('新路由：页面、详情编号与查询参数；旧地址兼容', () => {
  expect(routeOf('')).toEqual({ page: 'overview', params: {} });
  expect(routeOf('#requirements/abc?project=p1')).toEqual({ page: 'requirements', id: 'abc', params: { project: 'p1' } });
  expect(routeOf('#board').page).toBe('overview');
  expect(routeOf('#feedback?project=p1')).toEqual({ page: 'requirements', params: { project: 'p1', view: 'feedback' } });
  expect(routeOf('#nope/1').page).toBe('overview');
  expect(hrefOf('requirements', 'a b', { project: 'p', q: undefined })).toBe('#requirements/a%20b?project=p');
  expect(routeOf(hrefOf('tasks', 'task:⟨x⟩'))).toEqual({ page: 'tasks', id: 'task:⟨x⟩', params: {} });
  expect(pageOf('#overview')).toBe('board');
});

test('老板下一步：待决策、进行中、阻塞与完成各有明确文案与颜色', () => {
  expect(nextStep({ state: 'pending', acceptance: 'a' })).toMatchObject({ tone: 'decide', owner: true, text: '等你确认开工' });
  expect(nextStep({ state: 'draft', acceptance: '' }).text).toBe('补充验收标准后确认');
  expect(nextStep({ state: 'queued', acceptance: 'a', planning_error: 'x' })).toMatchObject({ tone: 'blocked', owner: true });
  expect(nextStep({ state: 'implementing', acceptance: 'a' }, 'blocked').tone).toBe('blocked');
  expect(nextStep({ state: 'release_pending', acceptance: 'a' }, 'awaiting_release')).toMatchObject({ tone: 'progress', text: '等待执行端接续', owner: false });
  expect(nextStep({ state: 'release_pending', acceptance: 'a' }, 'release_not_configured').text).toBe('等待执行端接续');
  expect(nextStep({ state: 'released', acceptance: 'a' }).tone).toBe('done');
  expect(stateOf('merged').tone).toBe('neutral');
  expect(flowIndex('paused', 'implementing')).toBe(3);
  expect(taskTone('review')).toBe('progress');
});

test('需求已确认、任务已完成、产品已上线是三个独立里程碑', () => {
  const queued = milestones({ state: 'queued', approved_revision: 2, revision: 2 }, []);
  expect(queued.map(m => m.done)).toEqual([true, false, false]);
  const tasks = [{ state: 'done' }, { state: 'done' }, { state: 'void' }];
  expect(taskProgress(tasks)).toMatchObject({ done: 2, total: 2, percent: 100 });
  expect(milestones({ state: 'release_pending', approved_revision: 1, revision: 1 }, tasks).map(m => m.done)).toEqual([true, true, false]);
  expect(milestones({state:'release_pending',revision:1},[{state:'done'},{state:'review'}])[1]!.done).toBe(false);
  expect(milestones({ state: 'released', approved_revision: 1, revision: 1 }, tasks, 'abc')[2]).toMatchObject({ done: true, detail: '发布提交 abc' });
});

test('确认开工的阻碍：未保存、缺验收标准、产品未启用', () => {
  expect(approveBlockers({ state: 'pending', acceptance: 'a' }, enabled, false)).toEqual([]);
  expect(approveBlockers({ state: 'pending', acceptance: '' }, { ...enabled, enabled: false }, true)).toEqual([
    '有未保存的修改，请先保存', '请先填写验收标准', '该产品未启用迭代流程（在产品设置中启用）',
  ]);
  expect(approveBlockers({ state: 'queued', acceptance: 'a' }, enabled, false)).toContain('当前状态不能确认开工');
  expect(validateRequirement(EMPTY_DRAFT)).toEqual({ title: '请填写标题', problem: '请描述要解决的问题' });
  expect(validateRequirement({ ...EMPTY_DRAFT, title: 'x'.repeat(201), problem: 'p' }).title).toContain('200');
  expect(sameDraft(EMPTY_DRAFT, { ...EMPTY_DRAFT })).toBe(true);
  expect(sameDraft(EMPTY_DRAFT, { ...EMPTY_DRAFT, priority: 1 })).toBe(false);
});

const snapshot = async () => parseSnapshot(await Bun.file(resolve(import.meta.dir, '../demo/production.snapshot.json')).json());

test('设计案例全部带标注、覆盖各状态，且不改动生产快照', async () => {
  const base = await snapshot();
  const before = JSON.stringify(base);
  const data = withDesignCases(base, 1_700_000_000_000);
  expect(JSON.stringify(base)).toBe(before);
  const added = data.requirements.slice(base.requirements.length);
  expect(added.every(r => String(r.title).startsWith(DESIGN_TAG))).toBe(true);
  expect(data.products.slice(base.products.length).every(p => String(p.name).startsWith(DESIGN_TAG))).toBe(true);
  expect(data.tasks.slice(base.tasks.length).every(t => String(t.title).startsWith(DESIGN_TAG))).toBe(true);
  for (const s of ['draft', 'pending', 'queued', 'implementing', 'release_pending', 'released', 'paused', 'rejected', 'merged']) expect(added.some(r => r.state === s)).toBe(true);
  const ids = new Set(data.tasks.map(t => t.id));
  for (const e of Object.values(data.executions!)) for (const id of e.tasks as string[]) expect(ids.has(id)).toBe(true);
  expect(data.feedback.slice(base.feedback.length).every(f => f.requirement === undefined || data.requirements.some(r => r.id === f.requirement))).toBe(true);
});

test('本地闭环：编辑回到待确认 → 确认锁定 → 拆解执行 → 复核合并与自动部署 → 上线，全部只在内存', async () => {
  const store = new DemoStore(withDesignCases(await snapshot()));
  const id = 'design-req-1';
  const r = store.find(store.data.requirements, id);
  expect((store.command('feedback.list', { project: r.project, requirement: id }) as { feedback: unknown[] }).feedback).toHaveLength(2);
  store.command('requirement.edit', { id, revision: r.revision, title: r.title, problem: r.problem, acceptance: r.acceptance, priority: 0 });
  expect(r).toMatchObject({ state: 'pending', revision: 4, priority: 0 });
  store.command('requirement.approve', { id, revision: 4 });
  expect(r).toMatchObject({ state: 'queued', approved_revision: 4 });
  expect(() => store.command('requirement.edit', { id, revision: 4, title: 'x', problem: 'y', acceptance: 'z', priority: 1 })).toThrow();
  store.tick(Date.now() + 5000);
  expect(r.state).toBe('implementing');
  const exec = store.command('requirement.execution', { id }) as { execution: { stage: string }; tasks: { state: string }[] };
  expect(exec.execution.stage).toBe('running');
  expect(exec.tasks).toHaveLength(3);

  // 无二次发布入口；独立复核后模拟 GitHub 自动部署与 QA 线上验收。
  expect(() => store.command('requirement.release', { id })).toThrow('没有执行外部操作');
  store.tick(Date.now() + 11000);
  expect(r.state).toBe('release_pending');
  expect((store.command('requirement.execution', { id }) as { execution: { stage: string } }).execution.stage).toBe('verifying');
  store.tick(Date.now() + 17000);
  expect(r.state).toBe('released');
  expect((store.command('requirement.execution', { id }) as { tasks: {state:string}[] }).tasks.every(t=>t.state==='done')).toBe(true);

  // 拒绝后编辑回到待确认；规划失败可重试。
  const rej = store.find(store.data.requirements, 'design-req-14');
  store.command('requirement.edit', { id: rej.id, revision: rej.revision, title: rej.title, problem: rej.problem, acceptance: rej.acceptance, priority: 1 });
  expect(rej.state).toBe('pending');
  const failed = store.find(store.data.requirements, 'design-req-4');
  store.command('requirement.control', { id: failed.id, revision: failed.revision, action: 'retry' });
  expect(failed.planning_error).toBeUndefined();

  store.reset();
  expect(store.find(store.data.requirements, id)).toMatchObject({ state: 'pending', revision: 3 });
  expect(store.find(store.data.requirements, 'design-req-8').state).toBe('release_pending');
});
