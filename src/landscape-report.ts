/**
 * 公司服务全景的观测落库与老板通知：两端（owner-end 的分钟任务、插件的派工循环）各自采集后调用同一套约定——
 * 观测写 company_meta:⟨landscape_observed:<hostId>⟩，比对出的不一致按 host 发 owner_notice
 * （key = landscape-drift:<hostId>，与 owner.ts 的提示记录同一约定，见 owner-notice.ts）。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { COMPANY_LANDSCAPE, compareObservation, type Drift, type HostObservation } from './landscape.ts';
import { raiseOwnerNotice, resolveOwnerNotice } from './owner-notice.ts';

export const observationRecordId = (host: string): RecordId =>
  new RecordId('company_meta', `landscape_observed:${host}`);

export const driftNoticeKey = (host: string): string => `landscape-drift:${host}`;

/** 不一致提示的正文：开头固定说明哪台主机，逐项列出三类差异。 */
export function driftNoticeText(host: string, drift: Drift): string {
  const lines = [`公司服务全景与实机不一致（${host}）`];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`${title}：`);
    for (const item of items) lines.push(`- ${item}`);
  };
  section('未登记的单元在运行', drift.undeclared);
  section('已登记但实机缺失', drift.missing);
  section('应退役却仍在运行', drift.retireStillPresent);
  return lines.join('\n');
}

/** 距上次观测不足 intervalMs 时返回上次时间（本次应跳过），否则返回 undefined。 */
export async function observationFreshUntil(db: Surreal, host: string, now: Date, intervalMs: number): Promise<string | undefined> {
  const [rows] = await db.query<[Array<{ at?: unknown } | undefined>]>(
    'SELECT * FROM $record;', { record: observationRecordId(host) });
  const prior = rows?.[0];
  const at = typeof prior?.at === 'string' ? prior.at : prior?.at instanceof Date ? prior.at.toISOString() : undefined;
  if (at && Number.isFinite(Date.parse(at)) && now.getTime() - Date.parse(at) < intervalMs) return at;
  return undefined;
}

/** 比对并落库；三类差异任一非空发提示，一致则关闭，采集失败（unknown）只留观测不发提示。返回比对结果。 */
export async function recordObservation(db: Surreal, obs: HostObservation): Promise<Drift> {
  const drift = compareObservation(COMPANY_LANDSCAPE, obs);
  await db.query('UPSERT $record CONTENT $content;', { record: observationRecordId(obs.host), content: { ...obs, drift } });
  const key = driftNoticeKey(obs.host);
  if (!drift.unknown && (drift.undeclared.length || drift.missing.length || drift.retireStillPresent.length)) {
    await raiseOwnerNotice(db, key, driftNoticeText(obs.host, drift));
  } else if (!drift.unknown) {
    await resolveOwnerNotice(db, key);
  }
  return drift;
}
