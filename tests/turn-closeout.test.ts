import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarPool } from '../plugin/server/sidecar.ts';
import { settleCompanyTurn } from '../plugin/server/turn-closeout.ts';

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
