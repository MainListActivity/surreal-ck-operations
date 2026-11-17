// Synthetic board fixtures for board.snapshot and board.task. The fake database answers the SQL the board reads, by
// fragment, so the real readBoard, readBoardTask and ownerApi run unchanged. Nothing here is production data.
import { RecordId } from 'surrealdb';
import type { BoardView } from '../../src/board.ts';
import type { OwnerApiContext } from '../../src/owner-api.ts';

export const NOW = 1_800_000_000_000;
export const SEC = Math.floor(NOW / 1000);
const rid = (table: string, id: string) => new RecordId(table, id);

export interface BoardFixture {
  view: BoardView;
  /** Task rows by key, as the task table holds them. */
  tasks: Record<string, Record<string, unknown>>;
  /** Unsent message rows, newest first. */
  unsent: Record<string, unknown>[];
  employees: Record<string, unknown>[];
  /** Tasks with a holder: the claim time and the latest non-claim action. */
  progress: Record<string, { claimAt: number; action: string; evidence: string; at: number }>;
}

const EMPLOYEES = [
  { id: rid('employee', 'e1'), role: 'engineering', def: rid('employee_def', 'eng-1'), provider: 'codex', model: 'auto' },
  { id: rid('employee', 'e2'), role: 'qa', def: rid('employee_def', 'qa-1'), provider: 'codex', model: 'auto' },
];

/** The small board the unit tests read: a queue with a held draft, a gate, a leased task, a review, a block and a terminal task. */
export function smallBoardFixture(): BoardFixture {
  return {
    view: {
      at: NOW - 5_000,
      env: { sckBin: '/sck', opsRepo: '/ops' },
      queue: [
        { taskId: 't-queue', title: '队列任务', phase: 'execute', role: 'engineering', blocked: false, eligible: true, body: '依赖已解锁，等待派工' },
        { taskId: 't-held', title: '扣住任务', phase: 'execute', role: 'engineering', blocked: false, eligible: true, body: '依赖已解锁，等待派工' },
        { taskId: 't-gate', title: '门槛任务', phase: 'execute', role: 'engineering', blocked: true, eligible: false, body: '全员配额耗尽' },
      ],
      employees: {
        e1: {
          commDir: '/comm/e1',
          next: [
            { taskId: 't-queue', title: '队列任务', phase: 'execute', eligible: true, body: '可接' },
            { taskId: 't-gate', title: '门槛任务', phase: 'execute', eligible: false, body: '配额耗尽' },
          ],
        },
      },
    },
    tasks: {
      't-doing': { id: rid('task', 't-doing'), title: '在途任务', state: 'doing', reviewer_role: 'qa', current_employee: rid('employee', 'e1'), lease_expires_at: SEC + 600 },
      't-queue': { id: rid('task', 't-queue'), title: '队列任务', state: 'ready', reviewer_role: 'qa' },
      't-held': { id: rid('task', 't-held'), title: '扣住任务', state: 'ready', reviewer_role: 'qa' },
      't-gate': { id: rid('task', 't-gate'), title: '门槛任务', state: 'ready', reviewer_role: 'qa' },
      't-owner': { id: rid('task', 't-owner'), title: '老板复核任务', state: 'review', reviewer_role: 'owner' },
      't-blocked': { id: rid('task', 't-blocked'), title: '阻塞任务', state: 'blocked', blocked_to: 'owner', reviewer_role: 'qa' },
      't-wait': { id: rid('task', 't-wait'), title: '等待恢复任务', state: 'blocked', resume_state: 'ready', reviewer_role: 'qa' },
      't-done': { id: rid('task', 't-done'), title: '完成任务', state: 'done', reviewer_role: 'qa' },
      't-lapsed': { id: rid('task', 't-lapsed'), title: '租约过期任务', state: 'doing', reviewer_role: 'qa', current_employee: rid('employee', 'e2'), lease_expires_at: SEC - 60 },
    },
    unsent: [
      { id: rid('outbound_message', 'm-held'), task: rid('task', 't-held'), step: 'execute', state: 'draft', hold: true, body: '老板没放行的派工正文', created_at: new Date(NOW - 60_000) },
    ],
    employees: EMPLOYEES,
    progress: { 't-doing': { claimAt: NOW - 120_000, action: 'checkpoint', evidence: '已完成一半', at: NOW - 60_000 } },
  };
}

/**
 * A board with `queued` ready tasks in the queue (`q-000`, `q-001`, …), the first three eligible, and 40 held or unheld
 * drafts with bodies: the shape that overflows the relay budget. Each queued task is the real row a board read finds.
 */
