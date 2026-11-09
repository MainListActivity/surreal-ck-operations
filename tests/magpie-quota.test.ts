import { describe, expect, test } from 'bun:test';
import {
  magpieBase, missingFrom, poolRoom, readMagpieQuotas, toUsageEntry, usageEntriesFrom, windowId,
  type MagpieProvider,
} from '../src/dispatcher/magpie-quota.ts';

/** A provider entry shaped like magpie's `/v1/magpie/quotas` payload. */
const provider = (over: Partial<MagpieProvider> = {}): MagpieProvider => ({
  provider: 'factory',
  name: 'Factory',
  kind: 'subscription',
  windows: [
    { name: '5 hours', used: 3, remaining: 97, resetsAt: '2026-10-21T03:41:57.439Z' },
    { name: '7 days', used: 74, remaining: 26, resetsAt: '2026-10-22T00:25:33.454Z' },
    { name: '30 days', used: 100, remaining: 0, resetsAt: '2026-10-30T02:24:21.791Z' },
  ],
  ...over,
});

describe('window ids', () => {
  test('the names magpie actually serves become the ids isLongWindow already classifies', () => {
    // The quota breaker treats /week|month|billing|cycle/ as long windows. Left as written,
    // "7 days" and "30 days" would read as short windows and the weekly floor would never fire
    // on the allowance that actually ran out.
    expect(windowId('5 hours')).toBe('five_hour');
    expect(windowId('7 days')).toBe('weekly');
    expect(windowId('30 days')).toBe('monthly');
    expect(/week|month/i.test(windowId('7 days'))).toBe(true);
    expect(/week|month/i.test(windowId('30 days'))).toBe(true);
    expect(/week|month/i.test(windowId('5 hours'))).toBe(false);
  });
  test('the Factory Core allowance keeps its own prefix so both lines stay distinguishable', () => {
    expect(windowId('Droid Core · 5 hours')).toBe('core_five_hour');
    expect(windowId('Droid Core · 7 days')).toBe('core_weekly');
    expect(windowId('Droid Core · 30 days')).toBe('core_monthly');
    expect(windowId('Droid Core : 5 hours')).toBe('core_five_hour');
    expect(/week|month/i.test(windowId('Droid Core · 30 days'))).toBe(true);
  });
  test('names with no duration keep a stable slug instead of throwing', () => {
    expect(windowId('Credits')).toBe('credits');
    expect(windowId('Premium requests')).toBe('premium_requests');
    expect(windowId('Add-on credits')).toBe('add_on_credits');
    expect(windowId('')).toBe('window');
  });
});

describe('provider entries', () => {
  test('factory maps to the provider id the employee definitions use', () => {
    const entry = toUsageEntry(provider())!;
    expect(entry.providerId).toBe('factory-droid');
    expect(entry.status).toBe('available');
    expect(entry.windows.map(w => w.id)).toEqual(['five_hour', 'weekly', 'monthly']);
    // The monthly allowance is what actually ran out, and it must survive as 0 rather than vanish.
    expect(entry.windows.at(-1)!.remainingPct).toBe(0);
    expect(entry.windows.at(-1)!.resetsAt).toBe('2026-10-30T02:24:21.791Z');
  });
  test('a provider magpie reports with an error is unusable, not merely low', () => {
    expect(toUsageEntry(provider({ error: '请在 Our Free Model 一体化供应商中重新打开控制台并启用' }))!.status).toBe('error');
  });
  test('federated ids and empty payloads are dropped rather than stored as dead rows', () => {
    expect(toUsageEntry(provider({ provider: 'remote-magpie/copilot' }))).toBeUndefined();
    expect(toUsageEntry(provider({ provider: '' }))).toBeUndefined();
    expect(toUsageEntry(provider({ windows: [] }))).toBeUndefined();
    expect(toUsageEntry(provider({ windows: [{ name: 'Credits' }] }))).toBeUndefined();
    expect(usageEntriesFrom([provider(), provider({ provider: 'remote-magpie/x' }), provider({ provider: 'claude' })])
      .map(e => e.providerId)).toEqual(['factory-droid', 'claude']);
  });
  test('percentages are clamped, and a window without a number is skipped', () => {
    const entry = toUsageEntry(provider({
      windows: [{ name: '5 hours', remaining: 140 }, { name: '7 days', remaining: -3 }, { name: '30 days', remaining: null }],
    }))!;
    expect(entry.windows.map(w => w.remainingPct)).toEqual([100, 0]);
  });
});

