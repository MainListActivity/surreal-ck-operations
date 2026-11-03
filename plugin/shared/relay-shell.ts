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

const DARK_TOKENS = `--relay-bg:#0e0f12;--relay-panel:#17181d;--relay-panel-soft:#1b1d22;--relay-input:#111216;--relay-row:#181a20;--relay-row-hover:#201f2b;
--relay-border:#2a2c33;--relay-border-strong:#363941;--relay-text:#f0f0f2;--relay-muted:#9a9da7;--relay-faint:#6f727b;
--relay-accent:#9581ff;--relay-accent-strong:#aa9aff;--relay-accent-soft:#28233d;--relay-accent-border:rgba(149,129,255,.35);--relay-accent-shadow:rgba(149,129,255,.22);
--relay-score:#ad9eff;--relay-control:#f2f2f3;--relay-success:#58c99b;--relay-success-soft:#182c25;--relay-danger:#e08287;--relay-danger-soft:#321e21;--relay-danger-border:rgba(224,130,135,.32);
--relay-warning:#e1a456;--relay-warning-soft:#302619;--relay-blue:#78a4df;--relay-blue-soft:#1a2636;
--relay-sidebar:#111216;--relay-sidebar-text:#eeeef0;--relay-sidebar-muted:#858892;--relay-sidebar-hover:#1d1f24;--relay-sidebar-active:#29253a;
--relay-shadow:0 12px 34px rgba(0,0,0,.22);--relay-shadow-lg:0 24px 70px rgba(0,0,0,.34);--chart:#9784ff;--chart-soft:#3b345f`;

const LIGHT_TOKENS = `--relay-bg:#f4f5f7;--relay-panel:#fff;--relay-panel-soft:#f8f8fa;--relay-input:#f5f5f7;--relay-row:#fff;--relay-row-hover:#f6f4ff;
--relay-border:#e5e6ea;--relay-border-strong:#d8dae0;--relay-text:#202127;--relay-muted:#71747e;--relay-faint:#9da0a8;
--relay-accent:#6d5bd0;--relay-accent-strong:#5947bc;--relay-accent-soft:#f0edff;--relay-accent-border:rgba(109,91,208,.32);--relay-accent-shadow:rgba(109,91,208,.22);
--relay-score:#6957cc;--relay-control:#25272d;--relay-success:#218663;--relay-success-soft:#eaf7f1;--relay-danger:#b14f56;--relay-danger-soft:#fff0f1;--relay-danger-border:rgba(177,79,86,.3);
--relay-warning:#a7671d;--relay-warning-soft:#fff6e8;--relay-blue:#3d6eb1;--relay-blue-soft:#edf4ff;
--relay-sidebar:#16171b;--relay-sidebar-text:#e9e9ec;--relay-sidebar-muted:#888b94;--relay-sidebar-hover:#202127;--relay-sidebar-active:#2b2837;
--relay-shadow:0 12px 34px rgba(27,29,36,.055);--relay-shadow-lg:0 24px 70px rgba(27,29,36,.09);--chart:#7662df;--chart-soft:#dcd6fc`;

