// Owner maintenance: run from the merged main release. Dry-run unless --execute is provided.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {generatedGroupCleanup,type ExistingGroup} from '../src/model-routing/group-cleanup.ts';
import {saveMagpieGroups} from '../src/model-routing/magpie-admin.ts';
const file=join(homedir(),'.config/magpie/providers.json');
const groups=():ExistingGroup[]=>JSON.parse(readFileSync(file,'utf8')).groups??[];
const changes=generatedGroupCleanup(groups());
if(process.argv.includes('--execute')&&changes.length){
 const dir=join(homedir(),'Library/Application Support/SurrealCKCompany/maintenance/generated-group-cleanup');
 mkdirSync(dir,{recursive:true,mode:0o700});
 writeFileSync(join(dir,`before-${Date.now()}.json`),JSON.stringify(changes.map(c=>c.existing),null,2),{mode:0o600});
 await saveMagpieGroups('/Applications/magpie.app/Contents/MacOS/magpie',changes);
 const after=groups();
 for(const change of changes){
  const actual=after.find(g=>g.id===change.id);
  if(JSON.stringify(actual?.members)!==JSON.stringify(change.models))throw Error(`cleanup readback mismatch: ${change.id}`);
 }
}
console.log(JSON.stringify({execute:process.argv.includes('--execute'),changes:changes.map(({id,removed})=>({id,removed})),removed:changes.reduce((n,g)=>n+g.removed.length,0)}));
