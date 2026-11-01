import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { settleCompanyTurn, TurnInterruptions } from '../plugin/server/turn-closeout.ts';
import { reportPath } from '../src/comm.ts';

for (const phase of ['doing', 'review'] as const) test(`completed 429: ${phase} releases once, cools provider, refunds wake, never nudges`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'quota-turn-'));
  const calls: string[] = [];
  const inst = { id: 'fixture-employee', role: 'engineering' as const, provider: 'claude', paseoAgentId: undefined as string | undefined, credential: 'synthetic' };
  const workforce = {
    insts: async () => [inst],
    markExhausted: async () => { calls.push('exhausted'); },
    refundQuotaWake: async () => { calls.push('refund'); },
  };
  const pool = new SidecarPool({ runDir: join(root, 'comm'), heartbeatMs: 100000,
    core: {
      claim: async () => ({ task: { id: 'fixture-task', state: phase, version: 2 }, deliveryId: 'fixture-delivery', fence: 1, history: [] }),
      release: async (_c: string, _p: unknown, ev: {text: string}) => { calls.push(ev.text.includes('【基础设施：订阅额度耗尽】') ? 'infra-release' : 'release'); },
    } as never, workforce: workforce as never });
  try {
    pool.env(inst); inst.paseoAgentId = 'fixture-agent'; pool.bindAgent(inst.id, inst.paseoAgentId);
    await pool.claim(inst, { id: 'fixture-task', state: phase } as never);
    const event = { agent: { id: inst.paseoAgentId }, turnId: 'fixture-turn', outcome: { kind: 'completed' },
      timeline: [{ type: 'assistant_message', text: 'API Error: 429 usage cap reached until 08:00' }] };
    const paseo = { agents: { ref: () => ({ send: async () => { calls.push('nudge'); } }) } };
    await settleCompanyTurn({ sidecar: pool, workforce } as never, paseo as never, event as never);
    await settleCompanyTurn({ sidecar: pool, workforce } as never, paseo as never, event as never);
    expect(calls).toEqual(['exhausted', 'infra-release', 'refund']);
    expect((await pool.settle(inst.paseoAgentId)).status).toBe('no_claim');
  } finally { pool.close(); rmSync(root, { recursive: true, force: true }); }
});

test('failed circuit-breaker persistence retains the lease and sends no nudge', async () => {
  const calls: string[] = [];
  const ctx = { workforce: {
    insts: async () => [{ id: 'i', provider: 'claude', paseoAgentId: 'a' }],
    markExhausted: async () => { throw new Error('synthetic db unavailable'); },
  }, sidecar: { settle: async () => { calls.push('settle'); }, releaseClaim: async () => { calls.push('release'); } } };
  await expect(settleCompanyTurn(ctx as never, {} as never, { agent: { id: 'a' }, turnId: 't',
    outcome: { kind: 'failed', error: { message: '429' } }, timeline: [] } as never)).rejects.toThrow('synthetic db unavailable');
  expect(calls).toEqual([]);
});

