/** Visual source: owner-provided redesign/src/index.css. Layout retained; colors adapt to appearance. */
export const relayWebTheme = `:root{
 color-scheme:light dark;
 --relay-bg:#0b0d10;--relay-panel:#15171c;--relay-input:#101216;--relay-row:#111318;--relay-hover:#14161c;
 --relay-control:#23262d;--relay-tab:#2a2d34;--relay-path:#0d0f12;--relay-text:#f1f2f4;--relay-muted:#989da8;
 --relay-faint:#818794;--relay-border:rgba(255,255,255,.08);--relay-accent:#826cf6;--relay-score:#9b87ff;
 --relay-accent-soft:rgba(139,115,255,.12);--relay-success:#70dcb3;--relay-success-soft:rgba(89,215,168,.1);
 --relay-danger:#ff9a9a;--relay-shadow:0 24px 70px rgba(0,0,0,.28);
}
@media(prefers-color-scheme:light){:root{
 --relay-bg:#f5f6fa;--relay-panel:#fff;--relay-input:#f8f9fc;--relay-row:#fff;--relay-hover:#f8f6ff;
 --relay-control:#eef0f5;--relay-tab:#fff;--relay-path:#f2f3f8;--relay-text:#202330;--relay-muted:#606776;
 --relay-faint:#697181;--relay-border:rgba(31,36,51,.12);--relay-accent:#7154df;--relay-score:#694bcf;
 --relay-success:#177958;--relay-success-soft:rgba(23,121,88,.09);--relay-danger:#b52d45;
 --relay-shadow:0 12px 36px rgba(35,40,65,.06);
}}
`;

