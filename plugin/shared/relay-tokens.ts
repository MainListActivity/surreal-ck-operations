/**
 * 公司插件唯一设计变量源。颜色、字号、圆角、间距、阴影只在这里定义；
 * 网页（relay-shell.ts / model-routing-design.ts / preview-core.ts）、
 * Paseo 公司面板（relay-theme.ts / client/*.tsx）全部从这里取值。
 * 改一处，四个面一起变。纯数据零依赖——RN 面、网页、vendored 交付预览都能直接 import。
 */

/** 色板：一个面的明暗两套。键名即 CSS 变量 `--relay-*` 与 RN 调色板的对应键。 */
export interface RelayPalette {
  bg: string;
  panel: string;
  panelSoft: string;
  input: string;
  row: string;
  rowHover: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  accentBorder: string;
  accentShadow: string;
  score: string;
  control: string;
  success: string;
  successSoft: string;
  danger: string;
  dangerSoft: string;
  dangerBorder: string;
  warning: string;
  warningSoft: string;
  blue: string;
  blueSoft: string;
  /** 壳侧栏：明暗两态下都保持深色侧栏（设计稿口径）。 */
  sidebar: string;
  sidebarText: string;
  sidebarMuted: string;
  sidebarHover: string;
  sidebarActive: string;
  shadow: string;
  shadowLg: string;
  /** 页签/浮层的细分阴影。 */
  shadowTab: string;
  shadowToast: string;
  /** 图表主色与柔色。 */
  chart: string;
  chartSoft: string;
  /** 浮层/提示条固定深色（不随明暗切换）。 */
  toastBg: string;
  toastBorder: string;
  /** 品牌渐变起止色。 */
  brandFrom: string;
  brandTo: string;
  /** 强调色上的文字（网页按钮/徽章）。 */
  onAccent: string;
  /** Paseo 面板强调按钮上的文字（深色主题用深字压在浅紫上）。 */
  accentInk: string;
}

export const RELAY_LIGHT: RelayPalette = {
  bg: "#f4f5f7", panel: "#ffffff", panelSoft: "#f8f8fa", input: "#f5f5f7", row: "#ffffff", rowHover: "#f6f4ff",
  border: "#e5e6ea", borderStrong: "#d8dae0", text: "#202127", muted: "#71747e", faint: "#9da0a8",
  accent: "#6d5bd0", accentStrong: "#5947bc", accentSoft: "#f0edff", accentBorder: "rgba(109,91,208,.32)", accentShadow: "rgba(109,91,208,.22)",
  score: "#6957cc", control: "#25272d", success: "#218663", successSoft: "#eaf7f1", danger: "#b14f56", dangerSoft: "#fff0f1", dangerBorder: "rgba(177,79,86,.3)",
  warning: "#a7671d", warningSoft: "#fff6e8", blue: "#3d6eb1", blueSoft: "#edf4ff",
  sidebar: "#16171b", sidebarText: "#e9e9ec", sidebarMuted: "#888b94", sidebarHover: "#202127", sidebarActive: "#2b2837",
  shadow: "0 12px 34px rgba(27,29,36,.055)", shadowLg: "0 24px 70px rgba(27,29,36,.09)",
  chart: "#7662df", chartSoft: "#dcd6fc", toastBg: "#222329", toastBorder: "#3d3e45", brandFrom: "#9583f3", brandTo: "#6650c4",
  shadowTab: "0 2px 8px rgba(20,22,28,.08)", shadowToast: "0 14px 40px rgba(0,0,0,.28)",
  onAccent: "#ffffff", accentInk: "#ffffff",
};

