import {readFile,writeFile,rename} from 'node:fs/promises';
import {z} from 'zod';
import {AA_FLOOR,resolveBenchmark,routable,generatedModel,splitMember,type CatalogModel} from './policy.ts';
import type {AliasEntry,AliasFile} from './alias.ts';

const decisionSchema=z.object({
  by:z.enum(['jev','owner','rule','group']),slug:z.string().nullable(),at:z.string(),reason:z.string(),
  confidence:z.number().optional(),suggested:z.string().optional(),
});
const inventorySchema=z.object({version:z.literal(1),at:z.string(),present:z.array(z.string()),
  grouped:z.record(z.string(),z.array(z.string())),decisions:z.record(z.string(),decisionSchema)});
export type ModelInventory=z.infer<typeof inventorySchema>;
export async function loadInventory(file:string):Promise<ModelInventory>{
  try{return inventorySchema.parse(JSON.parse(await readFile(file,'utf8')));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,at:'',present:[],grouped:{},decisions:{}};throw error;}
}
export async function saveInventory(file:string,inventory:ModelInventory):Promise<void>{
  await writeFile(`${file}.tmp`,JSON.stringify(inventory),{mode:0o600});await rename(`${file}.tmp`,file);
}
/** Recover completed decisions even if a later compatibility-file write or group sync failed. */
export function inventoryAliases(inventory:ModelInventory,aliases:AliasFile):AliasFile{
  const merged={...aliases};
  for(const [model,d] of Object.entries(inventory.decisions)){
    if(d.by!=='jev'&&d.by!=='owner')continue;
    if(!merged[model]||d.at>merged[model]!.at){const {reason,...entry}=d;merged[model]=entry as AliasEntry;}
  }
  return merged;
}
export function recordDecision(inventory:ModelInventory,model:string,entry:AliasEntry):void{
  inventory.decisions[model]={...entry,reason:entry.slug?'已确认 AA 对应':entry.suggested?'已询问 Jev，等待人工确认候选':'已裁决无可确认的 AA 对应'};
}
/** Full catalog on the first run, then new ids only. Grouping versions never reset decisions. */
export function reconcileInventory(inventory:ModelInventory,catalog:CatalogModel[],groups:Record<string,string[]>,aliases:AliasFile,disabled:string[]=[],now=new Date().toISOString()):void{
  inventory.at=now;inventory.present=[...new Set(catalog.filter(routable).map(m=>m.id))];inventory.grouped={};
  for(const [model,entry] of Object.entries(aliases))recordDecision(inventory,model,entry);
  for(const [group,members] of Object.entries(groups)){
    if(!/^sck-(fable|opus|sonnet|haiku)$/.test(group))continue;
    for(const member of members){const model=splitMember(member).id;if(generatedModel(model))continue;const held=inventory.grouped[model]??=[];if(!held.includes(group))held.push(group);
      inventory.decisions[model]??={by:'group',slug:null,at:now,reason:'已有分组接纳记录'};
    }
  }
  for(const model of catalog.filter(routable)){
    if(inventory.decisions[model.id])continue;
    if(disabled.includes(model.id)){inventory.decisions[model.id]={by:'rule',slug:null,at:now,reason:'已人工禁用'};continue;}
    const match=resolveBenchmark(model.id);if(!match)continue;
    const usable=resolveBenchmark(model.id,model.reasoning_levels);
    inventory.decisions[model.id]={by:'rule',slug:match.row.slug,at:now,reason:!usable?'当前通道没有 AA 已测等级':usable.row.score<AA_FLOOR?`当前可用等级 AA ${usable.row.score} 低于 ${AA_FLOOR}`:'名称已精确匹配 AA'};
  }
}
export function inventoryView(inventory:ModelInventory){
  const present=new Set(inventory.present.filter(model=>!generatedModel(model)));
  return {at:inventory.at,
    grouped:Object.entries(inventory.grouped).filter(([model])=>!generatedModel(model)).map(([model,groups])=>({model,groups})),
    decidedUngrouped:Object.entries(inventory.decisions).filter(([model])=>!generatedModel(model)&&!inventory.grouped[model]).map(([model,d])=>({model,...d,present:present.has(model)})),
    pending:inventory.present.filter(model=>!generatedModel(model)&&!inventory.grouped[model]&&!inventory.decisions[model]),
  };
}
