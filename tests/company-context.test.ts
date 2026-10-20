import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { COMPANY_PART_BYTES, companyBlock, companyParts, reassembleCompany } from '../src/company-context.ts';
import { CompanyError } from '../src/core-errors.ts';
import type { CompanyBrief, CompanyPart, GoalView, ProjectView } from '../src/contracts.ts';
import { parseContextInput } from '../src/query-input.ts';
import { RESPONSE_BUDGET_BYTES, answerBytes } from '../src/response-budget.ts';

// SYS01 AC-A, the pure contract of get_context with scope company: the parts of the company block, the reader's join, and the
// refusals. The fork-backed suite (company-scope.integration.test.ts) holds the same contract through the database and MCP.

const unit = '中文🙂字符';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A text of about `bytes` UTF-8 bytes of mixed Chinese and emoji (every character is 3 or 4 bytes, so cuts land mid-run). */
function textOf(bytes: number, prefix = ''): string {
  let text = prefix;
  while (Buffer.byteLength(text, 'utf8') < bytes) text += unit;
  return text;
}

const goal = (index: number, brief: string): GoalView => ({
  id: `goal-${index}`, title: `目标 ${index}`, brief, state: 'active', tier: 'standard', tasks: {},
});

const project = (index: number, runbook: string): ProjectView => ({
  id: `project-${index}`, name: `项目 ${index}`, repoPath: `/fixture/project-${index}`, defaultBranch: 'main', release: 'local',
  redLines: [], runbooks: [runbook],
} as unknown as ProjectView);

function briefOf(parts: { directions?: string[]; goals?: string[]; projects?: string[]; paused?: boolean }): CompanyBrief {
  return {
    paused: parts.paused ?? false,
    directions: (parts.directions ?? []).map((text, index) => ({ text, source: `owner:fixture-${index}`, at: '2026-10-20T00:00:00.000Z' })),
    goals: (parts.goals ?? []).map((brief, index) => goal(index, brief)),
    projects: (parts.projects ?? []).map((runbook, index) => project(index, runbook)),
  };
}

/** One page of parts as get_context answers it: principal and page wrap the parts, so the budget measures the whole answer. */
const pageAnswer = (parts: CompanyPart[]) => ({
  principal: { employeeId: 'fixture-gm', role: 'gm' }, scope: 'company', parts, page: { pageSize: parts.length, returned: parts.length, hasMore: false, total: parts.length, budgetBytes: RESPONSE_BUDGET_BYTES },
});

