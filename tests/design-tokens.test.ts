import { test, expect } from 'bun:test';
import {
  RELAY_LIGHT, RELAY_DARK, RELAY_FONT_PX, RELAY_RADIUS_PX, RELAY_SPACE_PX,
  paletteToCssVars, scaleToCssVars, previewListCss,
} from '../plugin/shared/relay-tokens.ts';
import { relayShellCss } from '../plugin/shared/relay-shell.ts';
import { routingDesignCss } from '../plugin/shared/model-routing-design.ts';
import { relayPalette } from '../plugin/client/relay-theme.ts';

// AC1: colours, font sizes, radii and spacing are defined once (relay-tokens.ts) and every
// surface consumes that file. These assertions fail if a literal drifts back into a page CSS.
const WEB_CSS: Array<[string, string]> = [
  ['relay-shell', relayShellCss],
  ['model-routing-design', routingDesignCss],
  ['preview-list', previewListCss],
];
/** The token declarations themselves are the one place values may appear; check the rules they feed. */
const rules = (css: string) => css.replace(/--relay-[a-z0-9-]+\s*:[^;}]+;/gi, '');

test('no page CSS carries raw colours — they all come from the shared palette', () => {
  for (const [name, css] of WEB_CSS) {
    const body = rules(css);
    expect(body, `${name} has a raw hex colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body, `${name} has a raw rgb()/rgba() colour`).not.toMatch(/\brgba?\(/);
  }
});

test('no page CSS carries raw font sizes, radii or spacing — they are all scale variables', () => {
  for (const [name, css] of WEB_CSS) {
    const body = rules(css);
    expect(body, `${name} has a raw font-size`).not.toMatch(/font-size:\s*\d+px/);
    expect(body, `${name} has a raw border-radius`).not.toMatch(/border-radius:\s*\d+px/);
    expect(body, `${name} has a raw gap/padding/margin`).not.toMatch(/(?:gap|padding|margin)[^;{}]*\d+px/);
    expect(body, `${name} has a raw font shorthand size`).not.toMatch(/font:[^;}]*\d+px/);
  }
});

test('both themes and both scale families are present in the generated variables', () => {
  expect(paletteToCssVars(RELAY_LIGHT)).toContain(`--relay-bg:${RELAY_LIGHT.bg}`);
  expect(paletteToCssVars(RELAY_DARK)).toContain(`--relay-bg:${RELAY_DARK.bg}`);
  for (const n of RELAY_FONT_PX) expect(scaleToCssVars()).toContain(`--relay-fs-${n}:${n}px`);
  for (const n of RELAY_RADIUS_PX) expect(scaleToCssVars()).toContain(`--relay-r-${n}:${n}px`);
  for (const n of RELAY_SPACE_PX) expect(scaleToCssVars()).toContain(`--relay-sp-${n}:${n}px`);
  // The shell CSS must carry both the light and the dark palette.
  expect(relayShellCss).toContain(`--relay-bg:${RELAY_LIGHT.bg}`);
  expect(relayShellCss).toContain(`--relay-bg:${RELAY_DARK.bg}`);
});

test('the Paseo panel palette is derived from the same tokens, not a second colour table', () => {
  const light = relayPalette({ colors: { surface0: '#ffffff' } } as never);
  const dark = relayPalette({ colors: { surface0: '#000000' } } as never);
  expect(light.light).toBe(true);
  expect(light.core.surface0).toBe(RELAY_LIGHT.bg);
  expect(light.core.accent).toBe(RELAY_LIGHT.accent);
  expect(light.core.accentForeground).toBe(RELAY_LIGHT.accentInk);
  expect(light.inputBg).toBe(RELAY_LIGHT.input);
  expect(dark.light).toBe(false);
  expect(dark.core.surface0).toBe(RELAY_DARK.bg);
  expect(dark.core.accent).toBe(RELAY_DARK.accent);
  expect(dark.core.accentForeground).toBe(RELAY_DARK.accentInk);
});
