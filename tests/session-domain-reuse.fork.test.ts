import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { Workforce, SESSION_HANDOFF_MAX_BYTES } from '../src/workforce.ts';

// 显式领域复用的库侧回归：会话域/项目登记、交班材料的写入与按 scope 取用、消费只清掉被投递的那一份。
// 只在公司 fork 上跑；生产探针只读，不 bootstrap。
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
const ROOT_PASSWORD = 'isolated-domain-reuse-test-only';
setDefaultTimeout(120_000);

async function startFork() {
  const dir = mkdtempSync(join(tmpdir(), 'session-domain-reuse-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD,
    '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: ROOT_PASSWORD,
    namespace: 'isolated_session_domain_reuse', database: 'control_plane' });
  const close = async () => { await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); };
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true);
    await db.connect(); await db.bootstrap();
    return { dir, db, close };
  } catch (error) {
    await close();
    throw error;
  }
}

run('会话登记、交班材料与按项目+域+角色+仓库取用/消费', async () => {
  const w = await startFork();
  try {
    const wf = new Workforce(w.db);
    const def = { id: 'eng-fixture', role: 'engineering' as const, provider: 'codex', model: 'fixture', enabled: true,
      maxInstances: 1, priority: 0, weight: 1, errorStreak: 0 };
    const spawned = await wf.spawnInst(def, '/repo', 'maintenance', 'task-a', { domain: '后端', project: 'proj-ck' });
    let insts = await wf.insts();
    expect(insts.find(i => i.id === spawned.id)).toMatchObject({ sessionTask: 'task-a', sessionDomain: '后端', sessionProject: 'proj-ck' });
    await wf.recordSessionBinding(spawned.id, { task: 'task-b', domain: '后端', project: 'proj-ck' });
    insts = await wf.insts();
    expect(insts.find(i => i.id === spawned.id)?.sessionTask).toBe('task-b');

    // 任务事实：任务卡、提交、检查点、工作树。
    await w.db.db.query(`CREATE project:proj_plain CONTENT { name: 'CK', repo_path: '/repo', red_lines: [] };`);
    await w.db.db.query(`CREATE task:handoff_a CONTENT { title: '同域上一个任务', state: 'done', discipline: '后端',
      project: project:proj_plain, worktree: { branch: 'task/handoff-a', worktreePath: '/repo-sck-handoff-a', repo: '/repo' },
      acceptance_text: $acceptance, created_at: time::now() };`, { acceptance: '验收要求：'.repeat(120) });
    await w.db.db.query(`CREATE audit CONTENT { task: task:handoff_a, actor: 'employee:fixture', action: 'checkpoint',
      evidence: $checkpoint, at: time::now() };
      CREATE audit CONTENT { task: task:handoff_a, actor: 'employee:fixture', action: 'submit',
      evidence: $submission, at: time::now() };`, { checkpoint: '检查点：完成一半。'.repeat(40), submission: '提交摘要：'.repeat(160) });

    // 交班材料先落在会话行上。退休门禁之前不会对外可见（pending 只看 retired=true）。
    const old = await wf.spawnInst(def, '/repo', 'maintenance', 'handoff_a', { domain: '后端', project: 'proj-ck' });
    const source = await wf.sessionHandoffSource('handoff_a', 'engineering');
    expect(source).toBeDefined();
    const stored = await wf.storeSessionHandoff({ ...old, sessionDomain: '后端', sessionProject: 'proj-ck' },
      { project: 'proj-ck', domain: '后端', role: 'engineering', repo: '/repo', reason: 'fixture rotation' });
    expect(stored?.bytes).toBeGreaterThan(2048);
    expect(stored?.bytes).toBeLessThanOrEqual(SESSION_HANDOFF_MAX_BYTES);
    expect(await wf.pendingSessionHandoff({ project: 'proj-ck', domain: '后端', role: 'engineering', repo: '/repo' })).toBeUndefined();
    await wf.retire(old.id, 'fixture rotation', 'rotation');

    const pending = await wf.pendingSessionHandoff({ project: 'proj-ck', domain: '后端', role: 'engineering', repo: '/repo' });
    expect(pending).toMatchObject({ employee: old.id, task: 'handoff_a' });
    expect(pending?.text).toContain('【交班材料·上一会话轮换前交接】');
    expect(pending?.text).toContain('不得沿用上一会话的任何权限、凭据或复核签署权');
    // 跨域、换仓库、换角色都不匹配。
    expect(await wf.pendingSessionHandoff({ project: 'proj-ck', domain: '前端', role: 'engineering', repo: '/repo' })).toBeUndefined();
    expect(await wf.pendingSessionHandoff({ project: 'proj-ck', domain: '后端', role: 'engineering', repo: '/other' })).toBeUndefined();
    expect(await wf.pendingSessionHandoff({ project: 'proj-ck', domain: '后端', role: 'qa', repo: '/repo' })).toBeUndefined();

    await wf.consumeSessionHandoff(pending!.employee, pending!.key, spawned.id);
    expect(await wf.pendingSessionHandoff({ project: 'proj-ck', domain: '后端', role: 'engineering', repo: '/repo' })).toBeUndefined();
    const row = await w.db.db.select<{ session_handoff?: string; session_handoff_consumed_by?: string }>(new RecordId('employee', old.id));
    expect(row?.session_handoff).toBeUndefined();
    expect(row?.session_handoff_consumed_by).toBe(spawned.id);
    // insts() 不携带交班正文（只读雇员列表不应为每个会话背 4KB）。
    expect(Object.hasOwn((await wf.insts()).find(i => i.id === spawned.id) ?? {}, 'session_handoff')).toBe(false);
  } finally { await w.close(); }
});