export const relayShellCss = `
/* ---- tokens：默认浅色，data-theme=dark 或系统深色时切换（toggle 写 data-theme） ---- */
:root{color-scheme:light dark;${LIGHT_TOKENS}}
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
h4.sec,h4{color:var(--relay-muted);font-size:12px;letter-spacing:.06em;margin:18px 0 8px}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:var(--relay-border-strong);border-radius:9px}

/* ---- 壳层 ---- */
.shell{min-height:100vh;display:grid;grid-template-columns:232px minmax(0,1fr)}
.sidebar{height:100vh;position:sticky;top:0;padding:24px 14px 16px;background:var(--relay-sidebar);color:var(--relay-sidebar-text);display:flex;flex-direction:column;z-index:20}
.brand{height:36px;display:flex;align-items:center;gap:11px;padding:0 8px;color:var(--relay-sidebar-text);text-decoration:none}
.brand>span:last-child{display:grid;line-height:1.05}
.brand strong{font-size:15px;letter-spacing:.01em}
.brand small{margin-top:4px;color:var(--relay-sidebar-muted);font-size:9px;letter-spacing:.18em;text-transform:uppercase}
.brand-mark{width:31px;height:31px;border-radius:9px;background:linear-gradient(145deg,#9583f3,#6650c4);display:flex;align-items:center;justify-content:center;gap:3px;box-shadow:0 9px 25px rgba(108,84,212,.3)}
.brand-mark i{width:4px;background:white;border-radius:4px}
.brand-mark i:first-child{height:10px}
.brand-mark i:last-child{height:16px}
.nav-label{margin:26px 10px 8px;color:#62656e;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.main-nav{display:grid;gap:4px}
.main-nav button,.main-nav a{height:42px;padding:0 11px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--relay-sidebar-muted);display:flex;align-items:center;gap:11px;text-align:left;font-size:12px;cursor:pointer;transition:.15s;text-decoration:none}
.main-nav button:hover{color:#d6d7db;background:var(--relay-sidebar-hover)}
.main-nav button.active{color:#fff;border-color:#3a344f;background:var(--relay-sidebar-active)}
.main-nav button.active .icon{color:#ad9cff}
.main-nav button span{flex:1}
.main-nav button b{min-width:19px;height:19px;padding:0 5px;border-radius:7px;background:#35313f;color:#b8aaff;display:grid;place-items:center;font-size:9px}
.main-nav button b[hidden]{display:none}
.sidebar-footer{margin-top:auto;padding-top:15px;border-top:1px solid #292a2f}
.operator{display:flex;align-items:center;gap:9px;padding:5px}
.avatar{width:31px;height:31px;border-radius:9px;background:#35313f;color:#c4b9ff;display:grid;place-items:center;font-size:11px;font-weight:800;flex:none}
.avatar.large{width:40px;height:40px;border-radius:11px}
.operator>span:nth-child(2){display:grid;gap:2px;flex:1}
.operator strong{font-size:11px}
.operator small{color:var(--relay-sidebar-muted);font-size:9px}
.main-area{min-width:0}
.topbar{height:62px;padding:0 3vw;position:sticky;top:0;z-index:15;border-bottom:1px solid var(--relay-border);background:var(--relay-bg);display:flex;align-items:center;justify-content:space-between;gap:12px}
.breadcrumb{display:flex;align-items:center;gap:9px;font-size:12px;min-width:0}
.breadcrumb span,.breadcrumb b{color:var(--relay-faint);font-weight:500}
.breadcrumb strong{font-weight:650;white-space:nowrap}
.top-actions{display:flex;align-items:center;gap:8px}
.icon-button,.refresh,.filter-button,.quiet,.text-button,.load-more,.pin-button{border:1px solid var(--relay-border);background:var(--relay-panel);cursor:pointer}
.icon-button{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;color:var(--relay-muted)}
.icon-button .icon{width:15px}
.refresh{height:34px;padding:0 12px;border-radius:8px;display:flex;align-items:center;gap:7px;font-size:11px;font-weight:650;color:var(--relay-muted)}
.refresh .icon{width:14px}
.content{width:min(1240px,94%);margin:auto;padding:34px 0 70px}

/* ---- 页头与通用件 ---- */
.page-title{min-height:56px;margin-bottom:24px;display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap}
.kicker{margin:0 0 9px;color:var(--relay-accent);font:800 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.15em}
.page-title h1{margin:0 0 8px;font-size:26px;line-height:1;letter-spacing:-.03em}
.page-copy{margin:0;color:var(--relay-muted);font-size:12px;line-height:1.6;max-width:640px}
.title-actions{display:flex;align-items:center;gap:9px}
.primary{min-height:36px;padding:0 14px;border:0;border-radius:9px;background:var(--relay-accent);color:white;display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;font-weight:750;cursor:pointer;box-shadow:0 8px 20px var(--relay-accent-shadow);transition:.15s}
.primary:hover{background:var(--relay-accent-strong)}
.primary .icon{width:14px}
.primary.small{min-height:31px;padding-inline:10px;font-size:11px}
.status{width:max-content;min-height:22px;padding:0 9px;border-radius:99px;background:var(--relay-input);color:var(--relay-muted);display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:650;white-space:nowrap}
.status i{width:5px;height:5px;border-radius:50%;background:currentColor}
.status.success{color:var(--relay-success);background:var(--relay-success-soft)}
.status.warning{color:var(--relay-warning);background:var(--relay-warning-soft)}
.status.danger{color:var(--relay-danger);background:var(--relay-danger-soft)}
.status.violet{color:var(--relay-accent);background:var(--relay-accent-soft)}
.status.blue{color:var(--relay-blue);background:var(--relay-blue-soft)}
.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.metric-card{min-height:96px;padding:15px 17px;position:relative;overflow:hidden;border:1px solid var(--relay-border);border-radius:13px;background:var(--relay-panel);box-shadow:var(--relay-shadow);display:grid;gap:5px;align-content:start}
.metric-card>span{color:var(--relay-muted);font-size:11px}
.metric-card>strong{font-size:23px;line-height:1;letter-spacing:-.03em}
.metric-card>small{color:var(--relay-faint);font-size:10px}
.metric-card>i{width:48px;height:48px;position:absolute;right:-17px;bottom:-18px;border-radius:50%;background:var(--relay-accent-soft);box-shadow:0 0 0 11px var(--relay-accent-soft)}
.metric-card.amber>i{background:var(--relay-warning-soft);box-shadow:0 0 0 11px var(--relay-warning-soft)}
.metric-card.blue>i{background:var(--relay-blue-soft);box-shadow:0 0 0 11px var(--relay-blue-soft)}
.metric-card.green>i{background:var(--relay-success-soft);box-shadow:0 0 0 11px var(--relay-success-soft)}
.notice{min-height:56px;margin:4px 0 18px;padding:11px 13px;border:1px solid var(--relay-accent-border);border-radius:12px;background:var(--relay-accent-soft);display:flex;align-items:center;gap:11px}
.notice>span{width:34px;height:34px;border-radius:9px;background:var(--relay-panel);color:var(--relay-accent);display:grid;place-items:center;flex:none}
.notice .icon{width:15px}
.notice>div{flex:1;min-width:0;font-size:12px;line-height:1.55}
.notice button,.quiet{height:32px;padding:0 12px;border-radius:8px;color:var(--relay-muted);font-size:11px;font-weight:650;display:inline-flex;align-items:center;gap:6px}
.notice button .icon,.quiet .icon{width:12px}
.section-bar{margin:20px 0 12px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.section-bar h2{margin:0;font-size:14px}
.section-bar p{margin:4px 0 0;color:var(--relay-muted);font-size:11px}
.count{padding:3px 8px;border-radius:99px;background:var(--relay-accent-soft);color:var(--relay-accent);font-size:10px;font-weight:700;vertical-align:2px}

/* ---- 卡片与决策 ---- */
.panel,.decision-card,.goal-card,.compose-card,.recent-card,.ranking-card,.rule-card,.docs-shell{border:1px solid var(--relay-border);border-radius:14px;background:var(--relay-panel);box-shadow:var(--relay-shadow)}
.panel{padding:18px;margin-bottom:12px}
.decision-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.decision-card{padding:18px;margin-bottom:0}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.type-label{color:var(--relay-accent);font:750 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em}
.decision-card h3,.compact-decision h3{margin:14px 0 6px;font-size:15px;letter-spacing:-.01em}
.byline{margin:0;color:var(--relay-faint);font-size:11px}
.submission,.body{white-space:pre-wrap;word-break:break-word;margin:13px 0 4px;padding:12px;border-radius:9px;background:var(--relay-input);color:var(--relay-muted);font-size:12px;line-height:1.7}
.body{max-height:300px;overflow:auto}
.body b{color:var(--relay-text)}
.atts{display:grid;gap:6px;margin-top:8px}
.atts:empty{display:none}
.attachment{min-height:40px;padding:7px 9px;border:1px solid var(--relay-border);border-radius:8px;display:flex;align-items:center;gap:8px;color:inherit;text-decoration:none;font-size:12px}
.attachment .icon{color:var(--relay-accent);width:14px}
.attachment span{flex:1;min-width:0}
.attachment strong{font-size:11px}
.attachment small{color:var(--relay-faint);font-size:10px;margin-left:6px}
.comment-field{display:grid;gap:7px;margin-top:12px}
.comment-field>span,.compose>span,.goal-form label>span{font-size:11px;font-weight:700;color:var(--relay-muted)}
textarea{width:100%;min-height:62px;padding:10px 11px;border:1px solid var(--relay-border);border-radius:9px;background:var(--relay-input);color:var(--relay-text);resize:vertical;outline:0;font-size:13px;line-height:1.6}
textarea:focus,input:focus,select:focus{border-color:var(--relay-accent)}
input,select{background:var(--relay-input);border:1px solid var(--relay-border);border-radius:8px;color:var(--relay-text);outline:0}
input{padding:8px 10px}
.decision-actions{margin-top:12px;display:flex;gap:7px;flex-wrap:wrap}
.decision-actions button{height:34px;padding:0 13px;border-radius:8px;display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid transparent}
.decision-actions .icon{width:13px}
.approve{border:0;background:var(--relay-control);color:var(--relay-bg)}
.reject{border-color:var(--relay-danger-border);background:var(--relay-danger-soft);color:var(--relay-danger)}
.decision-actions .quiet{margin-left:auto}
button:disabled{opacity:.5;cursor:wait}
.upgrade-cols{display:grid;grid-template-columns:1fr 1fr;gap:4px 22px;margin-top:4px}
.upgrade-card h4{margin:12px 0 4px}
.upgrade-card ul{margin:4px 0;padding-left:18px;color:var(--relay-muted);font-size:12px;line-height:1.7}
.upgrade-card .upgrade-p{margin:4px 0;color:var(--relay-muted);font-size:12px;line-height:1.7}
details.sha{margin-top:10px}
details.sha summary,.request-details summary{cursor:pointer;color:var(--relay-muted);font-size:11px}
details.sha code,.version-row code,.model-path{font:11px ui-monospace,Menlo,monospace;background:var(--relay-input);border-radius:6px;padding:5px 8px;color:var(--relay-muted);word-break:break-all;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.version-panel{display:grid;gap:8px}
.version-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.version-row strong{font-size:16px}
.err{color:var(--relay-danger);font-size:12px;margin-top:8px;white-space:pre-wrap}
.okm{color:var(--relay-success);font-size:12px;margin-top:8px}
.empty{color:var(--relay-faint);text-align:center;padding:30px 0;font-size:13px}

/* ---- 目标 ---- */
.goal-list{display:grid;gap:9px}
.goal-card{overflow:hidden}
.goal-main{width:100%;min-height:78px;padding:14px 16px;border:0;background:transparent;color:inherit;display:grid;grid-template-columns:38px minmax(200px,1fr) minmax(140px,220px) 18px;align-items:center;gap:15px;text-align:left;cursor:pointer}
.goal-index{width:36px;height:36px;border-radius:11px;background:var(--relay-accent-soft);color:var(--relay-accent);display:grid;place-items:center;font:700 12px ui-monospace,Menlo,monospace}
.goal-name{min-width:0;display:grid;gap:3px}
.goal-name>span{color:var(--relay-faint);font-size:10px}
.goal-name h3{margin:0;font-size:13px}
.goal-name p{margin:0;color:var(--relay-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.goal-stages{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.stage{font-size:10px;padding:2px 8px;border-radius:99px;background:var(--relay-input);color:var(--relay-muted)}
.stage.done{background:var(--relay-success-soft);color:var(--relay-success)}
.stage.active{background:var(--relay-blue-soft);color:var(--relay-blue)}
.stage.waiting{background:var(--relay-warning-soft);color:var(--relay-warning)}
.stage.missing{background:var(--relay-danger-soft);color:var(--relay-danger)}
.goal-arrow{width:15px;color:var(--relay-faint);transition:.2s}
.goal-card.open .goal-arrow{transform:rotate(90deg)}
.goal-extra{padding:0 16px 12px 69px;display:grid;gap:6px}
.goal-extra .meta{margin:0;color:var(--relay-muted);font-size:11px;line-height:1.6}
.goal-extra .meta.bad{color:var(--relay-danger)}
.task-drawer{padding:6px 18px 15px 69px;border-top:1px solid var(--relay-border);background:var(--relay-panel-soft)}
.task-head,.task-row{display:grid;grid-template-columns:minmax(160px,1fr) minmax(130px,160px) 92px minmax(150px,auto);gap:12px;align-items:center}
.task-head{padding:10px 8px 6px;color:var(--relay-faint);font-size:10px}
.task-row{min-height:42px;padding:4px 8px;border-top:1px solid var(--relay-border);font-size:11px}
.task-row strong{font-size:11px;font-weight:600}
.task-row .task-people{color:var(--relay-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-acts{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.task-acts button{height:27px;padding:0 10px;border-radius:7px;font-size:10px;font-weight:700;border:1px solid var(--relay-border);background:var(--relay-panel);color:var(--relay-muted);cursor:pointer}
.task-acts button.mid{color:var(--relay-accent);border-color:var(--relay-accent-border)}
.task-acts button.no{color:var(--relay-danger);border-color:var(--relay-danger-border)}
.text-button{margin-top:10px;padding:0;border:0;background:transparent;color:var(--relay-accent);display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700}
.text-button .icon{width:12px}
.text-button.danger{color:var(--relay-danger)}
.retired-list{margin-top:10px;border-top:1px solid var(--relay-border);padding-top:10px}
.retired-title{font-size:10px;color:var(--relay-faint);letter-spacing:.04em}
.retired-item{display:grid;gap:8px;margin-top:8px;padding:10px;border:1px solid var(--relay-border);border-radius:9px;background:var(--relay-panel)}
.retired-item .retired-name{font-size:11px;font-weight:600}
.retired-item .retired-meta{font-size:10px;color:var(--relay-muted);line-height:1.5}
.retired-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.retired-form select{font:inherit;font-size:11px;height:27px}
.retired-form textarea{flex:1 1 100%;font:inherit;font-size:11px;min-height:44px;resize:vertical}
.tier{font-size:10px;padding:1px 8px;border-radius:10px;border:1px solid var(--relay-border);color:var(--relay-muted)}

/* ---- 手册 ---- */
.docs-shell{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:480px;overflow:hidden}
.docs-nav{padding:16px 11px;border-right:1px solid var(--relay-border);background:var(--relay-panel-soft);display:grid;gap:3px;align-content:start}
.docs-search{height:35px;padding:0 9px;border:1px solid var(--relay-border);border-radius:8px;background:var(--relay-panel);display:flex;align-items:center;gap:7px}
.docs-search .icon{width:13px;color:var(--relay-faint)}
.docs-search input{width:100%;border:0;background:transparent;padding:0;font-size:11px}
.docs-nav>p{margin:14px 9px 5px;color:var(--relay-faint);font-size:9px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}
.docs-nav>button{width:100%;height:33px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--relay-muted);display:flex;align-items:center;gap:8px;text-align:left;font-size:11px;cursor:pointer;overflow:hidden}
.docs-nav>button .icon{width:13px}
.docs-nav>button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.docs-nav>button.active{background:var(--relay-accent-soft);color:var(--relay-accent);font-weight:700}
.doc-view{padding:26px 4vw 40px;min-width:0}
.doc-meta{display:flex;align-items:center;gap:13px}
.doc-icon{width:42px;height:42px;border-radius:12px;background:var(--relay-accent-soft);color:var(--relay-accent);display:grid;place-items:center;flex:none}
.doc-meta div{flex:1;min-width:0}
.doc-meta p{margin:0 0 4px;color:var(--relay-faint);font-size:10px}
.doc-meta h2{margin:0;font-size:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doc-info{margin:16px 0 18px;padding:9px 0;border-top:1px solid var(--relay-border);border-bottom:1px solid var(--relay-border);display:flex;gap:20px;flex-wrap:wrap;color:var(--relay-faint);font-size:10px}
.docbody,.doc-content{white-space:pre-wrap;word-break:break-word;font:12px/1.85 ui-monospace,Menlo,monospace;color:var(--relay-muted);max-height:62vh;overflow:auto}

/* ---- 留言 ---- */
.message-layout{display:grid;grid-template-columns:minmax(0,720px);gap:14px}
.compose-card{padding:22px}
.compose-head{padding-bottom:16px;border-bottom:1px solid var(--relay-border);display:flex;align-items:center;gap:11px}
.compose-head div{flex:1;min-width:0}
.compose-head h2{margin:0;font-size:13px}
.compose-head p{margin:4px 0 0;color:var(--relay-muted);font-size:11px}
.compose{margin-top:18px;display:grid;gap:8px}
.compose textarea{min-height:150px;padding:13px;font-size:13px}
.compose small{color:var(--relay-faint);font-size:10px}
.send-row{margin-top:14px;display:flex;justify-content:flex-end}

/* ---- 模型排序（沿用页面既有类名，按新视觉重写） ---- */
.sync-state{display:flex;align-items:center;gap:10px;border:1px solid var(--relay-border);border-radius:10px;padding:9px 13px;background:var(--relay-panel)}
.sync-dot{width:8px;height:8px;border-radius:50%;background:var(--relay-success);box-shadow:0 0 0 4px var(--relay-success-soft)}
.sync-state>div{display:grid;gap:2px}
.sync-state strong{font-size:11px}
.sync-state span{color:var(--relay-faint);font-size:10px}
.workspace{display:grid;grid-template-columns:300px minmax(0,1fr);gap:13px;align-items:start}
.settings-panel,.results-panel{border:1px solid var(--relay-border);border-radius:14px;background:var(--relay-panel);box-shadow:var(--relay-shadow);padding:19px}
.settings-panel{position:sticky;top:82px}
.settings-panel p{font-size:12px}
.results-panel{padding-bottom:10px}
.section-heading{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.section-heading .step{width:31px;height:31px;border-radius:9px;background:var(--relay-accent-soft);color:var(--relay-accent);display:grid;place-items:center;font:750 10px ui-monospace,Menlo,monospace;flex:none}
.section-heading div{flex:1;min-width:0}
.section-heading h2{margin:0;font-size:13px}
.section-heading p{margin:3px 0 0;color:var(--relay-muted);font-size:11px}
.results-heading{justify-content:space-between}
.updated{color:var(--relay-faint);font-size:10px}
.field-label{display:block;margin:14px 0 6px;color:var(--relay-muted);font-size:11px;font-weight:700}
.field-help{margin:6px 0 0;color:var(--relay-faint);font-size:11px;line-height:1.55}
.select-wrap select{width:100%;height:38px;padding:0 9px;border-radius:9px;font-size:12px}
.settings-panel .pin-button{height:31px;padding:0 11px;border-radius:8px;color:var(--relay-muted);font-size:11px;margin:10px 6px 0 0}
.save-button{width:100%;min-height:38px;margin-top:16px;border:0;border-radius:9px;background:var(--relay-accent);color:#fff;font-size:12px;font-weight:750;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
.save-button:disabled{opacity:.55}
.save-button.saved{background:var(--relay-success)}
.last-refresh{margin-top:16px;padding-top:13px;border-top:1px solid var(--relay-border);display:grid;gap:4px;color:var(--relay-faint);font-size:10px}
.last-refresh time{font:500 11px ui-monospace,Menlo,monospace;color:var(--relay-text)}
.error-message{color:var(--relay-danger);font-size:11px}
.tabs{margin-bottom:15px;padding:4px;border-radius:10px;background:var(--relay-input);display:flex;gap:3px}
.tabs .tab{flex:1;height:34px;border:0;border-radius:7px;background:transparent;color:var(--relay-muted);font-size:11px;font-weight:650;cursor:pointer}
.tabs .tab span{margin-left:5px;color:var(--relay-faint);font-size:10px}
.tabs .tab.active{background:var(--relay-panel);color:var(--relay-text);box-shadow:0 2px 8px rgba(20,22,28,.08)}
.group-summary{margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.group-summary h2{margin:0;font-size:13px}
.group-summary p{margin:4px 0 0;color:var(--relay-faint);font-size:11px}
.model-count{padding:4px 9px;border-radius:99px;background:var(--relay-accent-soft);color:var(--relay-accent);font-size:10px;font-weight:700;white-space:nowrap}
.model-list{display:grid;gap:4px}
.model-row{border:1px solid var(--relay-border);border-radius:9px;background:var(--relay-panel-soft);overflow:hidden}
.model-row:hover,.model-row.expanded{border-color:var(--relay-accent-border);background:var(--relay-row-hover)}
.model-row-header{display:flex;align-items:stretch}
.model-row-main{flex:1;min-width:0;display:grid;grid-template-columns:29px minmax(150px,1fr) 62px 70px 62px 74px 16px;align-items:center;gap:9px;padding:7px 9px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}
.rank{width:29px;height:29px;border-radius:8px;background:var(--relay-input);color:var(--relay-muted);display:grid;place-items:center;font:700 10px ui-monospace,Menlo,monospace}
.model-primary{min-width:0;display:grid;gap:2px}
.model-name-row{display:flex;align-items:center;gap:6px;min-width:0}
.model-name-row h3{margin:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model-primary>p{margin:0;color:var(--relay-faint);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{padding:1px 7px;border-radius:99px;background:var(--relay-accent-soft);color:var(--relay-accent);font-size:9px;font-weight:700;flex:none}
.row-stat{min-width:0;display:grid;gap:2px}
.row-stat span{color:var(--relay-faint);font-size:9px}
.row-stat strong{font-size:11px}
.score{text-align:right;display:grid;gap:2px}
.score span{color:var(--relay-faint);font-size:9px}
.score strong{color:var(--relay-score);font-size:14px}
.chevron{color:var(--relay-muted);font-size:13px;text-align:center}
.model-row-header>button.pin-button{margin:7px 9px;align-self:center;height:29px;padding:0 10px;border-radius:7px;color:var(--relay-accent);font-size:10px;flex:none}
.row-details{padding:8px 12px 13px 47px;display:grid;gap:9px;border-top:1px dashed var(--relay-border)}
.model-path{display:block}
.metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.metrics>div{padding:8px 10px;border-radius:8px;background:var(--relay-input);display:grid;gap:3px;min-width:0}
.metrics span{color:var(--relay-faint);font-size:9px}
.metrics strong{font-size:11px}
.metrics small{color:var(--relay-faint);font-size:9px}
.row-details .field-label{margin:4px 0 0}
.row-details select{height:32px;padding:0 8px;font-size:11px;max-width:220px}
.mobile-performance{margin:0;color:var(--relay-faint);font-size:10px}
.request-details{margin-top:12px}
.request-details pre{max-height:300px;overflow:auto;background:var(--relay-input);border-radius:8px;padding:10px;font:11px/1.5 ui-monospace,Menlo,monospace;margin:8px 0 0}
.empty-state{color:var(--relay-faint);text-align:center;padding:26px 0;font-size:12px}

/* ---- toast ---- */
.toast{max-width:360px;min-height:42px;padding:0 16px;position:fixed;left:50%;bottom:25px;z-index:50;border:1px solid #3d3e45;border-radius:10px;background:#222329;color:#fff;box-shadow:0 14px 40px rgba(0,0,0,.28);display:flex;align-items:center;font-size:12px;opacity:0;transform:translate(-50%,15px);pointer-events:none;transition:.22s}
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
 .sidebar{height:auto;position:sticky;top:0;padding:9px 12px;display:grid;grid-template-columns:auto 1fr;align-items:center;gap:12px;z-index:30}
 .brand>span:last-child{display:grid}
 .nav-label,.sidebar-footer{display:none}
 .main-nav{padding:0 0 0 8px;display:flex;justify-content:flex-end;gap:2px;overflow-x:auto}
 .main-nav button,.main-nav a{width:auto;height:38px;padding:0 9px;gap:6px;justify-content:center}
 .main-nav button span{display:none}
 .topbar{top:56px}
 .content{padding:22px 0 60px}
 .page-title h1{font-size:22px}
 .goal-main{grid-template-columns:34px minmax(0,1fr) 18px}
 .goal-stages{display:none}
 .goal-extra,.task-drawer{padding-left:16px}
 .task-head{display:none}
 .task-row{grid-template-columns:minmax(120px,1fr) 90px;grid-auto-rows:auto}
 .task-row .task-acts{grid-column:1/-1;justify-content:flex-start}
 .docs-shell{display:block}
 .docs-nav{border-right:0;border-bottom:1px solid var(--relay-border);display:flex;gap:5px;overflow:auto;flex-wrap:wrap}
 .docs-search,.docs-nav>p{display:none}
 .docs-nav>button{width:auto;min-width:max-content;border:1px solid var(--relay-border);border-radius:7px}
 .doc-view{padding:20px 14px 30px}
 .metric-card{min-height:84px;padding:13px 14px}
 .metric-card>strong{font-size:20px}
}
@media(max-width:560px){
 .stat-grid{gap:8px}
 .decision-card{padding:15px}
 .model-row-main{grid-template-columns:27px minmax(0,1fr) 58px 14px;gap:7px}
 .row-stat.intelligence{display:none}
 .row-details{padding-left:40px}
 .metrics{grid-template-columns:1fr 1fr}
 .compose-card{padding:16px}
 .version-row code{max-width:200px}
}
`.trimStart();
