// Lazily boots the company stack inside the plugin's Node subprocess.
// Repo modules live under server/vendor (copied by scripts/vendor.sh at install/update).
import { installBunShim } from "./bun-shim";
import { loadServiceEnv, serviceHome } from "./env";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { readProviderQuotas } from "./dispatch";

export interface Company {
  db: import("./vendor/src/database").CompanyDatabase;
  owner: import("./vendor/src/owner").OwnerDesk;
  workforce: import("./vendor/src/workforce").Workforce;
  dispatcher: import("./vendor/src/dispatcher/dispatcher").Dispatcher;
  core: import("./vendor/src/contracts").CompanyCore;
  sidecar: import("./sidecar").SidecarPool;
  /** Agent home repo — the default project staffing pools are scoped to. */
  opsRepo: string;
  ops: import("./vendor/src/ops/broker").OpsBroker;
}

let boot: Promise<Company> | undefined;

const notify = async (title: string, text: string) => {
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 240);
  const child = spawn("/usr/bin/osascript", ["-e", `display notification "${esc(text)}" with title "${esc(title)}"`],
    { stdio: "ignore" });
  await new Promise<void>(resolve => child.once("close", () => resolve()));
  // Optional phone push: any relay that accepts a JSON POST (Bark: title/body, Gotify: title/message). The URL carries the secret and lives in the private service env.
  const hook = process.env.SCK_NOTIFY_WEBHOOK;
  if (hook) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
      body: JSON.stringify({ title, body: text.slice(0, 1500), message: text.slice(0, 1500), text: text.slice(0, 1500) }) }).catch(() => undefined);
    clearTimeout(timer);
  }
};