export const RELAY_DARK: RelayPalette = {
  bg: "#0e0f12", panel: "#17181d", panelSoft: "#1b1d22", input: "#111216", row: "#181a20", rowHover: "#201f2b",
  border: "#2a2c33", borderStrong: "#363941", text: "#f0f0f2", muted: "#9a9da7", faint: "#6f727b",
  accent: "#9581ff", accentStrong: "#aa9aff", accentSoft: "#28233d", accentBorder: "rgba(149,129,255,.35)", accentShadow: "rgba(149,129,255,.22)",
  score: "#ad9eff", control: "#f2f2f3", success: "#58c99b", successSoft: "#182c25", danger: "#e08287", dangerSoft: "#321e21", dangerBorder: "rgba(224,130,135,.32)",
  warning: "#e1a456", warningSoft: "#302619", blue: "#78a4df", blueSoft: "#1a2636",
  sidebar: "#111216", sidebarText: "#eeeef0", sidebarMuted: "#858892", sidebarHover: "#1d1f24", sidebarActive: "#29253a",
  shadow: "0 12px 34px rgba(0,0,0,.22)", shadowLg: "0 24px 70px rgba(0,0,0,.34)",
  chart: "#9784ff", chartSoft: "#3b345f", toastBg: "#222329", toastBorder: "#3d3e45", brandFrom: "#9583f3", brandTo: "#6650c4",
  shadowTab: "0 2px 8px rgba(20,22,28,.16)", shadowToast: "0 14px 40px rgba(0,0,0,.34)",
  onAccent: "#ffffff", accentInk: "#1c1830",
};

/** 字号阶梯（px）：只认这一组，页面/面板共用。 */
export const RELAY_FONT = {
  /** 页面大标题。 */
  display: 26,
  /** 卡片/区块大标题。 */
  h1: 18,
  /** 抽屉主标题、区块标题。 */
  h2: 14,
  h3: 13,
  /** 正文。 */
  body: 12,
  /** 辅助说明、表头。 */
  small: 11,
  /** 弱化说明、标签、徽章。 */
  caption: 10,
  /** 单字距 kicker。 */
  kicker: 10,
  /** 徽标/计数的极小字。 */
  micro: 9,
} as const;

/** 圆角阶梯（px）。 */
export const RELAY_RADIUS = {
  sm: 8,
  md: 9,
  lg: 12,
  xl: 13,
  xxl: 14,
  pill: 99,
} as const;

/** 控件高度（px），避免按钮/输入框尺寸漂移。 */
export const RELAY_CONTROL = {
  xs: 27,
  sm: 31,
  md: 34,
  lg: 38,
  xl: 45,
} as const;

/** 间距阶梯（px）。 */
export const RELAY_SPACE = {
  xxs: 4,
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
  xxl: 18,
  page: 20,
  section: 24,
} as const;

/**
 * 数值阶梯：CSS 里每个 font-size / border-radius / padding / margin / gap 都引用
 * 由这些数组生成的 `--relay-fs-N` / `--relay-r-N` / `--relay-sp-N`，
 * 页面里不再出现裸 px。新增值只在这里改。
 */
/** CSS 数值阶梯：网页里每个 font-size / border-radius / padding / margin / gap 引用由此生成的变量。 */
export const RELAY_FONT_PX = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 23, 26, 28, 30] as const;
export const RELAY_RADIUS_PX = [2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 22, 23, 99, 999] as const;
export const RELAY_SPACE_PX = [...Array.from({ length: 49 }, (_, i) => i), 49, 50, 56, 60, 69, 70] as const;

/**
 * RN 面板数值阶梯：包含网页 CSS 用不到的分数/负值/大尺寸，仍是同一份文件、同一组阶梯。
 * 小数字面量（letterSpacing、opacity 不算尺寸）也在此登记，避免散落。
 */
export const RELAY_RN_PX = [
  ...RELAY_FONT_PX, ...RELAY_RADIUS_PX, ...RELAY_SPACE_PX,
  -18, -16, -0.4, 0.5, 1.5, 1.6, 11.5, 12.5, 17, 19, 36, 46, 55, 62, 64, 65, 75, 80, 90, 125, 130, 140, 160, 200, 280, 390, 1100,
] as const;

