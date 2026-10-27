/**
 * SYS05 · Bounded cleanup when a lease ends (AC03).
 *
 * Leaving a wait drops the broker-held session handles and bounded-closes the browser task spaces. The local drop
 * is not a remote logout and is never described as one. A space with no closer, or one whose closer throws, stays
 * pending cleanup — exactly what the audit says, with no token in the text.
 */
import { expect, test } from 'bun:test';
import { OpsBroker } from '../src/ops/broker.ts';

interface ScopeLike { actor: { employeeId: string } }

function brokerWith(options: { closeBrowserSpace?: (input: { employeeId: string; spaceId: number }) => Promise<void> }) {
  const audits: Array<{ action: string; evidence: string }> = [];
  const broker = new OpsBroker({
    core: { auditOps: async (_scope: unknown, action: string, evidence: string) => { audits.push({ action, evidence }); } },
    ...options,
  } as never);
  // The broker's private bookkeeping is the state a real browserLogin would have written; the cleanup contract is
  // what this test is about, not the injection protocol covered by the browser tests.
  (broker as unknown as { browserSpaces: Map<string, Set<number>> }).browserSpaces.set('e1', new Set([7]));
  (broker as unknown as { lastScope: Map<string, ScopeLike> }).lastScope.set('e1', { actor: { employeeId: 'e1' } });
  return { broker, audits };
}

test('a browser space with no closer is pending, never claimed as closed, and the audit says so', async () => {
  const { broker, audits } = brokerWith({});
  const report = broker.release('e1');
  expect(report).toEqual({ sessions: 0, browserSpaces: 1, pending: 1 });
  await Bun.sleep(0);
  const cleanup = audits.find(entry => entry.action === 'ops_cleanup');
  expect(cleanup?.evidence).toContain('closer 未配置');
  expect(cleanup?.evidence).toContain('未调用远端注销');
  expect(cleanup?.evidence).not.toMatch(/Bearer|eyJ|token=/i);
});

test('a failing closer leaves the space pending and writes a cleanup-failure audit, not a success claim', async () => {
  const { broker, audits } = brokerWith({
    closeBrowserSpace: async () => { throw new Error('browser process unavailable'); },
  });
  const report = broker.release('e1');
  expect(report.browserSpaces).toBe(1);
  await Bun.sleep(5);
  const failure = audits.find(entry => entry.action === 'ops_cleanup' && entry.evidence.includes('关闭失败'));
  expect(failure?.evidence).toContain('待清理');
  expect(failure?.evidence).toContain('不冒称远端已注销');
  expect(failure?.evidence).not.toMatch(/Bearer|eyJ|token=/i);
});

test('release is idempotent: the second call finds no space and reports zero', () => {
  const { broker } = brokerWith({});
  expect(broker.release('e1')).toEqual({ sessions: 0, browserSpaces: 1, pending: 1 });
  expect(broker.release('e1')).toEqual({ sessions: 0, browserSpaces: 0, pending: 0 });
});
