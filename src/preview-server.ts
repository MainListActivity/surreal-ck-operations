/**
 * 交付预览服务 · 应急桥接。正式宿主是 Paseo 插件（plugin/server/preview.ts），
 * 本脚本只在插件进程不可用时人工兜底，监听面与插件完全一致：
 *   LAN  面 0.0.0.0:SCK_PREVIEW_PORT（缺省 18777）——无鉴权，老板 Mac 局域网口径
 *   签名面 127.0.0.1:SCK_PREVIEW_SIGNED_PORT（缺省 18778）——需 SCK_PREVIEW_SECRET，
 *        公网经 VPS → SSH 反向隧道打到这里；本机回环绑定，隧道之外不可直连
 * 用法: bun src/preview-server.ts
 *   GET /e/<taskId>/<file>[?exp&sig]  → $SCK_SERVICE_HOME/evidence/<taskId>/<file>
 *   GET /d/<taskId>/<file>[?exp&sig]  → $SCK_SERVICE_HOME/deliverables/<taskId>/<file>
 *   GET /healthz → {"ok":true,"port":...,"uptime":...}
 * 路由与安全统一在 src/preview-core.ts（auth 选项即签名门控，密钥校验在 preview-sign.ts）。
 * previewFetch 为兼容导出（保留 #369 的测试与调用面）：secret 缺席时非 healthz 请求 503。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createPreviewFetch, lanIPv4 } from './preview-core.ts';

const HOME = process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany');

/** 与 plugin/server/env.ts 的 loadServiceEnv 等价：桥接进程自持，避免改 launchd plist。 */
const loadServiceEnv = () => {
  try {
    for (const line of readFileSync(join(HOME, 'private/service.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* service.env 可选 */ }
};

const ttlMs = () => Number(process.env.SCK_PREVIEW_TTL_MS ?? 3_600_000);

export interface PreviewOptions {
  /** 测试注入：serviceHome 覆盖；默认 env 或 ~/Library/Application Support/SurrealCKCompany。 */
  home?: string;
  /** 测试注入：签名密钥覆盖；默认 process.env.SCK_PREVIEW_SECRET。 */
  secret?: string;
  now?: () => number;
}

/** 签名面请求处理（#369 兼容导出）：/e//d/ 请求 secret 未配置时 fail-closed 503；
 *  healthz 与索引页等其余路径不鉴权，与 #369 合并版行为一致。 */
export function previewFetch(opts: PreviewOptions = {}) {
  const home = opts.home ?? HOME;
  const now = opts.now ?? Date.now;
  const open = createPreviewFetch({ home, port: 0, now });
  let authed: ReturnType<typeof createPreviewFetch> | undefined;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    if (!/^\/[ed]\//.test(url.pathname)) return open(req);
    const key = opts.secret ?? process.env.SCK_PREVIEW_SECRET;
    if (!key) return new Response('preview secret not configured', { status: 503 });
    authed ??= createPreviewFetch({ home, port: 0, now, auth: { secret: key, ttlMs: ttlMs() } });
    return authed(req);
  };
}

if (import.meta.main) {
  loadServiceEnv();
  const lanPort = Number(process.env.SCK_PREVIEW_PORT ?? 18777);
  Bun.serve({
    port: lanPort,
    hostname: '0.0.0.0',
    fetch: createPreviewFetch({ home: HOME, port: lanPort }),
  });
  console.log(`deliverable-preview LAN listening: http://0.0.0.0:${lanPort} → http://${lanIPv4()}:${lanPort} (open)`);
  const secret = process.env.SCK_PREVIEW_SECRET;
  if (secret) {
    const sigPort = Number(process.env.SCK_PREVIEW_SIGNED_PORT ?? 18778);
    Bun.serve({
      port: sigPort,
      hostname: '127.0.0.1',
      fetch: createPreviewFetch({ home: HOME, port: sigPort, auth: { secret, ttlMs: ttlMs() } }),
    });
    console.log(`deliverable-preview signed listening: http://127.0.0.1:${sigPort} (tunnel-facing, loopback only)`);
  } else {
    console.log('deliverable-preview signed listener disabled: SCK_PREVIEW_SECRET not set');
  }
}
