// Lazily boots the company stack inside the plugin's Node subprocess.
// Repo modules live under server/vendor (copied by scripts/vendor.sh at install/update).
import { installBunShim } from "./bun-shim";
import { loadServiceEnv, serviceHome } from "./env";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readProviderQuotas } from "./dispatch";
import { setAgentModel } from "./vendor/src/dispatcher/agent-model.ts";
import { dispatcherLogSink } from "./vendor/src/dispatcher/log-sink.ts";
import { OutboundMessageStore } from "./vendor/src/outbound-messages.ts";
import { installNodeHost } from "./vendor/src/host-node.ts";
import { IdpClient } from "./vendor/src/cloud/idp.ts";
import { readSecretFile } from "./vendor/src/cloud/secret.ts";
import { GatewayClient } from "./vendor/src/cloud/gateway.ts";
import { AgentTokenCache } from "./vendor/src/cloud/agent-tokens.ts";
import { OpsJobRunner } from "./vendor/src/cloud/ops-jobs.ts";
import { hostExec } from "./vendor/src/cloud/host-exec.ts";
import { ensureNodeId } from "./vendor/src/node-identity.ts";
import { RELEASE } from "./release-stamp";
import { ownerApi, RUNNER_ONLY_COMMANDS } from "./vendor/src/owner-api.ts";
import type { CloudRoute } from "./sidecar";
import type { PaseoApi } from "@getpaseo/client";

export interface Company {
  /** 本执行端的节点 ID（保存在服务目录 private/node-id，首次启动时生成）。 */
  nodeId: string;
  /** 当前安装的发行版本号（打包时由 release-stamp 写入；源码检出为 "dev"）。 */
  runnerVersion: () => Promise<string>;
  db: import("./vendor/src/database").CompanyDatabase;
  owner: import("./vendor/src/owner").OwnerDesk;
  workforce: import("./vendor/src/workforce").Workforce;
  dispatcher: import("./vendor/src/dispatcher/dispatcher").Dispatcher;
  core: import("./vendor/src/contracts").CompanyCore;
  sidecar: import("./sidecar").SidecarPool;
  /** Agent home repo — the default project staffing pools are scoped to. */
  opsRepo: string;
  ops: import("./vendor/src/ops/broker").OpsBroker;
  messages: OutboundMessageStore;
  /** Absolute path of the sck CLI, as the dispatcher resolves it. */
  sckBin: string;
  /**
   * The plugin host's Paseo API handle, learned from lifecycle hooks and owner RPC contexts.
   * It is not created here (the CLI wrapper the dispatcher uses has no `agents` API); the
   * first event supplies it, so owner commands that need it error honestly before then.
   */
  paseo: PaseoApi | undefined;
  /** 云端执行端的运维作业执行器；只在云端模式（配置了 COMPANY_DB_URL）存在。 */
  opsJobs?: OpsJobRunner;
}

let paseoApi: PaseoApi | undefined;
/** Remember the latest host handle; called by dispatch hooks and the owner RPC wrapper. */
export function notePaseo(api: PaseoApi | undefined): void { if (api) paseoApi = api; }
export function currentPaseo(): PaseoApi | undefined { return paseoApi; }