export const relayDesignCss = relayWebTheme + `
*{box-sizing:border-box;border-style:solid;border-width:0}body,h1,h2,h3,p{margin:0}button,textarea,select{font:inherit}button{background:none;color:inherit}button:not(:disabled){cursor:pointer}button:focus-visible{outline:2px solid var(--relay-accent);outline-offset:3px}button:disabled{opacity:.55;cursor:wait}a{color:inherit;text-decoration:none}


:root {color:var(--relay-text);background:var(--relay-bg);font-family:Inter,"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-synthesis:none;}

@layer base {
  body {
    min-width: 320px;
    min-height: 100vh;
    background:
      radial-gradient(circle at 15% 0%, rgba(128, 99, 255, 0.13), transparent 30rem),
      radial-gradient(circle at 88% 12%, rgba(46, 210, 162, 0.08), transparent 26rem),
      var(--relay-bg);
  }

  button,
  textarea,
  select {
    outline: none;
  }
}

.app-shell {
  min-height: 100vh;
}

.topbar {
  height: 68px;
  padding: 0 4vw;
  border-bottom: 1px solid var(--relay-border);
  background: var(--relay-bg);
  backdrop-filter: blur(18px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 20;
}

.brand,
.preview-badge,
.sync-state,
.model-identity,
.model-name-row {
  display: flex;
  align-items: center;
}

.brand {
  gap: 11px;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: linear-gradient(145deg, #9881ff, #6f58ed);
  color: white;
  display: grid;
  place-items: center;
  box-shadow: 0 8px 24px rgba(125, 99, 246, 0.3);
}

.preview-badge {
  gap: 8px;
  border: 1px solid var(--relay-border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--relay-muted);
  border-radius: 999px;
  padding: 7px 12px;
  font-size: 12px;
}

.pulse,
.sync-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--relay-success);
  box-shadow: 0 0 0 4px rgba(94, 228, 174, 0.1);
}

.page {
  width: min(1240px, 92vw);
  margin: 0 auto;
  padding: 64px 0 80px;
}

.hero {
  display: flex;
  justify-content: space-between;
  gap: 32px;
  align-items: flex-end;
  margin-bottom: 36px;
}

.eyebrow {
  color: var(--relay-score);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
  margin-bottom: 12px;
}

.hero h1 {
  font-size: clamp(36px, 5vw, 58px);
  line-height: 1;
  font-weight: 720;
  letter-spacing: -0.045em;
  margin-bottom: 16px;
}

.hero-copy {
  max-width: 600px;
  color: var(--relay-muted);
  font-size: 14px;
  line-height: 1.8;
}

.sync-state {
  flex: none;
  gap: 12px;
  padding: 12px 15px;
  border: 1px solid var(--relay-border);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.035);
}

.sync-state div {
  display: grid;
  gap: 2px;
}

.sync-state strong {
  font-size: 12px;
}

.sync-state span:last-child {
  color: var(--relay-faint);
  font-size: 11px;
}

.workspace {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}

.settings-panel,
.results-panel {
  border: 1px solid var(--relay-border);
  border-radius: 22px;
  background: var(--relay-panel);
  box-shadow: var(--relay-shadow);
}

.settings-panel {
  padding: 26px;
  position: sticky;
  top: 92px;
}

.results-panel {
  padding: 26px;
}

.section-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 27px;
}

.step {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--relay-accent-soft);
  color: var(--relay-score);
  font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.section-heading h2 {
  color: var(--relay-text);
  font-size: 15px;
  font-weight: 700;
}

.section-heading p {
  color: var(--relay-faint);
  font-size: 11px;
  margin-top: 3px;
}

.field-label {
  display: block;
  color: var(--relay-text);
  font-size: 12px;
  font-weight: 650;
  margin: 20px 0 9px;
}

textarea,
select {
  width: 100%;
  border: 1px solid var(--relay-border);
  background: var(--relay-input);
  color: var(--relay-text);
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}

textarea:focus,
select:focus {
  border-color: #8069f4;
  box-shadow: 0 0 0 3px rgba(128, 105, 244, 0.12);
}

textarea {
  min-height: 118px;
  resize: vertical;
  border-radius: 13px;
  padding: 14px;
  font-size: 13px;
  line-height: 1.7;
}

.field-help {
  color: var(--relay-faint);
  font-size: 11px;
  line-height: 1.6;
  margin-top: 8px;
}

.select-wrap {
  position: relative;
}

.select-wrap::after {
  content: "⌄";
  color: var(--relay-muted);
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-58%);
  pointer-events: none;
}

select {
  appearance: none;
  height: 45px;
  border-radius: 12px;
  padding: 0 38px 0 14px;
  font-size: 13px;
}

.save-button {
  width: 100%;
  height: 47px;
  border-radius: 13px;
  background: var(--relay-accent);
  color: white;
  margin-top: 22px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 700;
  box-shadow: 0 12px 30px rgba(105, 82, 225, 0.28);
  cursor: pointer;
  transition:
    transform 160ms ease,
    background 160ms ease;
}

.save-button:hover {
  background: #907cff;
  transform: translateY(-1px);
}

.save-button.saved {
  background: #2ea77e;
}

.save-button span {
  font-size: 18px;
}

.last-refresh {
  border-top: 1px solid var(--relay-border);
  margin-top: 24px;
  padding-top: 19px;
  display: grid;
  gap: 5px;
}

.last-refresh > span {
  color: var(--relay-faint);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.last-refresh time {
  color: var(--relay-text);
  font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.last-refresh p {
  color: var(--relay-faint);
  font-size: 10px;
  line-height: 1.6;
}

.results-heading {
  margin-bottom: 22px;
}

.updated {
  color: var(--relay-faint);
  font-size: 10px;
  margin-left: auto;
}

.tabs {
  display: flex;
  gap: 7px;
  padding: 5px;
  border-radius: 13px;
  background: var(--relay-input);
  margin-bottom: 25px;
}

.tab {
  flex: 1;
  height: 39px;
  color: var(--relay-muted);
  border-radius: 9px;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  transition: 160ms ease;
}

.tab:hover {
  color: var(--relay-text);
}

.tab span {
  margin-left: 7px;
  color: var(--relay-faint);
  font-size: 10px;
}

.tab.active {
  color: var(--relay-text);
  background: var(--relay-tab);
  box-shadow: inset 0 0 0 1px var(--relay-border);
}

.tab.active span {
  color: var(--relay-score);
}

.group-summary {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  margin-bottom: 18px;
}

.group-summary h2 {
  font-size: 17px;
  font-weight: 720;
  text-transform: capitalize;
}

.group-summary p {
  color: var(--relay-faint);
  font-size: 11px;
  line-height: 1.6;
  margin-top: 6px;
}

.model-count {
  flex: none;
  color: var(--relay-score);
  background: rgba(139, 115, 255, 0.1);
  border: 1px solid rgba(139, 115, 255, 0.15);
  border-radius: 999px;
  padding: 6px 9px;
  font-size: 10px;
  font-weight: 700;
}

.model-list {
  display: grid;
  gap: 8px;
}

.model-row {
  border: 1px solid var(--relay-border);
  border-radius: 12px;
  background: var(--relay-row);
  transition:
    border-color 180ms ease,
    background 180ms ease;
  overflow: hidden;
}

.model-row:hover,
.model-row.expanded {
  border-color: rgba(139, 115, 255, 0.3);
  background: var(--relay-hover);
}

.model-row-main {
  width: 100%;
  min-height: 62px;
  padding: 10px 12px;
  display: grid;
  grid-template-columns: 34px minmax(180px, 1fr) 72px 96px 64px 76px 22px;
  align-items: center;
  gap: 12px;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.rank {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: var(--relay-control);
  color: var(--relay-text);
  font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.model-name-row {
  gap: 8px;
  min-width: 0;
}

.model-name-row h3 {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--relay-text);
  font-size: 13px;
  font-weight: 680;
  white-space: nowrap;
}

.tag {
  flex: none;
  padding: 3px 6px;
  border-radius: 5px;
  background: var(--relay-success-soft);
  color: var(--relay-success);
  font-size: 9px;
}

.model-primary {
  min-width: 0;
}

.model-primary p {
  color: var(--relay-faint);
  font-size: 10px;
  margin-top: 2px;
}

.score {
  text-align: right;
  display: grid;
}

.score span,
.score small {
  color: var(--relay-faint);
  font-size: 9px;
}

.score strong {
  color: var(--relay-score);
  font-size: 19px;
  line-height: 1.2;
  letter-spacing: -0.03em;
}

.row-stat {
  display: grid;
  gap: 2px;
}

.row-stat span {
  color: var(--relay-faint);
  font-size: 9px;
}

.row-stat strong {
  color: var(--relay-text);
  font-size: 11px;
  font-weight: 650;
}

.chevron {
  color: var(--relay-faint);
  font-size: 17px;
  text-align: center;
}

.row-details {
  padding: 0 14px 14px 58px;
  animation: reveal 140ms ease-out;
}

@keyframes reveal {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

.model-path {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--relay-faint);
  font: 500 9px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  margin: 12px 0;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--relay-path);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
}

.metrics div {
  min-width: 0;
  display: grid;
  gap: 2px;
  padding-left: 10px;
  border-left: 1px solid var(--relay-border);
}

.metrics div:first-child {
  padding-left: 0;
  border-left: 0;
}

.metrics span,
.metrics small {
  overflow: hidden;
  color: var(--relay-faint);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metrics strong {
  color: var(--relay-text);
  font-size: 12px;
  font-weight: 700;
}

@media (max-width: 900px) {
  .workspace {
    grid-template-columns: 1fr;
  }

  .settings-panel {
    position: static;
  }

  .metrics {
    grid-template-columns: repeat(3, 1fr);
  }

  .metrics div:nth-child(4) {
    padding-left: 0;
    border-left: 0;
  }

  .model-row-main {
    grid-template-columns: 34px minmax(150px, 1fr) 70px 88px 22px;
  }

  .model-row-main .intelligence,
  .model-row-main .quota {
    display: none;
  }
}

@media (max-width: 600px) {
  .topbar {
    height: 60px;
    padding: 0 18px;
  }

  .page {
    width: auto;
    padding: 30px 12px 40px;
  }

  .hero {
    align-items: flex-start;
    margin-bottom: 25px;
  }

  .hero h1 {
    font-size: 38px;
  }

  .hero-copy {
    font-size: 12px;
  }

  .sync-state {
    display: none;
  }

  .settings-panel,
  .results-panel {
    padding: 16px;
    border-radius: 16px;
  }

  .updated {
    display: none;
  }

  .group-summary p {
    max-width: 270px;
  }

  .results-panel {
    padding: 14px 12px 16px;
  }

  .results-heading {
    margin: 2px 2px 14px;
  }

  .tabs {
    margin-bottom: 16px;
  }

  .group-summary {
    align-items: center;
    margin: 0 2px 12px;
  }

  .group-summary h2 {
    font-size: 15px;
  }

  .group-summary p {
    display: none;
  }

  .model-list {
    gap: 5px;
  }

  .model-row {
    border-radius: 10px;
  }

  .model-row-main {
    min-height: 52px;
    padding: 7px 8px;
    grid-template-columns: 28px minmax(0, 1fr) 66px 18px;
    gap: 7px;
  }

  .model-row-main .speed,
  .model-row-main .intelligence,
  .model-row-main .quota {
    display: none;
  }

  .rank {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    font-size: 9px;
  }

  .model-name-row {
    display: block;
  }

  .model-name-row h3 {
    max-width: calc(100vw - 154px);
    font-size: 12px;
  }

  .tag {
    display: none;
  }

  .model-primary p {
    margin-top: 2px;
    font-size: 9px;
  }

  .score strong {
    font-size: 14px;
  }

  .score small {
    display: none;
  }

  .row-details {
    padding: 0 9px 10px 43px;
  }

  .row-details .model-path {
    margin: 9px 0;
    padding: 5px 7px;
    font-size: 8px;
  }

  .metrics {
    grid-template-columns: repeat(3, 1fr);
    gap: 7px 0;
    padding-top: 1px;
  }

  .metrics div {
    gap: 1px;
    padding-left: 8px;
  }

  .metrics div:nth-child(4) {
    padding-left: 0;
    border-left: 0;
  }

  .metrics span {
    font-size: 8px;
  }

  .metrics strong {
    font-size: 11px;
  }

  .metrics small {
    display: block;
    overflow-wrap: anywhere;
  }
}

.error-message{color:var(--relay-danger);font-size:12px;margin-top:12px}.empty-state{color:var(--relay-muted);padding:24px 0;text-align:center}.mobile-performance{display:none}@media(max-width:600px){.mobile-performance{display:block;color:var(--relay-muted);font-size:9px;margin-top:7px}}.request-details{margin-top:22px;color:var(--relay-muted);font-size:12px}.request-details pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--relay-input);padding:12px;border-radius:12px;max-height:400px;overflow:auto}

.model-row-header{display:flex;align-items:center;min-width:0}
.model-row-header .model-row-main{flex:1;min-width:0}
.pin-button{flex-shrink:0;margin-right:10px;padding:8px 6px;min-height:44px;background:transparent;border:0;color:var(--relay-muted);font-size:11px;cursor:pointer}
.pin-button[aria-pressed="true"]{color:var(--relay-accent)}
.pin-button:disabled{opacity:.5;cursor:wait}
@media(max-width:600px){.pin-button{margin-right:5px;padding:6px 3px;font-size:10px}}

.ranking-layer-guide,.ranking-layer{background:var(--relay-control);color:var(--relay-text);border-radius:10px;padding:14px;margin:12px 0;line-height:1.7;font-size:12px;overflow-wrap:anywhere}
.ranking-layer-guide p,.ranking-layer p{margin:5px 0;color:var(--relay-muted)}
.ranking-layer{border-top:2px solid var(--relay-accent);margin-top:20px}
.ranking-layer h3{margin:0;font-size:13px}
.ranking-layer .layer-range{color:var(--relay-accent);font-weight:600}
`;
