/**
 * 译文语言选项与看板「变化高亮」的纯函数。不依赖 DOM，供 bun test 测试。
 */
import type { BoardMessageRow, BoardOutboxRow, BoardTranslation, OwnerBoard } from './types.ts';

/** 可选译文语言。空串表示「不翻译」：清除语言，回到原文投递（translate.message 传 lang: null）。 */
export const LANG_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '不翻译（原文投递）' },
  { value: 'en', label: '英文 en' },
  { value: 'ja', label: '日文 ja' },
  { value: 'ko', label: '韩文 ko' },
  { value: 'fr', label: '法文 fr' },
  { value: 'de', label: '德文 de' },
  { value: 'es', label: '西班牙文 es' },
  { value: 'ru', label: '俄文 ru' },
  { value: 'vi', label: '越南文 vi' },
];

export function langLabel(lang: string | undefined | null): string {
  if (!lang) return '不翻译';
  return LANG_OPTIONS.find(o => o.value === lang)?.label ?? lang;
}

/** 译文上屏时的 lang 字段：空串或缺失映射为 null（清除语言）。 */
export function langPayload(pick: string): string | null {
  return pick === '' ? null : pick;
}

/** 一条消息对页面可见的内容签名：原文、扣住状态、译文状态与文本。签名变化才高亮。 */
export function messageSignature(row: { body: string; hold: boolean; lang?: string; translation?: BoardTranslation }): string {
  const t = row.translation;
  return JSON.stringify([row.body, row.hold, row.lang ?? '', t ? [t.lang, t.status, t.text ?? ''] : null]);
}

/** 看板里所有未发消息（卡片、排队、其它）按编号收集签名。 */
export function boardSignatures(board: OwnerBoard): Map<string, string> {
  const out = new Map<string, string>();
  const add = (row: BoardMessageRow | BoardOutboxRow | undefined) => {
    if (!row || !row.messageId) return;
    const key = row.messageId;
    // 同一条消息可能同时出现在员工卡片与 messages 中，签名取第一次出现的值。
    if (!out.has(key)) out.set(key, messageSignature({
      body: row.body,
      hold: row.hold === true,
      lang: 'lang' in row ? (row as BoardMessageRow).lang : undefined,
      translation: row.translation,
    }));
  };
  for (const e of board.employees ?? []) for (const o of e.outbox ?? []) add(o);
  for (const u of board.unassigned ?? []) add(u.message);
  for (const m of board.messages ?? []) add(m);
  return out;
}

/** 与上一次快照相比签名变化或新增的编号。第一次读取（prev 为空）不算变化。 */
export function changedIds(prev: ReadonlyMap<string, string> | undefined, next: ReadonlyMap<string, string>): string[] {
  if (!prev) return [];
  const changed: string[] = [];
  for (const [id, sig] of next) if (prev.get(id) !== sig) changed.push(id);
  return changed;
}
