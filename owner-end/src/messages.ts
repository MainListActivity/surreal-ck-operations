/**
 * 译文命令（只由老板调用）。translate.preview 只返回译文，不落库；translate.message 为消息选语言并保存译文。
 * 译文只对应它译过的那一版原文（translated_from_hash）：原文一改即作废，投递前等待补译（见 src/outbound-messages.ts）。
 */
import { bodyHash, type OutboundMessage, type OutboundMessageStore } from '../../src/outbound-messages.ts';
import { CompanyError } from '../../src/core-errors.ts';
import type { Config } from './env.ts';
import { LANG, MAX_TRANSLATION, translateText, type Magpie } from './translate.ts';
import { textOf } from './rows.ts';

/** 本模块处理的命令名。 */
export const TRANSLATE_COMMANDS: ReadonlySet<string> = new Set(['translate.preview', 'translate.message']);

/**
 * 派工时会替换成真实路径与命令的占位标记（见 src/outbound-render.ts）。原文里有的，译文里也必须还有，
 * 否则员工收到的指令会缺少路径或命令。
 */
const PLACEHOLDERS: readonly RegExp[] = [
  /\{taskId\}/, /\{acId\}/, /sck call/, /task\.md/, /notes\.md/, /findings\/round-(?:\d+|NN)\.md/, /agents\/eval\.md/,
];

/** 原文里出现过的占位标记，译文里都还在。 */
export function keepsPlaceholders(source: string, translated: string): boolean {
  return PLACEHOLDERS.every((marker) => !marker.test(source) || marker.test(translated));
}

/** 译文仍对应当前原文：有译文，且译文时的原文哈希与现在的原文一致。 */
export async function translationFresh(message: { body: string; translatedText?: string; translatedFromHash?: string }): Promise<boolean> {
  return Boolean(message.translatedText?.trim()) && message.translatedFromHash === await bodyHash(message.body);
}

function langOf(value: unknown): string {
  if (typeof value !== 'string' || !LANG.test(value.trim())) throw new CompanyError('invalid', 'lang invalid');
  return value.trim();
}

function magpieOf(cfg: Config): Magpie {
  if (!cfg.magpie) throw new CompanyError('not_configured', '缺少译文服务配置（MAGPIE_BASE_URL、MAGPIE_MODEL、MAGPIE_API_KEY）');
  return cfg.magpie;
}

/** 译成目标语言，并检查占位标记。失败时抛错，调用方不写库。 */
export async function translateChecked(cfg: Config, text: string, lang: string, fetchImpl?: typeof fetch): Promise<string> {
  const translated = await translateText(magpieOf(cfg), { text, lang }, fetchImpl);
  if (!keepsPlaceholders(text, translated)) {
    throw new CompanyError('upstream_error', '译文没有保留命令或文件名等占位标记，请重试');
  }
  return translated;
}

/** translate.preview：译成目标语言，不落库。 */
export async function translatePreview(cfg: Config, input: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<{ lang: string; text: string }> {
  const lang = langOf(input.lang);
  const text = textOf(input.text, 'text', MAX_TRANSLATION);
  return { lang, text: await translateChecked(cfg, text, lang, fetchImpl) };
}

/** translate.message 用到的存储面，便于测试替换。 */
export type MessageStoreLike = Pick<OutboundMessageStore, 'get' | 'setLanguage' | 'setTranslation'>;

/**
 * translate.message：为消息选语言并保存译文；lang 为 null 即回到中文原文投递。
 * 选语言时先译好再保存：译文失败则消息保持原样；保存时以译过的原文为守卫，期间原文被改则报冲突、请重新译。
 */
export async function translateMessage(store: MessageStoreLike, cfg: Config, input: Record<string, unknown>,
  actor: string, fetchImpl?: typeof fetch): Promise<OutboundMessage> {
  const messageId = textOf(input.messageId, 'messageId', 200);
  if (input.lang === null) return store.setLanguage(messageId, undefined);
  const lang = langOf(input.lang);
  const message = await store.get(messageId);
  if (!message) throw new CompanyError('not_found', 'message not found');
  if (message.state === 'sent') throw new CompanyError('conflict', 'conflict: message already sent');
  const translated = await translateChecked(cfg, message.body, lang, fetchImpl);
  await store.setLanguage(messageId, lang);
  return store.setTranslation(messageId, lang, translated, message.body, actor);
}
