import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { type Surreal } from "surrealdb";
import {
  classify,
  digest,
  rank,
  type CatalogModel,
  type Domain,
  type Tier,
} from "./policy.ts";
import { createPaseoCli } from "../dispatcher/paseo.ts";
import { saveMagpieGroups, magpieEnvironment } from "./magpie-admin.ts";
import { readModelResults } from "./store.ts";
const exec = promisify(execFile);
/** magpie names a plugin installed from a path by that absolute path, not by its file stem. */
export const selectorPath = (home: string) =>
  join(home, "model-routing", "sck-performance.gateway.js");
export interface RoutingConfig {
  enabled?: boolean;
  disabledModels?: string[];
  tierOverrides?: Record<string, Tier>;
}
export class ModelRoutingController {
  enabled = false;
  private updated = 0;
  private sessionsChecked = 0;
  private pending?: Promise<void>;
  constructor(
    private readonly db: Surreal,
    private readonly home: string,
    private readonly sourcePath: string,
    private readonly cli = "/Applications/magpie.app/Contents/MacOS/magpie",
    private readonly io: {
      fetch?: typeof fetch;
      command?: (args: string[]) => Promise<void>;
    } = {},
  ) {
    try {
      this.enabled =
        JSON.parse(
          readFileSync(join(home, "model-routing", "activation.json"), "utf8"),
        ).enabled === true;
    } catch {}
  }
  private async command(args: string[]) {
    if (this.io.command) return this.io.command(args);
    try {
      await exec(this.cli, args, {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        env: magpieEnvironment(),
      });
    } catch (error) {
      const why = String((error as { stderr?: string }).stderr ?? "")
        .trim()
        .split("\n")
        .pop()
        ?.slice(0, 200);
      throw Error(
        `magpie management command failed: ${args.slice(0, 2).join(" ")}${why ? `: ${why}` : ""}`,
      );
    }
  }
  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.updated < 300000) return Promise.resolve();
    this.pending = this.sync().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  /** Existing busy sessions finish normally; only idle, unleased Claude sessions reopen on the gateway. */
  async activateIdle(): Promise<void> {
    if (!this.enabled || Date.now() - this.sessionsChecked < 30000) return;
    this.sessionsChecked = Date.now();
    const [rows] = await this.db.query<
      [Array<{ paseo_agent_id: string; workspace_cwd?: string }>]
    >(
      "SELECT paseo_agent_id,workspace_cwd FROM employee WHERE provider='claude' AND retired!=true AND revoked!=true AND paseo_agent_id!=NONE AND active_task=NONE LIMIT 100;",
    );
    const paseo = createPaseoCli(undefined, { timeoutMs: 5000 });
    const pending = rows
      .filter(
        (row) =>
          row.workspace_cwd &&
          !existsSync(join(row.workspace_cwd, ".sck-model-router")),
      )
      .slice(0, 3);
    for (const row of pending) {
      const status = await paseo
        .status(row.paseo_agent_id)
        .catch(() => undefined);
      if (status?.status === "idle" && status.pendingPermissions === 0)
        await paseo.reload(row.paseo_agent_id);
    }
  }
  async prepare(): Promise<void> {
    await this.sync(true);
  }
  private async sync(preparing = false) {
    const [config] = await this.db.query<[RoutingConfig | undefined]>(
      "SELECT enabled,disabledModels,tierOverrides FROM ONLY company_meta:model_routing;",
    );
    this.enabled = preparing || config?.enabled === true;
    if (!this.enabled) {
      this.updated = Date.now();
      return;
    }
    const reply = await (this.io.fetch ?? fetch)(
      "http://127.0.0.1:3425/v1/models",
      { signal: AbortSignal.timeout(10000) },
    );
    if (!reply.ok) throw Error(`magpie catalog unavailable: ${reply.status}`);
    const catalog = (await reply.json()) as { data: CatalogModel[] };
    const models = classify(catalog.data).filter(
      (m) => !config?.disabledModels?.includes(m.id),
    );
    for (const m of models)
      if (config?.tierOverrides?.[m.id]) m.tier = config.tierOverrides[m.id]!;
    if (!models.length) throw Error("no usable magpie models");
    const results = await readModelResults(this.db);
    const dir = join(this.home, "model-routing");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let previous: Record<string, string> = {};
    try {
      previous = JSON.parse(await readFile(join(dir, "groups.json"), "utf8"));
    } catch {}
    const groups: Record<string, string> = {};
    const routes: Record<
      string,
      Array<{ model: string; group: string; score: number; samples: number }>
    > = {};
    const groupsToSet: Array<{
      id: string;
      models: string[];
      signature: string;
    }> = [];
    const add = (id: string, members: string[]) => {
      const signature = digest(JSON.stringify(members));
      groups[id] = signature;
      if (previous[id] !== signature)
        groupsToSet.push({ id, models: members, signature });
    };
    const tiers: Tier[] = ["high", "medium", "low"];
    for (const [level, tier] of tiers.entries()) {
      // An empty tier borrows the next stronger one: an upgrade, never a silent downgrade.
      const bucket =
        tiers
          .slice(0, level + 1)
          .reverse()
          .map((t) => models.filter((m) => m.tier === t))
          .find((b) => b.length) ?? [];
      if (!bucket.length)
        throw Error(`magpie tier ${tier} has no models or stronger fallback`);
      add(
        `sck-${tier}`,
        rank(bucket, results, "general").map((m) => m.id),
      );
      for (const domain of ["engineering", "writing", "general"] as Domain[]) {
        const ordered = rank(bucket, results, domain);
        const alias = `group/sck-${domain}-${tier}`;
        routes[alias] = [];
        add(
          alias.slice(6),
          ordered.map((m) => m.id),
        );
        // Two complete fallback plans per domain/tier keep the GUI and model catalog bounded.
        // The exploration head rotates every refresh; every candidate remains in each plan's fallbacks.
        const round = Math.floor(Date.now() / 300000);
        const selected =
          ordered.length > 1
            ? [ordered[0]!, ordered[1 + (round % (ordered.length - 1))]!]
            : [ordered[0]!];
        for (const [choice, first] of selected.entries()) {
          const id = `sck-route-${tier}-${domain}-${choice === 0 ? "best" : "explore"}`;
          add(id, [
            first.id,
            ...ordered.filter((m) => m.id !== first.id).map((m) => m.id),
          ]);
          routes[alias]!.push({
            model: first.id,
            group: `group/${id}`,
            score: first.score,
            samples: first.samples,
          });
        }
      }
    }
    for (const tier of tiers)
      routes[`group/sck-${tier}`] = routes[`group/sck-general-${tier}`]!;
    // Only private sck-* groups are touched; existing user groups/providers/accounts are never rewritten.
    if (this.io.command) {
      for (const g of groupsToSet)
        await this.command([
          "group",
          "add",
          g.id,
          `models=${g.models.join(",")}`,
          "routing=order",
          "stays=session",
        ]);
    } else await saveMagpieGroups(this.cli, groupsToSet);

    const selector = selectorPath(this.home);
    const source = await readFile(this.sourcePath, "utf8");
    let old = "";
    try {
      old = await readFile(selector, "utf8");
    } catch {}
    if (old !== source) {
      await writeFile(`${selector}.tmp`, source, { mode: 0o600 });
      await rename(`${selector}.tmp`, selector);
    }
    // Installation is idempotent by path in magpie's registry; options follow only after all groups exist.
    if (previous.__selector !== digest(source))
      await this.command(["plugin", "add", selector]);
    const options = { routes };
    const optionsHash = digest(JSON.stringify(options));
    if (previous.__options !== optionsHash)
      await this.command([
        "plugin",
        "options",
        selector,
        JSON.stringify(options),
      ]);
    groups.__selector = digest(source);
    groups.__options = optionsHash;
    await writeFile(join(dir, "groups.json.tmp"), JSON.stringify(groups), {
      mode: 0o600,
    });
    await rename(join(dir, "groups.json.tmp"), join(dir, "groups.json"));
    await this.db.query(
      "UPSERT company_meta:model_routing_status CONTENT {at:time::now(),catalog:$models,routes:$routes,groups:$groups,source:$source,enabled:$enabled};",
      {
        models,
        routes,
        groups: Object.keys(groups).filter((k) => !k.startsWith("__")),
        source: "https://artificialanalysis.ai/leaderboards/models",
        enabled: !preparing,
      },
    );
    if (!preparing) {
      await writeFile(
        join(dir, "activation.json.tmp"),
        JSON.stringify({ enabled: true }),
        { mode: 0o600 },
      );
      await rename(
        join(dir, "activation.json.tmp"),
        join(dir, "activation.json"),
      );
    }
    this.updated = Date.now();
  }
}
