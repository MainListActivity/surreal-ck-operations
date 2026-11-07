/**
 * Relay Operations 审核台共享样式（源：redesign2/deliverables/model-ranking-ui 的审核原型）。
 * 只服务 /o/<token> 的网页审核台与模型排序页；Paseo 插件 RN 面不走这份 CSS。
 * 结构类名沿用原型（sidebar/topbar/page-title/decision-card/goal-card/docs-layout/…），
 * 排序页既有交互类名（settings-panel/results-panel/model-row…）按新视觉重写。
 * color-mix/backdrop-filter 不用：LAN 面要兼容旧移动 WebView，派生色直接落成 rgba 变量。
 */

export const relayIcon = (name: string, cls = ""): string =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${RELAY_ICON_PATHS[name] ?? RELAY_ICON_PATHS.grid!}</svg>`;

export const RELAY_ICON_PATHS: Record<string, string> = {
  inbox: '<path d="M4 5h16v12H4z"/><path d="M4 13h4l2 3h4l2-3h4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M15 9l5-5"/>',
  book: '<path d="M4 5.5A3.5 3.5 0 017.5 2H20v17H7.5A3.5 3.5 0 014 15.5z"/><path d="M8 6h8M8 10h7"/>',
  layers: '<path d="M12 3L3 8l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/>',
  send: '<path d="M21 3L9 15M21 3l-7 18-5-6-6-5 18-7z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  pulse: '<path d="M3 12h3l2-6 4 12 3-9 2 3h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M18 9a7 7 0 00-12-2L4 9M6 15a7 7 0 0012 2l2-2"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  check: '<path d="M5 12l4 4L19 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
};

import { RELAY_DARK, RELAY_LIGHT, RELAY_FONT, RELAY_RADIUS, RELAY_CONTROL, RELAY_SPACE, paletteToCssVars, scaleToCssVars } from "./relay-tokens.ts";

/** 字号/圆角/控件高/间距设计变量：同一份常量铺成 CSS 变量，页面共用。 */
const SIZE_TOKENS = `--relay-fs-display:${RELAY_FONT.display}px;--relay-fs-h1:${RELAY_FONT.h1}px;--relay-fs-h2:${RELAY_FONT.h2}px;--relay-fs-h3:${RELAY_FONT.h3}px;--relay-fs-body:${RELAY_FONT.body}px;--relay-fs-small:${RELAY_FONT.small}px;--relay-fs-caption:${RELAY_FONT.caption}px;--relay-fs-kicker:${RELAY_FONT.kicker}px;--relay-fs-micro:${RELAY_FONT.micro}px;
--relay-r-sm:${RELAY_RADIUS.sm}px;--relay-r-md:${RELAY_RADIUS.md}px;--relay-r-lg:${RELAY_RADIUS.lg}px;--relay-r-xl:${RELAY_RADIUS.xl}px;--relay-r-xxl:${RELAY_RADIUS.xxl}px;--relay-r-pill:${RELAY_RADIUS.pill}px;
--relay-c-xs:${RELAY_CONTROL.xs}px;--relay-c-sm:${RELAY_CONTROL.sm}px;--relay-c-md:${RELAY_CONTROL.md}px;--relay-c-lg:${RELAY_CONTROL.lg}px;--relay-c-xl:${RELAY_CONTROL.xl}px;
--relay-s-xxs:${RELAY_SPACE.xxs}px;--relay-s-xs:${RELAY_SPACE.xs}px;--relay-s-sm:${RELAY_SPACE.sm}px;--relay-s-md:${RELAY_SPACE.md}px;--relay-s-lg:${RELAY_SPACE.lg}px;--relay-s-xl:${RELAY_SPACE.xl}px;--relay-s-xxl:${RELAY_SPACE.xxl}px;--relay-s-page:${RELAY_SPACE.page}px;--relay-s-section:${RELAY_SPACE.section}px`;
/** 数值阶梯变量与语义别名同一来源（relay-tokens.ts），CSS 里只写 var()。 */
const SCALE_TOKENS = scaleToCssVars();

const DARK_TOKENS = paletteToCssVars(RELAY_DARK);
const LIGHT_TOKENS = paletteToCssVars(RELAY_LIGHT);

export const relayShellCss = `
/* ---- tokens：默认浅色，data-theme=dark 或系统深色时切换（toggle 写 data-theme） ---- */
:root{color-scheme:light dark;${LIGHT_TOKENS}${SIZE_TOKENS}${SCALE_TOKENS}}
:root[data-theme="dark"]{${DARK_TOKENS}}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK_TOKENS}}}
@media(prefers-color-scheme:light){:root:not([data-theme="dark"]){${LIGHT_TOKENS}}}

