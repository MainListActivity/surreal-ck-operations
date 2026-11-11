/**
 * 浏览器构建里替代 `node:crypto`（构建插件把共享核心的 `node:crypto` 导入指向本模块）。
 * 只实现共享核心实际用到的部分，结果与 Node 逐字节一致（见 tests/node-crypto-shim.test.ts）：
 * createHash('sha256')、createHmac('sha256')、timingSafeEqual、randomBytes、randomUUID。
 * AES（createCipheriv/createDecipheriv）只用于项目密钥封存，需要执行端的密钥，浏览器里明确拒绝。
 */
import { Buffer } from 'buffer';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

type Input = string | Uint8Array;
type Encoding = 'hex' | 'base64' | 'base64url' | 'utf8' | 'latin1';

const bytesOf = (data: Input, encoding?: BufferEncoding): Uint8Array =>
  typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : data;

function onlySha256(algorithm: string): void {
  if (algorithm.toLowerCase() !== 'sha256') throw new Error(`浏览器构建只支持 sha256，收到 ${algorithm}`);
}

function output(bytes: Uint8Array, encoding?: Encoding): Buffer | string {
  const buf = Buffer.from(bytes);
  return encoding ? buf.toString(encoding) : buf;
}

class Hash {
  readonly #state = sha256.create();
  update(data: Input, encoding?: BufferEncoding): this {
    this.#state.update(bytesOf(data, encoding));
    return this;
  }
  digest(): Buffer;
  digest(encoding: Encoding): string;
  digest(encoding?: Encoding): Buffer | string {
    return output(this.#state.digest(), encoding);
  }
}

class Hmac {
  readonly #state;
  constructor(key: Input) {
    this.#state = hmac.create(sha256, bytesOf(key));
  }
  update(data: Input, encoding?: BufferEncoding): this {
    this.#state.update(bytesOf(data, encoding));
    return this;
  }
  digest(): Buffer;
  digest(encoding: Encoding): string;
  digest(encoding?: Encoding): Buffer | string {
    return output(this.#state.digest(), encoding);
  }
}

export function createHash(algorithm: string): Hash {
  onlySha256(algorithm);
  return new Hash();
}

export function createHmac(algorithm: string, key: Input): Hmac {
  onlySha256(algorithm);
  return new Hmac(key);
}

/** 与 Node 相同：长度不同抛 RangeError；长度相同时逐字节恒时比较。 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomBytes(size: number): Buffer {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes);
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

function unsupported(): never {
  throw new Error('项目密钥加解密需要执行端的密钥，老板端页面不支持');
}
export const createCipheriv = unsupported;
export const createDecipheriv = unsupported;

export default { createHash, createHmac, timingSafeEqual, randomBytes, randomUUID, createCipheriv, createDecipheriv };
