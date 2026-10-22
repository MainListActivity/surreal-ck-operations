import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';

export interface HostResources { freeMemMb: number; freeDiskMb: number; memoryPressure?: 1 | 2 | 4 }

/** macOS's kernel pressure signal includes compression and reclaimable pages. */
export const memoryBlocked = (host: HostResources, floorMb: number): boolean => floorMb > 0 &&
  (host.memoryPressure !== undefined ? host.memoryPressure !== 1 : host.freeMemMb < floorMb);

export const hostResources = (diskPath: string, deps: {
  platform?: string; read?: (bin: string, args: string[]) => string;
} = {}): HostResources => {
  const read = deps.read ?? ((bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 1500 }));
  let freeMemMb = Math.round(freemem() / 1048576);
  let memoryPressure: HostResources['memoryPressure'];
  if ((deps.platform ?? process.platform) === 'darwin') {
    try {
      const raw = read('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim();
      if (raw === '1' || raw === '2' || raw === '4') memoryPressure = Number(raw) as 1 | 2 | 4;
    } catch { /* unsupported kernel: use the existing free-memory fallback */ }
    if (memoryPressure === undefined) {
      try {
        const pct = read('/usr/bin/memory_pressure', []).match(/System-wide memory free percentage:\s*(\d+)%/);
        if (pct && Number(pct[1]) <= 100) freeMemMb = Math.round(totalmem() * Number(pct[1]) / 100 / 1048576);
      } catch { /* os.freemem remains the portable fallback */ }
    }
  }
  const stat = statfsSync(diskPath);
  return { freeMemMb, freeDiskMb: Math.round(stat.bavail * stat.bsize / 1048576), ...(memoryPressure ? { memoryPressure } : {}) };
};
