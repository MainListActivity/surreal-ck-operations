import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectPluginRuntimeDiagnostics, releaseRootOf,
  type PluginRuntimeDiagnostics,
} from '../plugin/server/runtime-diagnostics.ts';

/** A release-shaped tree: <root>/plugin/server with a vendor/src beside it, as a real snapshot has. */
function makeRelease(): { root: string; serverDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'sck-rt-diag-'));
  const root = join(base, 'a'.repeat(40));
  const serverDir = join(root, 'plugin', 'server');
  const vendor = join(serverDir, 'vendor', 'src');
  mkdirSync(join(vendor, 'ops'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"release"}\n');
  writeFileSync(join(vendor, 'core.ts'), 'core\n');
  writeFileSync(join(vendor, 'contracts.ts'), 'contracts\n');
  writeFileSync(join(vendor, 'faults.ts'), 'faults\n');
  writeFileSync(join(vendor, 'ops', 'broker.ts'), 'broker\n');
  writeFileSync(join(vendor, 'ops', 'idp.ts'), 'idp\n');
  // A release snapshot ships the plugin's own sources as .ts; that is what the fixture mirrors.
  writeFileSync(join(serverDir, 'sidecar.ts'), 'sidecar\n');
  writeFileSync(join(serverDir, 'runtime-diagnostics.ts'), 'diag\n');
  return { root, serverDir };
}

const AT = new Date('2026-10-25T12:00:00.000Z');
const sample = (moduleDir: string): PluginRuntimeDiagnostics =>
  collectPluginRuntimeDiagnostics({ clock: () => AT, moduleDir });

