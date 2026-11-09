import { expect, test } from 'bun:test';

test('R2 pruning keeps the newest hourly copies and as many daily copies as fit 40MB', async () => {
  const { prunePlan, TOTAL_LIMIT } = await import('../scripts/company-backup.ts');
  const MB = 1024 * 1024;
  const objects = [
    ...['20261025T1000Z', '20261025T1100Z', '20261025T1200Z'].map(s => ({ key: `hourly/${s}.surql.zst`, size: 6 * MB })),
    ...['20261018', '20261019', '20261020', '20261021', '20261022', '20261023', '20261024', '20261025'].map(d => ({ key: `daily/${d}.surql.zst`, size: 6 * MB })),
  ];
  const removed = prunePlan(objects);
  const kept = objects.filter(o => !removed.includes(o.key));
  expect(kept.map(o => o.key)).toEqual(['hourly/20261025T1100Z.surql.zst', 'hourly/20261025T1200Z.surql.zst',
    'daily/20261022.surql.zst', 'daily/20261023.surql.zst', 'daily/20261024.surql.zst', 'daily/20261025.surql.zst']);
  expect(kept.reduce((a, o) => a + o.size, 0)).toBeLessThanOrEqual(TOTAL_LIMIT);
});

test('the company database file wins over the product env, and tests never read it implicitly', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { loadDatabaseConfig } = await import('../src/config.ts');
  const root = mkdtempSync(join(tmpdir(), 'company-db-env-'));
  const saved = { ...process.env };
  try {
    mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'product.env'), 'SURREAL_URL=wss://product.example/rpc\nSURREAL_ROOT_USER=product\nSURREAL_ROOT_PASS=product-fixture\n');
    writeFileSync(join(root, 'private/company-db.env'), 'SURREAL_URL=ws://127.0.0.1:1/rpc\nSURREAL_ROOT_USER=company\nSURREAL_ROOT_PASS=company-fixture\n');
    for (const k of ['SURREAL_URL', 'SURREAL_ROOT_USER', 'SURREAL_ROOT_PASS', 'SCK_COMPANY_DB_ENV']) delete process.env[k];
    Object.assign(process.env, { SCK_PRODUCT_ENV: join(root, 'product.env'), SCK_SERVICE_HOME: root, NODE_ENV: 'production' });
    expect(loadDatabaseConfig()).toMatchObject({ url: 'ws://127.0.0.1:1/rpc', rootUser: 'company' });
    process.env.NODE_ENV = 'test';
    expect(() => loadDatabaseConfig()).toThrow('Refusing to run tests against a non-local database');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup keys sort by time and give each UTC day its own daily copy', async () => {
  const { backupKeys } = await import('../scripts/company-backup.ts');
  expect(backupKeys(new Date('2026-10-25T13:51:07.123Z'))).toEqual({ hourly: 'hourly/20261025T1351Z.surql.zst', daily: 'daily/20261025.surql.zst' });
  expect(backupKeys(new Date('2026-10-26T00:05:00Z')).daily).toBe('daily/20261026.surql.zst');
});
