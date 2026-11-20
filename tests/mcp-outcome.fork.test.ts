// MCP-2 core：SurrealCompanyCore.mcpOutcome 的租约一致性——只有持本租约（员工×delivery×fence）的
// 凭证能开闸与读取；别的员工、过期 delivery、旧 fence 都被 forbidden，开闸清结论、读取不清结论。
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import type { ClaimResult, LeaseProof, McpOutcome } from '../src/contracts.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
const key = () => `mcp-outcome-${Math.random().toString(36).slice(2, 10)}`;

run('mcpOutcome：开闸清结论、读取绑租约，别员工/旧 fence/forbidden', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-outcome-fork-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const rootPassword = 'isolated-mcp-outcome-test-only';
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`,
    '--user', 'root', '--pass', rootPassword, '--log', 'error', `surrealkv:${dir}/database`],
    { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword,
    namespace: 'isolated_mcp_outcome', database: 'control_plane' });
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
    expect(ready).toBe(true); await db.connect(); await db.bootstrap();
    const core = new SurrealCompanyCore(db);
    const enrollment = new LocalEnrollmentAdmin(db);
    const gm = await enrollment.enroll('fixture-manager', 'owner', ['execute', 'review', 'manage']);
    const eng = await enrollment.enroll('fixture-eng', 'engineering', ['execute']);
    const eng2 = await enrollment.enroll('fixture-eng2', 'engineering', ['execute']);
    const task = await core.createTask(gm, { title: 'MCP 结论租约一致性', context: '隔离用例：写结论只绑本租约。',
      executorRole: 'engineering', reviewerRole: 'qa', idempotencyKey: key() });

    const claim: ClaimResult = await core.claim(eng, task.id);
    const proof: LeaseProof = { taskId: task.id, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version };

    // 未开过闸：读不到结论；open 返回 opened 且把残留的 mcp_outcome 清掉。
    expect(await core.mcpOutcome!(eng, proof, 'read')).toEqual({ outcome: null });
    const rid = new RecordId('task', task.id);
    const holder = String((await core.getTask(gm, task.id)).currentEmployee);
    const stale = { kind: 'submit', text: '旧轮结论', employee: holder, delivery: 'old', fence: 0, at: 'x' };
    await db.db.update(rid).merge({ mcp_outcome: stale });
    expect(await core.mcpOutcome!(eng, proof, 'open')).toEqual({ opened: true });
    const cleared = await db.db.select<{ mcp_outcome?: unknown }>(rid);
    expect(cleared?.mcp_outcome).toBeUndefined();

    // 本租约的结论：员工×delivery×fence 匹配才能读回来；读取不清空。
    const outcome: McpOutcome = { kind: 'submit', text: '本轮交卷', employee: holder,
      delivery: claim.deliveryId, fence: claim.fence, at: '2030-01-01T00:00:00Z' };
    await db.db.update(rid).merge({ mcp_outcome: outcome });
    const read = await core.mcpOutcome!(eng, proof, 'read') as { outcome?: McpOutcome | null };
    expect(read.outcome?.kind).toBe('submit');
    expect(read.outcome?.text).toBe('本轮交卷');
    const again = await core.mcpOutcome!(eng, proof, 'read') as { outcome?: McpOutcome | null };
    expect(again.outcome?.kind).toBe('submit');

    // delivery/fence 嵌在结论里不匹配（别人写的）→ 读不到也不报 forbidden。
    const foreign = { ...outcome, delivery: 'other-delivery' };
    await db.db.update(rid).merge({ mcp_outcome: foreign });
    expect(await core.mcpOutcome!(eng, proof, 'read')).toEqual({ outcome: null });

    // 别的员工、旧 fence、错 delivery：open/read 都 forbidden。
    const staleFence = { ...proof, fence: proof.fence + 9 };
    const staleDelivery = { ...proof, deliveryId: 'delivery-old' };
    for (const badProof of [staleFence, staleDelivery]) {
      await expect(core.mcpOutcome!(eng, badProof, 'open')).rejects.toMatchObject({ code: 'forbidden' });
      await expect(core.mcpOutcome!(eng, badProof, 'read')).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(core.mcpOutcome!(eng2, proof, 'open')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(core.mcpOutcome!(eng2, proof, 'read')).rejects.toMatchObject({ code: 'forbidden' });
  } finally {
    try { await db.close(); } catch {}
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
