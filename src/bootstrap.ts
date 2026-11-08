import { loadDatabaseConfig } from './config.ts';
import { CompanyDatabase } from './database.ts';
import { LocalEnrollmentAdmin } from './enrollment.ts';
import { serviceHome } from './config.ts';
import { installNodeHost } from './host-node.ts';

installNodeHost();

const config = loadDatabaseConfig();
const database = new CompanyDatabase(config);
try {
  await database.connect();
  await database.bootstrap();
  await new LocalEnrollmentAdmin(database).ensureOwner(serviceHome());
  console.log(JSON.stringify({ ok: true, namespace: config.namespace, database: config.database }));
} finally {
  await database.close();
}
