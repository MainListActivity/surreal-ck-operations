import type { WorkContext } from "../../../src/work-context.ts";
/**
 * 页面侧的数据形状。镜像 src/board.ts 的 OwnerBoard（字段以该文件为准）。
 * 页面不 import 服务端模块（那些会拉进 surrealdb 等依赖）。
 */

export type BoardPhase = 'execute' | 'review';

/** 译文状态：ready 已译、missing 缺译文、stale 原文已改需重译。没有 translation 字段表示「不翻译」。 */
export interface BoardTranslation {
  lang: string;
  status: 'ready' | 'missing' | 'stale';
  /** 员工待发行上的译文是派工文本（含工作目录行）；消息列表上是存储的译文。 */
  text?: string;
}

/** 一条未发消息，按老板看到的原文（存储原文，未渲染）。 */
export interface BoardMessageRow {
  context?: WorkContext;
  messageId: string;
  taskId: string;
  title: string;
  step: string;
  state: 'draft' | 'held';
  hold: boolean;
  /** 存储原文（原文）。 */
  body: string;
  /** 译文的语言（若有译文）。 */
  lang?: string;
  /** 持有者语言下的译文。队列项或员工无语言时没有。 */
  translation?: BoardTranslation;
  /** 持有任务的员工编号；排队中的任务没有。 */
  employeeId?: string;
  editable: true;
}

export type BoardNow =
  | {
    state: 'leased';
    taskId: string;
    title: string;
    phase: BoardPhase;
    leaseStartedAt?: number;
    elapsedSeconds?: number;
    leaseExpiresAt?: number;
    leaseActive: boolean;
    progress?: { at: number; action: string; label: string; summary: string };
  }
  | { state: 'idle'; idleSeconds?: number };

export interface BoardNextRow {
  taskId: string;
  title: string;
  phase: BoardPhase;
  position: number;
  eligible: boolean;
  reason: string;
}

/** 员工待发消息（渲染后的派工文本，员工收到的样子）。 */
export interface BoardOutboxRow {
  context?: WorkContext;
  messageId: string;
  taskId: string;
  title: string;
  step: string;
  body: string;
  workdirPending: boolean;
  hold: boolean;
  lang: 'zh';
  editable: true;
  translation?: BoardTranslation;
}

export interface BoardEmployee {
  id: string;
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
  message?: BoardMessageRow;
}

export interface BoardActivity {
  at: number;
  actor: string;
  action: string;
  label: string;
  taskId?: string;
  taskTitle?: string;
}

export interface OwnerBoard {
  at: number;
  scheduler?: { at: number; ageMs: number };
  runner: { state: 'online' | 'offline' | 'unknown'; id?: string; host?: string; version?: string; at?: number };
  employees: BoardEmployee[];
  unassigned: BoardUnassignedRow[];
  recent: BoardActivity[];
  /** 全部未发消息（state != sent），按任务标题、步骤、创建时间排序。页面容忍缺失（按空列表处理）。 */
  messages?: BoardMessageRow[];
}
