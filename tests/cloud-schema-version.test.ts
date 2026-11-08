import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_SCHEMA_VERSION } from '../src/database.ts';

// 云端 bootstrap 只核对库内结构版本：常量必须等于 applySchema 写入的最后一个版本，否则新结构上线后执行端会误判通过或误拒。
test('CLOUD_SCHEMA_VERSION 等于 applySchema 的最后一个 schema_version', () => {
  const source = readFileSync(join(import.meta.dir, '../src/database.ts'), 'utf8');
  const versions = [...source.matchAll(/SET schema_version = (\d+) WHERE/g)].map(match => Number(match[1]));
  expect(Math.max(...versions)).toBe(CLOUD_SCHEMA_VERSION);
});
