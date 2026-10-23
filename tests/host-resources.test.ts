import { expect, test } from 'bun:test';
import { memoryBlocked, hostResources } from '../src/dispatcher/host.ts';
import { tmpdir } from 'node:os';
test('kernel pressure overrides low free-page estimates; warning/critical stop new dispatch', () => {
  expect(memoryBlocked({ freeMemMb: 100, freeDiskMb: 99999, memoryPressure: 1 }, 2048)).toBe(false);
  expect(memoryBlocked({ freeMemMb: 8192, freeDiskMb: 99999, memoryPressure: 2 }, 2048)).toBe(true);
  expect(memoryBlocked({ freeMemMb: 8192, freeDiskMb: 99999, memoryPressure: 4 }, 2048)).toBe(true);
  expect(memoryBlocked({ freeMemMb: 100, freeDiskMb: 99999 }, 2048)).toBe(true);
  expect(memoryBlocked({ freeMemMb: 100, freeDiskMb: 99999, memoryPressure: 4 }, 0)).toBe(false);
});
test('valid sysctl skips the slower memory_pressure command; unavailable sysctl falls back', () => {
  const calls: string[] = [];
  const h = hostResources(tmpdir(), { platform: 'darwin', read: (bin) => { calls.push(bin); return '1\n'; } });
  expect(h.memoryPressure).toBe(1);
  expect(calls).toHaveLength(1);
  const fallback = hostResources(tmpdir(), { platform: 'darwin', read: (bin) => {
    if (bin.endsWith('sysctl')) throw new Error('unavailable');
    return 'System-wide memory free percentage: 25%';
  } });
  expect(fallback.memoryPressure).toBeUndefined();
  expect(fallback.freeMemMb).toBeGreaterThan(0);
});
