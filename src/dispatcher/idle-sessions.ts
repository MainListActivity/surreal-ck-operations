import type { EmployeeInst, SessionTaskFacts, SupervisedTask, Workforce } from '../workforce.ts';
import type { PaseoGateway } from './paseo.ts';

const waiting = (state: string | undefined) => state === 'idle' || state === 'sleeping';

/**
 * The session oneshot lets continue a task: the one that last worked this task in this phase (rework, a repeat review,
 * a resume). Candidates already belong to this task (staffingPool), so a follow-up never continues its parent's session.
 */
export function continuitySession(sessions: readonly EmployeeInst[], states: ReadonlyMap<string, string>, task: SupervisedTask, forReview: boolean): EmployeeInst | undefined {
  const phase = forReview ? 'review' : 'execute';
  return sessions
    .filter(inst => waiting(states.get(inst.id)) && inst.lastTask === task.id && inst.lastPhase === phase)
    .sort((a, b) => (b.lastWakeAt ?? 0) - (a.lastWakeAt ?? 0))[0];
}

/** Sessions oneshot ends: waiting, holding nothing, and their last task over. A follow-up never resumes them. */
export function finishedSessions(input: { instances: readonly EmployeeInst[]; states: ReadonlyMap<string, string>; held: ReadonlySet<string>; facts: SessionTaskFacts }): EmployeeInst[] {
  return input.instances.filter(inst => {
    if (!inst.lastTask || !inst.paseoAgentId || inst.activeTask || input.held.has(inst.id) || !waiting(input.states.get(inst.id))) return false;
    const state = input.facts.states.get(inst.lastTask);
    return state === undefined || state === 'done' || state === 'void';
  });
}

/** Only observed idle time counts. Busy/unknown observations and a fresh wake reset the timer. */
export async function reclaimIdleSessions(input: {
  instances: EmployeeInst[]; states: ReadonlyMap<string, string>; held: ReadonlySet<string>; bound: ReadonlySet<string>;
  now: number; minutes: number; workforce: Workforce; paseo: PaseoGateway;
  archiveScene: (inst: EmployeeInst) => Promise<void>; log: (text: string) => void;
}): Promise<string[]> {
  const { workforce: wf, now } = input;
  if (input.minutes <= 0 || typeof wf.observeSessionIdle !== 'function' || typeof wf.retireIdle !== 'function') return [];
  const updates: Array<{ inst: EmployeeInst; since?: number }> = [];
  const candidates: EmployeeInst[] = [];
  for (const inst of input.instances) {
    // A closed runtime reads as sleeping: it still has to end, or it stays on the roster forever.
    const eligible = ['idle', 'sleeping'].includes(input.states.get(inst.id) ?? '') && !inst.activeTask && !input.held.has(inst.id) && !input.bound.has(inst.id) && !!inst.paseoAgentId;
    const freshWake = inst.idleSince !== undefined && (inst.lastWakeAt ?? 0) >= inst.idleSince;
    const since = eligible ? freshWake ? now : inst.idleSince ?? now : undefined;
    if (since !== inst.idleSince) updates.push({ inst, since });
    if (eligible && since !== undefined && now - since >= input.minutes * 60) candidates.push(inst);
  }
  if (updates.length) await wf.observeSessionIdle(updates.map(u => ({ id: u.inst.id, since: u.since, lastWakeAt: u.inst.lastWakeAt })));
  if (!candidates.length) return [];
  // An unreadable pending-wake set must never turn into an empty set.
  let wakes;
  try { wakes = await wf.openPendingWakes(); } catch { input.log('idle cleanup skipped: pending wake ownership unavailable'); return []; }
  const retired: string[] = [];
  for (const inst of candidates) {
    if (wakes.some(w => w.employee === inst.id || w.agent === inst.paseoAgentId)) continue;
    const status = await input.paseo.status(inst.paseoAgentId!).catch(() => undefined);
    if ((status?.status !== 'idle' && status?.status !== 'closed') || status.pendingPermissions > 0) continue;
    try { await wf.retireIdle(inst); }
    catch (error) { input.log(`idle cleanup kept ${inst.id}: ${(error as Error).message}`); continue; }
    // The credential gate succeeded before anything is archived.
    await input.paseo.archive(inst.paseoAgentId!).catch(error => input.log(`idle archive failed for ${inst.id}: ${(error as Error).message}`));
    await input.archiveScene(inst);
    retired.push(inst.id);
  }
  return retired;
}
