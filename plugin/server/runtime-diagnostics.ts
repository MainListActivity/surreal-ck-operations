// SYS04: a read-only diagnostic of what the plugin process is ACTUALLY running.
//
// The company service has two execution contexts that both hold company code, and they are not the same
// tree: the launchd MCP face loads `release/src/*`, while the Paseo plugin `sck-company` — the one every
// employee's `sck call` reaches — loads `release/plugin/server/vendor/src/*`. A version read from the wrong
// context looks authoritative and is worthless, which is why this module never reads the MCP face's path,
// the `active` symlink, or a client-side directory: it reports what this process loaded.
//
// The module's own directory is resolved from what the running program actually offers: the Paseo plugin
// host loads the server entry as ESM, where `__dirname` is undefined, so the location comes from
// `import.meta.url`. A host that instead runs bundled CJS output offers `__dirname` and no usable
// `import.meta.url`. Both answers name the directory the loaded code occupies — a bundle collapses inlined
// modules onto itself, which is still the honest answer about what was loaded. What cannot be proven is
// reported as unavailable: nothing here is inferred, and nothing is echoed from a sibling context.
//
// Read-only by construction: it opens no socket, writes nothing, reads no private/ or credential file, and
// exposes no arbitrary file or command capability.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginRuntimeView } from "./vendor/src/contracts.ts";

/** One file the diagnostic read, with the digest that binds its content. */
export interface RuntimeModule {
  /** Logical name, so the same file is recognizable across the two faces. */
  readonly name: string;
  /** Absolute path read, or null when the file was not there or could not be read. */
  readonly path: string | null;
  /** sha256 of the bytes read; null when unreadable. */
  readonly sha256: string | null;
  /** Byte length of the bytes read; null when unreadable. */
  readonly bytes: number | null;
}

/** The answer shape is the shared contract, so core and the plugin agree on it exactly. */
export type PluginRuntimeDiagnostics = PluginRuntimeView;

/** Read one file's content and digest it; an unreadable file is reported as a gap, never omitted. */
function readModule(name: string, path: string | null): RuntimeModule {
  if (!path) return { name, path: null, sha256: null, bytes: null };
  try {
    const bytes = readFileSync(path);
    return { name, path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
  } catch {
    return { name, path, sha256: null, bytes: null };
  }
}

/**
 * The directory this module's code occupies in the running program.
 *
 * ESM is checked first because the Paseo plugin host loads the server entry as ESM (there `__dirname` is
 * undefined). A CJS build has no usable `import.meta.url` and falls back to `__dirname`. `typeof` on an
 * undeclared identifier is safe in ESM, so neither branch can throw; a context that offers neither reports
 * unavailable rather than guessing.
 */
export function moduleDirOfThisFile(): string | null {
  const meta = import.meta as { url?: string } | undefined;
  const metaUrl = typeof meta?.url === "string" ? meta.url : undefined;
  if (metaUrl) {
    try {
      return dirname(fileURLToPath(metaUrl));
    } catch {
      // fall through to the CJS global
    }
  }
  if (typeof __dirname === "string" && __dirname.length > 0) return resolve(__dirname);
  return null;
}

/**
 * The path this diagnostic's own code occupies inside the running program.
 *
 * In an esbuild CJS bundle every inlined module collapses onto the bundle, so this is the bundle's own
 * location rather than a per-module one — which is still the honest answer about what was loaded. The
 * extension follows whichever file is actually present: a release snapshot ships `.ts`, a bundle leaves
 * `.cjs`. When neither is there the answer is null rather than a guess.
 */
function selfPath(serverDir: string | null): string | null {
  if (!serverDir) return null;
  const [found] = [join(serverDir, "runtime-diagnostics.ts"), join(serverDir, "runtime-diagnostics.cjs")].filter(path => existsSync(path));
  return found ? resolve(found) : null;
}

/**
 * Where the plugin's vendored company source actually lives.
 *
 * The plugin imports `./vendor/src/*` relative to its server directory, so the vendor root is that
 * directory's `vendor` child. It is reported only when it exists and is a directory; a bundled plugin whose
 * vendor directory was pruned at install time reports `unavailable` rather than a guessed path.
 */
function resolveVendorDir(serverDir: string | null): { vendorDir: string | null; by: PluginRuntimeDiagnostics["loaded"]["vendorResolvedBy"] } {
  if (!serverDir) return { vendorDir: null, by: "unavailable" };
  const candidate = join(serverDir, "vendor");
  try {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return { vendorDir: resolve(candidate), by: "vendor-child-of-server-dir" };
  } catch {
    // fall through to unavailable
  }
  return { vendorDir: null, by: "unavailable" };
}

/**
 * Prove the release this plugin code came from, from this context only.
 *
 * The plugin server directory is inside the release snapshot (`<release>/plugin/server`), so the release
 * root is two levels up from it. This is a path resolution of what was actually loaded, not a read of the
 * `active` symlink: a symlink names what the service points at, which is exactly the claim that needs
 * independent evidence rather than restatement.
 */
function bindRelease(serverDir: string | null): PluginRuntimeView["binding"] {
  if (!serverDir) return { kind: "unavailable", path: null, reason: "plugin server directory could not be resolved in this context" };
  // <release>/plugin/server -> <release>
  const candidate = resolve(serverDir, "..", "..");
  try {
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
      return { kind: "unavailable", path: null, reason: "resolved release root is not a directory" };
    }
    // A release snapshot carries the repo's own manifest files; their presence is what makes the resolved
    // root a release rather than a coincidentally-named directory.
    const marker = ["package.json", "src", "plugin"].find(name => existsSync(join(candidate, name)));
    if (!marker) return { kind: "unavailable", path: null, reason: "resolved root carries no release manifest" };
    return { kind: "plugin-server-dir", path: candidate };
  } catch (error) {
    return { kind: "unavailable", path: null, reason: `release root could not be inspected: ${(error as Error).name}` };
  }
}

