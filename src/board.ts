/**
 * 老板看板的数据层：每个员工现在在干什么、接下来干什么、要发给他的消息原文。
 *
 * 本模块只读数据库、不读宿主状态，会跑在 Cloudflare Worker 上，因此不得 import node 内建模块。
 * 候选与排队判定来自本机调度器：它每轮用同一个 staffingPool 算出排队与每位员工的候选，写进 company_meta:board_view，
 * 这里读回来后再与数据库里的最新状态对齐（已被派走、已完成、已作废的不再显示）。
 */
import type { Surreal } from 'surrealdb';

export type BoardPhase = 'execute' | 'review';

/** One queued work item in dispatch order. `body` is the reason without its position; the reader adds the position. */
export interface BoardQueueItem {
  taskId: string;
  title: string;
  phase: BoardPhase;
  role: string;
  /** True when a pass-wide gate or a dispatch-blocked verdict keeps the item from being dispatched. */
  blocked: boolean;
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
