import {generatedModel} from './policy.ts';
import type {ManagedGroup} from './magpie-admin.ts';
export interface ExistingGroup {id:string; members?:string[]|null; [key:string]:unknown}
/** The owner authorized removal in the company's four tiers, including the otherwise manual Opus tier. */
export function generatedGroupCleanup(groups:ExistingGroup[]):Array<ManagedGroup & {removed:string[]}> {
  return groups.filter(g=>/^sck-(haiku|sonnet|opus|fable)$/.test(g.id)).flatMap(group=>{
    const members=group.members??[], removed=members.filter(generatedModel);
    return removed.length ? [{id:group.id,models:members.filter(m=>!generatedModel(m)),existing:group,removed}] : [];
  });
}
