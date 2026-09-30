// Syncs the shared MCP gate token from the company database into the local
// private/mcp-remote.env (mode 600). Creates the record server-side
// (rand::string) when missing. The token value is never printed.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../config';
import { CompanyDatabase } from '../database';

const serviceHome = process.env.SCK_SERVICE_HOME
  ?? join(process.env.HOME ?? '', 'Library/Application Support/SurrealCKCompany');
const remoteUrl = process.env.SCK_MCP_REMOTE_URL ?? 'https://data.maplayer.top/sck-mcp/mcp';
const gateRecord = new RecordId('service_gate', 'primary');

const db = new CompanyDatabase(loadDatabaseConfig());
await db.connect();
try {
  await db.useDatabase();
  let row = await db.db.select<{ token?: string }>(gateRecord);
  if (!row?.token) {
    await db.db.query('CREATE service_gate:primary SET token = rand::string(64);');
    row = await db.db.select<{ token?: string }>(gateRecord);
    if (!row?.token) throw new Error('gate token record could not be created');
    console.log('gate token record created (server-generated)');
  }
  const target = join(serviceHome, 'private', 'mcp-remote.env');
  writeFileSync(target, `SCK_MCP_URL=${remoteUrl}\nSCK_MCP_TOKEN=${row.token}\n`, { mode: 0o600 });
  console.log(`mcp-remote.env written -> ${target}`);
} finally {
  await db.close();
}
