import { expect, test } from 'bun:test';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { loadDatabaseConfig } from '../src/config.ts';
import { Workforce } from '../src/workforce.ts';
import { reclaimIdleSessions } from '../src/dispatcher/idle-sessions.ts';
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
run('persistent idle observations survive restart, manager wakes and a fresh dispatch protect credentials', async () => {
  const db = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: 'idle_session_fixture', database: 'control_plane' });
  try {
    await db.connect(); await db.bootstrap();
    const wf = new Workforce(db, '/tmp/unused-idle-fixture');
    await db.db.query(`CREATE employee:fixture CONTENT { role: 'engineering', paseo_agent_id: 'fixture-agent', last_wake_at: 10, idle_since: 20, revoked: false, retired: false };`);
    const find = async () => (await wf.insts()).find(i => i.id === 'fixture')!;
    const input = () => ({ instances: [] as Awaited<ReturnType<Workforce['insts']>>, states: new Map([['fixture','idle']]), held: new Set<string>(), bound: new Set<string>(), now: 8000, minutes: 120, workforce: wf,
      paseo: { status: async () => ({ status: 'idle', pendingPermissions: 0 }), archive: async () => {} } as never,
      archiveScene: async () => {}, log: () => {},
    });
    await db.db.query(`CREATE dispatch:fixture CONTENT { purpose: 'gm-manager-wake', state: 'running', employee: 'fixture', agent: 'fixture-agent', task: 'fixture-task', phase: 'execute', episode: 1 };`);
    expect(await reclaimIdleSessions({ ...input(), instances: [await find()] })).toEqual([]);
    // The server guard protects even a caller whose manager-wake snapshot was stale.
    await expect(wf.retireIdle(await find())).rejects.toThrow('manager wake');
    await db.db.query("UPDATE dispatch:fixture SET state = 'finished';");
    const lifecycleOld = await find();
    await wf.clearIdleForAgent('fixture-agent');
    await expect(wf.retireIdle(lifecycleOld)).rejects.toThrow('idle retirement moved');
    await db.db.query('UPDATE employee:fixture SET idle_since = 20;');
    const old = await find();
    await wf.touchWake('fixture');
    await expect(wf.retireIdle(old)).rejects.toThrow('idle retirement moved');
    await db.db.query('UPDATE employee:fixture SET last_wake_at = 10, idle_since = 20;');
    expect(await reclaimIdleSessions({ ...input(), instances: [await find()] })).toEqual(['fixture']);
    const retired = await db.db.select<{ retired: boolean; retired_kind: string }>(new RecordId('employee', 'fixture'));
    expect(retired).toMatchObject({ retired: true, retired_kind: 'rotation' });
  } finally { await db.close(); }
});