/* ---- base ---- */
*{box-sizing:border-box}
html,body{margin:0;min-width:320px;min-height:100%;font-family:Inter,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
button,input,textarea,select{font:inherit}
button{color:inherit}
body{background:var(--relay-bg);color:var(--relay-text)}
a{color:var(--relay-score);word-break:break-all}
.icon{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
h4.sec,h4{color:var(--relay-muted);font-size:var(--relay-fs-body);letter-spacing:.06em;margin:var(--relay-sp-18) 0 var(--relay-sp-8)}
/* 区块小标题：抽屉/卡片的 h3 统一为设计字号，避免浏览器默认 18.7px 外露 */
section h3,h3.sec-title{margin:0 0 var(--relay-sp-6);font-size:var(--relay-fs-h3);font-weight:700;color:var(--relay-text)}
/* 弱化说明文字：替代散落各处的 .meta/.byline 字号 */
.meta{color:var(--relay-muted);font-size:var(--relay-fs-small);line-height:1.55;margin:var(--relay-sp-6) 0}
.meta.faint,.faint{color:var(--relay-faint);font-size:var(--relay-fs-caption)}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:var(--relay-border-strong);border-radius:var(--relay-r-9)}

/* ---- 壳层 ---- */
.shell{min-height:100vh;display:grid;grid-template-columns:232px minmax(0,1fr)}
.sidebar{height:100vh;position:sticky;top:0;padding:var(--relay-sp-24) var(--relay-sp-14) var(--relay-sp-16);background:var(--relay-sidebar);color:var(--relay-sidebar-text);display:flex;flex-direction:column;z-index:20}
.brand{height:36px;display:flex;align-items:center;gap:var(--relay-sp-11);padding:0 var(--relay-sp-8);color:var(--relay-sidebar-text);text-decoration:none}
.brand>span:last-child{display:grid;line-height:1.05}
.brand strong{font-size:var(--relay-fs-15);letter-spacing:.01em}
.brand small{margin-top:var(--relay-sp-4);color:var(--relay-sidebar-muted);font-size:var(--relay-fs-9);letter-spacing:.18em;text-transform:uppercase}
.brand-mark{width:31px;height:31px;border-radius:var(--relay-r-md);background:linear-gradient(145deg,var(--relay-brand-from),var(--relay-brand-to));display:flex;align-items:center;justify-content:center;gap:var(--relay-sp-3);box-shadow:0 9px 25px var(--relay-accent-shadow)}
.brand-mark i{width:4px;background:var(--relay-on-accent);border-radius:var(--relay-r-4)}
.brand-mark i:first-child{height:10px}
.brand-mark i:last-child{height:16px}
.nav-label{margin:var(--relay-sp-26) var(--relay-sp-10) var(--relay-sp-8);color:var(--relay-sidebar-muted);font-size:var(--relay-fs-caption);font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.main-nav{display:grid;gap:var(--relay-sp-4)}
.main-nav button,.main-nav a{height:42px;padding:0 var(--relay-sp-11);border:1px solid transparent;border-radius:var(--relay-r-md);background:transparent;color:var(--relay-sidebar-muted);display:flex;align-items:center;gap:var(--relay-sp-11);text-align:left;font-size:var(--relay-fs-body);cursor:pointer;transition:.15s;text-decoration:none}
.main-nav button:hover{color:var(--relay-sidebar-text);background:var(--relay-sidebar-hover)}
.main-nav button.active{color:var(--relay-on-accent);border-color:var(--relay-accent-border);background:var(--relay-sidebar-active)}
.main-nav button.active .icon{color:var(--relay-score)}
.main-nav button span{flex:1}
.main-nav button b{min-width:19px;height:19px;padding:0 var(--relay-sp-5);border-radius:var(--relay-r-7);background:var(--relay-sidebar-active);color:var(--relay-score);display:grid;place-items:center;font-size:var(--relay-fs-micro)}
.main-nav button b[hidden]{display:none}
.sidebar-footer{margin-top:auto;padding-top:var(--relay-sp-15);border-top:1px solid var(--relay-border)}
.operator{display:flex;align-items:center;gap:var(--relay-sp-9);padding:var(--relay-sp-5)}
.avatar{width:31px;height:31px;border-radius:var(--relay-r-md);background:var(--relay-accent-soft);color:var(--relay-score);display:grid;place-items:center;font-size:var(--relay-fs-small);font-weight:800;flex:none}
.avatar.large{width:40px;height:40px;border-radius:var(--relay-r-11)}
.operator>span:nth-child(2){display:grid;gap:var(--relay-sp-2);flex:1}
.operator strong{font-size:var(--relay-fs-11)}
.operator small{color:var(--relay-sidebar-muted);font-size:var(--relay-fs-9)}
.main-area{min-width:0}
.topbar{height:62px;padding:0 3vw;position:sticky;top:0;z-index:15;border-bottom:1px solid var(--relay-border);background:var(--relay-bg);display:flex;align-items:center;justify-content:space-between;gap:var(--relay-sp-12)}
.breadcrumb{display:flex;align-items:center;gap:var(--relay-sp-9);font-size:var(--relay-fs-12);min-width:0}
.breadcrumb span,.breadcrumb b{color:var(--relay-faint);font-weight:500}
.breadcrumb strong{font-weight:650;white-space:nowrap}
.top-actions{display:flex;align-items:center;gap:var(--relay-sp-8)}
.icon-button,.refresh,.filter-button,.quiet,.text-button,.load-more,.pin-button,.small{border:1px solid var(--relay-border);background:var(--relay-panel);cursor:pointer}
.icon-button{width:34px;height:34px;border-radius:var(--relay-r-sm);display:inline-flex;align-items:center;justify-content:center;gap:var(--relay-sp-7);color:var(--relay-muted)}
.icon-button .icon{width:15px}
.icon-button .icon-txt,.theme-label{font-size:var(--relay-fs-small);font-weight:650;white-space:nowrap}
.icon-button.theme-toggle{width:auto;min-width:34px;padding:0 var(--relay-sp-10)}
.small{height:var(--relay-c-md);padding:0 var(--relay-sp-12);border-radius:var(--relay-r-sm);display:inline-flex;align-items:center;gap:var(--relay-sp-7);font-size:var(--relay-fs-small);font-weight:650;color:var(--relay-muted);text-decoration:none}
.small .icon{width:14px}
.refresh{height:var(--relay-c-md);padding:0 var(--relay-sp-12);border-radius:var(--relay-r-sm);display:flex;align-items:center;gap:var(--relay-sp-7);font-size:var(--relay-fs-small);font-weight:650;color:var(--relay-muted)}
.refresh .icon{width:14px}
.content{width:min(1240px,94%);margin:auto;padding:var(--relay-sp-34) 0 var(--relay-sp-70)}

/* ---- 页头与通用件 ---- */
.page-title{min-height:56px;margin-bottom:var(--relay-sp-24);display:flex;align-items:flex-end;justify-content:space-between;gap:var(--relay-sp-24);flex-wrap:wrap}
.kicker{margin:0 0 var(--relay-sp-9);color:var(--relay-accent);font:800 var(--relay-fs-10)/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.15em}
.page-title h1{margin:0 0 var(--relay-sp-8);font-size:var(--relay-fs-26);line-height:1;letter-spacing:-.03em}
.page-copy{margin:0;color:var(--relay-muted);font-size:var(--relay-fs-12);line-height:1.6;max-width:640px}
.title-actions{display:flex;align-items:center;gap:var(--relay-sp-9)}
.primary{min-height:36px;padding:0 var(--relay-sp-14);border:0;border-radius:var(--relay-r-9);background:var(--relay-accent);color:var(--relay-on-accent);display:flex;align-items:center;justify-content:center;gap:var(--relay-sp-8);font-size:var(--relay-fs-12);font-weight:750;cursor:pointer;box-shadow:0 8px 20px var(--relay-accent-shadow);transition:.15s}
.primary:hover{background:var(--relay-accent-strong)}
.primary .icon{width:14px}
.primary.small{min-height:31px;padding-inline:var(--relay-sp-10);font-size:var(--relay-fs-11)}
.status{width:max-content;min-height:22px;padding:0 var(--relay-sp-9);border-radius:var(--relay-r-99);background:var(--relay-input);color:var(--relay-muted);display:inline-flex;align-items:center;gap:var(--relay-sp-5);font-size:var(--relay-fs-11);font-weight:650;white-space:nowrap}
.status i{width:5px;height:5px;border-radius:50%;background:currentColor}
.status.success{color:var(--relay-success);background:var(--relay-success-soft)}
.status.warning{color:var(--relay-warning);background:var(--relay-warning-soft)}
.status.danger{color:var(--relay-danger);background:var(--relay-danger-soft)}
.status.violet{color:var(--relay-accent);background:var(--relay-accent-soft)}
.status.blue{color:var(--relay-blue);background:var(--relay-blue-soft)}
.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--relay-sp-12);margin-bottom:var(--relay-sp-16)}
.metric-card{min-height:96px;padding:var(--relay-sp-15) var(--relay-sp-17);position:relative;overflow:hidden;border:1px solid var(--relay-border);border-radius:var(--relay-r-13);background:var(--relay-panel);box-shadow:var(--relay-shadow);display:grid;gap:var(--relay-sp-5);align-content:start}
.metric-card>span{color:var(--relay-muted);font-size:var(--relay-fs-11)}
.metric-card>strong{font-size:var(--relay-fs-23);line-height:1;letter-spacing:-.03em}
.metric-card>small{color:var(--relay-faint);font-size:var(--relay-fs-10)}
.metric-card>i{width:48px;height:48px;position:absolute;right:-17px;bottom:-18px;border-radius:50%;background:var(--relay-accent-soft);box-shadow:0 0 0 11px var(--relay-accent-soft)}
.metric-card.amber>i{background:var(--relay-warning-soft);box-shadow:0 0 0 11px var(--relay-warning-soft)}
.metric-card.blue>i{background:var(--relay-blue-soft);box-shadow:0 0 0 11px var(--relay-blue-soft)}
.metric-card.green>i{background:var(--relay-success-soft);box-shadow:0 0 0 11px var(--relay-success-soft)}
.notice{min-height:56px;margin:var(--relay-sp-4) 0 var(--relay-sp-18);padding:var(--relay-sp-11) var(--relay-sp-13);border:1px solid var(--relay-accent-border);border-radius:var(--relay-r-12);background:var(--relay-accent-soft);display:flex;align-items:center;gap:var(--relay-sp-11)}
.notice>span{width:34px;height:34px;border-radius:var(--relay-r-9);background:var(--relay-panel);color:var(--relay-accent);display:grid;place-items:center;flex:none}
.notice .icon{width:15px}
.notice>div{flex:1;min-width:0;font-size:var(--relay-fs-12);line-height:1.55}
.notice button,.quiet{height:32px;padding:0 var(--relay-sp-12);border-radius:var(--relay-r-8);color:var(--relay-muted);font-size:var(--relay-fs-11);font-weight:650;display:inline-flex;align-items:center;gap:var(--relay-sp-6)}
.notice button .icon,.quiet .icon{width:12px}
.section-bar{margin:var(--relay-sp-20) 0 var(--relay-sp-12);display:flex;align-items:center;justify-content:space-between;gap:var(--relay-sp-16);flex-wrap:wrap}
.section-bar h2{margin:0;font-size:var(--relay-fs-14)}
.section-bar p{margin:var(--relay-sp-4) 0 0;color:var(--relay-muted);font-size:var(--relay-fs-11)}
.count{padding:var(--relay-sp-3) var(--relay-sp-8);border-radius:var(--relay-r-99);background:var(--relay-accent-soft);color:var(--relay-accent);font-size:var(--relay-fs-10);font-weight:700;vertical-align:2px}

