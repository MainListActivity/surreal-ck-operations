/**
 * 交付预览签名 URL：HMAC-SHA256 签发/校验。
 * 签名输入 = `${exp}\n${pathname}`（exp 为毫秒时间戳，pathname 为 URL 编码后的请求路径）。
 * 签发方（插件 RPC）与服务方（preview-server）共享 SCK_PREVIEW_SECRET。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type PreviewSigCheck = "ok" | "missing" | "bad" | "expired";

export const signPreviewPath = (secret: string, path: string, exp: number): string =>
  createHmac("sha256", secret).update(`${exp}\n${path}`, "utf8").digest("base64url");

/**
 * 校验请求签名。path 必须是原始 url.pathname（编码形态），签发方构造同一路径。
 */
export const checkPreviewSig = (
  secret: string, path: string, expRaw: string | null, sig: string | null, now = Date.now(),
): PreviewSigCheck => {
  if (!expRaw || !sig) return "missing";
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return "bad";
  const expect = Buffer.from(signPreviewPath(secret, path, exp), "utf8");
  const got = Buffer.from(sig, "utf8");
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return "bad";
  return exp >= now ? "ok" : "expired";
};

/**
 * 为 evidence(e)/deliverables(d) 下的 relPath 构造 `路径?exp&sig`。
 * 每段 relPath 单独 encodeURIComponent，分隔符保留。relPath 为空时签目录列表页。
 */
export const previewSignedPath = (
  secret: string, kind: "e" | "d", taskId: string, relPath: string,
  ttlMs = 3600_000, now = Date.now(),
): { path: string; exp: number } => {
  const exp = now + ttlMs;
  const segs = relPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const path = `/${kind}/${encodeURIComponent(taskId)}/${segs}`;
  return { path: `${path}?exp=${exp}&sig=${signPreviewPath(secret, path, exp)}`, exp };
};
