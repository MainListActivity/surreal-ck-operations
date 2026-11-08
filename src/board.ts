/**
 * 老板看板的数据层：每个员工现在在干什么、接下来干什么、要发给他的消息原文。
 *
 * 只读数据库、不读宿主状态，会跑在 Cloudflare Worker 上，因此不得 import node 内建模块（board-purity 测试逐级检查）。
 * 排队与候选判定来自本机调度器：它每轮用同一个 staffingPool 算出排队与每位员工的候选，写进 company_meta:board_view。
 * 这里读回来后与数据库现状对齐：已派走、已完成、已作废的不再显示；租约、交接与放行门按数据库现状计算。
 */
import type { RecordId, Surreal } from 'surrealdb';
import { latestFindings } from './dispatcher/brief.ts';
import { HANDOVER_ROWS } from './handover-window.ts';
import { acIdOf, dispatchText, renderMessage, stepOfTask, type MessageStep, type RenderContext } from './outbound-render.ts';

export type BoardPhase = 'execute' | 'review';

/** One queued work item in dispatch order. `body` is the reason without its position; the reader adds the position. */
export interface BoardQueueItem {
  taskId: string;
  title: string;
  phase: BoardPhase;
  role: string;
  /** True when a pass-wide gate, a held message or a dispatch-blocked verdict keeps the item from being dispatched. */
  blocked: boolean;
  /** True when some candidate, an existing employee or a seat to spawn one, may take the item in that pass. */
  eligible: boolean;
  body: string;
}

/** One queued item an employee could take, as the pass judged it for that employee. */
export interface BoardNextEntry {
  taskId: string;
  title: string;
  phase: BoardPhase;
  eligible: boolean;
  body: string;
}

export interface BoardEmployeeView {
  /** Absolute comm dir of the employee's channel, the one a dispatch message names. */
  commDir: string;
  next: BoardNextEntry[];
}

/**
 * The scheduler's view of the queue and of each employee's next rows. `queue` is in dispatch order, so a row's position is its
 * index plus one. `env` carries the values a rendered dispatch message names and the database cannot know.
 */
export interface BoardView {
  at: number;
  env: { sckBin: string; opsRepo: string };
  queue: BoardQueueItem[];
  employees: Record<string, BoardEmployeeView>;
}

/** The position phrase of a queue or next row: eligible rows read as ready, the others name what they wait for. */
export const boardReason = (position: number, eligible: boolean, body: string): string =>
  eligible ? `排在第 ${position} 位，可接` : `排在第 ${position} 位；${body}`;

/** Writes the latest pass's view. One row, replaced on every pass. */
export async function writeBoardView(db: Surreal, view: BoardView): Promise<void> {
  await db.query('UPSERT company_meta:board_view CONTENT { at: $at, json: $json };', { at: view.at, json: JSON.stringify(view) });
}

/** The latest pass's view, or undefined before the first pass has written one. */
export async function readBoardView(db: Surreal): Promise<BoardView | undefined> {
  const [rows] = await db.query<[Array<{ json?: string }>]>('SELECT json FROM company_meta:board_view;');
  const raw = rows?.[0]?.json;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as BoardView;
  } catch {
    return undefined;
  }
}

/** The local runner beats every thirty seconds; three missed beats read as offline. */
export const RUNNER_BEAT_MS = 30_000;
export const RUNNER_STALE_MS = 3 * RUNNER_BEAT_MS;
/** Company activity rows the board shows. */
export const BOARD_RECENT_ROWS = 20;
/** What the board says about a queued item whose message the owner holds: the tick never claims for a held message. */
const HELD_TEXT = '消息待老板放行';
const OPEN_STATES = ['ready', 'doing', 'review'];

/** Writes the runner's heartbeat. One row for the local runner, replaced on every beat. */
export async function writeRunnerHeartbeat(db: Surreal, beat: { runner: string; host: string; version: string }): Promise<void> {
  await db.query('UPSERT runner_heartbeat:current CONTENT { runner: $runner, host: $host, version: $version, at: time::now() };', beat);
}

export interface BoardRunner {
  state: 'online' | 'offline' | 'unknown';
  id?: string;
  host?: string;
  version?: string;
  /** Unix milliseconds of the last beat. */
  at?: number;
}

