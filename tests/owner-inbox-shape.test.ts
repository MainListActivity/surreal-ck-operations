import { expect, test } from 'bun:test';
import { ownerApi } from '../src/owner-api.ts';

test('inbox carries the running release at upgrades.current, not one level deeper', async () => {
  const box = { gates: [], questions: [], notices: [], pendingCommands: 0 };
  const state = { automatic: { enabled: true, revision: 1 }, current: { version: '0.3.99', sha: 'abc' }, items: [] };
  // The upgrade desk returns the whole inbox, exactly as CompanyUpgrades.inbox does.
  const ctx = { db: { db: {} }, owner: { inbox: async () => box }, upgrades: { inbox: async () => ({ ...box, upgrades: state }) } };
  const inbox = await ownerApi(ctx as never, { command: 'inbox' }, 'web' as never) as { upgrades: typeof state; gates: unknown[] };
  expect(inbox.upgrades.current.version).toBe('0.3.99');
  expect(inbox.upgrades.items).toEqual([]);
  expect(inbox.gates).toEqual([]);
  const plain = await ownerApi({ ...ctx, upgrades: undefined } as never, { command: 'inbox' }, 'web' as never);
  expect(plain).toEqual(box);
});
