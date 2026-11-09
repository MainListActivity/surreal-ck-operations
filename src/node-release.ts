import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import { redactText } from './ops/redact.ts';

/** 节点记录与升级结果的错误文本上限（字符）。 */
const ERROR_LIMIT = 500;

/** 节点记录行：node_release 的记录 ID 即节点 ID。 */
const nodeRecord = (node: string) => new RecordId('node_release', node);

/** 插件心跳：每台执行端周期性 upsert 自己的 node_release 行。 */
export interface NodeBeat { node: string; host: string; platform: string; version: string; sha: string; at: number }

export async function beatNodeRelease(database: CompanyDatabase, beat: NodeBeat): Promise<void> {
  await database.db.query(
    `UPSERT $rec MERGE {
      host: $host, platform: $platform, version: $version, sha: $sha, seen_at: $at, updated_at: $at
    };`,
    { rec: nodeRecord(beat.node), host: beat.host, platform: beat.platform, version: beat.version, sha: beat.sha, at: beat.at });
}

/**
 * 确保节点行存在（更新器在云端检查前调用）：只写 host / platform / updated_at，不写 seen_at 与 last_*，
 * 所以心跳字段与升级结果都不被它改动。
 */
export async function ensureNodeRelease(database: CompanyDatabase, r: { node: string; host: string; platform: string; at: number }): Promise<void> {
  await database.db.query(
    `UPSERT $rec MERGE { host: $host, platform: $platform, updated_at: $at };`,
    { rec: nodeRecord(r.node), host: r.host, platform: r.platform, at: r.at });
}

/** 只记录真正的升级尝试结果；「已是最新」或「等待租约」用 touchNodeCheck。 */
export type NodeUpgradeStatus = 'ok' | 'refused' | 'failed' | 'rolled_back' | 'rollback_failed';

export interface NodeUpgradeResult { node: string; status: NodeUpgradeStatus; target?: string; at: number; error?: string }

export async function recordNodeUpgrade(database: CompanyDatabase, r: NodeUpgradeResult): Promise<void> {
  await database.db.query(
    `UPDATE $rec MERGE {
      last_status: $status, last_target: $target, last_at: $at, last_error: $error, checked_at: $at, updated_at: $at
    };`,
    {
      rec: nodeRecord(r.node),
      status: r.status,
      target: r.target,
      at: r.at,
      error: r.error === undefined ? undefined : clip(redactText(r.error)),
    });
}

/**
 * 只更新检查时间，不改 last_status（「已是最新」或「等待租约」的检查）。
 * UPDATE 而非 UPSERT：行由心跳创建，缺少 host/platform 时不能凭空建行。
 */
export async function touchNodeCheck(database: CompanyDatabase, node: string, at: number): Promise<void> {
  await database.db.query(
    `UPDATE $rec MERGE { checked_at: $at, updated_at: $at };`,
    { rec: nodeRecord(node), at });
}

/** 回退记录：node_rollback 只追加，每次回退一条。 */
export interface NodeRollbackRecord {
  node: string;
  at: number;
  fromVersion: string;
  fromSha: string;
  toVersion: string;
  toSha: string;
  reason: string;
  outcome: 'rolled_back' | 'rollback_failed';
}

export async function recordNodeRollback(database: CompanyDatabase, r: NodeRollbackRecord): Promise<void> {
  await database.db.query(
    `CREATE node_rollback CONTENT {
      node: $node, at: $at, from_version: $fromVersion, from_sha: $fromSha,
      to_version: $toVersion, to_sha: $toSha, reason: $reason, outcome: $outcome
    };`,
    {
      node: r.node, at: r.at, fromVersion: r.fromVersion, fromSha: r.fromSha,
      toVersion: r.toVersion, toSha: r.toSha, reason: clip(redactText(r.reason)), outcome: r.outcome,
    });
}

export interface NodeReleaseRow {
  host?: string;
  platform?: string;
  version?: string;
  sha?: string;
  seen_at?: number;
  checked_at?: number;
  last_status?: string;
  last_target?: string;
  last_at?: number;
  last_error?: string;
  updated_at?: number;
}

export async function readNodeRelease(database: CompanyDatabase, node: string): Promise<NodeReleaseRow | undefined> {
  const [row] = await database.db.query<[NodeReleaseRow | undefined | null]>(
    `SELECT host, platform, version, sha, seen_at, checked_at, last_status, last_target, last_at, last_error, updated_at
     FROM ONLY $rec;`,
    { rec: nodeRecord(node) });
  return row ?? undefined;
}

/**
 * 阻止本节点升级的进行中租约数：current_employee 非空、租约未过期，且归属本节点或尚未归属。
 * 未归属的旧租约（本版本之前认领的）按阻止处理（fail closed）；归属其它节点的租约不阻止本节点。
 */
export async function activeLeaseCount(database: CompanyDatabase, node: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const [rows] = await database.db.query<[number[]]>(
    `SELECT VALUE count() FROM task
     WHERE current_employee != NONE AND current_employee != ''
       AND lease_expires_at > $now
       AND (lease_node = NONE OR lease_node = $node)
     GROUP ALL;`,
    { node, now });
  return rows[0] ?? 0;
}

function clip(text: string): string {
  return text.length > ERROR_LIMIT ? text.slice(0, ERROR_LIMIT) : text;
}
