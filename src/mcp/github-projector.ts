import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CompanyCore, OutboxEvent, TaskView } from '../contracts';

type GhIssue = { number: number; body: string; title: string };
type GhComment = { body: string };
type ProjectionState = { version: 1; issues: Record<string, number>; completedEvents: string[] };

export interface GithubGateway {
  listIssues(): Promise<GhIssue[]>;
  createIssue(title: string, body: string): Promise<number>;
  getIssue(number: number): Promise<{ body: string; comments: GhComment[]; state: 'OPEN' | 'CLOSED' }>;
  editIssue(number: number, body: string): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  closeIssue(number: number): Promise<void>;
}

/** Uses the user's existing gh login. No PAT or shell command interpolation. */
export function createGhCliGateway(repository: string): GithubGateway {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid GitHub repository');
  const run = async (args: string[]): Promise<string> => {
    const child = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [output, , status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0) throw new Error(`gh operation failed (${args[0]}, exit ${status})`);
    return output.trim();
  };
  const withBody = async (body: string, operation: (file: string) => Promise<string>) => {
    const dir = await mkdtemp(join(tmpdir(), 'sck-gh-projection-'));
    const file = join(dir, 'body.md');
    try {
      await writeFile(file, body, { mode: 0o600 });
      return await operation(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  return {
    async listIssues() {
      const rows = JSON.parse(await run(['issue', 'list', '-R', repository, '--state', 'all', '--limit', '1000', '--json', 'number,body,title'])) as GhIssue[];
      if (rows.length >= 1000) throw new Error('GitHub issue scan reached its safety limit');
      return rows;
    },
    async createIssue(title, body) {
      const url = await withBody(body, file => run(['issue', 'create', '-R', repository, '--title', title, '--body-file', file]));
      const match = /\/issues\/(\d+)\s*$/.exec(url);
      if (!match) throw new Error('gh did not return an issue number');
      return Number(match[1]);
    },
    async getIssue(number) {
      return JSON.parse(await run(['issue', 'view', String(number), '-R', repository, '--json', 'body,comments,state'])) as { body: string; comments: GhComment[]; state: 'OPEN' | 'CLOSED' };
    },
    async editIssue(number, body) {
      await withBody(body, file => run(['issue', 'edit', String(number), '-R', repository, '--body-file', file]));
    },
    async comment(number, body) {
      await withBody(body, file => run(['issue', 'comment', String(number), '-R', repository, '--body-file', file]));
    },
    async closeIssue(number) {
      await run(['issue', 'close', String(number), '-R', repository]);
    },
  };
}

const taskMarker = (id: string) => `<!-- sck-company-task:${encodeURIComponent(id)} -->`;
const eventMarker = (id: string) => `<!-- sck-company-outbox:${encodeURIComponent(id)} -->`;
const managedStart = '<!-- sck-company-managed:start -->';
const managedEnd = '<!-- sck-company-managed:end -->';

function managedBody(task: TaskView): string {
  return [
    managedStart,
    taskMarker(task.id),
    `# ${task.title}`,
    `状态：${task.state}`,
    `执行岗位：${task.executorRole}；验收岗位：${task.reviewerRole}`,
    `任务版本：${task.version}`,
    `依赖：${task.dependencies.join(', ') || '无'}`,
    '任务上下文与交付证据以本机公司任务服务为准。',
    managedEnd,
  ].join('\n');
}

function replaceManagedBody(existing: string, task: TaskView): string {
  const start = existing.indexOf(managedStart);
  const end = existing.indexOf(managedEnd, start);
  if (start < 0 || end < 0 || !existing.includes(taskMarker(task.id))) throw new Error('GitHub issue is not owned by this projector');
  return existing.slice(0, start) + managedBody(task) + existing.slice(end + managedEnd.length);
}

async function loadState(path: string): Promise<ProjectionState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1) throw new Error('invalid projection state');
    return parsed as ProjectionState;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return { version: 1, issues: {}, completedEvents: [] };
    throw error;
  }
}

async function saveState(path: string, state: ProjectionState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export function createGithubProjector(input: {
  core: CompanyCore;
  credential: string;
  github: GithubGateway;
  statePath: string;
}) {
  const { core, credential, github, statePath } = input;
  const ensureIssue = async (task: TaskView, state: ProjectionState): Promise<number> => {
    const known = state.issues[task.id];
    if (known) return known;
    const found = (await github.listIssues()).find(issue => issue.body.includes(taskMarker(task.id)));
    const number = found?.number ?? await github.createIssue(`[Company] ${task.title}`, managedBody(task));
    state.issues[task.id] = number;
    await saveState(statePath, state);
    return number;
  };
  const projectEvent = async (event: OutboxEvent, state: ProjectionState): Promise<void> => {
    const task = await core.getTask(credential, event.taskId);
    const number = await ensureIssue(task, state);
    const issue = await github.getIssue(number);
    const updatedBody = replaceManagedBody(issue.body, task);
    if (updatedBody !== issue.body) await github.editIssue(number, updatedBody);
    const marker = eventMarker(event.id);
    if (!issue.comments.some(comment => comment.body.includes(marker))) {
      await github.comment(number, `${marker}\n事件：${event.kind}\n任务版本：${task.version}\n时间：${event.createdAt}\n详情以本机持久审计为准。`);
    }
    if (task.state === 'done' && issue.state !== 'CLOSED') await github.closeIssue(number);
    state.completedEvents.push(event.id);
    await saveState(statePath, state);
  };
  return {
    async runOnce(): Promise<{ projected: number; remaining: number }> {
      const principal = await core.authenticate(credential);
      if (!principal.capabilities.includes('manage')) throw new Error('outbox projection requires manage capability');
      const state = await loadState(statePath);
      const completed = new Set(state.completedEvents);
      let projected = 0;
      let after: string | undefined;
      while (true) {
        // Core orders by (at, id); each page starts after the previous event id.
        // Every run starts from the beginning so concurrent inserts before a
        // current scan's cursor are picked up in the next run.
        const events = await core.listOutbox(credential, after);
        if (events.length > 1000) throw new Error('core outbox page exceeds contract limit');
        for (const event of events) {
          if (completed.has(event.id)) continue;
          await projectEvent(event, state);
          completed.add(event.id);
          projected++;
        }
        if (events.length < 1000) break;
        const next = events.at(-1)?.id;
        if (!next || next === after) throw new Error('core outbox cursor did not advance');
        after = next;
      }
      return { projected, remaining: 0 };
    },
  };
}
