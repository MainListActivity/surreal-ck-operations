import { loadDatabaseConfig } from './config.ts';
import { CompanyDatabase } from './database.ts';

const config = loadDatabaseConfig();
const database = new CompanyDatabase(config);
try {
  await database.connect();
  await database.bootstrap();
  console.log(JSON.stringify({ ok: true, namespace: config.namespace, database: config.database }));
} finally {
  await database.close();
}
