/** Test children get private process groups; never signal the invoking shell's group. */
export function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}
export async function stopGroups(pids: readonly number[], graceMs = 800): Promise<void> {
  const owned = pids.filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
  for (const pid of owned) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
  const until = Date.now() + graceMs;
  while (Date.now() < until && owned.some(groupAlive)) await Bun.sleep(25);
  for (const pid of owned) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
}
