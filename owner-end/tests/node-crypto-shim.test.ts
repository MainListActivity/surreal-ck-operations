import { expect, test } from 'bun:test';
import * as node from 'node:crypto';
import * as shim from '../src/ui/node-shim/crypto.ts';

const inputs = ['', 'abc', '老板端 0.11 生产验收（仅测试）', '🧪 emoji + ascii', 'x'.repeat(10_000)];

test('createHash sha256：单次与多次 update、hex / base64 / base64url / Buffer 与 Node 逐字节一致', () => {
  for (const text of inputs) {
    for (const enc of ['hex', 'base64', 'base64url'] as const) {
      expect(shim.createHash('sha256').update(text).digest(enc)).toBe(node.createHash('sha256').update(text).digest(enc));
    }
    const parts = [text.slice(0, 3), text.slice(3), '尾'];
    const a = shim.createHash('sha256'); const b = node.createHash('sha256');
    for (const p of parts) { a.update(p); b.update(p); }
    expect(a.digest('hex')).toBe(b.digest('hex'));
    expect([...shim.createHash('sha256').update(new TextEncoder().encode(text)).digest()])
      .toEqual([...node.createHash('sha256').update(new TextEncoder().encode(text)).digest()]);
  }
});

test('createHmac sha256：字符串与字节密钥、多种输出编码与 Node 一致', () => {
  const keys: Array<string | Uint8Array> = ['k', '密钥', new Uint8Array(64).fill(7), node.randomBytes(32)];
  for (const key of keys) for (const text of inputs) for (const enc of ['hex', 'base64url'] as const) {
    expect(shim.createHmac('sha256', key).update(text).digest(enc)).toBe(node.createHmac('sha256', key).update(text).digest(enc));
  }
});

test('timingSafeEqual 与 Node 行为一致；随机数与 UUID 形状正确；不支持的算法与 AES 明确拒绝', () => {
  const a = new Uint8Array([1, 2, 3]);
  expect(shim.timingSafeEqual(a, new Uint8Array([1, 2, 3]))).toBe(node.timingSafeEqual(a, new Uint8Array([1, 2, 3])));
  expect(shim.timingSafeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
  expect(() => shim.timingSafeEqual(a, new Uint8Array(2))).toThrow(RangeError);
  expect(shim.randomBytes(32).byteLength).toBe(32);
  expect(shim.randomBytes(32).toString('base64url')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(shim.randomBytes(3).toString('hex')).toMatch(/^[0-9a-f]{6}$/);
  expect(shim.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(() => shim.createHash('md5')).toThrow();
  expect(() => shim.createCipheriv()).toThrow('执行端');
});
