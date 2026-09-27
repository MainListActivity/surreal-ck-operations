import { chmodSync, mkdirSync, openSync, writeSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDatabaseConfig } from './config.ts';
import { CompanyDatabase } from './database.ts';
import { LocalEnrollmentAdmin } from './enrollment.ts';
import type { Role } from './contracts.ts';

const [action, employeeId, roleArg] = process.argv.slice(2);
if (!employeeId || !['enroll', 'revoke'].includes(action)) {
  throw new Error('Usage: pnpm run admin enroll <employee-id> <role> | revoke <employee-id>');
}
const database = new CompanyDatabase(loadDatabaseConfig());
try {
  await database.connect();
  await database.bootstrap();
  const admin = new LocalEnrollmentAdmin(database);
  if (action === 'revoke') {
    await admin.revoke(employeeId);
    console.log(JSON.stringify({ action: 'revoke', employeeId, ok: true }));
  } else {
    const role = roleArg as Role;
    const capabilities = role === 'gm' ? ['execute', 'review', 'manage'] as const
      : role === 'product' ? ['execute', 'review', 'manage'] as const
      : ['execute', 'review'] as const;
    const directory = join(import.meta.dir, '..', '.runtime', 'credentials');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, `${employeeId}.token`);
    if (existsSync(path)) throw new Error('Credential file already exists; revoke and archive it before replacement');
    const credential = await admin.enroll(employeeId, role, capabilities);
    const fd = openSync(path, 'wx', 0o600);
    try { writeSync(fd, credential); } finally { closeSync(fd); }
    console.log(JSON.stringify({ action: 'enroll', employeeId, path, ok: true }));
  }
} finally {
  await database.close();
}
