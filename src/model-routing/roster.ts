import { REQUIRED_TRACKS } from '../core.ts';
import type { Role } from '../contracts.ts';
import { FACTORY_PROVIDER } from '../dispatcher/provider-order.ts';
import { employeeTier, employeeClientModel } from './policy.ts';
export interface RoutingDef {
  id:string; role:string; provider:string; model:string; enabled:boolean;
  tracks?:string[]; maxInstances?:number; quotaLimited?:boolean; thinking?:string; priority?:number; weight?:number;
}
/** One Claude definition per role plus existing native Factory definitions. Story-author definitions and their subscriptions remain untouched. */
export function planRoutingRoster(defs: RoutingDef[]): Array<RoutingDef> {
  const changes: RoutingDef[] = [];
  for (const role of [...new Set([...defs.filter(d=>(d.enabled || d.provider===FACTORY_PROVIDER) && d.role!=='story-author').map(d=>d.role),'eval'])]) {
    const roleDefs = defs.filter(d=>d.role===role);
    const selected = roleDefs.filter(d=>d.provider==='claude').sort((a,b)=>Number(b.enabled)-Number(a.enabled)||a.id.localeCompare(b.id))[0];
    const id = selected?.id ?? `${role}-claude`;
    for (const def of roleDefs) {
      if (def.provider === FACTORY_PROVIDER) changes.push({...def,enabled:true,quotaLimited:true});
      else if (def.id!==id && def.enabled) changes.push({...def,enabled:false});
    }
    changes.push({...selected,id,role,provider:'claude',model:employeeClientModel(role),thinking:employeeTier(role)==='haiku'?'max':selected?.thinking,enabled:true,quotaLimited:false,
      tracks:!REQUIRED_TRACKS[role as Role] && roleDefs.some(d=>(d.enabled || d.provider===FACTORY_PROVIDER) && !d.tracks?.length) ? [] : [...new Set(roleDefs.filter(d=>d.enabled || d.provider===FACTORY_PROVIDER).flatMap(d=>d.tracks ?? []))],
      maxInstances:Math.max(2,...roleDefs.filter(d=>d.enabled || d.provider===FACTORY_PROVIDER).map(d=>d.maxInstances ?? 1))});
  }
  return changes;
}

/** Delete obsolete non-Claude definitions, while keeping authors and native Factory as explicit exceptions. */
export function removedRoutingDefs(defs: RoutingDef[]): RoutingDef[] {
  return defs.filter(d => d.role !== 'story-author' && d.provider !== 'claude' && d.provider !== FACTORY_PROVIDER);
}

/** Owner maintenance: upsert replacements before removing definitions; existing task/employee history is untouched. */
export async function applyRoutingRoster(workforce: Pick<import('../workforce.ts').Workforce,'defs'|'upsertDef'>, db: import('surrealdb').Surreal) {
  const [config] = await db.query<[{paused?:boolean}|undefined]>('SELECT paused FROM ONLY company_meta:config;');
  if (config?.paused !== true) throw Error('Pause dispatch before changing the roster');
  const defs = await workforce.defs();
  const changes = planRoutingRoster(defs);
  for (const def of changes) await workforce.upsertDef(def.id,{
    role:def.role as Role,provider:def.provider,model:def.model,thinking:def.thinking,
    tracks:def.tracks,maxInstances:def.maxInstances,priority:def.priority,weight:def.weight,
    enabled:def.enabled,quotaLimited:def.quotaLimited,
  });
  const {RecordId} = await import('surrealdb');
  const removed = removedRoutingDefs(defs);
  await db.query("DELETE employee_def WHERE id IN $obsolete AND role!='story-author' AND provider NOT IN ['claude','factory-droid'] RETURN NONE;",{obsolete:removed.map(d=>new RecordId('employee_def',d.id))});
  return {changes,removed};
}
