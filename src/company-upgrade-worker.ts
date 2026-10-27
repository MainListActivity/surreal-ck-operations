// Detached host worker: survives replacement of the plugin that accepted the owner's click.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CompanyDatabase } from './database.ts';
import { loadDatabaseConfig } from './config.ts';
import { OwnerDesk } from './owner.ts';
import { CompanyUpgrades } from './company-upgrades.ts';
import { runCompanyUpgrade } from './company-upgrade-runner.ts';
const home=process.env.SCK_SERVICE_HOME??join(homedir(),'Library/Application Support/SurrealCKCompany');
const {loadServiceEnv}=await import(join(home,'active/plugin/server/env.ts'));loadServiceEnv();
const id=process.argv[2];if(!id||!/^[a-f0-9-]{36}$/.test(id))throw Error('invalid upgrade job');
// pnpm scripts and the gates must use the same pinned runtime as launchd.
process.env.PATH=join(home,'runtime-bun/bin')+':'+(process.env.PATH??'/usr/bin:/bin');
process.env.SCK_OPS_REPO=process.env.SCK_AGENT_CWD??'/Users/y/IdeaProjects/surreal-ck-operations';
process.env.SCK_COMPONENTS='mcp';
const db=new CompanyDatabase(loadDatabaseConfig());
try{await db.connect();await db.useDatabase();await runCompanyUpgrade(new CompanyUpgrades(db,new OwnerDesk(db),{home,repo:process.env.SCK_OPS_REPO}),id);}finally{await db.close();}
