/**
 * Relay Operations 插件面共享调色板（源：redesign2 审核原型的 --relay-* token）。
 * 只服务 plugin/client 的 React Native 面；网页审核台走 shared/relay-shell.ts。
 * 明暗选择沿用既有做法：从宿主主题的 surface0 亮度判断，不引入宿主之外的运行时依赖。
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Theme = PluginSurfaceProps["theme"];

export interface RelayPalette {
  light: boolean;
  /** 与宿主 PluginTheme 同名的核心键，覆盖后所有既有的 colors.* 读取都落到新设计。 */
  core: Pick<Theme["colors"], "surface0" | "surface1" | "surface2" | "foreground" | "foregroundMuted" | "border" | "accent" | "accentForeground">;
  inputBg: string;
  score: string;
  accentSoft: string;
  success: string; successSoft: string;
  warning: string; warningSoft: string;
  danger: string; dangerSoft: string; dangerBorder: string;
  blue: string; blueSoft: string;
}

const LIGHT: RelayPalette = {
  light: true,
  core: { surface0: "#f4f5f7", surface1: "#ffffff", surface2: "#f5f5f7", foreground: "#202127", foregroundMuted: "#71747e", border: "#e5e6ea", accent: "#6d5bd0", accentForeground: "#ffffff" },
  inputBg: "#ececef",
  score: "#6957cc",
  accentSoft: "#f0edff",
  success: "#218663", successSoft: "#eaf7f1",
  warning: "#a7671d", warningSoft: "#fff6e8",
  danger: "#b14f56", dangerSoft: "#fff0f1", dangerBorder: "rgba(177,79,86,.3)",
  blue: "#3d6eb1", blueSoft: "#edf4ff",
};

const DARK: RelayPalette = {
  light: false,
  core: { surface0: "#0e0f12", surface1: "#17181d", surface2: "#111216", foreground: "#f0f0f2", foregroundMuted: "#9a9da7", border: "#2a2c33", accent: "#9581ff", accentForeground: "#1c1830" },
  inputBg: "#23252b",
  score: "#ad9eff",
  accentSoft: "#28233d",
  success: "#58c99b", successSoft: "#182c25",
  warning: "#e1a456", warningSoft: "#302619",
  danger: "#e08287", dangerSoft: "#321e21", dangerBorder: "rgba(224,130,135,.32)",
  blue: "#78a4df", blueSoft: "#1a2636",
};

function surfaceIsLight(theme: Theme): boolean {
  const s = theme.colors.surface0 ?? "";
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)?.[1];
  const rgb = hex?.length === 3 ? hex.split("").map(x => x + x).join("") : hex;
  const cssRgb = /rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/i.exec(s);
  const channels = rgb ? [parseInt(rgb.slice(0, 2), 16), parseInt(rgb.slice(2, 4), 16), parseInt(rgb.slice(4, 6), 16)] : cssRgb?.slice(1, 4).map(Number);
  if (channels) return (channels[0]! * 299 + channels[1]! * 587 + channels[2]! * 114) / 1000 > 128;
  const hsl = s.startsWith("hsl") ? /[\d.]+%/g.exec(s) : null;
  return hsl?.[0] ? parseFloat(hsl[0]) > 50 : true;
}

export function relayPalette(theme: Theme): RelayPalette {
  return surfaceIsLight(theme) ? LIGHT : DARK;
}

/** Same shape as the host theme, with the core colors swapped for the Relay palette. */
export function relayTheme<T extends { colors: Theme["colors"] }>(theme: T): T {
  return { ...theme, colors: { ...theme.colors, ...relayPalette(theme).core } };
}
