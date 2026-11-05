// B3: the pass observation keeps every verdict/reason, fails closed on oversized items, and marks a failed write stale.
import { expect, test } from 'bun:test';
import { persistDispatchObservation, QA_DISPATCH_ITEM_MAX_BYTES } from '../plugin/server/dispatch.ts';
import { qaDispatchFor } from '../src/qa-observation.ts';

const reason = (i: number) => ({ code: `r${i}`, text: `reason ${i}`, candidates: [], owner: 'owner', recovery: '', nextTrigger: '', basis: '' });
const verdict = (taskId: string, reasons: any[]) => ({ taskId, phase: 'review', dispatchable: false, workflowState: 'review', eligibleCount: 0, feasible: false, summary: 's', checkedAt: '2026-10-22T00:00:00Z', waitingMinutes: 1, reasons });
const ctxFor = (verdicts: any[], onQuery: (q: string, vars: any) => void = () => {}) => ({
  dispatcher: { dispatchSnapshot: () => ({ at: Date.now(), verdicts }) },
  db: { db: { query: async (q: string, vars: any) => { onQuery(q, vars); return []; } } },
}) as any;

test('persists all 31 reasons and reads the complete observation', async () => {
  let saved: any;
  await persistDispatchObservation(ctxFor([verdict('subject', Array.from({ length: 31 }, (_, i) => reason(i)))], (_q, vars) => { if (vars.verdicts) saved = vars; }));
  expect(saved.verdicts[0].reasons.length).toBe(31);
  expect(saved.complete).toBe(true);
  const observed = qaDispatchFor({ at: '2026-10-22T00:00:00Z', verdicts: saved.verdicts, complete: true, originalVerdicts: 1, originalReasons: 31 }, 'subject', { ok: true });
  expect(observed.available).toBe(true);
  expect(observed.complete).toBe(true);
  expect(observed.verdicts?.[0]?.reasons.length).toBe(31);
});

test('keeps more than 120 verdicts instead of slicing the pass', async () => {
  let saved: any;
  const verdicts = Array.from({ length: 130 }, (_, i) => verdict(`t${i}`, [reason(i)]));
  await persistDispatchObservation(ctxFor(verdicts, (_q, vars) => { if (vars.verdicts) saved = vars; }));
  expect(saved.verdicts.length).toBe(130);
  expect(saved.ov).toBe(130);
});

test('a single oversized reason fails closed with no partial snapshot', async () => {
  let saved: any;
  const huge = { ...reason(0), text: 'x'.repeat(QA_DISPATCH_ITEM_MAX_BYTES + 10) };
  await persistDispatchObservation(ctxFor([verdict('subject', [huge])], (_q, vars) => { if (vars.verdicts) saved = vars; }));
  expect(saved.complete).toBe(false);
  expect(saved.verdicts.length).toBe(0);
  expect(String(saved.reason)).toContain('safe item size');
  const observed = qaDispatchFor({ at: '2026-10-22T00:00:00Z', verdicts: [], complete: false, reason: saved.reason, originalVerdicts: 1, originalReasons: 1 }, 'subject', { ok: true });
  expect(observed.available).toBe(false);
  expect(observed.complete).toBe(false);
});

test('a failed write records the attempt as failed and the old snapshot reads stale', async () => {
  let status: any;
  const ctx = {
    dispatcher: { dispatchSnapshot: () => ({ at: Date.now(), verdicts: [verdict('subject', [reason(0)])] }) },
    db: { db: { query: async (q: string, vars: any) => {
      if (q.includes('ok: $ok')) { status = vars; return []; }
      throw new Error('write failed');
    } } },
  } as any;
  await expect(persistDispatchObservation(ctx)).rejects.toThrow('write failed');
  expect(status.ok).toBe(false);
  const observed = qaDispatchFor({ at: '2026-10-22T00:00:00Z', verdicts: [verdict('subject', [reason(0)])], complete: true }, 'subject', { at: '2026-10-22T00:01:00Z', ok: false, error: 'write failed' });
  expect(observed.available).toBe(false);
  expect(observed.reason).toContain('stale');
});
