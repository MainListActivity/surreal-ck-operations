import { CompanyError } from '../../src/core-errors.ts';

/** 仅接受完整 JSON 或一个完整 Markdown 代码块，不从说明文字中猜测对象边界。 */
export function modelJson(content: string): unknown {
  const text = content.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  try {
    return JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    // 只保留形态信息，禁止把模型正文（可能含反馈原文）放进错误或日志。
    throw new CompanyError('invalid', `模型返回的 JSON 无效（代码块：${text.startsWith('```') ? '是' : '否'}，长度：${text.length}）`);
  }
}
