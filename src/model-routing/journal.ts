import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import { scoreModels } from "./store.ts";
import { createHash } from "node:crypto";
/** Local write-ahead queue. The inference path never awaits a database operation. */
export class ExecutionJournal {
  private readonly active = new Map<string, Record<string, unknown>>();
  private pending?: Promise<number>;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private save(id: string, row: Record<string, unknown>) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw Error("invalid execution id");
    const file = join(this.dir, `${id}.json`),
      temp = file + ".tmp";
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(row));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  }
  async record(row: Record<string, unknown>) {
    const id = String(row.id);
    this.save(id, row);
    this.active.set(id, row);
  }
  async complete(id: string, completed: boolean) {
    const base = this.active.get(id);
    if (!base) throw Error("execution was not recorded");
    this.save(id, { ...base, completed, ended_at: new Date() });
    this.active.delete(id);
  }
  drain(db: Surreal): Promise<number> {
    if (this.pending) return this.pending;
    this.pending = this.flush(db).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async flush(db: Surreal): Promise<number> {
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .slice(0, 100);
    if (!files.length) return 0;
    const batch = files.map((file) => {
      const text = readFileSync(join(this.dir, file), "utf8");
      return { file, text, row: JSON.parse(text) };
    });
    let sql = "BEGIN;";
    const vars: Record<string, unknown> = {};
    for (const [i, b] of batch.entries()) {
      const { id, ...row } = b.row;
      if (row.task) row.task = new RecordId("task", row.task);
      else delete row.task;
      if (row.at) row.at = new Date(row.at);
      if (row.ended_at) row.ended_at = new Date(row.ended_at);
      vars[`id${i}`] = new RecordId("model_execution", id);
      vars[`row${i}`] = row;
      sql += `UPSERT $id${i} MERGE $row${i} RETURN NONE;`;
    }
    for (const [i, b] of batch.entries())
      if (
        b.row.task &&
        [402, 429].includes(b.row.status) &&
        b.row.requested?.startsWith("group/sck-")
      ) {
        vars[`task${i}`] = new RecordId("task", String(b.row.task));
        vars[`employee${i}`] = b.row.employee;
        vars[`fence${i}`] = b.row.fence;
        vars[`until${i}`] =
          Math.floor(Date.parse(b.row.at) / 1000) +
          Math.min(900, b.row.retry_seconds || 60);
        sql += `UPDATE $task${i} SET model_route_until=math::max([model_route_until??0,$until${i}]) WHERE fence<=$fence${i}+1 AND (current_employee=$employee${i} OR current_employee=NONE) AND state IN ['ready','doing','review'] RETURN NONE;`;
      }
    await db.query(sql + "COMMIT;", vars);
    // A completion may arrive just after task evaluation. Reconcile already-scored participants before
    // acknowledging the local queue; retries rebuild fractional evidence instead of adding samples.
    const tasks = [
      ...new Set(
        batch
          .filter((b) => b.row.completed && b.row.task)
          .map((b) => String(b.row.task)),
      ),
    ];
    if (tasks.length) {
      const [cards] = await db.query<
        [
          Array<{
            task: RecordId;
            employee: string;
            overall: number;
            configured_model?: string;
            model?: string;
          }>,
        ]
      >(
        "SELECT task,employee,overall,configured_model,model FROM scorecard WHERE task IN $tasks;",
        { tasks: tasks.map((t) => new RecordId("task", t)) },
      );
      for (const card of cards) {
        const models = await scoreModels(
          db,
          String(card.task.id),
          card.employee,
          card.overall,
        );
        await db.query(
          "UPDATE $card SET configured_model=$configured,model=$model,actual_models=$models,model_attribution=$basis RETURN NONE;",
          {
            card: new RecordId(
              "scorecard",
              createHash("sha256")
                .update(`${String(card.task.id)}${card.employee}`)
                .digest("hex")
                .slice(0, 24),
            ),
            configured: card.configured_model ?? card.model,
            model:
              models.length === 1
                ? models[0]
                : models.length
                  ? "mixed"
                  : "unknown",
            models,
            basis: models.length ? "gateway-completed-requests" : "unknown",
          },
        );
      }
    }
    // Completion can arrive while the remote write is in flight. Never unlink that newer record.
    for (const b of batch) {
      try {
        if (readFileSync(join(this.dir, b.file), "utf8") === b.text)
          unlinkSync(join(this.dir, b.file));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return batch.length;
  }
}
