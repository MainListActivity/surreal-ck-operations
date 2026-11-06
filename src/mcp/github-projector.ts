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
    const timeout = setTimeout(() => child.kill(), 60_000);
    try {
      const [output, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (status !== 0) throw new Error(`gh operation failed (${args[0]}, exit ${status}): ${stderr.slice(0, 300)}`);
      return output.trim();
    } finally {
      clearTimeout(timeout);
    }
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
      const json = await run(['api', `repos/${repository}/issues?state=all&per_page=100`, '--paginate', '--slurp']);
      const pages = JSON.parse(json) as Array<Array<GhIssue & { pull_request?: unknown }>>;
      return pages.flat().filter(issue => !issue.pull_request);
    },
    async createIssue(title, body) {
      const url = await withBody(body, file => run(['issue', 'create', '-R', repository, '--title', title, '--body-file', file]));
      const match = /\/issues\/(\d+)\s*$/.exec(url);
      if (!match) throw new Error('gh did not return an issue number');
      return Number(match[1]);
    },
    async getIssue(number) {
      const [issueJson, commentsJson] = await Promise.all([
        run(['issue', 'view', String(number), '-R', repository, '--json', 'body,state']),
        run(['api', `repos/${repository}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp']),
      ]);
      const issue = JSON.parse(issueJson) as { body: string; state: 'OPEN' | 'CLOSED' };
      const pages = JSON.parse(commentsJson) as GhComment[][];
      return { ...issue, comments: pages.flat() };
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
    `执行岗位：${task.executorRole}${task.discipline ? `/${task.discipline}` : ''}；验收岗位：${task.reviewerRole}`,
    `任务版本：${task.version}`,
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
  heal?: () => Promise<void>;
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
    if ((task.state === 'done' || task.state === 'void') && issue.state !== 'CLOSED') await github.closeIssue(number);
    state.completedEvents.push(event.id);
    await saveState(statePath, state);
  };
  return {
    async runOnce(): Promise<{ projected: number }> {
      const principal = await core.authenticate(credential);
      if (!principal.capabilities.includes('manage')) throw new Error('outbox projection requires manage capability');
      const state = await loadState(statePath);
      const completed = new Set(state.completedEvents);
      let projected = 0;
      let after: string | undefined;
      while (true) {
        // Core orders by a durable global sequence. Each page starts after
        // the previous event ID, which resolves to its sequence in the DB.
        const events = await core.listOutbox(credential, after);
        if (events.length > 1000) throw new Error('core outbox page exceeds contract limit');
        let failed = 0;
        for (const event of events) {
          if (completed.has(event.id)) continue;
          try {
            await projectEvent(event, state);
            completed.add(event.id);
            projected++;
          } catch (error) {
            failed++;
            // One poisoned event must not block the whole backlog; it retries next pass.
            console.error(`projection skipped event ${String(event.id)} (${event.kind}): ${(error as Error).message}`);
            // If the conn lost its session scope mid-pass, heal before the next event.
            await input.heal?.().catch(() => {});
          }
        }
        if (failed) console.error(`projection: ${failed} event(s) failed this pass`);
        if (events.length < 1000) break;
        const next = events.at(-1)?.id;
        if (!next || next === after) throw new Error('core outbox cursor did not advance');
        after = next;
      }
      return { projected };
    },
  };
}
