/**
 * 派工投递选文本的纯函数：按译文与原文哈希的一致性决定投递哪一段。不读数据库，也不读宿主状态。
 * 规则：无 lang 投递原文；有 lang 且译文哈希与当前原文一致且非空投递译文；其余（译文缺失或已过期）不投递，等网关补译。
 */
import { createHash } from 'node:crypto';

/** 原文 body 的 sha256 十六进制串（64 位），译文记录的哈希与之比对。 */
export function sourceHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface DeliverySource {
  body: string;
  /** 原文语言；空（NONE 或空串）表示中文原文。 */
  lang?: string | null;
  translatedText?: string | null;
  /** 译文所对应原文的哈希；与当前原文哈希不一致即为过期译文。 */
  translatedFromHash?: string | null;
}

/** 本次应投递的文本；返回 null 表示暂不投递（有 lang 但译文缺失或已过期）。 */
export function deliveryBody(message: DeliverySource): string | null {
  if (!message.lang || !message.lang.trim()) return message.body;
  const translated = message.translatedText;
  if (!translated || !translated.trim()) return null;
  if (message.translatedFromHash !== sourceHash(message.body)) return null;
  return translated;
}
