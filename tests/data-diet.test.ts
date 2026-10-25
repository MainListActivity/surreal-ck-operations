import { expect, test } from 'bun:test';
import { summarizeModelEvidence, validateScores, type EvalState } from '../src/scoring.ts';

const row = (employee: string, model: string, fence: number, phase = 'execute', at = `2026-10-24T00:0${fence}:00Z`) => ({ employee, model, fence, phase, at });
const score = { quality: 4, evidence: 4, discipline: 4, timeliness: 4, overall: 4 };

test('model evidence rolls hundreds of executions into one line per employee and model', () => {
  const rows = [...Array.from({ length: 300 }, (_, i) => row('eng-a', i % 2 ? 'm/one' : 'm/two', 1 + (i % 3))), row('qa-b', 'm/one', 4, 'review')];
  const summary = summarizeModelEvidence(rows);
  expect(summary).toEqual([
    { employee: 'eng-a', models: [
      { model: 'm/one', executions: 150, fences: [1, 2, 3], phases: ['execute'], first: '2026-10-24T00:01:00Z', last: '2026-10-24T00:03:00Z' },
      { model: 'm/two', executions: 150, fences: [1, 2, 3], phases: ['execute'], first: '2026-10-24T00:01:00Z', last: '2026-10-24T00:03:00Z' },
    ] },
    { employee: 'qa-b', models: [{ model: 'm/one', executions: 1, fences: [4], phases: ['review'], first: '2026-10-24T00:04:00Z', last: '2026-10-24T00:04:00Z' }] },
  ]);
  expect(JSON.stringify(summary).length).toBeLessThan(1000);
});

test('score validation names the missing and the foreign models instead of a bare refusal', () => {
  const state = { participants: ['eng-a'], modelExecutions: [row('eng-a', 'm/one', 1), row('eng-a', 'm/two', 2), row('eng-a', 'm/three', 3)] } as unknown as EvalState;
  expect(validateScores(state, [{ employee: 'eng-a', ...score, modelScores: [{ model: 'm/one', overall: 4 }] }] as never))
    .toBe('Missing model assessments: eng-a needs m/three, m/two');
  expect(validateScores(state, [{ employee: 'eng-a', ...score, modelScores: [{ model: 'm/one', overall: 4 }, { model: 'm/two', overall: 4 }, { model: 'm/three', overall: 4 }, { model: 'm/guess', overall: 4 }] }] as never))
    .toBe('Invalid model assessment: m/guess is not a model of eng-a (actual: m/one, m/three, m/two)');
  expect(validateScores(state, [{ employee: 'eng-a', ...score, modelScores: ['m/one', 'm/two', 'm/three'].map(model => ({ model, overall: 4 })) }] as never)).toBeUndefined();
});

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
