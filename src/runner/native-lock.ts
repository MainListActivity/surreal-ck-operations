import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, openSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// A permanent inode with a kernel-owned lock. Never unlink or rename it: doing so
// would let concurrent starters lock different inodes and both become writers.
const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

export function acquireNativeWriter(path: string, host: string): () => void {
  const fd = openSync(`${path}.kernel`, 'a+', 0o600);
  try {
    if (libc.symbols.flock(fd, 2 | 4) !== 0) throw new Error('执行端写锁已占用或不可用'); // LOCK_EX | LOCK_NB
    let text: string | undefined;
    try { text = readFileSync(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Reserve the legacy name with O_EXCL before publishing v2. A concurrent old
      // binary either wins this creation (we refuse) or sees EEXIST and cannot start.
      // If killed between create/write, the empty legacy record fails closed.
      writeFileSync(path, JSON.stringify({ version: 2, pid: process.pid, host }), { mode: 0o600, flag: 'wx' });
    }
    if (text !== undefined) {
      let previous: { version?: number; pid?: number; host?: string };
      try { previous = JSON.parse(text); } catch { throw new Error('执行端旧写锁损坏，拒绝猜测接管'); }
      if (previous.host !== host) throw new Error('执行端写锁节点身份不匹配');
      if (previous.version !== 2) {
        if (!Number.isSafeInteger(previous.pid) || previous.pid! <= 0 || previous.host !== host) throw new Error('执行端旧写锁身份未知');
        // Legacy writers do not use flock. Never steal from a live or unobservable PID,
        // including PID reuse. An operator must resolve that conservative false positive.
        try { process.kill(previous.pid!, 0); throw new Error('旧执行端仍存活，拒绝接管'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    // Metadata is separate from the permanent lock inode. Atomic replacement means
    // a crash before/after publication leaves either the old complete record or new one.
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 2, pid: process.pid, host }), { mode: 0o600, flag: 'wx' });
      renameSync(temp, path);
    } finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    let released = false;
    return () => { if (!released) { released = true; closeSync(fd); } };
  } catch (error) {
    // Closing the descriptor releases only our kernel ownership, never another writer's.
    closeSync(fd);
    throw error;
  }
}
