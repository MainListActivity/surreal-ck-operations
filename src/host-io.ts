// The execution host: everything the core needs from the machine it runs on (files, paths, the home directory, external
// programs, the keychain, password hashing, request-scoped storage). Core modules reach the machine only
// through this interface, so the core's import graph contains no node built-in (scripts/worker-compat-check.ts enforces it).
// host-node.ts is the node implementation; each process that runs the core installs one at its entry. A process without a
// host gets CompanyError('unavailable') from hostIO() for any operation that needs one.
import { CompanyError } from './core-errors.ts';

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

/** How one attempt at the repository allocation lock ended. */
export type RepoLockResult = 'ok' | 'error' | 'busy' | 'unavailable' | 'lost';

/** The host's timing of one attempt at the repository allocation lock. Measured by the host, never inferred by the caller. */
export interface RepoLockTiming {
  /** Time queued before the lock was taken, or before the attempt gave up (ms). */
  waitMs: number;
  /** Time the lock was held, from acquisition to release (ms). Undefined when the lock was never taken. */
  heldMs?: number;
  /** ok: the action completed. error: the action threw. busy: not taken in time. unavailable: the lock helper could not run.
   * lost: the helper ended while the lock was supposed to be held. */
  result: RepoLockResult;
}

export interface RepoLockOptions {
  /** How long to wait for the lock before giving up with RepoLockError 'busy'. Defaults to the host's limit. */
  acquireMs?: number;
  /** Receives the timing once the attempt is over and the lock is released. Observation only: it never changes the outcome. */
  observe?: (timing: RepoLockTiming) => void;
}

export interface HostLock {
  /**
   * Runs `action` while holding the repository's allocation lock (a kernel flock, released when the holder exits). Throws
   * RepoLockError when the lock is not taken; an action that has started is never interrupted.
   */
  withRepoLock<T>(commonDir: string, action: () => Promise<T>, options?: RepoLockOptions): Promise<T>;
}

export interface HostPassword {
  /** An argon2id hash of a secret, in the format Bun.password verifies. */
  hash(secret: string): Promise<string>;
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
