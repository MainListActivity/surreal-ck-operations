import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
/** Successful model choice is pinned to the task lease, across policy refreshes and plugin restarts. */
export class RoutingPins {
  private rows: Record<string, { model: string; at: number }> = {};
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      this.rows = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  get(key: string): string | undefined {
    const row = this.rows[key];
    return row && Date.now() - row.at < 7 * 86400000 ? row.model : undefined;
  }
  set(key: string, model: string | undefined) {
    if (model) this.rows[key] = { model, at: Date.now() };
    else delete this.rows[key];
    this.rows = Object.fromEntries(
      Object.entries(this.rows)
        .filter(([, v]) => Date.now() - v.at < 7 * 86400000)
        .slice(-4096),
    );
    writeFileSync(this.file + ".tmp", JSON.stringify(this.rows), {
      mode: 0o600,
    });
    renameSync(this.file + ".tmp", this.file);
  }
}
