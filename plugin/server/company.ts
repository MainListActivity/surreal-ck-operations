// Lazily boots the company stack inside the plugin's Node subprocess.
// Repo modules live under server/vendor (copied by scripts/vendor.sh at install/update).
import { installBunShim } from "./bun-shim";
import { loadServiceEnv } from "./env";
import { spawn } from "node:child_process";

export interface Company {
  db: import("./vendor/src/database").CompanyDatabase;
  owner: import("./vendor/src/owner").OwnerDesk;
  workforce: import("./vendor/src/workforce").Workforce;
  dispatcher: import("./vendor/src/dispatcher/dispatcher").Dispatcher;
}

let boot: Promise<Company> | undefined;

const notify = async (title: string, text: string) => {
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 240);
  const child = spawn("/usr/bin/osascript", ["-e", `display notification "${esc(text)}" with title "${esc(title)}"`],
    { stdio: "ignore" });
  await new Promise<void>(resolve => child.once("close", () => resolve()));
};

export function company(): Promise<Company> {
  boot ??= (async () => {
    installBunShim();
    loadServiceEnv();
    const { loadDatabaseConfig } = await import("./vendor/src/config.ts");
    const { CompanyDatabase } = await import("./vendor/src/database.ts");
    const { OwnerDesk } = await import("./vendor/src/owner.ts");
    const { Workforce } = await import("./vendor/src/workforce.ts");
    const { Dispatcher } = await import("./vendor/src/dispatcher/dispatcher.ts");
    const { createPaseoCli } = await import("./vendor/src/dispatcher/paseo.ts");
    const { createGitCli } = await import("./vendor/src/dispatcher/worktrees.ts");
    const { jevFromEnv } = await import("./vendor/src/dispatcher/jev.ts");

    const db = new CompanyDatabase(loadDatabaseConfig());
    await db.connect();
    await db.useDatabase(); // schema is owned by the launchd MCP service; we only query.
    const workforce = new Workforce(db, process.env.SCK_CREDENTIAL_DIR ?? `${process.env.HOME}/Library/Application Support/SurrealCKCompany/private/credentials`);
    const owner = new OwnerDesk(db);
    const dispatcher = new Dispatcher({
      workforce,
      owner,
      paseo: createPaseoCli(),
      env: {
        opsRepo: process.env.SCK_AGENT_CWD ?? "/Users/y/IdeaProjects/surreal-ck-operations",
        sckBin: process.env.SCK_TOOL_BIN ?? `${process.env.HOME}/Library/Application Support/SurrealCKCompany/bin/sck`,
        paseoBin: process.env.SCK_PASEO_BIN ?? "/Applications/Paseo.app/Contents/Resources/bin/paseo",
      },
      notify: process.env.SCK_NOTIFY === "0" ? undefined : notify,
      log: message => console.log(message),
      jev: jevFromEnv(),
      git: createGitCli(),
      // Quota snapshots written by lifecycle hooks (they hold the only paseo handle).
      quota: async () => {
        const [rows] = await db.db.query<[Array<{ provider?: string; summary?: string; lowest_pct?: number; status?: string; fetched_at?: string; at?: unknown }>]>(
          `SELECT provider, summary, lowest_pct, status, fetched_at, at FROM company_meta
           WHERE string::starts_with(<string>id, 'company_meta:quota_');`);
        return (rows ?? []).map(r => ({
          provider: r.provider ?? "", summary: r.summary ?? "", lowestPct: r.lowest_pct, status: r.status,
          fetchedAt: r.fetched_at ?? String(r.at ?? ""),
        }));
      },
      // `auto:<family>` model slots resolved by hooks/tick-loop via providers.listModels.
      models: async () => {
        const [rows] = await db.db.query<[Array<{ slots?: Record<string, string> }>]>(
          `SELECT slots FROM company_meta:model_slots;`);
        return rows?.[0]?.slots ?? {};
      },
    });
    return { db, owner, workforce, dispatcher };
  })();
  boot.catch(() => { boot = undefined; }); // a failed boot must not poison later calls
  return boot;
}