describe('merging with the Paseo usage list', () => {
  test('only providers Paseo does not report are taken from magpie', () => {
    // Paseo reports claude/codex/grok with fresh numbers; magpie must not overwrite those rows.
    const paseo = [{ providerId: 'claude' }, { providerId: 'codex' }, { providerId: 'grok' }];
    const magpie = usageEntriesFrom([provider(), provider({ provider: 'claude' })]);
    expect(missingFrom(paseo, magpie).map(e => e.providerId)).toEqual(['factory-droid']);
  });
  test('nothing is invented when Paseo already covers everything', () => {
    const paseo = [{ providerId: 'claude' }, { providerId: 'codex' }, { providerId: 'grok' }, { providerId: 'factory-droid' }];
    expect(missingFrom(paseo, usageEntriesFrom([provider()]))).toEqual([]);
  });
});

describe('gateway address', () => {
  test('MAGPIE_ADDR wins, with or without a scheme', () => {
    expect(magpieBase({ MAGPIE_ADDR: '127.0.0.1:4000' })).toBe('http://127.0.0.1:4000');
    expect(magpieBase({ MAGPIE_ADDR: 'http://10.0.0.5:4000' })).toBe('http://10.0.0.5:4000');
  });
  test('the VPS relay is the address when the env names none', () => {
    expect(magpieBase({})).toBe('https://data.maplayer.top/ofm');
    expect(magpieBase({ MAGPIE_ADDR: '   ' })).toBe('https://data.maplayer.top/ofm');
  });
});

describe('reading the snapshot', () => {
  const ok = (body: unknown, status = 200) => (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test('a good answer becomes entries', async () => {
    const entries = await readMagpieQuotas({ base: 'http://x', fetchImpl: ok({ data: [provider()] }) });
    expect(entries!.map(e => e.providerId)).toEqual(['factory-droid']);
  });
  test('every failure reads as "no answer", never as "no quota"', async () => {
    // Fail-open matters: a stopped magpie must not look like a subscription with zero allowance,
    // or the breaker would halt the whole company.
    const throwing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await readMagpieQuotas({ base: 'http://x', fetchImpl: throwing })).toBeUndefined();
    expect(await readMagpieQuotas({ base: 'http://x', fetchImpl: ok({}, 404) })).toBeUndefined();
    expect(await readMagpieQuotas({ base: 'http://x', fetchImpl: ok({ data: 'nope' }) })).toBeUndefined();
    expect(await readMagpieQuotas({ base: 'http://x', fetchImpl: ok([{ provider: 'x' }]) })).toEqual([]);
  });
  test('the employee key rides on the VPS read', async () => {
    const sent: unknown[] = [];
    const recording = (async (_url: string, init?: RequestInit) => {
      sent.push(init?.headers);
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    await readMagpieQuotas({ base: 'https://data.maplayer.top/ofm', headers: { Authorization: 'Bearer employee-key' }, fetchImpl: recording });
    expect(sent).toEqual([{ Authorization: 'Bearer employee-key' }]);
  });
  test('a bare array body is accepted as well as { data }', async () => {
    const entries = await readMagpieQuotas({ base: 'http://x', fetchImpl: ok([provider({ provider: 'claude' })]) });
    expect(entries!.map(e => e.providerId)).toEqual(['claude']);
  });
});

describe('pool room', () => {
  test('windows of one pool all bind, pools are alternatives', () => {
    // Factory: standard 5h/7d/30d have room, Droid Core 30d is spent -> the provider can still work.
    expect(poolRoom([
      { id: 'five_hour', pct: 99 }, { id: 'weekly', pct: 99 }, { id: 'monthly', pct: 99 },
      { id: 'core_five_hour', pct: 100 }, { id: 'core_weekly', pct: 100 }, { id: 'core_monthly', pct: 0 },
    ])).toBe(99);
    // One spent window inside a pool blocks that pool.
    expect(poolRoom([{ id: 'five_hour', pct: 90 }, { id: 'monthly', pct: 0 }])).toBe(0);
    // Both pools spent -> blocked; no windows -> unknown.
    expect(poolRoom([{ id: 'monthly', pct: 0 }, { id: 'core_monthly', pct: 0 }])).toBe(0);
    expect(poolRoom([])).toBeUndefined();
  });
});
