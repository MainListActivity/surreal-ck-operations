import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
/** Do not hand the company's database/ops credentials to third-party magpie provider plugins. */
export function magpieEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"].flatMap(
      (k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]]),
    ),
  );
}
/**
 * How long an employee session keeps the member that answered it. `auto` keeps it while the prompt
 * cache is worth keeping and routes afresh after that, so a member that filled up (a vendor queue
 * behind a few seats) does not hold every long-lived lease forever. magpie stores it as no field.
 */
export const GROUP_STAYS = "auto";
export interface ManagedGroup {
  id: string;
  models: string[];
}
/** Use magpie's own SaveGroup API in one short-lived loopback management process.
 * Repeated CLI invocations each boot provider plugins; an exclusively owned provider DB can make
 * that CLI's catalog incomplete, so it cannot safely validate the running gateway's model IDs.
 */
export async function saveMagpieGroups(
  cli: string,
  groups: ManagedGroup[],
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!groups.length) return;
  for (const group of groups)
    if (!/^sck-[a-z0-9.-]+$/.test(group.id) || !group.models.length)
      throw Error("invalid managed group");
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r, e) => probe.close((err) => (err ? e(err) : r())));
  const key = randomBytes(24).toString("hex");
  const child = spawn(
    cli,
    ["web", "--addr", `127.0.0.1:${port}`, "--no-open"],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...magpieEnvironment(),
        MAGPIE_WEB_KEY: key,
        MAGPIE_UPDATE_FEED: "http://127.0.0.1:1/disabled",
        MAGPIE_NOTES_FEED: "http://127.0.0.1:1/disabled",
      },
    },
  );
  // Own the temporary process group even if the plugin crashes before finally can run.
  const watchdog = child.pid
    ? spawn(
        process.execPath,
        [
          "-e",
          `const p=Number(process.argv[1]),g=Number(process.argv[2]);setInterval(()=>{try{process.kill(p,0)}catch{try{process.kill(-g,'SIGKILL')}catch{}process.exit(0)}try{process.kill(g,0)}catch{process.exit(0)}},500);`,
          String(process.pid),
          String(child.pid),
        ],
        { detached: true, stdio: "ignore", env: magpieEnvironment() },
      )
    : undefined;
  let spawnError = false;
  child.once("error", () => {
    spawnError = true;
  });
  const base = `http://127.0.0.1:${port}`,
    headers = {
      "content-type": "application/json",
      cookie: `magpie_web_${port}=${key}`,
    };
  try {
    let ready = false;
    for (let i = 0; i < 150 && !spawnError && child.exitCode === null; i++) {
      try {
        const r = await fetch(base + "/", {
          headers,
          signal: AbortSignal.timeout(500),
        });
        await r.body?.cancel();
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) throw Error("magpie management page did not become ready");
    for (const group of groups) {
      if (!isCurrent()) return;
      const r = await fetch(base + "/api/groups/save", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: group.id,
          name: group.id,
          members: group.models,
          routing: "order",
          affinity: GROUP_STAYS,
        }),
        signal: AbortSignal.timeout(45000),
      });
      await r.body?.cancel();
      if (!r.ok) throw Error(`magpie group update failed: HTTP ${r.status}`);
    }
  } finally {
    watchdog?.kill();
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
}