/* ---- 卡片与决策 ---- */
.panel,.decision-card,.goal-card,.compose-card,.recent-card,.ranking-card,.rule-card,.docs-shell{border:1px solid var(--relay-border);border-radius:var(--relay-r-14);background:var(--relay-panel);box-shadow:var(--relay-shadow)}
.panel{padding:var(--relay-sp-18);margin-bottom:var(--relay-sp-12)}
.decision-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--relay-sp-12)}
.decision-card{padding:var(--relay-sp-18);margin-bottom:0}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:var(--relay-sp-8);flex-wrap:wrap}
.type-label{color:var(--relay-accent);font:750 var(--relay-fs-10)/1 ui-monospace,Menlo,monospace;letter-spacing:.08em}
.decision-card h3,.compact-decision h3{margin:var(--relay-sp-14) 0 var(--relay-sp-6);font-size:var(--relay-fs-15);letter-spacing:-.01em}
.byline{margin:0;color:var(--relay-faint);font-size:var(--relay-fs-11)}
.submission,.body{white-space:pre-wrap;word-break:break-word;margin:var(--relay-sp-13) 0 var(--relay-sp-4);padding:var(--relay-sp-12);border-radius:var(--relay-r-9);background:var(--relay-input);color:var(--relay-muted);font-size:var(--relay-fs-12);line-height:1.7}
.body{max-height:300px;overflow:auto}
.body b{color:var(--relay-text)}
.atts{display:grid;gap:var(--relay-sp-6);margin-top:var(--relay-sp-8)}
.atts:empty{display:none}
.attachment{min-height:40px;padding:var(--relay-sp-7) var(--relay-sp-9);border:1px solid var(--relay-border);border-radius:var(--relay-r-8);display:flex;align-items:center;gap:var(--relay-sp-8);color:inherit;text-decoration:none;font-size:var(--relay-fs-12)}
.attachment .icon{color:var(--relay-accent);width:14px}
.attachment span{flex:1;min-width:0}
.attachment strong{font-size:var(--relay-fs-11)}
.attachment small{color:var(--relay-faint);font-size:var(--relay-fs-10);margin-left:var(--relay-sp-6)}
.comment-field{display:grid;gap:var(--relay-sp-7);margin-top:var(--relay-sp-12)}
.comment-field>span,.compose>span,.goal-form label>span{font-size:var(--relay-fs-11);font-weight:700;color:var(--relay-muted)}
textarea{width:100%;min-height:62px;padding:var(--relay-sp-10) var(--relay-sp-11);border:1px solid var(--relay-border);border-radius:var(--relay-r-9);background:var(--relay-input);color:var(--relay-text);resize:vertical;outline:0;font-size:var(--relay-fs-13);line-height:1.6}
textarea:focus,input:focus,select:focus{border-color:var(--relay-accent)}
input,select{background:var(--relay-input);border:1px solid var(--relay-border);border-radius:var(--relay-r-8);color:var(--relay-text);outline:0}
input{padding:var(--relay-sp-8) var(--relay-sp-10)}
.decision-actions{margin-top:var(--relay-sp-12);display:flex;gap:var(--relay-sp-7);flex-wrap:wrap}
.decision-actions button{height:34px;padding:0 var(--relay-sp-13);border-radius:var(--relay-r-8);display:flex;align-items:center;gap:var(--relay-sp-6);font-size:var(--relay-fs-11);font-weight:700;cursor:pointer;border:1px solid transparent}
.decision-actions .icon{width:13px}
.approve{border:0;background:var(--relay-control);color:var(--relay-bg)}
.reject{border-color:var(--relay-danger-border);background:var(--relay-danger-soft);color:var(--relay-danger)}
.decision-actions .quiet{margin-left:auto}
button:disabled{opacity:.5;cursor:wait}
.upgrade-cols{display:grid;grid-template-columns:1fr 1fr;gap:var(--relay-sp-4) var(--relay-sp-22);margin-top:var(--relay-sp-4)}
.upgrade-card h4{margin:var(--relay-sp-12) 0 var(--relay-sp-4)}
.upgrade-card ul{margin:var(--relay-sp-4) 0;padding-left:var(--relay-sp-18);color:var(--relay-muted);font-size:var(--relay-fs-12);line-height:1.7}
.upgrade-card .upgrade-p{margin:var(--relay-sp-4) 0;color:var(--relay-muted);font-size:var(--relay-fs-12);line-height:1.7}
details.sha{margin-top:var(--relay-sp-10)}
details.sha summary,.request-details summary{cursor:pointer;color:var(--relay-muted);font-size:var(--relay-fs-11)}
details.sha code,.version-row code,.model-path{font:var(--relay-fs-11) ui-monospace,Menlo,monospace;background:var(--relay-input);border-radius:var(--relay-r-6);padding:var(--relay-sp-5) var(--relay-sp-8);color:var(--relay-muted);word-break:break-all;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.version-panel{display:grid;gap:var(--relay-sp-8)}
.version-row{display:flex;align-items:center;gap:var(--relay-sp-10);flex-wrap:wrap}
.version-row strong{font-size:var(--relay-fs-16)}
.err{color:var(--relay-danger);font-size:var(--relay-fs-12);margin-top:var(--relay-sp-8);white-space:pre-wrap}
.okm{color:var(--relay-success);font-size:var(--relay-fs-12);margin-top:var(--relay-sp-8)}
.empty{color:var(--relay-faint);text-align:center;padding:var(--relay-sp-30) 0;font-size:var(--relay-fs-13)}

/* ---- 目标 ---- */
.goal-list{display:grid;gap:var(--relay-sp-9)}
.goal-card{overflow:hidden}
.goal-main{width:100%;min-height:78px;padding:var(--relay-sp-14) var(--relay-sp-16);border:0;background:transparent;color:inherit;display:grid;grid-template-columns:38px minmax(200px,1fr) minmax(140px,220px) 18px;align-items:center;gap:var(--relay-sp-15);text-align:left;cursor:pointer}
.goal-index{width:36px;height:36px;border-radius:var(--relay-r-11);background:var(--relay-accent-soft);color:var(--relay-accent);display:grid;place-items:center;font:700 var(--relay-fs-12) ui-monospace,Menlo,monospace}
.goal-name{min-width:0;display:grid;gap:var(--relay-sp-3)}
.goal-name>span{color:var(--relay-faint);font-size:var(--relay-fs-10)}
.goal-name h3{margin:0;font-size:var(--relay-fs-13)}
.goal-name p{margin:0;color:var(--relay-muted);font-size:var(--relay-fs-11);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.goal-stages{display:flex;gap:var(--relay-sp-5);flex-wrap:wrap;justify-content:flex-end}
.stage{font-size:var(--relay-fs-10);padding:var(--relay-sp-2) var(--relay-sp-8);border-radius:var(--relay-r-99);background:var(--relay-input);color:var(--relay-muted)}
.stage.done{background:var(--relay-success-soft);color:var(--relay-success)}
.stage.active{background:var(--relay-blue-soft);color:var(--relay-blue)}
.stage.waiting{background:var(--relay-warning-soft);color:var(--relay-warning)}
.stage.missing{background:var(--relay-danger-soft);color:var(--relay-danger)}
.goal-arrow{width:15px;color:var(--relay-faint);transition:.2s}
.goal-card.open .goal-arrow{transform:rotate(90deg)}
.goal-extra{padding:0 var(--relay-sp-16) var(--relay-sp-12) var(--relay-sp-69);display:grid;gap:var(--relay-sp-6)}
.goal-extra .meta{margin:0;color:var(--relay-muted);font-size:var(--relay-fs-11);line-height:1.6}
.goal-extra .meta.bad{color:var(--relay-danger)}
.task-drawer{padding:var(--relay-sp-6) var(--relay-sp-18) var(--relay-sp-15) var(--relay-sp-69);border-top:1px solid var(--relay-border);background:var(--relay-panel-soft)}
.task-head,.task-row{display:grid;grid-template-columns:minmax(160px,1fr) minmax(130px,160px) 92px minmax(150px,auto);gap:var(--relay-sp-12);align-items:center}
.task-head{padding:var(--relay-sp-10) var(--relay-sp-8) var(--relay-sp-6);color:var(--relay-faint);font-size:var(--relay-fs-10)}
.task-row{min-height:42px;padding:var(--relay-sp-4) var(--relay-sp-8);border-top:1px solid var(--relay-border);font-size:var(--relay-fs-11)}
.task-row strong{font-size:var(--relay-fs-11);font-weight:600}
.task-row .task-people{color:var(--relay-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-acts{display:flex;gap:var(--relay-sp-6);justify-content:flex-end;flex-wrap:wrap}
.task-acts button{height:27px;padding:0 var(--relay-sp-10);border-radius:var(--relay-r-7);font-size:var(--relay-fs-10);font-weight:700;border:1px solid var(--relay-border);background:var(--relay-panel);color:var(--relay-muted);cursor:pointer}
.task-acts button.mid{color:var(--relay-accent);border-color:var(--relay-accent-border)}
.task-acts button.no{color:var(--relay-danger);border-color:var(--relay-danger-border)}
.text-button{margin-top:var(--relay-sp-10);padding:0;border:0;background:transparent;color:var(--relay-accent);display:flex;align-items:center;gap:var(--relay-sp-6);font-size:var(--relay-fs-11);font-weight:700}
.text-button .icon{width:12px}
.text-button.danger{color:var(--relay-danger)}
.retired-list{margin-top:var(--relay-sp-10);border-top:1px solid var(--relay-border);padding-top:var(--relay-sp-10)}
.retired-title{font-size:var(--relay-fs-10);color:var(--relay-faint);letter-spacing:.04em}
.retired-item{display:grid;gap:var(--relay-sp-8);margin-top:var(--relay-sp-8);padding:var(--relay-sp-10);border:1px solid var(--relay-border);border-radius:var(--relay-r-9);background:var(--relay-panel)}
.retired-item .retired-name{font-size:var(--relay-fs-11);font-weight:600}
.retired-item .retired-meta{font-size:var(--relay-fs-10);color:var(--relay-muted);line-height:1.5}
.retired-form{display:flex;gap:var(--relay-sp-8);flex-wrap:wrap;align-items:center}
.retired-form select{font:inherit;font-size:var(--relay-fs-11);height:27px}
.retired-form textarea{flex:1 1 100%;font:inherit;font-size:var(--relay-fs-11);min-height:44px;resize:vertical}
.tier{font-size:var(--relay-fs-10);padding:var(--relay-sp-1) var(--relay-sp-8);border-radius:var(--relay-r-10);border:1px solid var(--relay-border);color:var(--relay-muted)}

/* ---- 手册 ---- */
.docs-shell{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:480px;overflow:hidden}
.docs-nav{padding:var(--relay-sp-16) var(--relay-sp-11);border-right:1px solid var(--relay-border);background:var(--relay-panel-soft);display:grid;gap:var(--relay-sp-3);align-content:start}
.docs-search{height:35px;padding:0 var(--relay-sp-9);border:1px solid var(--relay-border);border-radius:var(--relay-r-8);background:var(--relay-panel);display:flex;align-items:center;gap:var(--relay-sp-7)}
.docs-search .icon{width:13px;color:var(--relay-faint)}
.docs-search input{width:100%;border:0;background:transparent;padding:0;font-size:var(--relay-fs-11)}
.docs-nav>p{margin:var(--relay-sp-14) var(--relay-sp-9) var(--relay-sp-5);color:var(--relay-faint);font-size:var(--relay-fs-9);font-weight:750;letter-spacing:.08em;text-transform:uppercase}
.docs-nav>button{width:100%;height:33px;padding:0 var(--relay-sp-9);border:0;border-radius:var(--relay-r-7);background:transparent;color:var(--relay-muted);display:flex;align-items:center;gap:var(--relay-sp-8);text-align:left;font-size:var(--relay-fs-11);cursor:pointer;overflow:hidden}
.docs-nav>button .icon{width:13px}
.docs-nav>button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.docs-nav>button.active{background:var(--relay-accent-soft);color:var(--relay-accent);font-weight:700}
.doc-view{padding:var(--relay-sp-26) 4vw var(--relay-sp-40);min-width:0}
.doc-meta{display:flex;align-items:center;gap:var(--relay-sp-13)}
.doc-icon{width:42px;height:42px;border-radius:var(--relay-r-12);background:var(--relay-accent-soft);color:var(--relay-accent);display:grid;place-items:center;flex:none}
.doc-meta div{flex:1;min-width:0}
.doc-meta p{margin:0 0 var(--relay-sp-4);color:var(--relay-faint);font-size:var(--relay-fs-10)}
.doc-meta h2{margin:0;font-size:var(--relay-fs-18);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doc-info{margin:var(--relay-sp-16) 0 var(--relay-sp-18);padding:var(--relay-sp-9) 0;border-top:1px solid var(--relay-border);border-bottom:1px solid var(--relay-border);display:flex;gap:var(--relay-sp-20);flex-wrap:wrap;color:var(--relay-faint);font-size:var(--relay-fs-10)}
.docbody,.doc-content{white-space:pre-wrap;word-break:break-word;font:var(--relay-fs-12)/1.85 ui-monospace,Menlo,monospace;color:var(--relay-muted);max-height:62vh;overflow:auto}

/* ---- 留言 ---- */
.message-layout{display:grid;grid-template-columns:minmax(0,720px);gap:var(--relay-sp-14)}
.compose-card{padding:var(--relay-sp-22)}
.compose-head{padding-bottom:var(--relay-sp-16);border-bottom:1px solid var(--relay-border);display:flex;align-items:center;gap:var(--relay-sp-11)}
.compose-head div{flex:1;min-width:0}
.compose-head h2{margin:0;font-size:var(--relay-fs-13)}
.compose-head p{margin:var(--relay-sp-4) 0 0;color:var(--relay-muted);font-size:var(--relay-fs-11)}
.compose{margin-top:var(--relay-sp-18);display:grid;gap:var(--relay-sp-8)}
.compose textarea{min-height:150px;padding:var(--relay-sp-13);font-size:var(--relay-fs-13)}
.compose small{color:var(--relay-faint);font-size:var(--relay-fs-10)}
.send-row{margin-top:var(--relay-sp-14);display:flex;justify-content:flex-end}

/* ---- 模型排序（沿用页面既有类名，按新视觉重写） ---- */
.sync-state{display:flex;align-items:center;gap:var(--relay-sp-10);border:1px solid var(--relay-border);border-radius:var(--relay-r-10);padding:var(--relay-sp-9) var(--relay-sp-13);background:var(--relay-panel)}
.sync-dot{width:8px;height:8px;border-radius:50%;background:var(--relay-success);box-shadow:0 0 0 4px var(--relay-success-soft)}
.sync-state>div{display:grid;gap:var(--relay-sp-2)}
.sync-state strong{font-size:var(--relay-fs-11)}
.sync-state span{color:var(--relay-faint);font-size:var(--relay-fs-10)}
.workspace{display:grid;grid-template-columns:300px minmax(0,1fr);gap:var(--relay-sp-13);align-items:start}
.settings-panel,.results-panel{border:1px solid var(--relay-border);border-radius:var(--relay-r-14);background:var(--relay-panel);box-shadow:var(--relay-shadow);padding:var(--relay-sp-19)}
.settings-panel{position:sticky;top:82px}
.settings-panel p{font-size:var(--relay-fs-12)}
.results-panel{padding-bottom:var(--relay-sp-10)}
.section-heading{display:flex;align-items:center;gap:var(--relay-sp-10);margin-bottom:var(--relay-sp-16)}
.section-heading .step{width:31px;height:31px;border-radius:var(--relay-r-9);background:var(--relay-accent-soft);color:var(--relay-accent);display:grid;place-items:center;font:750 var(--relay-fs-10) ui-monospace,Menlo,monospace;flex:none}
.section-heading div{flex:1;min-width:0}
.section-heading h2{margin:0;font-size:var(--relay-fs-13)}
.section-heading p{margin:var(--relay-sp-3) 0 0;color:var(--relay-muted);font-size:var(--relay-fs-11)}
.results-heading{justify-content:space-between}
.updated{color:var(--relay-faint);font-size:var(--relay-fs-10)}
.field-label{display:block;margin:var(--relay-sp-14) 0 var(--relay-sp-6);color:var(--relay-muted);font-size:var(--relay-fs-11);font-weight:700}
.field-help{margin:var(--relay-sp-6) 0 0;color:var(--relay-faint);font-size:var(--relay-fs-11);line-height:1.55}
.select-wrap select{width:100%;height:38px;padding:0 var(--relay-sp-9);border-radius:var(--relay-r-9);font-size:var(--relay-fs-12)}
.settings-panel .pin-button{height:31px;padding:0 var(--relay-sp-11);border-radius:var(--relay-r-8);color:var(--relay-muted);font-size:var(--relay-fs-11);margin:var(--relay-sp-10) var(--relay-sp-6) 0 0}
.save-button{width:100%;min-height:var(--relay-c-lg);margin-top:var(--relay-sp-16);border:0;border-radius:var(--relay-r-md);background:var(--relay-accent);color:var(--relay-on-accent);font-size:var(--relay-fs-body);font-weight:750;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:var(--relay-sp-8)}
.save-button:disabled{opacity:.55}
.save-button.saved{background:var(--relay-success)}
.last-refresh{margin-top:var(--relay-sp-16);padding-top:var(--relay-sp-13);border-top:1px solid var(--relay-border);display:grid;gap:var(--relay-sp-4);color:var(--relay-faint);font-size:var(--relay-fs-10)}
.last-refresh time{font:500 var(--relay-fs-11) ui-monospace,Menlo,monospace;color:var(--relay-text)}
.error-message{color:var(--relay-danger);font-size:var(--relay-fs-11)}
.tabs{margin-bottom:var(--relay-sp-15);padding:var(--relay-sp-4);border-radius:var(--relay-r-10);background:var(--relay-input);display:flex;gap:var(--relay-sp-3)}
.tabs .tab{flex:1;height:34px;border:0;border-radius:var(--relay-r-7);background:transparent;color:var(--relay-muted);font-size:var(--relay-fs-11);font-weight:650;cursor:pointer}
.tabs .tab span{margin-left:var(--relay-sp-5);color:var(--relay-faint);font-size:var(--relay-fs-10)}
.tabs .tab.active{background:var(--relay-panel);color:var(--relay-text);box-shadow:var(--relay-shadow-tab)}
.group-summary{margin-bottom:var(--relay-sp-10);display:flex;align-items:center;justify-content:space-between;gap:var(--relay-sp-10)}
.group-summary h2{margin:0;font-size:var(--relay-fs-13)}
.group-summary p{margin:var(--relay-sp-4) 0 0;color:var(--relay-faint);font-size:var(--relay-fs-11)}
.model-count{padding:var(--relay-sp-4) var(--relay-sp-9);border-radius:var(--relay-r-99);background:var(--relay-accent-soft);color:var(--relay-accent);font-size:var(--relay-fs-10);font-weight:700;white-space:nowrap}
.model-list{display:grid;gap:var(--relay-sp-4)}
.model-row{border:1px solid var(--relay-border);border-radius:var(--relay-r-9);background:var(--relay-panel-soft);overflow:hidden}
.model-row:hover,.model-row.expanded{border-color:var(--relay-accent-border);background:var(--relay-row-hover)}
.model-row-header{display:flex;align-items:stretch}
.model-row-main{flex:1;min-width:0;display:grid;grid-template-columns:29px minmax(150px,1fr) 62px 70px 62px 74px 16px;align-items:center;gap:var(--relay-sp-9);padding:var(--relay-sp-7) var(--relay-sp-9);border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}
.rank{width:29px;height:29px;border-radius:var(--relay-r-8);background:var(--relay-input);color:var(--relay-muted);display:grid;place-items:center;font:700 var(--relay-fs-10) ui-monospace,Menlo,monospace}
.model-primary{min-width:0;display:grid;gap:var(--relay-sp-2)}
.model-name-row{display:flex;align-items:center;gap:var(--relay-sp-6);min-width:0}
.model-name-row h3{margin:0;font-size:var(--relay-fs-12);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model-primary>p{margin:0;color:var(--relay-faint);font-size:var(--relay-fs-10);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{padding:var(--relay-sp-1) var(--relay-sp-7);border-radius:var(--relay-r-99);background:var(--relay-accent-soft);color:var(--relay-accent);font-size:var(--relay-fs-9);font-weight:700;flex:none}
.row-stat{min-width:0;display:grid;gap:var(--relay-sp-2)}
.row-stat span{color:var(--relay-faint);font-size:var(--relay-fs-9)}
.row-stat strong{font-size:var(--relay-fs-11)}
.score{text-align:right;display:grid;gap:var(--relay-sp-2)}
.score span{color:var(--relay-faint);font-size:var(--relay-fs-9)}
.score strong{color:var(--relay-score);font-size:var(--relay-fs-14)}
.chevron{color:var(--relay-muted);font-size:var(--relay-fs-13);text-align:center}
.model-row-header>button.pin-button{margin:var(--relay-sp-7) var(--relay-sp-9);align-self:center;height:29px;padding:0 var(--relay-sp-10);border-radius:var(--relay-r-7);color:var(--relay-accent);font-size:var(--relay-fs-10);flex:none}
.row-details{padding:var(--relay-sp-8) var(--relay-sp-12) var(--relay-sp-13) var(--relay-sp-47);display:grid;gap:var(--relay-sp-9);border-top:1px dashed var(--relay-border)}
.model-path{display:block}
.metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:var(--relay-sp-8)}
.metrics>div{padding:var(--relay-sp-8) var(--relay-sp-10);border-radius:var(--relay-r-8);background:var(--relay-input);display:grid;gap:var(--relay-sp-3);min-width:0}
.metrics span{color:var(--relay-faint);font-size:var(--relay-fs-9)}
.metrics strong{font-size:var(--relay-fs-11)}
.metrics small{color:var(--relay-faint);font-size:var(--relay-fs-9)}
.row-details .field-label{margin:var(--relay-sp-4) 0 0}
.row-details select{height:32px;padding:0 var(--relay-sp-8);font-size:var(--relay-fs-11);max-width:220px}
.mobile-performance{margin:0;color:var(--relay-faint);font-size:var(--relay-fs-10)}
.request-details{margin-top:var(--relay-sp-12)}
.request-details pre{max-height:300px;overflow:auto;background:var(--relay-input);border-radius:var(--relay-r-8);padding:var(--relay-sp-10);font:var(--relay-fs-11)/1.5 ui-monospace,Menlo,monospace;margin:var(--relay-sp-8) 0 0}
.empty-state{color:var(--relay-faint);text-align:center;padding:var(--relay-sp-26) 0;font-size:var(--relay-fs-12)}

/* ---- toast ---- */
.toast{max-width:360px;min-height:42px;padding:0 var(--relay-sp-16);position:fixed;left:50%;bottom:25px;z-index:50;border:1px solid var(--relay-toast-border);border-radius:var(--relay-r-lg);background:var(--relay-toast-bg);color:var(--relay-on-accent);box-shadow:var(--relay-shadow-toast);display:flex;align-items:center;font-size:var(--relay-fs-body);opacity:0;transform:translate(-50%,15px);pointer-events:none;transition:.22s}
.toast.show{opacity:1;transform:translate(-50%,0)}

/* ---- 响应式 ---- */
@media(max-width:1100px){
 .stat-grid{grid-template-columns:repeat(2,1fr)}
 .decision-grid{grid-template-columns:1fr}
 .workspace{grid-template-columns:1fr}
 .settings-panel{position:static}
 .model-row-main{grid-template-columns:29px minmax(140px,1fr) 62px 74px 16px}
 .row-stat.speed,.row-stat.quota{display:none}
 .upgrade-cols{grid-template-columns:1fr}
}
@media(max-width:800px){
 .shell{display:block}
 .sidebar{height:auto;position:sticky;top:0;padding:var(--relay-sp-9) var(--relay-sp-12);display:grid;grid-template-columns:auto 1fr;align-items:center;gap:var(--relay-sp-12);z-index:30}
 .brand>span:last-child{display:grid}
 .nav-label,.sidebar-footer{display:none}
 .main-nav{padding:0 0 0 var(--relay-sp-8);display:flex;justify-content:flex-end;gap:var(--relay-sp-2);overflow-x:auto}
 .main-nav button,.main-nav a{width:auto;height:38px;padding:0 var(--relay-sp-9);gap:var(--relay-sp-6);justify-content:center}
 .main-nav button span{display:none}
 .topbar{top:56px}
 .content{padding:var(--relay-sp-22) 0 var(--relay-sp-60)}
 .page-title h1{font-size:var(--relay-fs-22)}
 .goal-main{grid-template-columns:34px minmax(0,1fr) 18px}
 .goal-stages{display:none}
 .goal-extra,.task-drawer{padding-left:var(--relay-sp-16)}
 .task-head{display:none}
 .task-row{grid-template-columns:minmax(120px,1fr) 90px;grid-auto-rows:auto}
 .task-row .task-acts{grid-column:1/-1;justify-content:flex-start}
 .docs-shell{display:block}
 .docs-nav{border-right:0;border-bottom:1px solid var(--relay-border);display:flex;gap:var(--relay-sp-5);overflow:auto;flex-wrap:wrap}
 .docs-search,.docs-nav>p{display:none}
 .docs-nav>button{width:auto;min-width:max-content;border:1px solid var(--relay-border);border-radius:var(--relay-r-7)}
 .doc-view{padding:var(--relay-sp-20) var(--relay-sp-14) var(--relay-sp-30)}
 .metric-card{min-height:84px;padding:var(--relay-sp-13) var(--relay-sp-14)}
 .metric-card>strong{font-size:var(--relay-fs-20)}
}
@media(max-width:560px){
 .stat-grid{gap:var(--relay-sp-8)}
 .decision-card{padding:var(--relay-sp-15)}
 .model-row-main{grid-template-columns:27px minmax(0,1fr) 58px 14px;gap:var(--relay-sp-7)}
 .row-stat.intelligence{display:none}
 .row-details{padding-left:var(--relay-sp-40)}
 .metrics{grid-template-columns:1fr 1fr}
 .compose-card{padding:var(--relay-sp-16)}
 .version-row code{max-width:200px}
}
`.trimStart();
