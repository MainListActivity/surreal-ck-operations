// 老板端页面构建：共享核心里的 node:crypto 指向浏览器等价模块（逐字节一致，见 tests/node-crypto-shim.test.ts），
// node:buffer 指向 npm 的 buffer。其它 node: 导入一律报错，避免把服务端代码静默打进页面。
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const shims: Record<string, string> = {
  'node:crypto': resolve(root, 'src/ui/node-shim/crypto.ts'),
  'node:buffer': resolve(root, 'node_modules/buffer/index.js'),
};

// 按需加载的代码块文件名带内容哈希；先清掉旧块，避免把过期文件一起发布。
await rm(resolve(root, 'public/chunks'), { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/ui/main.tsx')],
  outdir: resolve(root, 'public'),
  naming: { entry: 'app.js', chunk: 'chunks/[name]-[hash].js' },
  splitting: true,
  format: 'esm',
  target: 'browser',
  minify: true,
  sourcemap: 'external',
  jsx: { importSource: 'preact' },
  plugins: [{
    name: 'browser-node-shims',
    setup(build) {
      build.onResolve({ filter: /^node:/ }, (args) => {
        const path = shims[args.path];
        if (!path) throw new Error(`页面构建不支持 ${args.path}（来自 ${args.importer}）`);
        return { path };
      });
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
for (const out of result.outputs) console.log(`${out.path.replace(root + '/', '')}  ${(out.size / 1024).toFixed(1)} KB`);
