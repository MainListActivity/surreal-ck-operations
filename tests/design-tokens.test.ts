import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  RELAY_LIGHT, RELAY_DARK, RELAY_FONT_PX, RELAY_RADIUS_PX, RELAY_SPACE_PX, RELAY_RN_PX,
  paletteToCssVars, scaleToCssVars, previewListCss, fs, radius, sp,
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

/** AC1 (round-02 finding): every numeric style value in plugin/client must come from relay-tokens.ts. */
const CLIENT_DIR = join(import.meta.dir, '..', 'plugin', 'client');
const STYLE_PROPS = [
  'fontSize', 'borderRadius', 'padding', 'paddingHorizontal', 'paddingVertical',
  'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'margin',
  'marginHorizontal', 'marginVertical', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'gap', 'rowGap', 'columnGap', 'lineHeight', 'letterSpacing',
  'minHeight', 'height', 'width', 'minWidth', 'borderWidth', 'borderLeftWidth',
  'borderTopWidth', 'borderBottomWidth', 'right', 'bottom',
];

test('every Paseo client file consumes the shared token functions, with no raw numeric style literals', () => {
  const files = readdirSync(CLIENT_DIR).filter(f => f.endsWith('.tsx'));
  expect(files.length).toBeGreaterThan(5);
  for (const file of files) {
    const src = readFileSync(join(CLIENT_DIR, file), 'utf8');
    if (!/\b(?:fs|radius|sp)\(/.test(src)) continue; // relay-theme.ts is a .ts file, not included here
    expect(src, `${file} does not import relay-tokens.ts`).toContain('relay-tokens.ts');
    for (const match of src.matchAll(new RegExp(`\\b(?:${STYLE_PROPS.join('|')}):\\s*([^,}\\n]+)`, 'g'))) {
      const value = match[1]!;
      const stripped = value
        .replace(/(?:fs|radius|sp)\([^)]*\)/g, '')
        .replace(/["'][^"']*["']/g, ''); // percentages/strings are not px literals
      expect(stripped, `${file} still has a raw numeric style value in ${match[0]}`)
        .not.toMatch(/(?<!\w)-?\d+(?:\.\d+)?/);
    }
  }
});

test('the shared numeric helpers accept exactly the declared RN scale and reject an undeclared value', () => {
  for (const n of RELAY_RN_PX) {
    expect(fs(n)).toBe(n);
    expect(radius(n)).toBe(n);
    expect(sp(n)).toBe(n);
  }
  expect(() => sp(999999 as never)).toThrow('不在共享数值阶梯中');
});