/**
 * The company modules whose content proves which build is running.
 *
 * The list is deliberately short and stable: these are the files whose behaviour the diagnostic is meant to
 * attest, and a short list keeps the answer inside the channel's reply budget. The digests are computed from
 * the bytes actually read, so a stale or hand-edited file shows up as a mismatch rather than as a claim.
 *
 * The list is the same whatever the context: a file that cannot be read is reported as a gap. Dropping it
 * instead would let a reader take a short list for agreement, when it may only mean the tree was not there.
 *
 * The plugin's own files are looked up as `.ts` (what a release snapshot ships) and as `.cjs` (what an
 * esbuild bundle would leave beside itself), and the one that exists is reported. Guessing a single
 * extension would make two entries permanent gaps in every release, which reads as a broken sample.
 */
function bindModules(vendorDir: string | null, serverDir: string | null): RuntimeModule[] {
  const vendored: readonly (readonly [string, string | null])[] = [
    ["core", vendorDir ? join(vendorDir, "src", "core.ts") : null],
    ["contracts", vendorDir ? join(vendorDir, "src", "contracts.ts") : null],
    ["faults", vendorDir ? join(vendorDir, "src", "faults.ts") : null],
    ["ops-broker", vendorDir ? join(vendorDir, "src", "ops", "broker.ts") : null],
    ["ops-idp", vendorDir ? join(vendorDir, "src", "ops", "idp.ts") : null],
  ];
  const pluginOwned: readonly (readonly [string, readonly string[]])[] = [
    ["plugin-sidecar", serverDir ? [join(serverDir, "sidecar.ts"), join(serverDir, "sidecar.cjs")] : []],
    ["plugin-runtime-diagnostics", serverDir ? [join(serverDir, "runtime-diagnostics.ts"), join(serverDir, "runtime-diagnostics.cjs")] : []],
  ];
  const owned = pluginOwned.map(([name, candidates]) => [name, candidates.find(path => existsSync(path)) ?? null] as const);
  return [...vendored, ...owned].map(([name, path]) => readModule(name, path));
}

/**
 * Sample what this plugin process is actually running.
 *
 * `clock` is injectable so a test can pin the timestamp without touching the real process. Everything else is
 * read from the live program.
 */
export function collectPluginRuntimeDiagnostics(options: {
  clock?: () => Date;
  moduleDir?: string;
} = {}): PluginRuntimeDiagnostics {
  const clock = options.clock ?? (() => new Date());
  // A test may name the directory this module would occupy; otherwise the module's own location is used.
  const serverDir = options.moduleDir ?? moduleDirOfThisFile();
  const { vendorDir, by } = resolveVendorDir(serverDir);
  return {
    context: "plugin-host",
    collectedAt: clock().toISOString(),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      execPath: process.execPath,
      bunShim: typeof (globalThis as { Bun?: unknown }).Bun !== "undefined",
    },
    loaded: {
      selfPath: selfPath(serverDir),
      serverDir,
      vendorDir,
      vendorResolvedBy: by,
    },
    binding: bindRelease(serverDir),
    modules: bindModules(vendorDir, serverDir),
    // Recorded so a reader can see the diagnostic stayed inside its remit. None of these are read.
    notRead: [
      "private/ (service credentials)",
      "active symlink (names a target, not a loaded module)",
      "MCP face tree (release/src, a different execution context)",
      "process environment values",
    ],
  };
}

/** Resolve the release root a plugin server directory belongs to, or null when it is not inside one. */
export function releaseRootOf(serverDir: string): string | null {
  const binding = bindRelease(serverDir);
  return binding.kind === "plugin-server-dir" ? binding.path : null;
}
