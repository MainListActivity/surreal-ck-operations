// Platform operator listing (read-only). The product owns the only read path for `_system.platform_operator`
// (GET /api/ops/platform-operators, format_version 1); this module is the company-side contract for that
// response. It is strict on purpose: a product regression that starts returning raw subjects, emails or
// display names must fail here instead of leaking through the ops tool.
import { z } from 'zod';
import { CompanyError } from '../core-errors.ts';

/** The response format this tool accepts. Anything else is refused, not passed through. */
export const PLATFORM_OPERATORS_FORMAT_VERSION = 1;

const subjectHash = z.string().regex(/^sha256:[a-f0-9]{12}$/);
const capability = z.string().min(1).max(80);
const operator = z.object({
  subject_hash: subjectHash,
  kind: z.enum(['human', 'agent']).nullable(),
  status: z.enum(['active', 'disabled']),
  capabilities: z.array(capability).max(64),
  isCurrent: z.boolean(),
}).strict();

export const platformOperatorsViewSchema = z.object({
  format_version: z.literal(PLATFORM_OPERATORS_FORMAT_VERSION),
  operators: z.array(operator).max(500),
}).strict();
export type PlatformOperatorsView = z.infer<typeof platformOperatorsViewSchema>;
export type PlatformOperatorView = z.infer<typeof operator>;

/**
 * Parses the product's operator listing. Only `subject_hash`, `kind`, `status`, `capabilities` and `isCurrent`
 * can leave this function; any extra key (a raw subject, an email, a display name) is a contract violation.
 */
export function parsePlatformOperatorsView(body: unknown): PlatformOperatorsView {
  const parsed = platformOperatorsViewSchema.safeParse(body);
  if (!parsed.success) {
    throw new CompanyError('upstream_error', '产品运营主体清单不符合 format_version 1 契约；拒绝透传未知字段', true);
  }
  return parsed.data;
}
