import { readFileSync, statSync } from "node:fs";
import { RecordId } from "surrealdb";
import { loadDatabaseConfig } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/config.ts";
import { CompanyDatabase } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/database.ts";
const cfg=loadDatabaseConfig();
const db=new CompanyDatabase(cfg);
await db.connect();
try {
 await db.db.use({namespace:cfg.namespace,database:cfg.database});
 const [rows]=await db.db.query("SELECT action,actor,version,at FROM audit WHERE task = $task ORDER BY at;",{task:new RecordId("task","8b233ba6-f6aa-48be-849f-f8f20579f1a0")});
 console.log(JSON.stringify({audit:rows.map((r:any)=>({action:r.action,actor:String(r.actor),version:r.version}))}));
 const root="/Users/y/Library/Application Support/SurrealCKCompany/";
 const secrets=[cfg.rootPassword,...["gm-01","cs-01","qa-01"].map(x=>readFileSync(root+"private/credentials/"+x+".token","utf8").trim())].filter(Boolean);
 const logs=["logs/stdout.log","logs/stderr.log"];
 const report=readFileSync("/tmp/qa28-submit.md","utf8");
 console.log(JSON.stringify({reportKnownSecret:secrets.some(x=>report.includes(x)),reportBearer:/Bearer\s+[A-Za-z0-9._-]+/.test(report)}));
 for(const name of logs){
  const value=readFileSync(root+name,"utf8");
  const knownSecret=secrets.some(s=>value.includes(s));
  const bearer=/Bearer\s+[A-Za-z0-9._-]+/.test(value);
  console.log(JSON.stringify({log:name,knownSecret,bearer,bytes:Buffer.byteLength(value)}));
 }
 for(const name of ["private/service.env","private/credentials/qa-01.token","private/credentials/cs-01.token"]){
  const mode=(statSync(root+name).mode&0o777).toString(8).padStart(3,"0");
  console.log(JSON.stringify({file:name,mode}));
 }
}finally{await db.close();}