function silentWorld() {
  const root = mkdtempSync(join(tmpdir(), 'interrupt-turn-'));
  const calls: string[] = [];
  const inst = { id: 'fixture-employee', role: 'engineering' as const, provider: 'claude', paseoAgentId: undefined as string | undefined, credential: 'synthetic' };
  const workforce = { insts: async () => [inst], markExhausted: async () => {}, refundQuotaWake: async () => {} };
  const pool = new SidecarPool({ runDir: join(root, 'comm'), heartbeatMs: 100000,
    core: {
      claim: async () => ({ task: { id: 'fixture-task', state: 'doing', version: 2 }, deliveryId: 'fixture-delivery', fence: 1, history: [] }),
      release: async () => { calls.push('release'); },
    } as never, workforce: workforce as never });
  pool.env(inst); inst.paseoAgentId = 'fixture-agent'; pool.bindAgent(inst.id, inst.paseoAgentId);
  const paseo = { agents: { ref: () => ({ send: async () => { calls.push('nudge'); } }) } };
  let turn = 0;
  const cancel = (interruptions: TurnInterruptions) => settleCompanyTurn({ sidecar: pool, workforce } as never, paseo as never,
    { agent: { id: 'fixture-agent' }, turnId: `turn-${++turn}`, outcome: { kind: 'canceled' }, timeline: [] } as never, interruptions);
  return { root, calls, inst, pool, cancel, close: () => { pool.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('a canceled silent turn releases only after the grace, and never once the plugin stops', async () => {
  const w = silentWorld();
  try {
    await w.pool.claim(w.inst, { id: 'fixture-task', state: 'doing' } as never);
    const released = new TurnInterruptions(20);
    await w.cancel(released);
    expect(w.calls).toEqual([]);
    await Bun.sleep(60);
    expect(w.calls).toEqual(['release']);

    await w.pool.claim(w.inst, { id: 'fixture-task', state: 'doing' } as never);
    const shutdown = new TurnInterruptions(20);
    await w.cancel(shutdown);
    shutdown.stop();
    await Bun.sleep(60);
    expect(w.calls).toEqual(['release']);
    expect(w.pool.holdsLease(w.inst.id, 'fixture-task')).toBe(true);
    await w.cancel(shutdown);
    await Bun.sleep(60);
    expect(w.calls).toEqual(['release']);
  } finally { w.close(); }
});

test('a turn started inside the grace keeps the lease of the canceled one', async () => {
  const w = silentWorld();
  try {
    await w.pool.claim(w.inst, { id: 'fixture-task', state: 'doing' } as never);
    const interruptions = new TurnInterruptions(20);
    await w.cancel(interruptions);
    await Bun.sleep(2);
    interruptions.turnStarted('fixture-agent');
    await Bun.sleep(60);
    expect(w.calls).toEqual([]);
    expect(w.pool.holdsLease(w.inst.id, 'fixture-task')).toBe(true);
  } finally { w.close(); }
});

test('a report written after the lease ended is preserved with its task and listed on the next claim', async () => {
  const w = silentWorld();
  try {
    await w.pool.claim(w.inst, { id: 'fixture-task', state: 'doing' } as never);
    w.pool.dropLease(w.inst.id, 'fixture-task');
    const dir = w.pool.commDirFor(w.inst.id);
    writeFileSync(reportPath(dir), 'finished after the lease was revoked');
    expect((await w.pool.settle('fixture-agent')).status).toBe('no_claim');
    expect(existsSync(reportPath(dir))).toBe(false);
    const evidence = join(w.root, 'evidence', 'fixture-task');
    const kept = readdirSync(evidence).filter(f => f.startsWith('orphaned-report-fixture-employee-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(evidence, kept[0]!), 'utf8')).toBe('finished after the lease was revoked');
    await w.pool.claim(w.inst, { id: 'fixture-task', state: 'doing' } as never);
    const claim = JSON.parse(readFileSync(join(dir, 'claim.json'), 'utf8')) as { orphanedArtifacts?: string[] };
    expect(claim.orphanedArtifacts).toEqual([join(evidence, kept[0]!)]);
  } finally { w.close(); }
});

for (const phase of ['doing', 'review'] as const) test(`silent nudge names the ${phase} closeout tool`, async () => {
  const sent: string[] = [];
  const ctx = { workforce: {}, sidecar: { settle: async () => ({ status: 'silent', silent: { instId: 'i', taskId: 't', nudges: 1, phase } }) } };
  const paseo = { agents: { ref: () => ({ send: async (text: string) => { sent.push(text); } }) } };
  await settleCompanyTurn(ctx as never, paseo as never, { agent: { id: 'a' }, outcome: { kind: 'completed' }, timeline: [] } as never);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain(`sck call ${phase === 'review' ? 'review' : 'submit'}`);
  if (phase === 'review') expect(sent[0]).not.toContain('call submit');
});