export function company(): Promise<Company> {
  boot ??= (async () => {
    installBunShim();
    loadServiceEnv();
    const { loadDatabaseConfig } = await import("./vendor/src/config.ts");
    const { CompanyDatabase } = await import("./vendor/src/database.ts");
    const { OwnerDesk } = await import("./vendor/src/owner.ts");
    const { Workforce } = await import("./vendor/src/workforce.ts");
    const { SurrealCompanyCore } = await import("./vendor/src/core.ts");
    const { ProjectStore, loadSecretKey } = await import("./vendor/src/projects.ts");
    const { CompanyProofStore } = await import("./vendor/src/ops/proof-store.ts");
    const { OpsBroker } = await import("./vendor/src/ops/broker.ts");
    const { SidecarPool } = await import("./sidecar.ts");
    const { MediaStudio } = await import("./vendor/src/media/elevenlabs.ts");
    const { SyncStudio } = await import("./vendor/src/media/sync.ts");
    const { VaultClient } = await import("./vendor/src/media/vault.ts");
    const { Dispatcher } = await import("./vendor/src/dispatcher/dispatcher.ts");
    const { createPaseoCli, createSceneCleaner } = await import("./vendor/src/dispatcher/paseo.ts");
    const { jevFromEnv } = await import("./vendor/src/dispatcher/jev.ts");

    const db = new CompanyDatabase(loadDatabaseConfig());
    await db.connect();
    await db.useDatabase(); // schema is owned by the launchd MCP service; we only query.
    const workforce = new Workforce(db, process.env.SCK_CREDENTIAL_DIR ?? `${process.env.HOME}/Library/Application Support/SurrealCKCompany/private/credentials`);
    const owner = new OwnerDesk(db);
    // Workforce also powers the manage-only def_* tools exposed through the sidecar.
    const paseo = createPaseoCli();
    const worktreeOpts = {
      opsRepo: process.env.SCK_AGENT_CWD ?? '/Users/y/IdeaProjects/surreal-ck-operations',
      // Three-layer same-death: a task worktree's Paseo workspaces/project die with the tree.
      // Employee agents inside those workspaces are retired with an honest reason first —
      // otherwise the workspace cascade archives them and the tick misreports 通道隔离.
      sceneCleaner: createSceneCleaner(paseo, {
        insts: () => workforce.insts(),
        retire: (id, reason, kind) => workforce.retire(id, reason, kind),
        detach: inst => { if (inst.paseoAgentId) sidecar.detachAgent(inst.paseoAgentId); },
      }),
      orphanGraceDays: process.env.SCK_WORKTREE_ORPHAN_GRACE_DAYS
        ? Number(process.env.SCK_WORKTREE_ORPHAN_GRACE_DAYS) : undefined,
      reclaimEnabled: process.env.SCK_WORKTREE_RECLAIM === '0' || process.env.SCK_WORKTREE_RECLAIM === 'false'
        ? false
        : process.env.SCK_WORKTREE_RECLAIM === '1' || process.env.SCK_WORKTREE_RECLAIM === 'true'
          ? true : undefined,
    };
    const { createSubmitCheck } = await import("./vendor/src/pr-gate.ts");
    const core = new SurrealCompanyCore(db, { workforce, worktrees: worktreeOpts, submitCheck: process.env.SCK_PR_GATE === "0" ? undefined : createSubmitCheck() });
    // Sealed credentials, login tokens and the Cloudflare token live only in this process; agents
    // reach them through the sidecar relay as named, audited, lease-gated operations.
    const ops = new OpsBroker({
      core, projects: new ProjectStore(db.db), secretKey: loadSecretKey, proofStore: new CompanyProofStore(db.db),
      log: message => console.log(message),
    });
    const runDir = process.env.SCK_COMM_ROOT ?? `${process.env.HOME}/Library/Application Support/SurrealCKCompany/comm`;
    // Provider keys live only in sck-vault (its own process, Keychain-bound); this side never sees them.
    const vault = new VaultClient(join(serviceHome(), "vault", "vault.sock"));
    const media = new MediaStudio({
      core, vault, evidenceRoot: join(dirname(runDir), "evidence"),
    });
    // sync-3 video channel: same vault boundary, plus owner approval artifacts under private/sync/.
    const sync = new SyncStudio({
      core, vault, evidenceRoot: join(dirname(runDir), "evidence"), serviceHome: serviceHome(),
    });
    // Browser-session generation (ChatGPT/Gemini/Grok web UIs): ego-browser drives the owner's
    // logged-in accounts; sessions and any account secrets stay inside that browser profile.
    const { BrowserStudio } = await import("./vendor/src/media/browser.ts");
    const browser = new BrowserStudio({ core, evidenceRoot: join(dirname(runDir), "evidence"),
      // Gemini write lane: default composer model, owner-tunable via admin config.
      notebookModel: async () => {
        const [rows] = await db.db.query<[Array<{ media_notebook_model?: string }>]>(
          `SELECT media_notebook_model FROM company_meta:config;`);
        return rows?.[0]?.media_notebook_model;
      } });
    const { hostResources } = await import("./vendor/src/dispatcher/host.ts");
    const { ArtifactReclaimer, dbArtifactTasks } = await import("./vendor/src/dispatcher/artifact-sweeper.ts");
    // Terminal-task artifact lifecycle (evidence/deliverables). Reclaimed against the same
    // company_meta:config the operator edits, and stopped by SCK_ARTIFACT_RECLAIM=0.
    const reclaimer = new ArtifactReclaimer({
      home: serviceHome(),
      tasks: dbArtifactTasks(db.db),
      config: async () => {
        const cfg = await workforce.config();
        return {
          artifactReclaimEnabled: cfg.artifactReclaimEnabled,
          artifactEvidenceGraceDays: cfg.artifactEvidenceGraceDays,
          artifactDeliverableGraceDays: cfg.artifactDeliverableGraceDays,
          artifactHeadroomMb: cfg.artifactHeadroomMb,
          minFreeDiskMb: cfg.minFreeDiskMb,
        };
      },
      freeDiskMb: () => hostResources(serviceHome()).freeDiskMb,
      env: process.env,
      log: message => console.log(message),
    });
    const sidecar = new SidecarPool({
      core, workforce, ops, media, browser, sync,
      runDir,
      log: message => console.log(message),
    });
    const opsRepo = process.env.SCK_AGENT_CWD ?? "/Users/y/IdeaProjects/surreal-ck-operations";
    const dispatcher = new Dispatcher({
      workforce,
      owner,
      paseo,
      env: {
        opsRepo,
        sckBin: process.env.SCK_TOOL_BIN ?? `${process.env.HOME}/Library/Application Support/SurrealCKCompany/bin/sck`,
        paseoBin: process.env.SCK_PASEO_BIN ?? "/Applications/Paseo.app/Contents/Resources/bin/paseo",
      },
      notify: process.env.SCK_NOTIFY === "0" ? undefined : notify,
      log: message => console.log(message),
      jev: jevFromEnv(),
      // Host resource admission: free-memory/disk floors pause dispatch on the owner's
      // machine; supervision still runs so stalled leases keep getting reclaimed.
      hostResources: () => hostResources(serviceHome()),
      // Terminal-task artifact lifecycle: the free-disk gate reclaims evidence/deliverables
      // before it gives up, so a full disk stops halting dispatch instead of silently wedging it.
      reclaimArtifacts: (input) => reclaimer.reclaim({
        trigger: input?.trigger ?? 'sweep', targetFreeMb: input?.targetFreeMb,
        dryRun: input?.dryRun, taskId: input?.taskId, emergency: input?.emergency,
      }),
      // WT02: bare call = 10-minute sweep (crash-orphan fallback); treeId+repo = event point.
      reclaimWorktrees: (input) => core.worktrees!.reclaimAll({
        trigger: input?.trigger ?? 'sweep', treeId: input?.treeId,
        repos: input?.repo ? [input.repo] : undefined }),
      sidecar,
      // Quota snapshots written by lifecycle hooks (they hold the only paseo handle).
      quota: () => readProviderQuotas({ db }),
      // `auto:<family>` model slots resolved by hooks/tick-loop via providers.listModels.
      models: async () => {
        const [rows] = await db.db.query<[Array<{ slots?: Record<string, string> }>]>(
          `SELECT slots FROM company_meta:model_slots;`);
        return rows?.[0]?.slots ?? {};
      },
    });
    // Rebuild agent↔instance bindings and live leases after a plugin restart.
    await sidecar.adopt(await workforce.insts());
    return { db, owner, workforce, dispatcher, core, sidecar, opsRepo, ops };
  })();
  boot.catch(() => { boot = undefined; }); // a failed boot must not poison later calls
  return boot;
}
