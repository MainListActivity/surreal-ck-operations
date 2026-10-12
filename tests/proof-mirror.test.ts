import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sha256 } from '../src/ops/proof-contract.ts';

// 固定产品源码的原始 UTF-8 字节，测试真实 schema 而非另写一个 mock schema。
const frozen = new URL('./fixtures/product-1adf73ae-internal-ai-proof.ts', import.meta.url);
const regions = [
  ['/** 供应商账户计划类型读回常量：', 'export const TOKEN_PLAN_PLAN_TYPE_FREE = "TOKEN_PLAN_PLAN_TYPE_FREE";\n'],
  ['const boundedRef = ', 'const model = z.string().max(128).regex(/^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*(?![\\s\\S])/);\n'],
  ['/** 三种证据文档共用的服务标识与采样窗口字段；', 'export type ReviewedEvidence = z.infer<typeof reviewedEvidenceSchema>;\n'],
];
const extract = (source: string) => regions.map(([start, end]) => {
  expect(source.split(start!).length).toBe(2); expect(source.split(end!).length).toBe(2);
  const a = source.indexOf(start!); return source.slice(a, source.indexOf(end!, a) + end!.length);
}).join('');
test('frozen PR175 source bytes and complete evidence helper regions mirror verbatim', () => {
  const product = readFileSync(frozen);
  expect(sha256(product)).toBe('3773b6a592cf1b8125ca4654ac51f14ba1e2214ab84ea49d64b2da09322af93e');
  const raw = extract(product.toString('utf8'));
  expect(sha256(raw)).toBe('f00621923eb24f2d7178fc03075d7876de4fc25891f8ea14bb62f87eddf79f20');
  expect(extract(readFileSync(new URL('../src/ops/proof-contract.ts', import.meta.url), 'utf8'))).toBe(raw);
});
