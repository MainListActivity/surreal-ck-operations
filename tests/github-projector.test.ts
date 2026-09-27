import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CompanyCore, OutboxEvent, TaskView } from '../src/contracts';
import { createGithubProjector, type GithubGateway } from '../src/mcp/github-projector';

const task: TaskView = {
  id: 'task-new-1', title: 'Synthetic managed task', context: 'private task context',
  state: 'ready', executorRole: 'ai-content', reviewerRole: 'engineering',
  dependencies: [], version: 1, fence: 0,
};
const event: OutboxEvent = { id: 'event-1', taskId: task.id, kind: 'created', payload: {}, createdAt: '2026-09-27T00:00:00Z' };
const core = {
  async authenticate() { return { employeeId: 'gm-01', role: 'gm', capabilities: ['manage'] }; },
  async listOutbox() { return [event]; },
  async getTask() { return task; },
} as unknown as CompanyCore;
const dir = await mkdtemp(join(tmpdir(), 'sck-projector-test-'));
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test('outbox replay recovers from lost local checkpoint without duplicate GitHub issue or comment', async () => {
  const statePath = join(dir, 'projection.json');
  const issues: Array<{ number: number; body: string; title: string; state: 'OPEN' | 'CLOSED'; comments: Array<{ body: string }> }> = [];
  const gateway: GithubGateway = {
    async listIssues() { return issues; },
    async createIssue(title, body) { issues.push({ number: 101, title, body, state: 'OPEN', comments: [] }); return 101; },
    async getIssue(number) { const { body, comments, state } = issues.find(issue => issue.number === number)!; return { body, comments, state }; },
    async editIssue(number, body) { issues.find(issue => issue.number === number)!.body = body; },
    async comment(number, body) { issues.find(issue => issue.number === number)!.comments.push({ body }); },
    async closeIssue(number) { issues.find(issue => issue.number === number)!.state = 'CLOSED'; },
  };
  const projector = createGithubProjector({ core, credential: 'opaque', github: gateway, statePath });
  expect(await projector.runOnce()).toEqual({ projected: 1 });
  expect(issues).toHaveLength(1);
  expect(issues[0].comments).toHaveLength(1);
  expect(issues[0].body).not.toContain(task.context);
  expect(await projector.runOnce()).toEqual({ projected: 0 });
  await unlink(statePath);
  expect(await projector.runOnce()).toEqual({ projected: 1 });
  expect(issues).toHaveLength(1);
  expect(issues[0].comments).toHaveLength(1);
});

test('failed GitHub comment leaves event pending, retry reuses the managed issue', async () => {
  const statePath = join(dir, 'failed-projection.json');
  let issue: { number: number; body: string; state: 'OPEN' | 'CLOSED'; comments: Array<{ body: string }> } | undefined;
  let fail = true;
  const gateway: GithubGateway = {
    async listIssues() { return issue ? [{ ...issue, title: task.title }] : []; },
    async createIssue(_title, body) { issue = { number: 102, body, state: 'OPEN', comments: [] }; return 102; },
    async getIssue() { return { body: issue!.body, comments: issue!.comments, state: issue!.state }; },
    async editIssue(_number, body) { issue!.body = body; },
    async comment(_number, body) {
      if (fail) throw new Error('temporary GitHub outage');
      issue!.comments.push({ body });
    },
    async closeIssue() {},
  };
  const projector = createGithubProjector({ core, credential: 'opaque', github: gateway, statePath });
  await expect(projector.runOnce()).rejects.toThrow('temporary GitHub outage');
  expect(issue?.number).toBe(102);
  fail = false;
  expect(await projector.runOnce()).toEqual({ projected: 1 });
  expect(issue?.comments).toHaveLength(1);
  expect((await gateway.listIssues())).toHaveLength(1);
});

test('reads beyond the first 1000 durable outbox events through the core cursor', async () => {
  const events = Array.from({ length: 1001 }, (_, index): OutboxEvent => ({
    id: `event-${String(index).padStart(4, '0')}`,
    taskId: task.id,
    kind: 'checkpoint',
    payload: {},
    createdAt: new Date(Date.UTC(2026, 8, 27, 0, 0, index)).toISOString(),
  }));
  const pageCalls: Array<string | undefined> = [];
  const pagedCore = {
    ...core,
    async listOutbox(_credential: string, after?: string) {
      pageCalls.push(after);
      const start = after ? events.findIndex(event => event.id === after) + 1 : 0;
      return events.slice(start, start + 1000);
    },
  } as CompanyCore;
  let issue: { body: string; comments: Array<{ body: string }> } | undefined;
  const gateway: GithubGateway = {
    async listIssues() { return issue ? [{ number: 103, title: task.title, body: issue.body }] : []; },
    async createIssue(_title, body) { issue = { body, comments: [] }; return 103; },
    async getIssue() { return { body: issue!.body, comments: issue!.comments, state: 'OPEN' }; },
    async editIssue(_number, body) { issue!.body = body; },
    async comment(_number, body) { issue!.comments.push({ body }); },
    async closeIssue() {},
  };
  const projector = createGithubProjector({ core: pagedCore, credential: 'opaque', github: gateway, statePath: join(dir, 'paged.json') });
  expect(await projector.runOnce()).toEqual({ projected: 1001 });
  expect(pageCalls).toEqual([undefined, 'event-0999']);
  expect(issue?.comments).toHaveLength(1001);
  expect(await projector.runOnce()).toEqual({ projected: 0 });
});