let boot: Promise<Company> | undefined;
let readyCompany:Company|undefined;
/** Local read only; never starts bootstrap or waits on the company database. */
export function currentCompany(){return readyCompany;}

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
    const { egoBrowserSpaceCloser } = await import("./vendor/src/ops/browser.ts");
    const { SidecarPool } = await import("./sidecar.ts");
    const { MediaStudio } = await import("./vendor/src/media/elevenlabs.ts");
    const { SyncStudio } = await import("./vendor/src/media/sync.ts");
    const { VaultClient } = await import("./vendor/src/media/vault.ts");
    const { Dispatcher } = await import("./vendor/src/dispatcher/dispatcher.ts");
    const { createPaseoCli, createSceneCleaner } = await import("./vendor/src/dispatcher/paseo.ts");
    const { jevFromEnv } = await import("./vendor/src/dispatcher/jev.ts");

    const databaseConfig = loadDatabaseConfig();
    const cloud = databaseConfig.cloud;
    // 云端执行端就是这台机器上的插件进程：装上本机宿主，RUNNER_ONLY_COMMANDS 才能在这里执行。本机模式不变。
    if (cloud) installNodeHost();
    const nodeId = ensureNodeId(serviceHome());
    const db = new CompanyDatabase(databaseConfig);
    await db.connect();
    await db.useDatabase(); // schema is owned by the launchd MCP service; we only query.

    const workforce = new Workforce(db, process.env.SCK_CREDENTIAL_DIR ?? `${process.env.HOME}/Library/Application Support/SurrealCKCompany/private/credentials`);
    const opsRepo = process.env.SCK_AGENT_CWD ?? "/Users/y/IdeaProjects/surreal-ck-operations";
    // The ops repo lets triage bind a company-system quick goal's code legs to it (see OwnerDesk.triage).
    const owner = new OwnerDesk(db, opsRepo);
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
    const { createSystemCheck } = await import("./vendor/src/submit-checks.ts");
    // Same build-cost line as the MCP process: the plugin's sidecar serves the same paged reads, so both surfaces must be diagnosable.
    const snapshotObserve = (stats: { outcome: string; kind: string; rows: number; bytes: number; batches: number; loadMs: number; reserveMs: number; writeMs: number; commitMs: number; totalMs: number; serverMs: number; loadAttempts: number; release: string; releaseMs: number }) =>
      console.log(`snapshot build ${stats.kind} ${stats.outcome} rows=${stats.rows} bytes=${stats.bytes} batches=${stats.batches} load=${Math.round(stats.loadMs)} reserve=${Math.round(stats.reserveMs)} write=${Math.round(stats.writeMs)} commit=${Math.round(stats.commitMs)} server=${Math.round(stats.serverMs)} total=${Math.round(stats.totalMs)} reads=${stats.loadAttempts} release=${stats.release} releaseMs=${Math.round(stats.releaseMs)}`);
    const core = new SurrealCompanyCore(db, { workforce, snapshotObserve, worktrees: worktreeOpts, nodeId, submitCheck: process.env.SCK_PR_GATE === "0" ? undefined : createSubmitCheck(),
      systemCheck: process.env.SCK_SUBMIT_CHECKS === "0" ? undefined : createSystemCheck({ serviceHome: serviceHome(), home: homedir() }) });
    // Sealed credentials, login tokens and the Cloudflare token live only in this process; agents
    // reach them through the sidecar relay as named, audited, lease-gated operations.
    const ops = new OpsBroker({
      core, projects: new ProjectStore(db.db), secretKey: loadSecretKey, proofStore: new CompanyProofStore(db.db),
      // SYS05: lease-end cleanup bounded-closes the spaces this broker injected, and never a
      // user-owned space. Without this wiring every space was only counted as pending.
      closeBrowserSpace: egoBrowserSpaceCloser,
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
    // 云端：员工调用网关的令牌经执行端凭证向身份服务换发（agent token exchange），只留在进程内存（见 sidecar.ts callCloud）。
    let cloudRoute: CloudRoute | undefined;
    if (cloud) {
      if (!cloud.gatewayUrl) throw new Error("云端执行端缺少 GATEWAY_URL，无法调用公司网关");
      if (!cloud.runnerClientId) throw new Error("云端执行端缺少 RUNNER_CLIENT_ID");
      const runnerIdp = new IdpClient({
        issuer: cloud.idpIssuer, clientId: cloud.runnerClientId,
        clientSecret: () => readSecretFile(cloud.runnerClientSecretFile),
      });
      cloudRoute = {
        gateway: new GatewayClient({ url: cloud.gatewayUrl }),
        tokens: new AgentTokenCache({ exchange: input => runnerIdp.exchangeAgentToken(input) }),
        idpUserOf: async employee => {
          const [rows] = await db.db.query<[Array<{ idp_user?: string }>]>(
            "SELECT idp_user FROM agent_identity WHERE employee = $employee LIMIT 1;", { employee });
          return rows?.[0]?.idp_user;
        },
      };
    }
    const sidecar = new SidecarPool({
      core, workforce, ops, media, browser, sync,
      cloud: cloudRoute,
      runDir,
      // SYS04: the plugin host bundles the server code and evaluates it without a module loader, so the
      // diagnostic cannot read its own directory from `__dirname`/`import.meta`. The host's own registry
      // (`paseo plugin ls --json`, the same query the release receipt uses) names the registered source
      // tree, which the diagnostic then binds by content hash. Read-only; resolved only after core
      // authorises the caller.
      pluginSource: async () => {
        const rows = (await paseo.plugins?.()) ?? [];
        const row = rows.find(item => item.id === "sck-company");
        return row?.installation?.identity?.path ?? row?.path ?? null;
      },
      log: message => console.log(message),
    });
    // One sink for the dispatcher's lifetime: it opens the logs directory once and appends from then on.
    const dispatcherLog = dispatcherLogSink(serviceHome());
    const messages = new OutboundMessageStore(db.db);
    const sckBin = process.env.SCK_TOOL_BIN ?? `${process.env.HOME}/Library/Application Support/SurrealCKCompany/bin/sck`;
    const dispatcher = new Dispatcher({
      workforce,
      owner,
      messages,
      paseo,
      env: {
        opsRepo,
        sckBin,
        paseoBin: process.env.SCK_PASEO_BIN ?? "/Applications/Paseo.app/Contents/Resources/bin/paseo",
      },
      notify: process.env.SCK_NOTIFY === "0" ? undefined : notify,
      // FV06: the dispatcher log also lands in <serviceHome>/logs/dispatcher.log (ISO timestamp, append), so
      // recovery wake/skip/fail decisions are auditable from the service home instead of only inside Paseo.
      log: message => { console.log(message); dispatcherLog(message); },
      jev: jevFromEnv(),
      // Host resource admission: free-memory/disk floors pause dispatch on the owner's
      // machine; supervision still runs so stalled leases keep getting reclaimed.
      hostResources: () => hostResources(serviceHome()),
      // Model drift is realignment, not retirement: a provider may switch the model under a live
      // session (Factory falls back once its standard allowance is spent) and switch back later.
      // The daemon's MCP endpoint applies the change to the running session in place.
      realignAgent: (agentId, model) => setAgentModel(agentId, model),
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
      quota: () => readProviderQuotas(db.db),
      // `auto:<family>` model slots resolved by hooks/tick-loop via providers.listModels.
      models: async () => {
        const [rows] = await db.db.query<[Array<{ slots?: Record<string, string> }>]>(
          `SELECT slots FROM company_meta:model_slots;`);
        return rows?.[0]?.slots ?? {};
      },
    });
    // Rebuild agent↔instance bindings and live leases after a plugin restart.
    await sidecar.adopt(await workforce.insts());
    // 云端执行端的运维作业：员工身份与租约只在本进程的 sidecar 里，作业经 sidecar.runCloudOps 执行。
    // 作业的执行者（ma_hono 用户 id 或员工编号）经 agent_identity 对到员工。
    const employeeOf = async (actor: string): Promise<string> => {
      const [rows] = await db.db.query<[Array<{ employee?: string }>]>(
        "SELECT employee FROM agent_identity WHERE idp_user = $actor OR employee = $actor LIMIT 1;", { actor });
      const employee = rows?.[0]?.employee;
      if (!employee) throw Object.assign(new Error("作业的执行者没有对应的员工身份"), { code: "forbidden" });
      return employee;
    };
    const opsJobs = cloud ? new OpsJobRunner({
      db: db.db,
      runner: `plugin:${process.pid}`,
      runnerOnlyCommands: RUNNER_ONLY_COMMANDS,
      // 只认领本机持有租约的 ops_* 作业（多执行端时其余作业留给持有者）；映射失败视为不持有。
      holds: async job => {
        try { return sidecar.holdsLease(await employeeOf(job.actor), job.task); } catch { return false; }
      },
      opsCall: async job => sidecar.runCloudOps({ employee: await employeeOf(job.actor), taskId: job.task, tool: job.tool, args: job.args }),
      runnerOnly: job => ownerApi({ db, core: core as never, owner, workforce, messages, opsRepo }, { ...job.input, command: job.command }, "runner"),
      hostExec: input => hostExec(input, { keyPath: join(serviceHome(), "private", "cloud", "sck-agent-ed25519") }),
      log: message => console.log(message),
    }) : undefined;
    return readyCompany={ nodeId, runnerVersion: async () => RELEASE.version, messages, db, owner, workforce, dispatcher, core, sidecar, opsRepo, ops, sckBin, opsJobs,
      get paseo(){ return currentPaseo(); } };
  })();
  boot.catch(() => { boot = undefined; }); // a failed boot must not poison later calls
  return boot;
}
