import { createHash } from "node:crypto";
import { loadDatabaseConfig } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/config.ts";
import { CompanyDatabase } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/database.ts";
const db=new CompanyDatabase(loadDatabaseConfig());
await db.connect();
try {
 const [root]=await db.db.query("INFO FOR ROOT;");
 const pieces:string[]=[];let databaseCount=0,tableCount=0;
 for(const namespace of Object.keys(root.namespaces??{}).sort()){
  if(namespace.startsWith("sck_agent_company"))continue;
  await db.db.use({namespace});
  const [nsInfo]=await db.db.query("INFO FOR NS;");
  for(const database of Object.keys(nsInfo.databases??{}).sort()){
   await db.db.use({namespace,database});
   const [info]=await db.db.query("INFO FOR DB;");
   databaseCount++;
   pieces.push(JSON.stringify({namespace,database,schema:info}));
   for(const table of Object.keys(info.tables??{}).sort()){
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))throw Error("Unexpected table identifier; no query issued");
    const [rows]=await db.db.query("SELECT count() AS n FROM "+table+" GROUP ALL;");
    const count=Number(rows?.[0]?.n??0);
    pieces.push(JSON.stringify({namespace,database,table,count}));
    tableCount++;
   }
  }
 }
 console.log(JSON.stringify({nonTargetDatabaseCount:databaseCount,tableCount,metadataAndCountsSha256:createHash("sha256").update(pieces.join("\n")).digest("hex")}));
}finally{await db.close();}
