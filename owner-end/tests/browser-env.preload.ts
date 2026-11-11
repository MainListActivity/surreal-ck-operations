// 用页面构建的运行环境跑共享核心的测试：node:crypto 换成浏览器等价模块，全局 Buffer 换成 npm 的 buffer。
// 用法：bun test --preload ./owner-end/tests/browser-env.preload.ts <测试>
import { mock } from 'bun:test';
import { Buffer as BrowserBuffer } from 'buffer';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha2';
import * as shim from '../src/ui/node-shim/crypto.ts';

// 产品代码只用 sha256（走等价模块）。测试脚手架用 HS512 给测试 JWT 签名，这里单独用 noble 提供，不引入 Node 实现。
function createHmac(algorithm: string, key: string | Uint8Array) {
  if (algorithm.toLowerCase() !== 'sha512') return shim.createHmac(algorithm, key);
  const state = hmac.create(sha512, typeof key === 'string' ? BrowserBuffer.from(key) : key);
  const self = {
    update(data: string | Uint8Array) { state.update(typeof data === 'string' ? BrowserBuffer.from(data) : data); return self; },
    digest(encoding?: 'hex' | 'base64' | 'base64url') {
      const out = BrowserBuffer.from(state.digest());
      return encoding ? out.toString(encoding) : out;
    },
  };
  return self;
}
const browser = { ...shim, createHmac };
mock.module('node:crypto', () => ({ ...browser, default: browser }));
mock.module('crypto', () => ({ ...browser, default: browser }));
(globalThis as { Buffer: unknown }).Buffer = BrowserBuffer;
