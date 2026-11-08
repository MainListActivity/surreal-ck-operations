/**
 * 读出行的小工具：记录编号、时间、文本里的 JSON、输入校验。只用 Web 标准 API，Worker 与测试都能用。
 */
import { CompanyError } from '../../src/core-errors.ts';

export type Row = Record<string, unknown>;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 记录编号的键部分（RecordId 取 id，普通值取字符串）。 */
export const keyOf = (value: unknown): string =>
  value !== null && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : String(value ?? '');

/** 时间统一成 ISO 字符串；无值或无法解析时为 null。 */
export function isoOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : new Date(time).toISOString();
  }
  return null;
}

/** 文本列里的 JSON 尽量还原为对象；不是 JSON 的原样返回，空值为 undefined。 */
export function parsedJson(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** 数量参数：缺省或非法时用 fallback，并限制在 1 到 max 之间。 */
export function boundedInt(value: unknown, fallback: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(1, number));
}

/** 必填文本：去首尾空白后长度在 1 到 max 之间，否则 invalid。 */
export function textOf(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new CompanyError('invalid', `${field} invalid`);
  }
  return value.trim();
}

/** 可选文本：缺省或空白为 undefined。 */
export function optionalTextOf(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return textOf(value, field, max);
}
