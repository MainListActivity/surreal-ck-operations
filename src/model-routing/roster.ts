import { employeeTier } from './policy.ts';
export interface RoutingDef {
  id:string; role:string; provider:string; model:string; enabled:boolean;
  tracks?:string[]; maxInstances?:number; quotaLimited?:boolean;
}
/** One Claude definition per role. Story-author definitions and their subscriptions remain untouched. */
export function planRoutingRoster(defs: RoutingDef[]): Array<RoutingDef> {
  const changes: RoutingDef[] = [];
  for (const role of [...new Set(defs.filter(d=>d.enabled && d.role!=='story-author').map(d=>d.role))]) {
    const roleDefs = defs.filter(d=>d.role===role);
    const selected = roleDefs.filter(d=>d.provider==='claude').sort((a,b)=>Number(b.enabled)-Number(a.enabled)||a.id.localeCompare(b.id))[0];
    const id = selected?.id ?? `${role}-claude`;
    for (const def of roleDefs) if (def.id!==id && def.enabled) changes.push({...def,enabled:false});
    changes.push({...selected,id,role,provider:'claude',model:`group/sck-${employeeTier(role)}`,enabled:true,quotaLimited:false,
      tracks:[...new Set(roleDefs.filter(d=>d.enabled).flatMap(d=>d.tracks ?? []))],
      maxInstances:Math.max(2,...roleDefs.filter(d=>d.enabled).map(d=>d.maxInstances ?? 1))});
  }
  return changes;
}
