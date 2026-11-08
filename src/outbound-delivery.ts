/**
 * 投递判定的唯一实现：看板（可放行、待译、译文过期）与派工（发不发、发哪段）都调这里，两边读出的状态不会各算一套。
 * 不读数据库，也不读宿主状态，也不引入 Node 内建模块：看板会跑在 Cloudflare Worker 上，哈希因此用纯 TypeScript 的 sha256Hex。
 */
import { sha256Hex } from './sha256.ts';

/** 原文 body 的 sha256 十六进制串（64 位）。译文只对应它译过的那一版原文：原文一改，哈希即不一致。 */
export function sourceHash(text: string): string {
  return sha256Hex(text);
}

/** 投递判定要看的消息字段（OutboundMessage 的子集）。 */
export interface DeliveryMessage {
  body: string;
  /** 消息上的语言：老板选过语言时即所选；否则是派工时对齐过来的员工默认语言（见 OutboundMessageStore.stampLang）。 */
  lang?: string;
  /** 老板为这条消息选过语言（含选“原文”）：选过后不再套用员工默认语言。 */
  langChosen?: boolean;
  /** 译文正文：只对应 lang 语言，且只在哈希一致时才用。 */
  translatedText?: string;
  /** 译文时的原文哈希（SHA-256，小写十六进制）。 */
  translatedFromHash?: string;
}

/**
 * 生效语言：老板选过语言（含选“原文”）时，以消息自己的语言为准（没有即原文）；没选过的，跟着收件员工走，取员工默认语言
 * （没有即原文）。消息上的 lang 只是派工时对齐过来的副本，这里不看它。
 */
export function effectiveLangOf(message: { lang?: string; langChosen?: boolean }, employeeLang: string | undefined): string | undefined {
  if (message.langChosen) return message.lang || undefined;
  return employeeLang || undefined;
}

/**
 * 译文状态。original：没有生效语言，原文照发。ready：同语言、非空、哈希与当前原文一致，发译文。stale：译过的那一版原文已改。
 * missing：没有该语言的译文（缺失、为空，或译的是别的语言）。
 */
export type TranslationState = 'original' | 'ready' | 'stale' | 'missing';

export function translationStateOf(message: DeliveryMessage, employeeLang: string | undefined): TranslationState {
  const lang = effectiveLangOf(message, employeeLang);
  if (!lang) return 'original';
  const translated = (message.lang || undefined) === lang ? (message.translatedText ?? '') : '';
  if (!translated.trim()) return 'missing';
  return message.translatedFromHash === sourceHash(message.body) ? 'ready' : 'stale';
}

/** 投递结果：ok 时 body 为要发的正文；否则等待补译，不发原文。 */
export type Delivery = { ok: true; body: string; translated: boolean } | { ok: false; reason: 'awaiting_translation' };

/** 投递判定：按译文状态决定发原文、发译文，还是等待补译。 */
export function deliveryOf(message: DeliveryMessage, employeeLang: string | undefined): Delivery {
  const state = translationStateOf(message, employeeLang);
  if (state === 'original') return { ok: true, body: message.body, translated: false };
  if (state === 'ready') return { ok: true, body: message.translatedText ?? '', translated: true };
  return { ok: false, reason: 'awaiting_translation' };
}