describe('plugin runtime diagnostics', () => {
  test('the answer names the execution context that produced it', () => {
    // SYS04: a version read from the wrong context is worthless. The context is stated, not inferred by the reader.
    const { serverDir } = makeRelease();
    expect(sample(serverDir).context).toBe('plugin-host');
  });

  test('the reported paths come from the plugin execution context, not the MCP face', () => {
    // The MCP face loads <release>/src; the plugin loads <release>/plugin/server/vendor/src. Both hold
    // company code, so the answer must show which one was actually loaded.
    const { serverDir, root } = makeRelease();
    const answer = sample(serverDir);
    expect(answer.loaded.serverDir).toBe(serverDir);
    expect(answer.loaded.vendorDir).toBe(join(serverDir, 'vendor'));
    // The vendored source is the plugin's own; the MCP face's tree is never reported as the loaded one.
    expect(answer.loaded.vendorDir).not.toBe(join(root, 'src'));
    expect(answer.loaded.selfPath).toBe(join(serverDir, 'runtime-diagnostics.ts'));
  });

  test('a bundled plugin reports the bundle path, and its own modules are still bound', () => {
    // Paseo bundles the plugin server with esbuild, where import.meta.url does not survive and every inlined
    // module collapses onto the bundle. The answer then names the bundle, and the plugin's own files are read
    // from their .cjs form. Reporting .ts here would make two entries permanent gaps in every real release.
    const { serverDir } = makeRelease();
    rmSync(join(serverDir, 'sidecar.ts'));
    rmSync(join(serverDir, 'runtime-diagnostics.ts'));
    writeFileSync(join(serverDir, 'sidecar.cjs'), 'bundled-sidecar\n');
    writeFileSync(join(serverDir, 'runtime-diagnostics.cjs'), 'bundled-diag\n');
    const answer = sample(serverDir);
    expect(answer.loaded.selfPath).toBe(join(serverDir, 'runtime-diagnostics.cjs'));
    const own = answer.modules.filter(m => m.name.startsWith('plugin-'));
    expect(own.map(m => m.name)).toEqual(['plugin-sidecar', 'plugin-runtime-diagnostics']);
    // Both are read from the bundle, so neither is a gap.
    expect(own.every(m => m.sha256 !== null)).toBe(true);
  });

  test('a module read from the MCP face tree cannot be mistaken for the plugin path', () => {
    // Pointed at <release>/src: there is no vendor directory there and no release manifest one level up,
    // so the answer says unavailable rather than reporting the MCP tree as the plugin's loaded code.
    const { root } = makeRelease();
    const mcpTree = join(root, 'src');
    const answer = sample(mcpTree);
    expect(answer.context).toBe('plugin-host');
    expect(answer.loaded.vendorDir).toBeNull();
    expect(answer.loaded.vendorResolvedBy).toBe('unavailable');
    expect(answer.binding.kind).toBe('unavailable');
    expect(answer.binding.path).toBeNull();
    // And the vendor modules are reported unread, not silently dropped.
    expect(answer.modules.filter(m => m.name === 'core')[0]?.path).toBeNull();
  });

  test('the release binding is a resolved path of loaded code, never the active symlink', () => {
    // The symlink names what the service points at; that is the claim needing evidence, so it is not used
    // as the evidence. The binding is the release root the plugin server directory itself resolves into.
    const { serverDir, root } = makeRelease();
    const answer = sample(serverDir);
    expect(answer.binding).toEqual({ kind: 'plugin-server-dir', path: root });
    expect(answer.notRead.join(' ')).toContain('active symlink');
    expect(releaseRootOf(serverDir)).toBe(root);
  });

  test('the module digests bind the content actually read', () => {
    const { serverDir } = makeRelease();
    const modules = sample(serverDir).modules;
    const core = modules.filter(m => m.name === 'core')[0]!;
    // sha256 of the five bytes written above ("core\n"): a changed file shows up as a mismatch, so the
    // digest is a real binding rather than a claim.
    expect(core.bytes).toBe(5);
    expect(core.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(core.sha256).toBe('d1e6e9f24df974e4c75706d8dd4728911b230bb7162cdfe2689ef4b487263835');
    // Every module is either fully read or reported unread; none is half-described.
    for (const m of modules) expect(m.sha256 !== null && m.bytes !== null || m.path === null).toBe(true);
  });

  test('a file that cannot be read is reported, not omitted', () => {
    // A pruned or unreadable file must be visible as a gap, or a reader would take silence for agreement.
    const { serverDir } = makeRelease();
    const modules = sample(serverDir).modules;
    expect(modules.length).toBeGreaterThan(0);
    const broken = collectPluginRuntimeDiagnostics({
      clock: () => AT,
      moduleDir: join(serverDir, 'does-not-exist'),
    }).modules;
    expect(broken.every(m => m.path === null && m.sha256 === null && m.bytes === null)).toBe(true);
  });

  test('the collection instant is an ISO 8601 timestamp with a timezone offset', () => {
    // SYS04 acceptance: the answer carries when it was taken. The injected clock proves the stamp is the
    // clock's, not a reformatted guess.
    const { serverDir } = makeRelease();
    expect(sample(serverDir).collectedAt).toBe('2026-10-25T12:00:00.000Z');
    // The default path uses the real clock, which is also offset-bearing.
    expect(collectPluginRuntimeDiagnostics({ moduleDir: serverDir }).collectedAt).toMatch(/Z|[+-]\d{2}:\d{2}$/);
  });

  test('the answer carries no credential, private path or environment value', () => {
    const { serverDir } = makeRelease();
    const text = JSON.stringify(sample(serverDir));
    // Nothing that identifies a secret, and no private/ or env content rides along.
    expect(text).not.toContain('private/service.env');
    expect(text).not.toContain('SCK_MCP_TOKEN');
    expect(text).not.toContain('SCK_EMPLOYEE_CREDENTIAL');
    // The declared boundary is part of the answer, so a reader can check it without reading the source.
    expect(sample(serverDir).notRead).toContain('process environment values');
  });

  test('the answer is bounded, so it fits the channel reply budget', () => {
    // The relay enforces a byte ceiling; a diagnostic that grows without bound would be refused there.
    const { serverDir } = makeRelease();
    expect(JSON.stringify(sample(serverDir)).length).toBeLessThan(8192);
  });
});
