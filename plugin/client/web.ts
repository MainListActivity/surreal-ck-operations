import { Platform } from "react-native";

/**
 * 插件移动端规则：DOM 全局只允许出现在本文件。
 * 网页端在新窗口打开链接；原生端，或宿主没有 window.open 时返回 false，由调用方降级。
 */
export function openInNewWindow(url: string): boolean {
  if (Platform.OS !== "web") return false;
  const win = (globalThis as { window?: { open?: (u: string, target?: string, features?: string) => unknown } }).window;
  if (typeof win?.open !== "function") return false;
  win.open(url, "_blank", "noopener,noreferrer");
  return true;
}