/** Every part is answered in a page of its own at most, and the whole answer stays inside the budget. */
function expectEveryPartFits(parts: CompanyPart[]) {
  for (const part of parts) {
    expect(answerBytes(pageAnswer([part]))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(Buffer.byteLength(part.json, 'utf8')).toBeLessThanOrEqual(COMPANY_PART_BYTES);
  }
}

test('the company block parts reassemble exactly for the 31 KiB sample of the operations company block', () => {
  // The operations sample is a 30683-byte company block: directions, goals and projects with long texts.
  const brief = briefOf({
    directions: [textOf(9000, '方向一 '), textOf(6000, '方向二 🙂 ')],
    goals: [textOf(7000, '目标简报 '), textOf(3000, '第二目标 ')],
    projects: [textOf(4000, '项目运行手册 "quoted" ')],
    paused: true,
  });
  const parts = companyParts(brief);
  expectEveryPartFits(parts);
  const items = reassembleCompany(parts);
  expect(items.get('meta\0company')!.value).toEqual({ paused: true });
  expect(items.get('directions\0direction-0')!.value).toEqual(JSON.parse(JSON.stringify(brief.directions[0])));
  expect(items.get('directions\0direction-1')!.value).toEqual(JSON.parse(JSON.stringify(brief.directions[1])));
  expect(items.get('goals\0goal-0')!.value).toEqual(JSON.parse(JSON.stringify(brief.goals[0])));
  expect(items.get('projects\0project-0')!.value).toEqual(JSON.parse(JSON.stringify(brief.projects[0])));
  expect(items.size).toBe(1 + brief.directions.length + brief.goals.length + brief.projects.length);
});

test('a 128 KiB block of Chinese, emoji and one very long direction reassembles whole, and every part fits a page', () => {
  const huge = textOf(200 * 1024, '单方向超长 🙂 ');
  const brief = briefOf({ directions: [huge, textOf(128 * 1024, '第二方向 ')], goals: [textOf(40 * 1024, '目标 🙂 ')], projects: [textOf(8 * 1024)] });
  const parts = companyParts(brief);
  expectEveryPartFits(parts);
  const longest = parts.filter(part => part.section === 'directions' && part.key === 'direction-0');
  expect(longest.length).toBeGreaterThan(1);
  // Every part of the long direction carries the same length and digest, and the offsets run from 0 with no gap.
  expect(new Set(longest.map(part => part.totalBytes)).size).toBe(1);
  expect(new Set(longest.map(part => part.sha256)).size).toBe(1);
  expect(longest.map(part => part.part)).toEqual(longest.map((_, index) => index));
  const items = reassembleCompany(parts);
  expect(items.get('directions\0direction-0')!.value).toEqual({ text: huge, source: 'owner:fixture-0', at: '2026-10-20T00:00:00.000Z' });
  expect(items.get('directions\0direction-1')!.value).toMatchObject({ source: 'owner:fixture-1' });
});

test('a growing project set (200 projects with long runbooks) pages into parts that all reassemble', () => {
  const projects = Array.from({ length: 200 }, (_, index) => textOf(900 + index, `项目 ${index} 运行手册 🙂 `));
  const parts = companyParts(briefOf({ projects }));
  expectEveryPartFits(parts);
  const items = reassembleCompany(parts);
  for (let index = 0; index < projects.length; index++) {
    expect(items.get(`projects\0project-${index}`)!.value).toMatchObject({ id: `project-${index}`, runbooks: [projects[index]] });
  }
});

test('a section narrows the parts to that section, and the meta part is always present', () => {
  const brief = briefOf({ directions: ['方向'], goals: ['目标'], projects: ['项目'], paused: true });
  expect(companyParts(brief, 'goals').map(part => `${part.section}/${part.key}`)).toEqual(['meta/company', 'goals/goal-0']);
  expect(companyBlock(brief, 'directions')).toEqual({ paused: true, directions: brief.directions });
  expect(Object.keys(companyBlock(brief))).toEqual(['paused', 'directions', 'goals', 'projects']);
});

test('the reader refuses a missing part, a repeated part, a gap, an altered text and a wrong length', () => {
  const brief = briefOf({ directions: [textOf(40 * 1024, '长方向 🙂 ')] });
  const parts = companyParts(brief).filter(part => part.section === 'directions');
  expect(parts.length).toBeGreaterThan(2);
  const refused = (list: CompanyPart[]) => {
    try {
      reassembleCompany(list);
      return undefined;
    } catch (error) {
      return error as CompanyError;
    }
  };
  expect(refused(parts)).toBeUndefined();
  expect(refused(parts.slice(1))).toBeInstanceOf(CompanyError);
  expect(refused([...parts, parts[1]!])).toBeInstanceOf(CompanyError);
  // One Chinese character becomes another of the same UTF-8 length, so only the digest can tell the text was changed.
  const altered = parts.map(part => (part.part === 1 ? { ...part, json: part.json.replace(/[一-鿿]/, '国') } : part));
  expect(altered[1]!.json).not.toBe(parts[1]!.json);
  expect(refused(altered)?.message).toContain('SHA-256');
  const shifted = parts.map(part => (part.part === 2 ? { ...part, offset: part.offset + 3 } : part));
  expect(refused(shifted)?.message).toContain('contiguous');
  expect(refused(parts.map(part => ({ ...part, totalBytes: part.totalBytes + 1 })))).toBeInstanceOf(CompanyError);
  expect(sha256(brief.directions[0]!.text).length).toBe(64);
});

test('scope company is a task-free read: task filters and an unknown section are refused, and tasks scope keeps the company block out by default', () => {
  expect(parseContextInput({ scope: 'company' })).toMatchObject({ scope: 'company', includeCompany: true, paged: false });
  expect(parseContextInput({ scope: 'company', section: 'projects', pageSize: 3 })).toMatchObject({ section: 'projects', paged: true, pageSize: 3 });
  for (const filter of [{ taskId: 'task-1' }, { state: 'ready' }, { goalId: 'goal-1' }, { role: 'gm' }, { since: '2026-10-01' }, { fields: ['id'] }, { includeCompany: true }]) {
    expect(() => parseContextInput({ scope: 'company', ...filter })).toThrow(CompanyError);
  }
  expect(() => parseContextInput({ scope: 'company', section: 'secrets' })).toThrow(CompanyError);
  expect(() => parseContextInput({ scope: 'everything' })).toThrow(CompanyError);
  expect(() => parseContextInput({ section: 'goals' })).toThrow(CompanyError);
  expect(parseContextInput({})).toMatchObject({ scope: 'tasks', includeCompany: false });
  expect(parseContextInput({ scope: null, includeCompany: null })).toMatchObject({ scope: 'tasks', includeCompany: false });
});
