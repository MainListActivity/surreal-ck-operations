import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';

async function fixture(run: (r: { relay: () => Promise<any>; blocks: string[]; upstream: () => number; setReply: (r: unknown) => void; root: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'ops-denial-'));
  const blocks: string[] = [];
  let calls = 0, seq = 0;
  let reply: unknown = { status: 403, ok: false, body: { error: { code: 'operator_required' } } };
  const pool = new SidecarPool({ runDir: root, sweepMs: 2, heartbeatMs: 1000000,
    core: { claim: async () => ({ task: { id: 'A', version: 2 }, deliveryId: 'delivery-A', fence: 1, history: [] }),
      block: async (_c: string, _p: unknown, to: string) => { blocks.push(to); return { id: 'A', version: 3 }; },
    } as unknown as SidecarDeps['core'], workforce: {} as never,
    ops: { tools: ['ops_request'], release: () => {}, call: async () => { calls++; if (reply instanceof Error) throw reply; return reply; } },
  });
  const inst = { id: 'qa-fixture-aaaaaa', role: 'qa' as const, credential: 'synthetic' };
  const env = pool.env(inst); pool.bindAgent(inst.id, 'fixture-agent');
  await pool.claim(inst, { id: 'A' } as never);
  const relay = async () => {
    const name = `${++seq}.json`;
    writeFileSync(join(env.SCK_COMM_DIR, 'req', name), JSON.stringify({ key: env.SCK_COMM_KEY, tool: 'ops_request', args: { session: 'synthetic-session' } }));
    const response = join(env.SCK_COMM_DIR, 'res', name);
    for (let n = 0; n < 200 && !existsSync(response); n++) await Bun.sleep(5);
    if (!existsSync(response)) throw new Error('response timeout');
    return JSON.parse(readFileSync(response, 'utf8'));
  };
  try { await run({ relay, blocks, upstream: () => calls, setReply: r => { reply = r; }, root }); }
  finally { pool.close(); rmSync(root, { recursive: true, force: true }); }
}

test('three identical HTTP denials block the actual lease and queued calls never reach upstream', async () => fixture(async r => {
  const out = await Promise.all([r.relay(), r.relay(), r.relay(), r.relay(), r.relay()]);
  expect(r.blocks).toEqual(['gm']);
  expect(r.upstream()).toBe(3);
  expect(out.some(o => !o.ok && /熔断/.test(o.error))).toBe(true);
  expect(readFileSync(join(r.root, 'qa-fixture-aaaaaa', 'ops-denials.json'), 'utf8')).not.toContain('synthetic-session');
}));
test('a successful call resets the streak; transient failures never count as denials', async () => fixture(async r => {
  await r.relay(); await r.relay();
  r.setReply({ ok: true, status: 200 }); await r.relay();
  r.setReply(Object.assign(new Error('temporary'), { code: 'upstream_error' }));
  await r.relay(); await r.relay(); await r.relay();
  expect(r.blocks).toEqual([]);
}));
test('repeated thrown contract refusals also block, without persisting raw messages', async () => fixture(async r => {
  r.setReply(Object.assign(new Error('synthetic-secret-private-detail'), { code: 'forbidden' }));
  await r.relay(); await r.relay(); await r.relay();
  expect(r.blocks).toEqual(['gm']);
  expect(readFileSync(join(r.root, 'qa-fixture-aaaaaa', 'ops-denials.json'), 'utf8')).not.toContain('synthetic-secret-private-detail');
}));

test('a replacement circuit keeps refusal counts, and failed blocker persistence retries without another upstream call', async () => {
  const { OpsCircuit } = await import('../plugin/server/ops-circuit.ts');
  const { mkdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'ops-restart-')); mkdirSync(join(root,'qa-fixture'));
  let calls=0, blocks=0;
  const input = { employee:'qa-fixture', task:'A', delivery:'lease-A', tool:'ops_request', check:()=>{},
    invoke:async()=>{calls++;return {status:403,ok:false};}, block:async()=>{blocks++;if(blocks===1)throw new Error('synthetic storage failure');} };
  try {
    await new OpsCircuit(root).run(input); await new OpsCircuit(root).run(input);
    await expect(new OpsCircuit(root).run(input)).rejects.toThrow('storage failure');
    await expect(new OpsCircuit(root).run(input)).rejects.toThrow('熔断');
    expect(calls).toBe(3);expect(blocks).toBe(2);
    await new OpsCircuit(root).run({...input,delivery:'lease-B'});
    expect(calls).toBe(4); // a newly authorized lease starts a new streak
  } finally { rmSync(root,{recursive:true,force:true}); }
});
