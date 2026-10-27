import { z } from 'zod';
import { CompanyError } from './core-errors.ts';

/** A deadline restricts an approved candidate; it never extends the underlying evidence. */
export const executionWindowSchema = z.object({
  approvalTask: z.string().min(1).max(200),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceExpiresAt: z.string().datetime({ offset: true }),
  minRemainingSeconds: z.number().int().min(0).max(86400),
  notAfter: z.string().datetime({ offset: true }),
}).strict();
export type ExecutionWindow = z.infer<typeof executionWindowSchema>;
export const recoveryReasonSchema = z.enum(['stale_window', 'missing_prerequisite', 'infrastructure']);
export type RecoveryReason = z.infer<typeof recoveryReasonSchema>;
export function parseExecutionWindow(raw: unknown): ExecutionWindow {
  const result = executionWindowSchema.safeParse(raw);
  if (!result.success) throw new CompanyError('invalid', 'Invalid executionWindow');
  const w = result.data;
  if (Date.parse(w.notAfter) > Date.parse(w.evidenceExpiresAt) - w.minRemainingSeconds * 1000)
    throw new CompanyError('invalid', 'Execution deadline exceeds approved evidence window');
  return w;
}
export function windowExpired(window: ExecutionWindow | undefined | null, now = Date.now()): boolean {
  return !!window && (!Number.isFinite(Date.parse(window.notAfter)) || !Number.isFinite(Date.parse(window.evidenceExpiresAt)) || now >= Date.parse(window.notAfter) || now + window.minRemainingSeconds * 1000 > Date.parse(window.evidenceExpiresAt));
}
/** Only evidence reported in this manager wait may suppress this wait. Old causes keep their budgets. */
export function faultBelongsToWait(updatedAt: string | undefined, blockedSinceMs: number | undefined): boolean {
  return blockedSinceMs === undefined || (updatedAt !== undefined && Date.parse(updatedAt) >= blockedSinceMs);
}

export function faultNeedsNotice(episode: { notified: boolean; notifiedStageAt?: string }, stageStartedAt?: number): boolean {
  return !episode.notified || (stageStartedAt !== undefined && (!episode.notifiedStageAt || Date.parse(episode.notifiedStageAt) < stageStartedAt));
}