export interface BoardProgress {
  /** Unix milliseconds. */
  at: number;
  action: string;
  label: string;
  /** The first line of the entry's text, cut short. */
  summary: string;
}

/** What an employee is doing now: a live lease on a task, or idle. */
export type BoardNow =
  | {
    state: 'leased';
    taskId: string;
    title: string;
    phase: BoardPhase;
    /** Unix milliseconds of the claim that started this lease. */
    leaseStartedAt?: number;
    elapsedSeconds?: number;
    /** Unix milliseconds when the lease runs out. */
    leaseExpiresAt?: number;
    /** False when the lease has lapsed but the task is still bound to this employee. */
    leaseActive: boolean;
    progress?: BoardProgress;
  }
  | { state: 'idle'; idleSeconds?: number };

/** One queued item this employee could take next, with its place in the queue. */
export interface BoardNextRow {
  taskId: string;
  title: string;
  phase: BoardPhase;
  position: number;
  eligible: boolean;
  reason: string;
}

/** An unsent message for this employee, as the employee would receive it. */
export interface BoardOutboxRow {
  messageId: string;
  taskId: string;
  title: string;
  step: MessageStep;
  /** Rendered text: exactly what the dispatch sends, workdir line included when the task names one. */
  body: string;
  /**
   * True while the task names no worktree yet. Its claim allocates one, and the dispatch then appends a workdir line
   * that this text does not show yet.
   */
  workdirPending: boolean;
  hold: boolean;
  lang: 'zh';
  editable: true;
}

export interface BoardEmployee {
  id: string;
  /** The employee's definition id when it has one, otherwise its role. */
  name: string;
  role: string;
  def?: string;
  provider?: string;
  model?: string;
  project?: string;
  now: BoardNow;
  next: BoardNextRow[];
  outbox: BoardOutboxRow[];
}

export interface BoardUnassignedRow {
  taskId: string;
  title: string;
  phase: BoardPhase;
  position: number;
  blocked: boolean;
  eligible: boolean;
  reason: string;
}

export interface BoardActivity {
  /** Unix milliseconds. */
  at: number;
  actor: string;
  action: string;
  label: string;
  taskId?: string;
  taskTitle?: string;
}

export interface OwnerBoard {
  /** Unix milliseconds when this board was read. */
  at: number;
  /** When the scheduler last wrote its queue view; absent before its first pass. */
  scheduler?: { at: number; ageMs: number };
  runner: BoardRunner;
  employees: BoardEmployee[];
  unassigned: BoardUnassignedRow[];
  recent: BoardActivity[];
}

type Row = Record<string, unknown>;

/** Record ids come back as RecordId objects; the key is what the board shows and what the scheduler stored. */
const keyOf = (value: unknown): string =>
  value !== null && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : String(value ?? '');

