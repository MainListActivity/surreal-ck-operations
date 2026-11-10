import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectPluginRuntimeDiagnostics, releaseRootOf,
  type PluginRuntimeDiagnostics,
} from '../plugin/server/runtime-diagnostics.ts';

const modulePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'server', 'runtime-diagnostics.ts');

/**
 * The esbuild the Paseo application itself bundles plugins with. The host loads plugin server code as esbuild
 * CJS inside `(function(require){…})` via `globalThis.eval`, where neither `__dirname` nor `import.meta.url`
 * exists — the context this diagnostic must survive. The application ships its own esbuild; without it the
 * exact loader cannot be reproduced and the case is skipped rather than approximated.
 */
const PASEO_ESBUILD = '/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/node_modules/esbuild/bin/esbuild';
const hostLoaderAvailable = existsSync(PASEO_ESBUILD);

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

  test('the reported paths come from the plugin execution context, not the release/src tree', () => {
    // The service's tree is <release>/src; the plugin loads <release>/plugin/server/vendor/src. Both hold
    // company code, so the answer must show which one was actually loaded.
    const { serverDir, root } = makeRelease();
    const answer = sample(serverDir);
    expect(answer.loaded.basis).toBe('module-dir');
    expect(answer.loaded.serverDir).toBe(serverDir);
    expect(answer.loaded.vendorDir).toBe(join(serverDir, 'vendor'));
    // The vendored source is the plugin's own; the release/src tree is never reported as the loaded one.
    expect(answer.loaded.vendorDir).not.toBe(join(root, 'src'));
    expect(answer.loaded.selfPath).toBe(join(serverDir, 'runtime-diagnostics.ts'));
  });

  test('a bundled plugin reports the bundle path, and its own modules are still bound', () => {
    // If the host instead runs bundled CJS output, import.meta.url does not survive and every inlined
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

  test('a module read from the release/src tree cannot be mistaken for the plugin path', () => {
    // Pointed at <release>/src: there is no vendor directory there and no release manifest one level up,
    // so the answer says unavailable rather than reporting the release/src tree as the plugin's loaded code.
    const { root } = makeRelease();
    const serviceTree = join(root, 'src');
    const answer = sample(serviceTree);
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
    expect(text).not.toContain('SCK_OWNER_TOKEN');
    expect(text).not.toContain('SCK_SERVICE_GATE');
    // The declared boundary is part of the answer, so a reader can check it without reading the source.
    expect(sample(serverDir).notRead).toContain('process environment values');
  });

  test('the host-registered plugin source is the directory, so no module global is consulted', () => {
    // The Paseo host evaluates a CJS bundle where `__dirname` and `import.meta.url` are both absent. The
    // sidecar resolves the host's own registry entry (`paseo plugin ls --json`) and passes it in; the
    // diagnostic binds that registered tree and says so, instead of deriving anything from the module.
    const { root, serverDir } = makeRelease();
    const answer = collectPluginRuntimeDiagnostics({
      clock: () => AT,
      pluginSourceDir: join(root, 'plugin'),
    });
    expect(answer.loaded.basis).toBe('registered-plugin-source');
    expect(answer.loaded.serverDir).toBe(serverDir);
    expect(answer.loaded.vendorDir).toBe(join(serverDir, 'vendor'));
    expect(answer.loaded.selfPath).toBe(join(serverDir, 'runtime-diagnostics.ts'));
    expect(answer.binding).toEqual({ kind: 'plugin-server-dir', path: root });
    expect(answer.modules.every(m => m.sha256 !== null)).toBe(true);
  });

  test('without a host-supplied directory the answer is unavailable, never guessed', () => {
    // No module globals, no registry entry: the honest answer is unavailable with null paths, not a path
    // derived from a process that happens to be nearby.
    const answer = collectPluginRuntimeDiagnostics({ clock: () => AT });
    expect(answer.loaded.basis).toBe('unavailable');
    expect(answer.loaded.serverDir).toBeNull();
    expect(answer.loaded.selfPath).toBeNull();
    expect(answer.binding.kind).toBe('unavailable');
    expect(answer.modules.every(m => m.path === null)).toBe(true);
  });

  test.skipIf(!hostLoaderAvailable)('under the real Paseo loader (esbuild CJS + eval) the registered source is bound with no module globals', () => {
    // Mirrors the host exactly: esbuild to CJS, wrap in `(function(require){…})`, evaluate with
    // `globalThis.eval`, then call the factory with a runtime require. If the diagnostic still depended on
    // `__dirname` or `import.meta`, this case would report unavailable — it is the context production failed in.
    const { root, serverDir } = makeRelease();
    const dir = mkdtempSync(join(tmpdir(), 'sck-rt-host-'));
    const entry = join(dir, 'entry.ts');
    writeFileSync(entry, [
      `import { collectPluginRuntimeDiagnostics } from ${JSON.stringify(modulePath)};`,
      'export default function run(pluginDir: string) {',
      '  return {',
      '    dirnameType: typeof __dirname,',
      '    metaUrl: (import.meta as { url?: string }).url ?? null,',
      '    withSource: collectPluginRuntimeDiagnostics({ pluginSourceDir: pluginDir }),',
      '    without: collectPluginRuntimeDiagnostics(),',
      '  };',
      '}',
      '',
    ].join('\n'));
    const bundle = join(dir, 'bundle.cjs');
    const build = spawnSync(PASEO_ESBUILD, [
      entry, '--bundle', '--format=cjs', '--platform=node', '--target=node20', `--outfile=${bundle}`,
    ], { encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    const runner = join(dir, 'runner.mjs');
    writeFileSync(runner, [
      "import { readFileSync } from 'node:fs';",
      "import { createRequire } from 'node:module';",
      'const code = readFileSync(process.argv[2], "utf8");',
      'const factory = globalThis.eval("(function(require) {\\nconst module = { exports: {} };\\nconst exports = module.exports;\\n" + code + "\\nreturn module.exports;\\n})");',
      'const mod = factory(createRequire(import.meta.url));',
      'const result = mod.default(process.argv[3]);',
      'console.log(JSON.stringify(result));',
      '',
    ].join('\n'));
    try {
      const run = spawnSync('node', [runner, bundle, join(root, 'plugin')], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const { dirnameType, metaUrl, withSource, without } = JSON.parse(run.stdout) as {
        dirnameType: string;
        metaUrl: string | null;
        withSource: PluginRuntimeDiagnostics;
        without: PluginRuntimeDiagnostics;
      };
      // The loader context really is the one production failed in: no globals to read a directory from.
      expect(dirnameType).toBe('undefined');
      expect(metaUrl).toBeNull();
      expect(withSource.loaded.basis).toBe('registered-plugin-source');
      expect(withSource.loaded.serverDir).toBe(serverDir);
      expect(withSource.loaded.selfPath).toBe(join(serverDir, 'runtime-diagnostics.ts'));
      expect(withSource.binding).toEqual({ kind: 'plugin-server-dir', path: root });
      expect(withSource.modules.filter(m => m.sha256 !== null).length).toBe(7);
      // With no host-supplied directory the same loader reports unavailable rather than inventing a path.
      expect(without.loaded.basis).toBe('unavailable');
      expect(without.loaded.serverDir).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the answer is bounded, so it fits the channel reply budget', () => {
    // The relay enforces a byte ceiling; a diagnostic that grows without bound would be refused there.
    const { serverDir } = makeRelease();
    expect(JSON.stringify(sample(serverDir)).length).toBeLessThan(8192);
  });
});
