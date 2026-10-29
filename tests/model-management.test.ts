import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ModelRoutingController} from '../src/model-routing/controller.ts';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'model-manage-'));dirs.push(home);mkdirSync(join(home,'model-routing'));
 const groups:Record<string,string[]>={'sck-haiku':['v/a:max'],'sck-opus':['v/b:max']};
 const settings={'sck-haiku':{id:'sck-haiku',routing:'order',affinity:'auto',custom:'preserve'},'sck-opus':{id:'sck-opus',routing:'manual',affinity:'session',levels:['max']}};
 const calls:any[]=[];const catalog=[{id:'v/a',display_name:'Alpha',reasoning_levels:['max']},{id:'v/b',reasoning_levels:['max']},{id:'group/x'},{id:'auto/y'}];
 const c=new ModelRoutingController({} as any,home,'unused',{fetch:(async()=>Response.json({data:catalog})) as unknown as typeof fetch,groups:()=>groups,groupSettings:()=>settings,saveGroups:async changes=>{calls.push(changes);for(const g of changes)groups[g.id]=g.models;}});
 return {c,groups,calls,home};
}
test('live catalog paginates/searches and never lists generated groups as models',async()=>{
 const {c}=fixture(),page=await c.catalogPage('',0,1);
 expect(page.total).toBe(2);expect(page.nextOffset).toBe(1);expect(page.models[0]!.id).toBe('v/a');
 expect((await c.catalogPage('Alpha')).models).toHaveLength(1);
 expect((await c.catalogPage('group/')).models).toHaveLength(0);
 await expect(c.catalogPage('',-1)).rejects.toThrow();
});
test('owner membership edit preserves group settings, other groups and persistent manual removal decisions',async()=>{
 const {c,groups,calls,home}=fixture();
 await c.setMembership({group:'sck-haiku',model:'v/b:max',present:true,expectedMembers:[]});
 expect(groups['sck-haiku']).toEqual(['v/a:max','v/b:max']);expect(groups['sck-opus']).toEqual(['v/b:max']);
 expect(calls[0][0].existing.custom).toBe('preserve');
 await c.setMembership({group:'sck-haiku',model:'v/b:max',present:false,expectedMembers:['v/b:max']});
 expect(groups['sck-haiku']).toEqual(['v/a:max']);
 expect(JSON.parse(readFileSync(join(home,'model-routing/membership.json'),'utf8')).known).toContain('v/b');
 await expect(c.setMembership({group:'sck-haiku',model:'v/a:max',present:false,expectedMembers:[]})).rejects.toThrow('已变化');
 expect(calls).toHaveLength(2);
 for(const model of ['group/x','auto/y','v/b:low','missing'])await expect(c.setMembership({group:'sck-haiku',model,present:true,expectedMembers:[]})).rejects.toThrow();
 expect(calls).toHaveLength(2);
});

test('corrupt inventory is rejected before any external group write',async()=>{
 const {c,calls,home}=fixture();writeFileSync(join(home,'model-routing/membership.json'),JSON.stringify({version:'bad',known:'not-an-array'}));
 await expect(c.setMembership({group:'sck-haiku',model:'v/b:max',present:true,expectedMembers:[]})).rejects.toThrow('未修改分组');expect(calls).toHaveLength(0);
});

test('adding an existing member preserves manual order and other effort variants',async()=>{
 const {c,groups}=fixture();groups['sck-opus']=['v/b:max','v/a:max'];
 await c.setMembership({group:'sck-opus',model:'v/b:max',present:true,expectedMembers:['v/b:max']});expect(groups['sck-opus']).toEqual(['v/b:max','v/a:max']);
});
