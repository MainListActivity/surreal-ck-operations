// The node implementation of the execution host (host-io.ts). The entry of each process that runs the core installs it
// (installNodeHost); the core modules themselves never import this file.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { CompanyError } from './core-errors.ts';
import { hostIOOrUndefined, installHost, type HostIO, type HostProcOptions, type HostProcResult } from './host-io.ts';

/** Runs a program without a shell; output is collected per stream, and the program is killed at the timeout or past the byte limit. */
function runProcess(file: string, args: readonly string[], options: HostProcOptions = {}): Promise<HostProcResult> {
  return new Promise((done, fail) => {
    const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      chunks[stream].push(chunk);
      sizes[stream] += chunk.length;
      if (options.maxBytes !== undefined && sizes[stream] > options.maxBytes) child.kill('SIGKILL');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('close', code => {
      clearTimeout(timer);
      done({ code, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    });
  });
}

/** Kernel flock spans every plugin process and is released on crash/EOF, with no stale lease timeout.
 * The helper reads only its lock file. Its stdin is closed even when the caller dies.
 */
async function withRepoLock<T>(commonDir: string, action: () => Promise<T>): Promise<T> {
  const helper = spawn('/usr/bin/python3', ['-c',
    'import fcntl,sys; f=open(sys.argv[1], "a"); fcntl.flock(f, fcntl.LOCK_EX); print("locked", flush=True); sys.stdin.buffer.read()',
    join(commonDir, 'sck-worktree-allocation.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  const closed = new Promise<void>(done => helper.once('close', () => { exited = true; done(); }));
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { helper.kill(); reject(new CompanyError('conflict', 'Repository allocation lock busy')); }, 35_000);
      helper.once('error', error => { clearTimeout(timer); reject(error); });
      helper.once('close', () => { clearTimeout(timer); reject(new CompanyError('conflict', 'Repository allocation lock unavailable')); });
      helper.stdout.once('data', () => { clearTimeout(timer); done(); });
    });
    if (exited) throw new CompanyError('conflict', 'Repository allocation lock lost');
    return await action();
  } finally { helper.stdin.end(); await closed; }
}

const nodeHost: HostIO = {
  path: {
    sep,
    join: (...parts) => join(...parts),
    dirname,
    basename,
    resolve: (...parts) => resolve(...parts),
    isAbsolute,
  },
  fs: {
    exists: path => existsSync(path),
    realpath: path => realpathSync(path),
    realpathAsync: path => realpath(path),
    readText: path => readFileSync(path, 'utf8'),
    readTextAsync: path => readFile(path, 'utf8'),
    readdirTree: path => readdirSync(path, { recursive: true }) as string[],
    readdirAsync: path => readdir(path),
    lstatAsync: path => lstat(path),
    writeText: (path, text, mode) => { writeFileSync(path, text, { mode }); },
    createText: (path, text, mode) => {
      const fd = openSync(path, 'wx', mode);
      try { writeSync(fd, text); } finally { closeSync(fd); }
    },
    mkdirp: (path, mode) => { mkdirSync(path, { recursive: true, mode }); },
    chmod: (path, mode) => { chmodSync(path, mode); },
    mkdtemp: prefix => mkdtempSync(join(tmpdir(), prefix)),
    removeTree: path => { rmSync(path, { recursive: true, force: true }); },
    removeTreeAsync: path => rm(path, { recursive: true, force: true }),
  },
  os: {
    homeDir: () => homedir(),
    tmpDir: () => tmpdir(),
  },
  proc: {
    run: runProcess,
  },
  keychain: {
    read: (service, account) => execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    write: (service, account, value) => {
      execFileSync('security', ['add-generic-password', '-s', service, '-a', account, '-w', value, '-U'], { stdio: 'ignore' });
    },
  },
  lock: {
    withRepoLock,
  },
  password: {
    hash: secret => Bun.password.hash(secret, { algorithm: 'argon2id' }),
  },
  context: {
    createStorage<T>() {
      const storage = new AsyncLocalStorage<T>();
      return {
        run<R>(store: T, fn: () => R): R { return storage.run(store, fn); },
        getStore: () => storage.getStore(),
      };
    },
  },
};

/** Installs the node execution host in this process, unless a host is already installed. */
export function installNodeHost(): void {
  if (hostIOOrUndefined() === undefined) installHost(nodeHost);
}
