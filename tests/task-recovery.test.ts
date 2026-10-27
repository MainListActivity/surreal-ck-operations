import { expect, test } from 'bun:test';
import { parseExecutionWindow, windowExpired, faultBelongsToWait } from '../src/task-recovery.ts';
import { CompanyProofStore } from '../src/ops/proof-store.ts';
const window = { approvalTask:'approval', configurationDigest:'a'.repeat(64), evidenceExpiresAt:'2026-10-28T04:00:00Z', minRemainingSeconds:5400, notAfter:'2026-10-28T02:30:00Z' };
test('deadline cannot extend underlying evidence or consume the reserved run time', () => {
  expect(parseExecutionWindow(window)).toEqual(window);
  expect(()=>parseExecutionWindow({...window,notAfter:'2026-10-28T02:31:00Z'})).toThrow('exceeds approved');
  expect(()=>parseExecutionWindow({...window,minRemainingSeconds:-1})).toThrow('Invalid');
  expect(()=>parseExecutionWindow({...window,notAfter:'tomorrow'})).toThrow('Invalid');
  expect(windowExpired(window,Date.parse('2026-10-28T02:29:59Z'))).toBe(false);
  expect(windowExpired(window,Date.parse(window.notAfter))).toBe(true);
});
test('proof dispatch checks current deadline and exact approved candidate before effects', async () => {
  let clock=Date.parse('2026-10-28T02:00:00Z');
  const db={query: async()=>[{execution_window:window}]};
  const store=new CompanyProofStore(db as never,()=>clock);
  const files={manifest:{configurationDigest:window.configurationDigest},evidence:{expiresAt:window.evidenceExpiresAt}} as never;
  await store.assertExecutionWindow('source','approval',files);
  expect(await store.assertExecutionWindow('source','different-approval',files).catch(e=>e.message)).toBe('execution window candidate mismatch');
  clock=Date.parse(window.notAfter);
  expect(await store.assertExecutionWindow('source','approval',files).catch(e=>e.message)).toBe('execution window expired');
});
test('only a current-stage fault suppresses a new manager wait; missing timestamps do not conceal a new wait',()=>{
  const since=Date.parse('2026-10-27T00:00:00Z');
  expect(faultBelongsToWait('2026-10-26T23:00:00Z',since)).toBe(false);
  expect(faultBelongsToWait('2026-10-27T00:01:00Z',since)).toBe(true);
  expect(faultBelongsToWait(undefined,since)).toBe(false);
  expect(faultBelongsToWait(undefined,undefined)).toBe(true);
});
