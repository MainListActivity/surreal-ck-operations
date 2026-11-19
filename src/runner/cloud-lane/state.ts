/**
 * 云端通道的回合状态：桥接进程在提交云端任务前先落盘，崩溃后同 prompt 重连而不是重复提交。
 * 文件放在 $SCK_COMM_DIR/.lane/state.json（原子写），员工沙箱可写。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LaneState {
  /** 逻辑会话 ID：同一个原生会话跨回合保持不变，作为 nativeSessionId 回传。 */
  sessionId: string;
  /** 在途云端任务（无则为已完成或尚未提交）。 */
  taskId?: string;
  taskUrl?: string;
  /** 可跨回合复用的供应商会话（Jules session name）；回合结束后保留供续轮 sendMessage。 */
  vendorSession?: string;
  /** 提交时的 prompt 摘要：无投递键时相同摘要重连；有投递键时只作新旧回合的辅助判据。 */
  digest?: string;
  /**
   * 当轮稳定投递标识（claim.json 的 deliveryId 或环境变量传入的投递键）。
   * 同一投递内正文重排、目录变化都仍要重连在途云会话，不得重复发送。
   */
  delivery?: string;
  branch?: string;
  submittedAt?: number;
  /** 派工 claim.json 里的公司任务 ID：换员工目录、换摘要重派时，凭它认出同一任务的在途发送。 */
  task?: string;
  /** devin-cloud 网页入口的记录：发送前落盘的 attempt 标记，以及最近一次核验到的档位与席位读数。 */
  devin?: DevinLaneState;
}

/** 仅移除已结清的同一个供应商任务；同公司任务上别的在途发送不可误删。 */
export function clearSettledInflight(stateRoot: string | undefined, provider: string, task: string | undefined, taskId: string | undefined): void {
  if (!stateRoot || !task || !taskId) return;
  const dir = join(stateRoot, provider, 'inflight');
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const row = JSON.parse(readFileSync(join(dir, name), 'utf8')) as InflightEntry;
        if (row.task === task && row.taskId === taskId) rmSync(join(dir, name), { force: true });
      } catch { /* 损坏或并发清理的记录不影响收尾 */ }
    }
  } catch { /* 没有共享目录 */ }
}

export interface DevinSeatReading { step: 'send' | 'follow'; cap: string; used: number; total: number; at: number }
export interface DevinLaneState {
  /** 按下发送前落盘的本轮标记：进程在按下之后、拿到回执之前中断时，重启只做受理核对，不重发。 */
  attempt?: string;
  attemptAt?: number;
  /**
   * 未确认受理的这次发送落在哪个已有会话里（续轮的原会话）；受理或拿到会话地址后清掉（地址已由 taskUrl 记录）。
   * 核对时只看这个会话；新会话发送没有，只能按标记在会话列表里找。
   */
  attemptSession?: string;
  /** 最近一次发送前核验的 Capability 与 N/M in use 席位读数（审计用，不含页面原文）。 */
  seats?: DevinSeatReading;
  /** Mode 1 本地代跑协助已用轮数（上限 3）；达到上限后 blocked 交老板裁决。 */
  assistRounds?: number;
  /**
   * 已产出但尚未确认回传原会话的代跑结果（含完整回传正文与标记）。恢复时先核可发条件再发这份结果，
   * 不再次调用只读工具；anchor 绑定触发它的请求内容，请求变了就丢弃。
   */
  assistRelay?: { anchor: string; marker: string; round: number; text: string; tool?: string; at: number };
}

/** 回合摘要：provider + 交给供应商的完整 prompt（含 task.md 与 findings），不是外层派工消息。 */
export function laneDigest(provider: string, vendorPrompt: string): string {
  return createHash('sha256').update(`${provider}\n${vendorPrompt}`).digest('hex');
}

export function readLaneState(commDir: string): LaneState | undefined {
  try {
    const value = JSON.parse(readFileSync(join(commDir, '.lane', 'state.json'), 'utf8'));
    if (!value || typeof value.sessionId !== 'string') return undefined;
    return value as LaneState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export function writeLaneState(commDir: string, state: LaneState): void {
  const dir = join(commDir, '.lane');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'state.json');
  writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/**
 * 跨员工实例的在途云端任务登记：同一公司任务换实例（comm 目录不同）时，
 * 凭 provider + 回合摘要找到已提交的云端任务并重连，而不是重复提交。
 * 存放于 <stateRoot>/<provider>/inflight/<digest>.json（原子写，0600）。
 */
export interface InflightEntry {
  taskId?: string; taskUrl?: string; submittedAt?: number; vendorSession?: string;
  /** 已按下发送但尚无 taskId 的发送意图：在碰发送按钮之前落盘，换员工目录也能看到，只核对不重发。 */
  attempt?: string; attemptAt?: number;
  /** 未确认受理的续轮落点会话：换员工目录核对时只看这个会话，不退回别的会话、也不按标记乱找。 */
  attemptSession?: string;
  /** 所属公司任务 ID：摘要变了（返工改了 findings）的重派也要认出是同一任务。 */
  task?: string;
  /** 该 attempt 是本轮第几次本地代跑回传：换员工目录恢复时据此保持 3 轮上限。 */
  assistRounds?: number;
}

function inflightPath(stateRoot: string, provider: string, digest: string): string {
  return join(stateRoot, provider, 'inflight', `${encodeURIComponent(digest)}.json`);
}

/** 原样读出登记项（含只有 attempt、还没有 taskId 的发送中间态）。 */
function readInflightRaw(stateRoot: string | undefined, provider: string, digest: string): InflightEntry | undefined {
  if (!stateRoot) return undefined;
  try {
    const value = JSON.parse(readFileSync(inflightPath(stateRoot, provider, digest), 'utf8')) as InflightEntry;
    return value && (typeof value.taskId === 'string' || typeof value.attempt === 'string') ? value : undefined;
  } catch { return undefined; }
}

export function readInflight(stateRoot: string | undefined, provider: string, digest: string): InflightEntry | undefined {
  return readInflightRaw(stateRoot, provider, digest);
}

/** 登记项里这次发送落在哪个会话：已拿到地址用地址，否则是续轮的原会话；都没有就是新会话、还没有地址可核对。 */
export function inflightSession(entry: InflightEntry): string | undefined {
  return entry.taskUrl ?? entry.attemptSession ?? entry.vendorSession;
}

/** 派工 claim.json 里的公司任务 ID（task.id）；读不到就是 undefined，跨目录只能靠摘要认出同一回合。 */
export function readClaimTask(commDir: string): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(join(commDir, 'claim.json'), 'utf8')) as { task?: { id?: unknown } }).task?.id;
    return typeof id === 'string' && id.trim() ? id.trim() : undefined;
  } catch { return undefined; }
}

