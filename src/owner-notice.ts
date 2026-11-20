/**
 * 老板提示（owner_notice）的记录约定：记录 id 是 HASH(key) 前 24 位，打开中的提示 resolved_at 为空。
 * OwnerDesk 的 raiseNotice/resolveNotice 与本模块共用这套实现；定时核对（如公司服务全景）在没有
 * OwnerDesk 的进程里直接用这两个函数，行为与 owner.ts 一致。
 */
import type { Surreal } from 'surrealdb';
import { HASH, id } from './core.ts';

export const noticeRecordId = (key: string) => id('owner_notice', HASH(key).slice(0, 24));

/** 打开一条提示；同 key 同文且未关闭时不重复写。返回 true 表示这次是新打开或重开。 */
export async function raiseOwnerNotice(db: Surreal, key: string, text: string): Promise<boolean> {
  const record = noticeRecordId(key);
  const [rows] = await db.query<[Array<{ resolved_at?: unknown; text: string } | undefined>]>(
    'SELECT * FROM $record;', { record });
  const existing = rows?.[0];
  if (existing && !existing.resolved_at && existing.text === text) return false;
  await db.query('UPSERT $record CONTENT { key: $key, text: $text, at: time::now(), resolved_at: NONE };', { record, key, text });
  return !existing || Boolean(existing.resolved_at);
}

/** 关闭一条打开的提示；已关闭或不存在的提示不写。 */
export async function resolveOwnerNotice(db: Surreal, key: string): Promise<void> {
  const record = noticeRecordId(key);
  await db.query('UPDATE $record SET resolved_at = time::now() WHERE resolved_at = NONE;', { record });
}