export type RelayPx = (typeof RELAY_RN_PX)[number];
/** 数值阶梯查表：RN 样式用 fs/radius/sp，网页 CSS 用同值生成的 var()。 */
const px = (n: RelayPx): number => {
  if (!(RELAY_RN_PX as readonly number[]).includes(n)) throw new Error(`relay-tokens: ${n} 不在共享数值阶梯中`);
  return n;
};
export const fs = px;
export const radius = px;
export const sp = px;

/** 由数值阶梯生成 CSS 自定义属性串。 */
export function scaleToCssVars(): string {
  return [
    ...RELAY_FONT_PX.map(n => `--relay-fs-${n}:${n}px;`),
    ...RELAY_RADIUS_PX.map(n => `--relay-r-${n}:${n}px;`),
    ...RELAY_SPACE_PX.map(n => `--relay-sp-${n}:${n}px;`),
  ].join("");
}

/** 把色板铺成 CSS 自定义属性串（`--relay-foo:val;`）。 */
export function paletteToCssVars(p: RelayPalette): string {
  const map: Record<string, string> = {
    bg: p.bg, panel: p.panel, "panel-soft": p.panelSoft, input: p.input, row: p.row, "row-hover": p.rowHover,
    border: p.border, "border-strong": p.borderStrong, text: p.text, muted: p.muted, faint: p.faint,
    accent: p.accent, "accent-strong": p.accentStrong, "accent-soft": p.accentSoft, "accent-border": p.accentBorder, "accent-shadow": p.accentShadow,
    score: p.score, control: p.control, success: p.success, "success-soft": p.successSoft,
    danger: p.danger, "danger-soft": p.dangerSoft, "danger-border": p.dangerBorder,
    warning: p.warning, "warning-soft": p.warningSoft, blue: p.blue, "blue-soft": p.blueSoft,
    sidebar: p.sidebar, "sidebar-text": p.sidebarText, "sidebar-muted": p.sidebarMuted, "sidebar-hover": p.sidebarHover, "sidebar-active": p.sidebarActive,
    shadow: p.shadow, "shadow-lg": p.shadowLg, "shadow-tab": p.shadowTab, "shadow-toast": p.shadowToast, chart: p.chart, "chart-soft": p.chartSoft,
    "toast-bg": p.toastBg, "toast-border": p.toastBorder, "brand-from": p.brandFrom, "brand-to": p.brandTo,
    "on-accent": p.onAccent, "accent-ink": p.accentInk,
  };
  return Object.entries(map).map(([k, v]) => `--relay-${k}:${v};`).join("");
}

/** 交付预览目录页 CSS：与其他面共用同一调色板与字号。插件宿主注入 preview-core。 */
export const previewListCss = `
:root{color-scheme:light dark;${paletteToCssVars(RELAY_LIGHT)}}
:root[data-theme="dark"]{${paletteToCssVars(RELAY_DARK)}}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${paletteToCssVars(RELAY_DARK)}}}
@media(prefers-color-scheme:light){:root:not([data-theme="dark"]){${paletteToCssVars(RELAY_LIGHT)}}}
body{font:var(--relay-fs-12)/1.8 Inter,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif;margin:0 auto;max-width:760px;padding:var(--relay-sp-24);background:var(--relay-bg);color:var(--relay-text)}
a{color:var(--relay-score);word-break:break-all;text-decoration:none}
h1{font-size:var(--relay-fs-18);margin:0 0 var(--relay-sp-14);letter-spacing:-.02em}
ul{list-style:none;padding:0;margin:0;border:1px solid var(--relay-border);border-radius:var(--relay-r-12);background:var(--relay-panel);overflow:hidden}
li{display:flex;align-items:baseline;gap:var(--relay-sp-8);padding:var(--relay-sp-9) var(--relay-sp-13);border-top:1px solid var(--relay-border);font-size:var(--relay-fs-12)}
li:first-child{border-top:0}
li:hover{background:var(--relay-row-hover)}
.sz{color:var(--relay-faint);font-size:var(--relay-fs-10);margin-left:auto;white-space:nowrap}
`;
