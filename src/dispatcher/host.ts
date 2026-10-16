import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';

export interface HostResources { freeMemMb: number; freeDiskMb: number }

// os.freemem() counts macOS purgeable/inactive pages as used and badly
// under-reports usable memory under cache pressure; `memory_pressure`'s
// system-wide free percentage is the usable-memory signal the gate wants.
const freeMemMb = (): number => {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/bin/memory_pressure', [], { encoding: 'utf8', timeout: 5000 });
      const pct = out.match(/System-wide memory free percentage:\s*(\d+)%/);
      if (pct) return Math.round((totalmem() * Number(pct[1])) / 100 / 1048576);
    } catch { /* fall through to os.freemem */ }
  }
  return Math.round(freemem() / 1048576);
};

export const hostResources = (diskPath: string): HostResources => {
  const stat = statfsSync(diskPath);
  return { freeMemMb: freeMemMb(), freeDiskMb: Math.round((stat.bavail * stat.bsize) / 1048576) };
};
