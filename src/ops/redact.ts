// Everything the broker returns or logs passes through here: employees must never see
// tokens or passwords, even when an upstream response echoes one.
const SECRET_KEY = /^(access_?token|refresh_?token|id_?token|token|password|passwd|secret|client_?secret|authorization|code_?verifier|login_?challenge)$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const MASK = '[redacted]';

/** Replaces known secret values and anything shaped like a JWT inside free text. */
export function redactText(text: string, known: readonly string[] = []): string {
  let out = text.replace(JWT, MASK);
  for (const secret of known) if (secret.length >= 6) out = out.split(secret).join(MASK);
  return out;
}

/** Deep copy of a JSON value with secret-named fields masked and secret-shaped strings scrubbed. */
export function redactJson(value: unknown, known: readonly string[] = [], depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, known);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 12) return MASK;
  if (Array.isArray(value)) return value.map(item => redactJson(item, known, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) && typeof item === 'string' ? MASK : redactJson(item, known, depth + 1);
  }
  return out;
}

/** Clips text without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.charCodeAt(max - 1) >= 0xd800 && text.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, cut)}…[truncated ${text.length - cut} chars]`;
}