/** 派工 claim.json 里的稳定投递标识（deliveryId）：同一投递的恢复不应因措辞或目录变化而重发。 */
export function readClaimDelivery(commDir: string): string | undefined {
  try {
    const delivery = (JSON.parse(readFileSync(join(commDir, 'claim.json'), 'utf8')) as { deliveryId?: unknown }).deliveryId;
    return typeof delivery === 'string' && delivery.trim() ? delivery.trim() : undefined;
  } catch { return undefined; }
}

/**
 * 同一公司任务、摘要不同的其它在途登记（换摘要重派，比如返工改了 findings）。摘要变了，共享登记的键就变了，
 * 只能按任务 ID 找回同一任务的发送，免得在别的目录另建会话。按提交时间从新到旧。
 */
export function readInflightOfTask(stateRoot: string | undefined, provider: string, task: string | undefined, digest: string): InflightEntry[] {
  if (!stateRoot || !task) return [];
  const dir = join(stateRoot, provider, 'inflight');
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const found: InflightEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === `${encodeURIComponent(digest)}.json`) continue;
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8')) as InflightEntry;
      if (value?.task === task && (typeof value.taskId === 'string' || typeof value.attempt === 'string')) found.push(value);
    } catch { /* 损坏的登记不参与判定 */ }
  }
  return found.sort((a, b) => (b.submittedAt ?? b.attemptAt ?? 0) - (a.submittedAt ?? a.attemptAt ?? 0));
}

/**
 * 发送意图的共享登记：必须在可能按下发送之前调用。换员工目录（不同 comm 目录、同一 stateRoot）
 * 或重启后按同一摘要读到它，就只核对是否已受理，绝不再次按下发送。attemptSession 是续轮的原会话地址（新会话不传）；
 * task 是公司任务 ID，换摘要重派时据此认出同一任务。
 */
export function recordInflightAttempt(stateRoot: string | undefined, provider: string, digest: string | undefined,
  attempt: string, at: number, attemptSession?: string, task?: string, assistRounds?: number): void {
  if (!stateRoot || !digest) return;
  const { attemptSession: _previous, ...prev } = readInflightRaw(stateRoot, provider, digest) ?? {};
  writeInflight(stateRoot, provider, digest,
    { ...prev, attempt, attemptAt: at, ...(attemptSession ? { attemptSession } : {}), ...(task ? { task } : {}),
      ...(assistRounds !== undefined ? { assistRounds } : {}) });
}

/** 撤销发送意图（确认没有按下发送时）。已有 taskId 的登记只去掉 attempt，不能误删在途任务。 */
export function clearInflightAttempt(stateRoot: string | undefined, provider: string, digest: string | undefined): void {
  if (!stateRoot || !digest) return;
  const prev = readInflightRaw(stateRoot, provider, digest);
  if (!prev?.attempt) return;
  const { attempt: _attempt, attemptAt: _attemptAt, attemptSession: _session, ...rest } = prev;
  if (rest.taskId) writeInflight(stateRoot, provider, digest, rest);
  else clearInflight(stateRoot, provider, digest);
}

export function writeInflight(stateRoot: string | undefined, provider: string, digest: string, entry: InflightEntry): void {
  if (!stateRoot) return;
  const dir = join(stateRoot, provider, 'inflight');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = inflightPath(stateRoot, provider, digest);
  writeFileSync(`${path}.tmp`, JSON.stringify(entry), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function clearInflight(stateRoot: string | undefined, provider: string, digest: string): void {
  if (!stateRoot) return;
  try { rmSync(inflightPath(stateRoot, provider, digest), { force: true }); } catch { /* 登记清理失败不影响回合收尾 */ }
}

/** 驱动提交到云端任务后落登记；没有 taskId（如 devin-cloud 拿不到云端会话 ID）时无登记可写。 */
export function recordInflight(stateRoot: string | undefined, provider: string, digest: string | undefined, state: LaneState): void {
  if (!stateRoot || !digest || !state.taskId) return;
  const session = state.devin?.attemptSession;
  writeInflight(stateRoot, provider, digest,
    { taskId: state.taskId, taskUrl: state.taskUrl, submittedAt: state.submittedAt, vendorSession: state.vendorSession,
      ...(session ? { attemptSession: session } : {}), ...(state.task ? { task: state.task } : {}) });
}
