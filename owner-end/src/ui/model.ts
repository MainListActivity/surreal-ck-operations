/**
 * 页面的纯函数：看板视图模型、草稿、错误文案、表单解析。不依赖 DOM 与 preact，供 bun test 直接测试。
 */
import type { CommandGroup, CommandSpec } from '../command-catalog.ts';
import type { BoardActivity, BoardEmployee, BoardMessageRow, BoardNow, BoardNextRow, BoardOutboxRow, BoardTranslation, BoardUnassignedRow, OwnerBoard } from './types.ts';

export const RUNNER_ZH: Record<string, string> = { online: '在线', offline: '离线', unknown: '未知' };
export const PHASE_ZH: Record<string, string> = { execute: '执行', review: '复核' };
export const STEP_ZH: Record<string, string> = { execute: '执行', review: '复核', rework: '返工', nudge: '催办', notice: '通知' };

/** 秒数 → 中文时长：不足一分钟写秒，超过一小时写小时。 */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} 秒`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/** 本地时间 HH:MM。 */
export function clockText(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 相对时间。以看板自己的时钟为基准（now），页面时钟快慢不影响判断。超过一小时改写钟点。 */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return clockText(at);
}

export interface TranslationView {
  kind: 'none' | 'ready' | 'missing' | 'stale' | 'unknown';
  label: string;
  text?: string;
  /** 缺译文或译文过期时为 true：发送前必须先重译。 */
  blocksSend: boolean;
}

export function translationView(t: BoardTranslation | undefined): TranslationView {
  if (!t) return { kind: 'none', label: '不翻译', blocksSend: false };
  switch (t.status) {
    case 'ready': return { kind: 'ready', label: '已译', text: t.text ?? '', blocksSend: false };
    case 'missing': return { kind: 'missing', label: '缺译文', blocksSend: true };
    case 'stale': return { kind: 'stale', label: '原文已改，需重译', blocksSend: true };
    default: return { kind: 'unknown', label: '译文状态未知', blocksSend: true };
  }
}

export interface NowView {
  status: 'executing' | 'reviewing' | 'idle';
  statusText: string;
  title?: string;
  phaseText?: string;
  facts: string[];
  progressText?: string;
  noTaskText?: string;
}

/** 员工「现在」：租约中展示任务、阶段、已用时长、租约与最近进展；空闲展示空闲时长。 */
export function nowView(now: BoardNow | undefined, at: number): NowView {
  if (!now || now.state !== 'leased') {
    const idle = now?.state === 'idle' ? now.idleSeconds : undefined;
    return {
      status: 'idle',
      statusText: idle != null ? `空闲 ${durationText(idle)}` : '空闲',
      facts: [],
      noTaskText: '当前没有领取任务',
    };
  }
  const facts: string[] = [];
  if (now.elapsedSeconds != null) facts.push(`已用 ${durationText(now.elapsedSeconds)}`);
  if (now.leaseExpiresAt != null) {
    facts.push(now.leaseActive === false ? '租约已过期，仍绑定本员工' : `租约到 ${clockText(now.leaseExpiresAt)}`);
  }
  const progressText = now.progress
    ? [`最近进展：${now.progress.label}`, now.progress.at ? agoText(now.progress.at, at) : '', now.progress.summary]
      .filter(Boolean).join(' · ')
    : undefined;
  const reviewing = now.phase === 'review';
  return {
    status: reviewing ? 'reviewing' : 'executing',
    statusText: reviewing ? '复核中' : '执行中',
    title: now.title,
    phaseText: PHASE_ZH[now.phase] ?? now.phase,
    facts,
    progressText,
  };
}

export interface NextView {
  key: string;
  title: string;
  phaseText: string;
  position: number;
  eligible: boolean;
  reason: string;
}

export function nextView(row: BoardNextRow): NextView {
  return {
    key: row.taskId,
    title: row.title,
    phaseText: PHASE_ZH[row.phase] ?? row.phase,
    position: row.position,
    eligible: row.eligible,
    reason: row.reason,
  };
}

export interface MessageView {
  /** 空串表示后端没有给消息编号：这条消息只能查看，不能操作。 */
  messageId: string;
  title: string;
  stepText: string;
  body: string;
  hold: boolean;
  taskId?: string;
}

export interface OutboxView extends MessageView {
  workdirPending: boolean;
  translation: TranslationView;
}

export interface EmployeeView {
  id: string;
  name: string;
  role: string;
  subtitle: string;
  now: NowView;
  next: NextView[];
  outbox: OutboxView[];
}

export function messageIdOf(row: { messageId?: string; id?: string }): string {
  return row.messageId ?? row.id ?? '';
}

export function stepText(step: string | undefined): string {
  return step ? (STEP_ZH[step] ?? step) : '';
}

export function messageView(row: BoardMessageRow): MessageView {
  return {
    messageId: messageIdOf(row),
    title: row.title ?? row.taskId ?? '',
    stepText: stepText(row.step),
    body: row.body,
    hold: row.hold === true,
    taskId: row.taskId,
  };
}

export function outboxView(row: BoardOutboxRow): OutboxView {
  return {
    messageId: row.messageId,
    title: row.title,
    stepText: stepText(row.step),
    body: row.body,
    hold: row.hold === true,
    taskId: row.taskId,
    workdirPending: row.workdirPending === true,
    translation: translationView(row.translation),
  };
}

export function employeeView(e: BoardEmployee, at: number): EmployeeView {
  return {
    id: e.id,
    name: e.name,
    role: e.role,
    subtitle: [e.provider, e.model, e.project].filter(Boolean).join(' · '),
    now: nowView(e.now, at),
    next: (e.next ?? []).map(nextView),
    outbox: (e.outbox ?? []).map(outboxView),
  };
}

export interface QueueView {
  key: string;
  taskId: string;
  title: string;
  phaseText: string;
  position: number;
  reason: string;
  blocked: boolean;
  eligible: boolean;
  message?: MessageView;
}

export function queueView(row: BoardUnassignedRow): QueueView {
  return {
    key: row.taskId,
    taskId: row.taskId,
    title: row.title,
    phaseText: PHASE_ZH[row.phase] ?? row.phase,
    position: row.position,
    reason: row.reason,
    blocked: row.blocked === true,
    eligible: row.eligible === true,
    message: row.message ? messageView(row.message) : undefined,
  };
}

/**
 * 「其它未发消息」：messages 里没有出现在任何员工卡片或排队项中的消息，按出现顺序去重。
 * shown 是已经在卡片或排队项里显示过的消息编号。
 */
export function otherUnsentMessages(messages: readonly BoardMessageRow[] | undefined, shown: ReadonlySet<string>): MessageView[] {
  const seen = new Set<string>();
  const out: MessageView[] = [];
  for (const row of messages ?? []) {
    const id = messageIdOf(row);
    if (id && (shown.has(id) || seen.has(id))) continue;
    if (id) seen.add(id);
    out.push(messageView(row));
  }
  return out;
}

/** 卡片与排队项里已经显示过的消息编号。 */
export function shownMessageIds(board: Pick<OwnerBoard, 'employees' | 'unassigned'>): Set<string> {
  const ids = new Set<string>();
  for (const e of board.employees ?? []) for (const o of e.outbox ?? []) ids.add(o.messageId);
  for (const u of board.unassigned ?? []) if (u.message) ids.add(messageIdOf(u.message));
  return ids;
}

export interface RecentView {
  key: string;
  time: string;
  actor: string;
  label: string;
  taskTitle?: string;
}

export function recentView(a: BoardActivity, index: number): RecentView {
  return {
    key: `${a.at}-${index}`,
    time: clockText(a.at),
    actor: a.actor,
    label: a.label || a.action,
    taskTitle: a.taskTitle,
  };
}

export interface BoardViewModel {
  runner: { stateText: string; tone: 'success' | 'danger' | ''; detail: string };
  scheduler: string;
  employees: EmployeeView[];
  queue: QueueView[];
  others: MessageView[];
  recent: RecentView[];
}

/** 把看板原始数据映射成页面要画的结构。 */
export function buildBoardView(board: OwnerBoard): BoardViewModel {
  const at = board.at;
  const runnerState = board.runner?.state ?? 'unknown';
  const version = board.runner?.version;
  const runnerDetail = [
    board.runner?.at ? `心跳 ${agoText(board.runner.at, at)}` : '',
    version && version !== 'unknown' ? `v${version}` : '',
  ].filter(Boolean).join(' · ');
  const scheduler = board.scheduler?.ageMs != null
    ? `调度器 ${durationText(board.scheduler.ageMs / 1000)}前更新`
    : board.scheduler?.at
      ? `调度器 ${agoText(board.scheduler.at, at)}更新`
      : '调度器还没有写出排队';
  return {
    runner: {
      stateText: `执行端${RUNNER_ZH[runnerState] ?? '未知'}`,
      tone: runnerState === 'online' ? 'success' : runnerState === 'offline' ? 'danger' : '',
      detail: runnerDetail,
    },
    scheduler,
    employees: (board.employees ?? []).map(e => employeeView(e, at)),
    queue: (board.unassigned ?? []).map(queueView),
    others: otherUnsentMessages(board.messages, shownMessageIds(board)),
    recent: (board.recent ?? []).map(recentView),
  };
}

// ---- 草稿：未保存的原文按 messageId 保存，刷新后保留 ----

export type Drafts = Readonly<Record<string, string>>;

export function draftOf(drafts: Drafts, messageId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(drafts, messageId) ? drafts[messageId] : undefined;
}

/** 有草稿且与服务端原文不同才算未保存修改。 */
export function isDirty(drafts: Drafts, messageId: string, saved: string): boolean {
  const draft = draftOf(drafts, messageId);
  return draft !== undefined && draft !== saved;
}

export function withDraft(drafts: Drafts, messageId: string, value: string): Drafts {
  return { ...drafts, [messageId]: value };
}

export function withoutDraft(drafts: Drafts, messageId: string): Drafts {
  const next: Record<string, string> = { ...drafts };
  delete next[messageId];
  return next;
}

// ---- 错误文案 ----

export const ERROR_TEXT: Record<string, string> = {
  invalid: '输入有误',
  unauthorized: '登录已过期，请重新登录',
  forbidden: '没有权限执行这个操作',
  not_found: '没有找到这条记录',
  conflict: '状态已变化，请刷新后重试',
  upstream_error: '上游服务出错，请稍后重试',
  unavailable: '服务暂不可用，请稍后重试',
  pending: '已排队，执行端处理中',
  network: '网络不可用，请检查连接后重试',
};

/** 服务端给了 message 就原样显示；否则按错误码给中文说明。 */
export function errorText(error: { code?: string; message?: string }): string {
  const message = error.message?.trim();
  if (message) return message;
  if (error.code && ERROR_TEXT[error.code]) return ERROR_TEXT[error.code];
  return `操作失败${error.code ? `（${error.code}）` : ''}`;
}

// ---- 表单解析 ----

/** 文本框按行切分：去掉首尾空白与空行，保持顺序并去重。 */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

/** 解析可选的 JSON 对象文本。空串视为没有值；非对象或语法错误返回 error。 */
export function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '参数必须是 JSON 对象' };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: '参数不是合法的 JSON' };
  }
}

/** 任务记录的 id 可能是字符串 'task:⟨x⟩'、'task:x'，或 {tb, id} 形式；统一成不带表名的 id。 */
export function taskIdOf(row: { id?: unknown }): string {
  const raw = row.id;
  if (typeof raw === 'string') return raw.replace(/^task:/, '').replace(/^⟨|⟩$/g, '');
  if (raw && typeof raw === 'object' && 'id' in raw) return String((raw as { id: unknown }).id).replace(/^⟨|⟩$/g, '');
  return String(raw ?? '');
}

export const TASK_STATE_ZH: Record<string, string> = {
  planned: '计划中', blocked: '阻塞', ready: '待领取', doing: '进行中', review: '复核中', done: '已完成', void: '已作废',
};

export interface TaskFormValues {
  title: string;
  requirement: string;
  acceptanceText: string;
  executorRole: string;
  reviewerRole: string;
  type: string;
}

/** 新建需求的必填校验：返回中文问题列表，空数组表示可以提交。 */
export function validateTaskForm(v: TaskFormValues): string[] {
  const problems: string[] = [];
  if (!v.title.trim()) problems.push('标题必填');
  if (!v.requirement.trim()) problems.push('需求原文必填');
  if (!v.acceptanceText.trim()) problems.push('验收标准必填');
  if (!v.executorRole) problems.push('请选择执行岗');
  if (!v.reviewerRole) problems.push('请选择复核岗');
  return problems;
}

/** 改派至少要改一个岗位，并写明原因。 */
export function validateReassign(v: { executorRole: string; reviewerRole: string; note: string }): string[] {
  const problems: string[] = [];
  if (!v.executorRole && !v.reviewerRole) problems.push('改派至少选一个岗位');
  if (!v.note.trim()) problems.push('请写明改派原因');
  return problems;
}

export function noteLanes(notes: ReadonlyArray<{ lane: string }>): string[] {
  return [...new Set(notes.map(n => n.lane))].sort();
}

export function pageOf(hash: string): 'board' | 'requirements' | 'tasks' | 'notes' | 'staff' | 'ops' {
  const name = hash.replace(/^#\/?/, '');
  return name === 'requirements' || name === 'tasks' || name === 'notes' || name === 'staff' || name === 'ops' ? name : 'board';
}

/** 命令面板的一组命令。 */
export interface CatalogGroupView {
  group: CommandGroup;
  commands: CommandSpec[];
}

/**
 * 按关键字筛选（命令名、用途或分组，不分大小写），再按分组归并。组的先后与目录里首次出现的顺序一致；
 * 没有匹配命令的组不返回。
 */
export function catalogGroups(entries: readonly CommandSpec[], query: string): CatalogGroupView[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<CommandGroup, CommandSpec[]>();
  for (const spec of entries) {
    if (needle && ![spec.command, spec.title, spec.group].some(text => text.toLowerCase().includes(needle))) continue;
    groups.set(spec.group, [...(groups.get(spec.group) ?? []), spec]);
  }
  return [...groups].map(([group, commands]) => ({ group, commands }));
}

/** 命令的标记：高危、执行端（网关排队为作业）、只读。没有标记时为空数组。 */
export function catalogTags(spec: CommandSpec): string[] {
  return [
    spec.risk === 'high' ? '高危' : undefined,
    spec.runner ? '执行端' : undefined,
    spec.readOnly ? '只读' : undefined,
  ].filter((tag): tag is string => tag !== undefined);
}
