// Privileged operator entry, intentionally separate from admin.ts (which bootstraps).
// Never grants database access, changes schema, stops a process, cancels or resends.
import { RecordId } from 'surrealdb';
import { createInterface } from 'node:readline/promises';
import { loadDatabaseConfig } from '../src/config.ts';
import { CompanyDatabase, CLOUD_SCHEMA_VERSION } from '../src/database.ts';
import { inspectDispatchRecovery } from '../src/dispatch-recovery-inspection.ts';
import { confirmAndFinalizeDispatch } from '../src/dispatch-recovery-command.ts';

const [action, request, operator, ...extra] = process.argv.slice(2);
if (!['inspect','receipt','finalize'].includes(action ?? '') || !request || extra.length || (action === 'finalize' && !operator)) {
  throw new Error('Usage: bun scripts/dispatch-recovery.ts inspect <request> | receipt <operation> | finalize <request> <operator>');
}
if (action === 'finalize' && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Manual finalization requires an interactive terminal; no unattended approval flag');
const db = new CompanyDatabase(loadDatabaseConfig());
try {
  await db.connect(); await db.useDatabase(); // Do NOT bootstrap or silently migrate production.
  const [rows] = await db.db.query<[Array<{schema_version:number}>]>('SELECT schema_version FROM company_meta:installation;');
  if (rows[0]?.schema_version !== CLOUD_SCHEMA_VERSION) throw new Error('Exact supported schema is required; this command never migrates');
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(request)) throw new Error('Exact request/operation ID required');
  if (action === 'receipt') {
    const [receipt] = await db.db.query('SELECT * FROM ONLY $receipt;', {receipt:new RecordId('dispatch_recovery_receipt',request)});
    console.log(JSON.stringify({operation:request,receipt:receipt ?? null},null,2));
  } else if (action === 'inspect') console.log(JSON.stringify(await inspectDispatchRecovery(db,request),null,2));
  else {
    const terminal = createInterface({input:process.stdin,output:process.stdout});
    try {
      const result = await confirmAndFinalizeDispatch(db,request,operator!,async(report,phrase)=>{
        console.log(JSON.stringify(report,null,2));
        console.log('Only complete database bookkeeping for this committed result. No resend, activation, stop or cancellation. Approval expires in five minutes.');
        return terminal.question(`Type exactly ${phrase}\n> `);
      });
      console.log(JSON.stringify(result,null,2));
    } finally { terminal.close(); }
  }
} finally { await db.close(); }
