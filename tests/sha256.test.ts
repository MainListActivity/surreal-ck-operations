import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../src/sha256.ts';

const nodeSha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

test('sha256Hex matches the FIPS 180-4 example vectors', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
    .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256Hex agrees with node:crypto at every padding boundary and on multi-byte utf8 text', () => {
  const samples = [
    ...Array.from({ length: 140 }, (_, length) => 'a'.repeat(length)),
    '请先读 notes.md，再提交结果。',
    '派工消息：🙂 中英混排 mixed text 与 emoji'.repeat(12),
    'x'.repeat(10_000),
  ];
  for (const sample of samples) expect(sha256Hex(sample)).toBe(nodeSha256(sample));
});
