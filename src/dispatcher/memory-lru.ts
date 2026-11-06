import type {EmployeeInst, Workforce, SupervisedTask} from '../workforce.ts';
import type {PaseoGateway} from './paseo.ts';

const MIN_IDLE_SECONDS = 3600;

/** Persist continuous idle observations, including durable goal conversations. Never infer idle from process age. */
export async function observeRuntimeIdle(input: {
  instances:EmployeeInst[]; states:ReadonlyMap<string,string>; tasks:SupervisedTask[]; now:number;
  workforce:Pick<Workforce,'observeSessionIdle'>;
}):Promise<void> {
  if (typeof input.workforce.observeSessionIdle !== 'function') return;
  const held=new Set(input.tasks.flatMap(t=>t.currentEmployee?[t.currentEmployee]:[]));
  const updates:Array<{id:string;since?:number;lastWakeAt?:number;previousIdleSince?:number}>=[];
  for (const inst of input.instances) {
    const idle=input.states.get(inst.id)==='idle' && !inst.activeTask && !held.has(inst.id) && !!inst.paseoAgentId;
    const fresh=inst.idleSince!==undefined && (inst.lastWakeAt??0)>=inst.idleSince;
    const since=idle?(fresh?input.now:inst.idleSince??input.now):undefined;
    if (since!==inst.idleSince) updates.push({id:inst.id,since,lastWakeAt:inst.lastWakeAt,previousIdleSince:inst.idleSince});
  }
  await input.workforce.observeSessionIdle(updates);
  for (const u of updates) input.instances.find(i=>i.id===u.id)!.idleSince=u.since;
}

/** Reclaim at most one runtime per dispatch pass so kernel pressure can settle between closes. */
export async function reclaimMemoryLru(input:{
  instances:EmployeeInst[]; states:ReadonlyMap<string,string>; now:number;
  workforce:Pick<Workforce,'insts'|'tasks'|'openPendingWakes'|'reserveRuntimeSleep'|'confirmRuntimeSleep'|'releaseRuntimeSleep'>;
  paseo:Pick<PaseoGateway,'status'|'sleep'>; log:(text:string)=>void;
}):Promise<EmployeeInst|undefined> {
  if (!input.paseo.sleep || (typeof input.workforce.reserveRuntimeSleep!=='function' || typeof input.workforce.confirmRuntimeSleep!=='function')) return;
  const eligible=(i:EmployeeInst)=>!!i.paseoAgentId && !i.activeTask && i.idleSince!==undefined &&
    input.now-i.idleSince>=MIN_IDLE_SECONDS && (i.lastWakeAt??0)<i.idleSince;
  const candidates=input.instances.filter(i=>input.states.get(i.id)==='idle' && eligible(i))
    .sort((a,b)=>a.idleSince!-b.idleSince! || a.id.localeCompare(b.id));
  for (const candidate of candidates) {
    try {
      const fresh=(await input.workforce.insts()).find(i=>i.id===candidate.id);
      if (!fresh || !eligible(fresh) || fresh.idleSince!==candidate.idleSince || fresh.paseoAgentId!==candidate.paseoAgentId) continue;
      if ((await input.workforce.tasks()).some(t=>t.currentEmployee===fresh.id)) continue;
      if ((await input.workforce.openPendingWakes()).some(w=>w.employee===fresh.id || w.agent===fresh.paseoAgentId)) continue;
      if (!await input.workforce.reserveRuntimeSleep(fresh,input.now)) continue;
      const status=await input.paseo.status(fresh.paseoAgentId!);
      if (status?.status!=='idle' || status.pendingPermissions>0) {
        await input.workforce.releaseRuntimeSleep(fresh.id,input.now);
        continue;
      }
      // An ambiguous close keeps its short claim barrier until expiry; never close a second process in that pass.
      try {
        await input.paseo.sleep(fresh.paseoAgentId!,()=>input.workforce.confirmRuntimeSleep(fresh,input.now));
        const after=await input.paseo.status(fresh.paseoAgentId!);
        if (after?.status!=='closed') {input.log(`memory LRU: closure unconfirmed for ${fresh.id}`);return;}
      } catch(error) {input.log(`memory LRU: closure uncertain for ${fresh.id}: ${(error as Error).message}`);return;}
      await input.workforce.releaseRuntimeSleep(fresh.id,input.now);
      input.log(`memory LRU: sleeping ${fresh.id}, idle ${Math.floor((input.now-fresh.idleSince!)/60)} minutes; identity and context retained`);
      return {...fresh,runtimeSleepRequestedAt:input.now};
    } catch(error) {input.log(`memory LRU kept ${candidate.id}: ${(error as Error).message}`);}
  }
}
