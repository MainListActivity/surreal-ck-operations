// SYS04: a read-only diagnostic of what the plugin process is ACTUALLY running.
//
// The company service has two execution contexts that both hold company code, and they are not the same
// tree: the launchd MCP face loads `release/src/*`, while the Paseo plugin `sck-company` — the one every
// employee's `sck call` reaches — loads `release/plugin/server/vendor/src/*`. A version read from the wrong
// context looks authoritative and is worthless, which is why this module never reads the MCP face's path,
// the `active` symlink, or a client-side directory: it reports what this process loaded.
//
// The Paseo host does not run the plugin module through a module loader at all: it bundles the server entry
// with esbuild to CJS, wraps that output in `(function(require){…})` and evaluates it with `globalThis.eval`.
// In that context both `__dirname` and `import.meta.url` are absent (esbuild empties `import.meta` for CJS),
// so a module's own directory cannot be derived from module globals. The directory therefore comes from the
// one place the host does publish — its own plugin registry entry (`paseo plugin ls --json`), which the
// sidecar resolves through the trusted host and passes in. That registered source tree is then content-bound
// by digest. When the host cannot supply it, the answer is `unavailable`; nothing is inferred, and nothing is
// echoed from a sibling context.
//
// Read-only by construction: it opens no socket, writes nothing, reads no private/ or credential file, and
// exposes no arbitrary file or command capability.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
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
 * The server directory inside a registered plugin source, or null when that tree has none.
 *
 * The host registers the plugin package directory (`<release>/plugin`); the server code lives in its
 * `server` child. A path that does not carry one is not a plugin source this diagnostic can bind, so it is
 * reported as unresolved instead of being guessed at.
 */
export function serverDirOfPluginSource(pluginSourceDir: string | null): string | null {
  if (!pluginSourceDir) return null;
  const candidate = join(resolve(pluginSourceDir), "server");
  try {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  } catch {
    // fall through to unresolved
  }
  return null;
}

/**
 * The path this diagnostic's source occupies in the registered plugin tree.
 *
 * A release snapshot ships `.ts`; a tree prepared by a bundler may leave `.cjs`. Whichever file is present is
 * reported, so a real tree never reads as a permanent gap. When neither is there the answer is null rather
 * than a guess.
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
 * `clock` is injectable so a test can pin the timestamp. The directories are supplied rather than derived
 * from module globals: the Paseo host evaluates a CJS bundle, where neither `__dirname` nor `import.meta.url`
 * exists, so the sidecar resolves the host's registered plugin source and passes it in. `moduleDir` remains
 * for tests and for a host that already resolved the server directory.
 */
export function collectPluginRuntimeDiagnostics(options: {
  clock?: () => Date;
  moduleDir?: string;
  pluginSourceDir?: string;
} = {}): PluginRuntimeDiagnostics {
  const clock = options.clock ?? (() => new Date());
  const explicitServerDir = options.moduleDir ? resolve(options.moduleDir) : null;
  const registeredServerDir = serverDirOfPluginSource(options.pluginSourceDir ?? null);
  const serverDir = explicitServerDir ?? registeredServerDir;
  const basis: PluginRuntimeDiagnostics["loaded"]["basis"] =
    explicitServerDir ? "module-dir" : registeredServerDir ? "registered-plugin-source" : "unavailable";
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
      basis,
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
      "in-memory bundle (the host evaluates generated CJS; only the registered source tree is read)",
    ],
  };
}

/** Resolve the release root a plugin server directory belongs to, or null when it is not inside one. */
export function releaseRootOf(serverDir: string): string | null {
  const binding = bindRelease(serverDir);
  return binding.kind === "plugin-server-dir" ? binding.path : null;
}
