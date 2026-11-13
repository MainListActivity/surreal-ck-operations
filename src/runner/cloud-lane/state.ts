/**
 * 云端通道的回合状态：桥接进程在提交云端任务前先落盘，崩溃后同 prompt 重连而不是重复提交。
 * 文件放在 $SCK_COMM_DIR/.lane/state.json（原子写），员工沙箱可写。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LaneState {
  /** 逻辑会话 ID：同一个原生会话跨回合保持不变，作为 nativeSessionId 回传。 */
  sessionId: string;
  /** 在途云端任务（无则为已完成或尚未提交）。 */
  taskId?: string;
  taskUrl?: string;
  /** 可跨回合复用的供应商会话（Jules session name）；回合结束后保留供续轮 sendMessage。 */
  vendorSession?: string;
  /** 提交时的 prompt 摘要：相同摘要重连，不同摘要说明是新回合。 */
  digest?: string;
  branch?: string;
  submittedAt?: number;
}

export function laneDigest(provider: string, prompt: string): string {
  return createHash('sha256').update(`${provider}\n${prompt}`).digest('hex');
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