/** Datetimes come back as Date objects; strings and Dates parse too. Unix milliseconds out. */
const dateMs = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && 'toDate' in value && typeof (value as { toDate: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  const time = new Date(value as string | Date).getTime();
  return Number.isNaN(time) ? undefined : time;
};

const ACTION_LABEL: Record<string, string> = {
  claim: '领取任务', checkpoint: '记录进展', submit: '提交成果', return: '退回返工', owner_reject: '老板退回',
  accept: '验收通过', owner_approve: '老板批准', block: '阻塞', released: '释放租约', revoked: '收回租约',
  task_project_update: '调整项目', proposal_voided: '提议作废',
};
const labelOf = (action: string): string => ACTION_LABEL[action] ?? action;

const SUMMARY_CHARS = 120;
const summaryOf = (text: unknown): string => {
  const first = typeof text === 'string' ? (text.trim().split(/\r?\n/)[0] ?? '') : '';
  return first.length > SUMMARY_CHARS ? `${first.slice(0, SUMMARY_CHARS)}…` : first;
};

/** The worktree a task names once it has been claimed: the workdir line a dispatch appends. */
const workdirOf = (worktree: unknown): string | undefined => {
  const path = worktree && typeof worktree === 'object' ? (worktree as { worktreePath?: unknown }).worktreePath : undefined;
  return typeof path === 'string' && path ? path : undefined;
};

/** A lane names its project; the company's own lane of a role names none. */
const projectOfLane = (lane: unknown): string | undefined => {
  const project = typeof lane === 'string' ? lane.split(':')[0] : undefined;
  return project && project !== 'company' ? project : undefined;
};

const rowsOf = (db: Surreal, sql: string, vars?: Record<string, unknown>): Promise<Row[]> =>
  db.query<[Row[]]>(sql, vars).then(result => result[0] ?? []);

/**
 * The findings file a rework message names: the newest return's, numbered over the window a claim's handover reads. Undefined when
 * the task has no return on record.
 */
export async function findingsFileOf(db: Surreal, task: RecordId): Promise<string | undefined> {
  // The window is read newest first and handed over oldest first, as the claim's handover history is.
  const history = await rowsOf(db, `SELECT id, action, actor, evidence, at, <string>at AS cat FROM audit
    WHERE task = $task AND !string::starts_with(action, 'ops_') ORDER BY at DESC, id DESC LIMIT ${HANDOVER_ROWS};`, { task });
  return latestFindings(history.reverse().map(row => ({ auditId: keyOf(row.id), action: String(row.action), actor: keyOf(row.actor),
    at: String(row.cat), evidence: typeof row.evidence === 'string' ? row.evidence : undefined })))?.file;
}

/**
 * The values a message of one task renders with for one employee. The board's outbox and the owner's edit of it both take their
 * values here, so the text the owner edits is the text the board shows. Undefined when the view lacks the employee's comm dir.
 */
export function renderContextFor(view: BoardView, employeeId: string,
  task: { taskId: string; step: MessageStep; acceptanceCriteria: unknown; findingsFile?: string }): RenderContext | undefined {
  const commDir = view.employees[employeeId]?.commDir;
  if (!commDir) return undefined;
  const acId = acIdOf(task.step, task.acceptanceCriteria);
  return {
    sckBin: view.env.sckBin, commDir, taskId: task.taskId,
    ...(task.findingsFile ? { findingsFile: task.findingsFile } : {}),
    ...(view.env.opsRepo ? { opsRepo: view.env.opsRepo } : {}),
    ...(acId ? { acId } : {}),
  };
}

/** The owner board, read from the database and the scheduler's latest view. Read-only. */
export async function readBoard(db: Surreal, opts: { now?: number } = {}): Promise<OwnerBoard> {
  const now = opts.now ?? Date.now();
  const nowSec = Math.floor(now / 1000);
  const [view, beats, employeeRows, openRows, recentRows] = await Promise.all([
    readBoardView(db),
    rowsOf(db, 'SELECT runner, host, version, at FROM runner_heartbeat ORDER BY at DESC LIMIT 1;'),
    rowsOf(db, `SELECT id, role, def, provider, model, idle_since, lane FROM employee
      WHERE revoked != true AND retired != true AND (def != NONE OR paseo_agent_id != NONE) ORDER BY id;`),
    rowsOf(db, `SELECT id, title, state, reviewer_role, current_employee, lease_expires_at, project, worktree, acceptance_criteria
      FROM task WHERE state IN ['ready', 'doing', 'review'] OR current_employee != NONE;`),
    rowsOf(db, `SELECT task, actor, action, at FROM audit WHERE !string::starts_with(action, 'ops_')
      ORDER BY at DESC LIMIT ${BOARD_RECENT_ROWS};`),
  ]);
  const tasks = new Map(openRows.map(row => [keyOf(row.id), row] as const));
  const holders = openRows.filter(row => row.current_employee && OPEN_STATES.includes(String(row.state)));

  // The queue as it stands now: only items whose task still waits for the same phase and has no holder.
  const queue = (view?.queue ?? []).filter(item => {
    const row = tasks.get(item.taskId);
    if (!row || row.current_employee) return false;
    return item.phase === 'review' ? row.state === 'review' && row.reviewer_role !== 'owner' : row.state === 'ready' || row.state === 'doing';
  });
  const positionOf = new Map(queue.map((item, index) => [`${item.taskId}:${item.phase}`, index + 1] as const));

  // Only the tasks this board shows in detail are read further: each holder's and each queued item's.
  const focus = new Map<string, Row>();
  for (const row of holders) focus.set(keyOf(row.id), row);
  for (const item of queue) {
    const row = tasks.get(item.taskId);
    if (row) focus.set(item.taskId, row);
  }
  const focusIds = [...focus.values()].map(row => row.id);
  const rowsIn = (sql: string, ids: unknown[]): Promise<Row[]> => ids.length ? rowsOf(db, sql, { ids }) : Promise.resolve([]);
  const [returns, drafts, claims, progress] = await Promise.all([
    rowsIn("SELECT task FROM audit WHERE task IN $ids AND action IN ['return', 'owner_reject'];", focusIds),
    rowsIn("SELECT * FROM outbound_message WHERE task IN $ids AND state != 'sent' ORDER BY created_at DESC;", focusIds),
    Promise.all(holders.map(row => rowsOf(db, "SELECT at FROM audit WHERE task = $task AND action = 'claim' ORDER BY at DESC LIMIT 1;", { task: row.id }))),
    Promise.all(holders.map(row => rowsOf(db, `SELECT action, evidence, at FROM audit
      WHERE task = $task AND action != 'claim' AND !string::starts_with(action, 'ops_') ORDER BY at DESC LIMIT 1;`, { task: row.id }))),
  ]);
  const leaseFacts = new Map<string, { claimAt?: number; progress?: BoardProgress }>();
  holders.forEach((row, index) => {
    const last = progress[index]?.[0];
    leaseFacts.set(keyOf(row.id), {
      claimAt: dateMs(claims[index]?.[0]?.at),
      ...(last ? { progress: { at: dateMs(last.at) ?? 0, action: String(last.action), label: labelOf(String(last.action)), summary: summaryOf(last.evidence) } } : {}),
    });
  });

  const returned = new Set(returns.map(row => keyOf(row.task)));
  const draftOf = new Map<string, Row>();
  for (const row of drafts) {
    const key = `${keyOf(row.task)}:${String(row.step)}`;
    if (!draftOf.has(key)) draftOf.set(key, row);
  }
  const stepOf = (taskId: string): MessageStep => stepOfTask(String(tasks.get(taskId)?.state), returned.has(taskId));
  // The owner's hold on the message a dispatch of this task would send next. The tick never claims for a held message.
  const heldAt = (taskId: string): boolean => {
    const draft = draftOf.get(`${taskId}:${stepOf(taskId)}`);
    return draft !== undefined && (draft.hold === true || draft.state === 'held');
  };

  // A rework message names the findings file of the newest return.
  const findingsFile = new Map<string, string>();
  await Promise.all([...focus.keys()].filter(taskId => returned.has(taskId)).map(async taskId => {
    const file = await findingsFileOf(db, focus.get(taskId)!.id as RecordId);
    if (file) findingsFile.set(taskId, file);
  }));

  // The text a dispatch of this task to this employee would send now: the same render and join the send path makes. Undefined when the
  // view lacks the employee's comm dir or the task has no draft for its next step, so the board shows nothing it cannot render exactly.
  const outboxOf = (employeeId: string, taskId: string): BoardOutboxRow | undefined => {
    const row = tasks.get(taskId);
    if (!view || !row) return undefined;
    const step = stepOf(taskId);
    const draft = draftOf.get(`${taskId}:${step}`);
    if (!draft) return undefined;
    const ctx = renderContextFor(view, employeeId, { taskId, step, acceptanceCriteria: row.acceptance_criteria, findingsFile: findingsFile.get(taskId) });
    if (!ctx) return undefined;
    const workdir = workdirOf(row.worktree);
    return { messageId: keyOf(draft.id), taskId, title: String(row.title ?? ''), step,
      body: dispatchText(renderMessage(String(draft.body ?? ''), ctx), workdir), workdirPending: workdir === undefined, hold: heldAt(taskId), lang: 'zh', editable: true };
  };

  const employees: BoardEmployee[] = employeeRows.map(row => {
    const id = keyOf(row.id);
    const lease = holders.find(task => keyOf(task.current_employee) === id);
    const leaseTask = lease ? keyOf(lease.id) : undefined;
    const facts = leaseTask ? leaseFacts.get(leaseTask) : undefined;
    const expires = lease?.lease_expires_at;
    const doing: BoardNow = lease && leaseTask
      ? {
        state: 'leased', taskId: leaseTask, title: String(lease.title ?? ''), phase: String(lease.state) === 'review' ? 'review' : 'execute',
        ...(facts?.claimAt !== undefined ? { leaseStartedAt: facts.claimAt, elapsedSeconds: Math.max(0, Math.floor((now - facts.claimAt) / 1000)) } : {}),
        ...(typeof expires === 'number' ? { leaseExpiresAt: expires * 1000 } : {}),
        leaseActive: typeof expires === 'number' && expires > nowSec,
        ...(facts?.progress ? { progress: facts.progress } : {}),
      }
      : { state: 'idle', ...(typeof row.idle_since === 'number' ? { idleSeconds: Math.max(0, nowSec - row.idle_since) } : {}) };
    const next: BoardNextRow[] = (view?.employees[id]?.next ?? []).flatMap(entry => {
      const position = positionOf.get(`${entry.taskId}:${entry.phase}`);
      if (position === undefined) return [];
      const held = heldAt(entry.taskId);
      const eligible = entry.eligible && !held;
      return [{ taskId: entry.taskId, title: String(tasks.get(entry.taskId)?.title ?? ''), phase: entry.phase, position, eligible,
        reason: boardReason(position, eligible, held ? HELD_TEXT : entry.body) }];
    });
    // The holder's message went out at its claim, so the outbox holds only what would go to this employee next.
    const outbox = next.flatMap(entry => {
      const message = outboxOf(id, entry.taskId);
      return message ? [message] : [];
    });
    const project = lease?.project ? keyOf(lease.project) : projectOfLane(row.lane);
    return {
      id, name: row.def ? keyOf(row.def) : String(row.role ?? id), role: String(row.role ?? ''),
      ...(row.def ? { def: keyOf(row.def) } : {}),
      ...(row.provider ? { provider: String(row.provider) } : {}),
      ...(row.model ? { model: String(row.model) } : {}),
      ...(project ? { project } : {}),
      now: doing, next, outbox,
    };
  });

  const unassigned: BoardUnassignedRow[] = queue.map((item, index) => {
    const position = index + 1;
    const held = heldAt(item.taskId);
    const eligible = item.eligible && !held;
    return { taskId: item.taskId, title: String(tasks.get(item.taskId)?.title ?? item.title), phase: item.phase, position,
      blocked: item.blocked || held, eligible, reason: boardReason(position, eligible, held ? HELD_TEXT : item.body) };
  });

  const outside = new Map<string, unknown>();
  for (const row of recentRows) if (row.task && !tasks.has(keyOf(row.task))) outside.set(keyOf(row.task), row.task);
  const titles = new Map<string, string>();
  if (outside.size) {
    for (const row of await rowsOf(db, 'SELECT id, title FROM task WHERE id IN $ids;', { ids: [...outside.values()] })) {
      titles.set(keyOf(row.id), String(row.title ?? ''));
    }
  }
  const recent: BoardActivity[] = recentRows.map(row => {
    const taskId = row.task ? keyOf(row.task) : undefined;
    const taskTitle = taskId ? (tasks.has(taskId) ? String(tasks.get(taskId)?.title ?? '') : titles.get(taskId)) : undefined;
    return { at: dateMs(row.at) ?? 0, actor: keyOf(row.actor), action: String(row.action), label: labelOf(String(row.action)),
      ...(taskId ? { taskId } : {}), ...(taskTitle !== undefined ? { taskTitle } : {}) };
  });

  const beat = beats[0];
  const beatAt = dateMs(beat?.at);
  const runner: BoardRunner = beat === undefined ? { state: 'unknown' } : {
    state: beatAt !== undefined && now - beatAt <= RUNNER_STALE_MS ? 'online' : 'offline',
    id: String(beat.runner ?? ''), host: String(beat.host ?? ''), version: String(beat.version ?? ''),
    ...(beatAt !== undefined ? { at: beatAt } : {}),
  };
  return {
    at: now,
    ...(view ? { scheduler: { at: view.at, ageMs: Math.max(0, now - view.at) } } : {}),
    runner, employees, unassigned, recent,
  };
}
