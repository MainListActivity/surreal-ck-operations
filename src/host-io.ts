// The execution host: everything the core needs from the machine it runs on (files, paths, the home directory, external
// programs, the keychain, the drill runner, password hashing, request-scoped storage). Core modules reach the machine only
// through this interface, so the core's import graph contains no node built-in (scripts/worker-compat-check.ts enforces it).
// host-node.ts is the node implementation; each process that runs the core installs one at its entry. A process without a
// host gets CompanyError('unavailable') from hostIO() for any operation that needs one.
import { CompanyError } from './core-errors.ts';
import type { DrillHost } from './deploy-drill-runner.ts';
import type { DrillHostContext, DrillPlan } from './deploy-drill.ts';
import type { DrillState } from './deploy-drill-service.ts';

export interface HostPath {
  readonly sep: string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  resolve(...parts: string[]): string;
  isAbsolute(path: string): boolean;
}

export interface HostStat {
  readonly size: number;
  readonly mtimeMs: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface HostFs {
  exists(path: string): boolean;
  /** Throws when the path does not exist. */
  realpath(path: string): string;
  realpathAsync(path: string): Promise<string>;
  /** UTF-8 text; throws when the file does not exist. */
  readText(path: string): string;
  readTextAsync(path: string): Promise<string>;
  /** Every entry below a directory, recursively, as paths relative to it. */
  readdirTree(path: string): string[];
  readdirAsync(path: string): Promise<string[]>;
  lstatAsync(path: string): Promise<HostStat>;
  /** Writes the file, replacing any previous content; `mode` applies when the file is created. */
  writeText(path: string, text: string, mode: number): void;
  /** Creates a new file with `mode`; throws when the file already exists. */
  createText(path: string, text: string, mode: number): void;
  mkdirp(path: string, mode: number): void;
  chmod(path: string, mode: number): void;
  /** A fresh directory under the system temporary directory, named from `prefix`. */
  mkdtemp(prefix: string): string;
  /** Removes a file or a directory tree; a missing path is not an error. */
  removeTree(path: string): void;
  removeTreeAsync(path: string): Promise<void>;
}

export interface HostProcOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** The program is killed after this many milliseconds; its result then carries `code: null`. */
  timeoutMs?: number;
  /** Output above this many bytes on either stream kills the program; its result then carries `code: null`. */
  maxBytes?: number;
}

export interface HostProcResult {
  /** The exit code, or null when the program was killed (timeout, output limit, signal). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HostProc {
  /**
   * Runs a program directly (no shell) and collects its output. Resolves once it exits, whatever the code; rejects only when
   * the program cannot be started. Callers decide what a non-zero code means.
   */
  run(file: string, args: readonly string[], options?: HostProcOptions): Promise<HostProcResult>;
}

export interface HostKeychain {
  /** The stored value of a generic password in the login keychain; throws when it is absent. */
  read(service: string, account: string): string;
  /** Stores a generic password in the login keychain, replacing any previous value. */
  write(service: string, account: string, value: string): void;
}

export interface HostLock {
  /** Runs `action` while holding the repository's allocation lock (a kernel flock, released when the holder exits). */
  withRepoLock<T>(commonDir: string, action: () => Promise<T>): Promise<T>;
}

export interface HostPassword {
  /** An argon2id hash of a secret, in the format Bun.password verifies. */
  hash(secret: string): Promise<string>;
}

export interface HostDrill {
  host(serviceHome: string, repo: string): DrillHost & { ctx: DrillHostContext };
  start(serviceHome: string, repo: string, plan: DrillPlan): number;
  status(serviceHome: string, runId: string): { state?: DrillState; stages?: string[] };
}

export interface HostStorage<T> {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
}

export interface HostContext {
  /** Storage that follows one asynchronous request, like AsyncLocalStorage. */
  createStorage<T>(): HostStorage<T>;
}

export interface HostIO {
  readonly path: HostPath;
  readonly fs: HostFs;
  readonly os: { homeDir(): string; tmpDir(): string };
  readonly proc: HostProc;
  readonly keychain: HostKeychain;
  readonly lock: HostLock;
  readonly password: HostPassword;
  readonly drill: HostDrill;
  readonly context: HostContext;
}

let installed: HostIO | undefined;

/** Registers this process's execution host, or clears it (`undefined`, for tests). */
export function installHost(host: HostIO | undefined): void {
  installed = host;
}

/** The execution host. Throws CompanyError('unavailable') when this process has none. */
export function hostIO(): HostIO {
  if (installed === undefined) {
    throw new CompanyError('unavailable', '该操作需要执行端（本机服务或 owner CLI）；当前运行环境没有本机宿主');
  }
  return installed;
}

/** The execution host when one is installed. For code that degrades gracefully without one. */
export function hostIOOrUndefined(): HostIO | undefined {
  return installed;
}
