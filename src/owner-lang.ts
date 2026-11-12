/**
 * 老板常用语言与员工回报的译文（067 reply_translation）。
 * - 老板常用语言存在 company_meta:config.owner_lang，缺省 zh。职能语言与之相同的不翻译（发出与回报都不译）。
 * - 员工回报：audit 里员工写的 submit / return / block 说明。员工所属职能设了语言、且与老板语言不同时，
 *   定时任务把它译成老板语言存入 reply_translation；页面优先显示译文，原文随时可看。
 * 只用 surrealdb SDK 与 Web 标准 API，执行端、老板端页面与云端定时任务共用。
 */
import { RecordId, type Surreal } from 'surrealdb';

export const OWNER_LANG_DEFAULT = 'zh';
/** 语言代码：如 en、ja、zh-TW（与 owner-end/src/translate.ts 的 LANG 一致）。 */
export const LANG_CODE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** 要译回老板语言的员工回报：提交说明、复核退回意见、受阻说明。实时进度（checkpoint）不译。 */
export const REPLY_ACTIONS: readonly string[] = ['submit', 'return', 'block'];

/** 职能语言与老板语言是否相同（zh 与 zh-CN 视为相同；zh-TW 与 zh-CN 不同）。相同即不翻译。 */
export function langMatches(roleLang: string, ownerLang: string): boolean {
  const a = roleLang.toLowerCase(), b = ownerLang.toLowerCase();
  if (a === b) return true;
  const [baseA, regionA] = a.split('-'), [baseB, regionB] = b.split('-');
  return baseA === baseB && (!regionA || !regionB);
}

/** 老板常用语言；没设或不合法时为 zh。 */
export async function ownerLangOf(db: Surreal): Promise<string> {
  const [rows] = await db.query<[unknown[]]>('SELECT VALUE owner_lang FROM company_meta:config;');
  const lang = rows?.[0];
  return typeof lang === 'string' && LANG_CODE.test(lang) ? lang : OWNER_LANG_DEFAULT;
}

/** 回报原文的哈希（SHA-256 十六进制），原文变了译文即过期。 */
export async function replyHash(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const keyOf = (value: unknown): string =>
  value !== null && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : String(value ?? '');

/**
 * 一组审计行在老板语言下的译文：audit 编号（不含表名）→ 译文。只返回已译好且原文未变的；行里要有 id 与 evidence。
 */
export async function replyTranslationsOf(db: Surreal, audits: ReadonlyArray<{ id?: unknown; evidence?: unknown }>, lang: string): Promise<Map<string, string>> {
  const sources = audits.filter((row) => row.id !== undefined && typeof row.evidence === 'string' && row.evidence);
  const out = new Map<string, string>();
  if (!sources.length) return out;
  const ids = sources.map((row) => row.id instanceof RecordId ? row.id : new RecordId('audit', keyOf(row.id)));
  const [rows] = await db.query<[Array<{ source?: unknown; text?: unknown; source_hash?: unknown }>]>(
    'SELECT source, text, source_hash FROM reply_translation WHERE source IN $ids AND lang = $lang AND text != NONE;', { ids, lang });
  const hashOf = new Map<string, string>();
  for (const row of rows ?? []) {
    if (typeof row.text !== 'string' || !row.text) continue;
    const id = keyOf(row.source);
    const source = sources.find((item) => keyOf(item.id) === id);
    if (!source) continue;
    const hash = hashOf.get(id) ?? await replyHash(String(source.evidence));
    hashOf.set(id, hash);
    if (row.source_hash === hash) out.set(id, row.text);
  }
  return out;
}