export function largeBoardFixture(queued = 300): BoardFixture {
  const ids = Array.from({ length: queued }, (_, index) => `q-${String(index).padStart(3, '0')}`);
  const tasks: BoardFixture['tasks'] = {};
  for (const id of ids) tasks[id] = { id: rid('task', id), title: `排队任务 ${id}`, state: 'ready', reviewer_role: 'qa' };
  return {
    view: {
      at: NOW - 5_000,
      env: { sckBin: '/sck', opsRepo: '/ops' },
      queue: ids.map((id, index) => ({
        taskId: id, title: `排队任务 ${id}`, phase: 'execute', role: 'engineering', blocked: false, eligible: index < 3,
        body: index < 3 ? '依赖已解锁，等待派工' : '等待前序任务释放名额',
      })),
      employees: {
        e1: {
          commDir: '/comm/e1',
          next: ids.slice(0, 5).map((id, index) => ({ taskId: id, title: `排队任务 ${id}`, phase: 'execute', eligible: index < 3, body: '可接' })),
        },
      },
    },
    tasks,
    unsent: ids.slice(0, 40).map((id, index) => ({
      id: rid('outbound_message', `m-${index}`), task: rid('task', id), step: 'execute', state: 'draft', hold: index % 2 === 0,
      body: `派工正文 ${id}：${'依赖与交付要求，'.repeat(60)}`, created_at: new Date(NOW - 60_000 - index),
    })),
    employees: EMPLOYEES,
    progress: {},
  };
}

/**
 * The widest single-task answer a board can give: `w-target` is a candidate of every one of `employees` employees, and its title,
 * queue reason and each candidate reason are `textChars` characters long. board.task must still fit the relay budget for it.
 */
export function wideBoardFixture(employees = 60, textChars = 300): BoardFixture {
  const title = `宽任务${'标题'.repeat(textChars)}`;
  const body = `等待派工条件：${'说明'.repeat(textChars)}`;
  const ids = Array.from({ length: employees }, (_, index) => `w${String(index).padStart(3, '0')}`);
  return {
    view: {
      at: NOW - 5_000,
      env: { sckBin: '/sck', opsRepo: '/ops' },
      queue: [{ taskId: 'w-target', title, phase: 'execute', role: 'engineering', blocked: true, eligible: false, body }],
      employees: Object.fromEntries(ids.map(id => [id, { commDir: `/comm/${id}`, next: [{ taskId: 'w-target', title, phase: 'execute', eligible: false, body }] }])),
    },
    tasks: { 'w-target': { id: rid('task', 'w-target'), title, state: 'ready', reviewer_role: 'qa' } },
    unsent: [],
    employees: ids.map(id => ({ id: rid('employee', id), role: 'engineering', def: rid('employee_def', `eng-${id}`), provider: 'codex', model: 'auto' })),
    progress: {},
  };
}

function answer(fixture: BoardFixture, sql: string, vars: Record<string, unknown>): unknown[] {
  if (sql.includes('company_meta:board_view') || sql.includes('runner_board')) return [[{ json: JSON.stringify(fixture.view), at: fixture.view.at }]];
  if (sql.includes('FROM runner_heartbeat')) return [[{ runner: 'r1', host: 'host-1', version: '0.13.35', at: new Date(NOW - 10_000) }]];
  if (sql.includes('FROM employee WHERE revoked')) return [fixture.employees];
  if (sql.includes('FROM task WHERE state IN')) {
    return [Object.values(fixture.tasks).filter(row => ['ready', 'doing', 'review'].includes(String(row.state)) || row.current_employee)];
  }
  if (sql.includes('SELECT task, actor, action, at FROM audit')) return [[]];
  if (sql.includes('FROM agent_policy')) return [[]];
  if (sql.includes("FROM outbound_message WHERE state != 'sent'")) return [fixture.unsent];
  if (sql.includes('VALUE owner_lang')) return [['zh']];
  if (sql.includes("action IN ['return', 'owner_reject']")) return [[]];
  if (sql.includes('FROM task WHERE id IN $ids')) {
    const wanted = new Set(((vars.ids ?? []) as RecordId[]).map(id => String(id.id)));
    return [Object.entries(fixture.tasks).filter(([id]) => wanted.has(id)).map(([, row]) => ({ id: row.id, title: row.title }))];
  }
  if (sql.includes('FROM $employee')) {
    const id = String((vars.employee as RecordId).id);
    return [fixture.employees.filter(row => String((row.id as RecordId).id) === id)];
  }
  if (sql.includes('FROM $task')) {
    const row = fixture.tasks[String((vars.task as RecordId).id)];
    return [row ? [row] : []];
  }
  if (sql.includes('FROM audit') && sql.includes('LIMIT 1')) {
    const fact = fixture.progress[String((vars.task as RecordId).id)];
    if (!fact) return [[]];
    return [sql.includes("action = 'claim'") ? [{ at: new Date(fact.claimAt) }] : [{ action: fact.action, evidence: fact.evidence, at: new Date(fact.at) }]];
  }
  return [[]];
}

/** A fake database over a fixture. Statements the board does not read answer no rows. */
export function boardFixtureDb(fixture: BoardFixture = smallBoardFixture()) {
  const queries: string[] = [];
  const db = {
    query: async (sql: string, vars: Record<string, unknown> = {}) => {
      const text = sql.replace(/\s+/g, ' ');
      queries.push(text);
      return answer(fixture, text, vars);
    },
    select: async () => undefined,
  };
  return { db, queries };
}

/** The owner API context the board commands need: only the database is read. */
export function boardContext(db: unknown): OwnerApiContext {
  return { db: { db } as never, core: {} as never, owner: {} as never, workforce: {} as never, messages: {} as never,
    opsRepo: '/ops' } as OwnerApiContext;
}
