/**
 * 模型调用（magpie，OpenAI 兼容的 chat completions）：译文与笔记整理的改写。只把结果交给调用方，不保存。
 * 失败时抛 upstream_error；调用方保留原文，老板可以手工写译文或稍后重试。
 */
import { CompanyError } from '../../src/core-errors.ts';
import type { RewriteNotes } from '../../src/lane-notes-consolidate.ts';
import type { Config } from './env.ts';

export const MAX_TRANSLATION = 20_000;
/** 语言代码：如 en、ja、zh-TW。 */
export const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export type Magpie = NonNullable<Config['magpie']>;

/** 一次 chat completions 调用，返回助手的文字内容（去首尾空白后非空，且不超过 MAX_TRANSLATION）。 */
export async function chatText(
  cfg: Magpie,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model: cfg.model, temperature: 0, messages }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CompanyError('upstream_error', '译文服务不可达');
  }
  if (!response.ok) throw new CompanyError('upstream_error', `译文服务返回 ${response.status}`);
  let body: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new CompanyError('upstream_error', '译文服务返回了无法解析的响应');
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0 || content.length > MAX_TRANSLATION) {
    throw new CompanyError('upstream_error', '译文服务没有返回可用的译文');
  }
  return content.trim();
}

/** 把消息正文译成目标语言。文件名、路径、命令、代码与标识符保持原样。 */
export async function translateText(
  cfg: Magpie,
  input: { text: string; lang: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!LANG.test(input.lang)) throw new CompanyError('invalid', 'lang invalid');
  if (input.text.trim().length === 0 || input.text.length > MAX_TRANSLATION) throw new CompanyError('invalid', 'text invalid');
  const system = `把用户消息翻译成语言代码 ${input.lang} 对应的语言。`
    + '文件名、路径、命令、代码、数字和标识符保持原样，不翻译。只输出译文，不加解释。';
  return chatText(cfg, [{ role: 'system', content: system }, { role: 'user', content: input.text }], fetchImpl);
}

const NOTE_SYSTEM = '把下面几条同一条线的工作笔记合并成一条经验教训。保留关键事实、数字、文件名和命令，'
  + '不加入新内容，不超过一百字。只输出合并后的这一条笔记。';

/** 笔记整理的改写：把一组笔记合成一条。失败由整理流程回退为最新的原文。 */
export function rewriteNotesWith(cfg: Magpie, fetchImpl: typeof fetch = fetch): RewriteNotes {
  return (texts) => chatText(cfg, [
    { role: 'system', content: NOTE_SYSTEM },
    { role: 'user', content: texts.map((text, index) => `${index + 1}. ${text}`).join('\n') },
  ], fetchImpl);
}
