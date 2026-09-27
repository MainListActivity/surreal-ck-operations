import { afterAll, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPrivateCredential } from '../src/mcp/credential-file';

const dir = await mkdtemp(join(tmpdir(), 'sck-credential-test-'));
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test('only owner-readable employee credential files are accepted', async () => {
  const path = join(dir, 'employee.token');
  await writeFile(path, 'sck_synthetic-test-only\n', { mode: 0o600 });
  expect(await readPrivateCredential(path)).toBe('sck_synthetic-test-only');
  await chmod(path, 0o644);
  await expect(readPrivateCredential(path)).rejects.toThrow('accessible only to its owner');
});
