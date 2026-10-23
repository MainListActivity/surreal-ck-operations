import { expect, test } from 'bun:test';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { loadDatabaseConfig } from '../src/config.ts';
import { collectEvalState, repairInfrastructureScores } from '../src/scoring.ts';
import { Workforce } from '../src/workforce.ts';
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
run('quota release excludes only failed claim-only rounds and wake refunds are idempotent', async () => {
  const config = loadDatabaseConfig();
  const db = new CompanyDatabase({ ...config, namespace: 'quota_scoring_fixture', database: 'control_plane' });
  try {
    await db.connect(); await db.bootstrap();
    await db.db.query(`CREATE task:fixture CONTENT { title: 'fixture', context: 'fixture', state: 'done', executor_role: 'engineering', reviewer_role: 'qa' };
      CREATE employee:fixture CONTENT { role: 'engineering', wake_count: 3 };`);
    let tick = 0;
    const audit = async (employee: string, action: string, evidence = '') => {
      await db.db.query('CREATE audit CONTENT { task: task:fixture, actor: $actor, action: $action, evidence: $evidence, at: $at };',
        { actor: new RecordId('employee', employee), action, evidence, at: new Date(1000 + tick++ * 1000) });
    };
    await audit('quota-only', 'claim');
    await audit('quota-only', 'released', '【通道回滚】【基础设施：订阅额度耗尽】API 拒绝，稍后重试');
    await audit('worked-before-quota', 'claim');
    await audit('worked-before-quota', 'checkpoint', '已完成实现');
    await audit('worked-before-quota', 'released', '【基础设施：订阅额度耗尽】');
    await audit('real-silent', 'claim');
    await audit('real-silent', 'released', '连续三轮无收尾退出');
    await audit('eventually-worked', 'claim');
    await audit('eventually-worked', 'released', '【基础设施：订阅额度耗尽】');
    await audit('eventually-worked', 'claim');
    await audit('eventually-worked', 'submit', '完成');
    const state = await collectEvalState(db.db, 'fixture');
    expect(state.participants).toEqual(['eventually-worked', 'real-silent', 'worked-before-quota']);
    expect(state.metrics['eventually-worked']?.claims).toBe(1);
    expect(state.timeline.filter(e => e.action === 'released' && e.evidence?.includes('【基础设施：订阅额度耗尽】')).every(e => e.actor === 'infrastructure')).toBe(true);
    for (const employee of ['quota-only', 'eventually-worked']) {
      await db.db.query(`CREATE scorecard CONTENT { task: task:fixture, employee: $employee, role: 'engineering',
        quality: 1, evidence: 1, discipline: 1, timeliness: 1, overall: 1, eval_by: 'fixture-judge' };`, { employee });
    }
    expect((await repairInfrastructureScores(db.db)).candidates).toHaveLength(1);
    expect((await repairInfrastructureScores(db.db, true)).candidates).toHaveLength(1);
    expect((await repairInfrastructureScores(db.db, true)).candidates).toHaveLength(0);
    const [cards] = await db.db.query<[Array<{employee: string; excluded_infrastructure?: boolean}>]>('SELECT employee, excluded_infrastructure FROM scorecard;');
    expect(cards).toHaveLength(2);
    expect(cards.find(c => c.employee === 'quota-only')?.excluded_infrastructure).toBe(true);
    expect(cards.find(c => c.employee === 'eventually-worked')?.excluded_infrastructure).not.toBe(true);
    const wf = new Workforce(db, '/tmp/not-used-quota-credentials');
    expect(await wf.config()).toMatchObject({ quotaWeeklyFloorPct: 6, sessionMaxInputK: 200 });
    await wf.refundQuotaWake('fixture', 'turn-1');
    await wf.refundQuotaWake('fixture', 'turn-1');
    expect((await db.db.select<{wake_count: number}>(new RecordId('employee', 'fixture')))?.wake_count).toBe(2);
    await wf.refundQuotaWake('fixture', 'turn-2');
    expect((await db.db.select<{wake_count: number}>(new RecordId('employee', 'fixture')))?.wake_count).toBe(1);
  } finally { await db.close(); }
});
