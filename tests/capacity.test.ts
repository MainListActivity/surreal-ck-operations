import { expect, test } from 'bun:test';
import { roleCapacity } from '../src/dispatcher/dispatcher.ts';
import type { ProviderHealth } from '../src/workforce.ts';

const defs = [
  { role: 'engineering', provider: 'codex', enabled: true }, { role: 'engineering', provider: 'grok', enabled: true },
  { role: 'engineering', provider: 'pi', enabled: true }, { role: 'engineering', provider: 'devin', enabled: false },
  { role: 'gm', provider: 'codex', enabled: true }, { role: 'qa', provider: 'pi', enabled: true },
] as const;
const health = new Map<string, ProviderHealth>([['grok', { provider: 'grok', state: 'exhausted', until: 2000, failures: 1, lastError: '402 Payment Required' }]]);
const quota = new Map([['codex', '额度不足（周/月额度 0%<2%）']]);

test('capacity counts only enabled seats whose provider has quota and is not cooling off', () => {
  const rows = roleCapacity([...defs], quota, health, 1000);
  expect(rows.find(r => r.role === 'engineering')).toEqual({ role: 'engineering', total: 3, usable: 1, down: ['codex 额度不足（周/月额度 0%<2%）', 'grok 额度耗尽或异常：402 Payment Required'] });
  expect(rows.find(r => r.role === 'gm')).toMatchObject({ total: 1, usable: 0 });
  expect(rows.find(r => r.role === 'qa')).toMatchObject({ total: 1, usable: 1, down: [] });
  expect(rows.map(r => r.role)).toEqual(['gm', 'engineering', 'qa']);
});

test('a provider whose cooldown has passed is usable again for a probe', () => {
  expect(roleCapacity([...defs], new Map(), health, 3000).find(r => r.role === 'engineering')!.usable).toBe(3);
});
