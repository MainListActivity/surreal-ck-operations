/**
 * Relay Operations 插件面共享调色板——数值唯一来源在 plugin/shared/relay-tokens.ts。
 * 只服务 plugin/client 的 React Native 面；网页审核台走 shared/relay-shell.ts。
 * 明暗选择沿用既有做法：从宿主主题的 surface0 亮度判断，不引入宿主之外的运行时依赖。
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { RELAY_DARK, RELAY_LIGHT, type RelayPalette as SharedPalette } from "../shared/relay-tokens.ts";

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

/** 共享色板 → RN 面板调色板。面板沿用既有 key 名，数值全部取自共享 token。 */
function toClientPalette(t: SharedPalette, light: boolean): RelayPalette {
  return {
    light,
    core: {
      surface0: t.bg, surface1: t.panel, surface2: t.input, foreground: t.text,
      foregroundMuted: t.muted, border: t.border, accent: t.accent,
      accentForeground: light ? "#ffffff" : "#1c1830",
    },
    inputBg: t.input,
    score: t.score,
    accentSoft: t.accentSoft,
    success: t.success, successSoft: t.successSoft,
    warning: t.warning, warningSoft: t.warningSoft,
    danger: t.danger, dangerSoft: t.dangerSoft, dangerBorder: t.dangerBorder,
    blue: t.blue, blueSoft: t.blueSoft,
  };
}

const LIGHT: RelayPalette = toClientPalette(RELAY_LIGHT, true);
const DARK: RelayPalette = toClientPalette(RELAY_DARK, false);

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
