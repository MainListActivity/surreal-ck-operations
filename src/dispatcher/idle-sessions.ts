import type { EmployeeInst, Workforce } from '../workforce.ts';
import type { PaseoGateway } from './paseo.ts';

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
    // Goal agents are durable conversations, independent of transient worktree resources.
    if (inst.workspaceScope) continue;
    const eligible = input.states.get(inst.id) === 'idle' && !inst.activeTask && !input.held.has(inst.id) && !input.bound.has(inst.id) && !!inst.paseoAgentId;
    const freshWake = inst.idleSince !== undefined && (inst.lastWakeAt ?? 0) >= inst.idleSince;
    const since = eligible ? freshWake ? now : inst.idleSince ?? now : undefined;
    if (since !== inst.idleSince) updates.push({ inst, since });
    if (eligible && since !== undefined && now - since >= input.minutes * 60) candidates.push(inst);
  }
  if (updates.length) await wf.observeSessionIdle(updates.map(u => ({ id: u.inst.id, since: u.since, lastWakeAt: u.inst.lastWakeAt })));
  if (!candidates.length) return [];
  // An unreadable manager-wake set must never turn into an empty set.
  let wakes;
  try { wakes = await wf.openManagerWakes(); } catch { input.log('idle cleanup skipped: manager wake ownership unavailable'); return []; }
  const retired: string[] = [];
  for (const inst of candidates) {
    if (wakes.some(w => w.employee === inst.id || w.agent === inst.paseoAgentId)) continue;
    const status = await input.paseo.status(inst.paseoAgentId!).catch(() => undefined);
    if (status?.status !== 'idle' || status.pendingPermissions > 0) continue;
    try { await wf.retireIdle(inst); }
    catch (error) { input.log(`idle cleanup kept ${inst.id}: ${(error as Error).message}`); continue; }
    // The credential gate succeeded before anything is archived.
    await input.paseo.archive(inst.paseoAgentId!).catch(error => input.log(`idle archive failed for ${inst.id}: ${(error as Error).message}`));
    await input.archiveScene(inst);
    retired.push(inst.id);
  }
  return retired;
}
