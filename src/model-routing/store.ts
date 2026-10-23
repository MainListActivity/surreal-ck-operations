import { RecordId, type Surreal } from "surrealdb";
import { digest, domainOf, type ModelResult } from "./policy.ts";
/** Rebuildable, idempotent attribution: mixed executions get fractional task evidence, never a last-model guess. */
export async function scoreModels(
  db: Surreal,
  taskId: string,
  employee: string,
  overall: number,
): Promise<string[]> {
  if (!Number.isFinite(overall) || overall < 1 || overall > 5)
    throw Error("invalid model score");
  const task = new RecordId("task", taskId);
  const [rows] = await db.query<
    [
      Array<{
        model?: string;
        completed: boolean;
        status: number;
        domain: string;
      }>,
    ]
  >(
    "SELECT model,completed,status,domain FROM model_execution WHERE task=$task AND employee=$employee AND completed=true AND status>=200 AND status<300 AND phase!='auxiliary';",
    { task, employee },
  );
  const counts = new Map<string, { n: number; domain: string }>();
  for (const r of rows) {
    if (!r.model) continue;
    const k = `${r.domain}\0${r.model}`;
    const x = counts.get(k) ?? { n: 0, domain: r.domain };
    x.n++;
    counts.set(k, x);
  }
  // Replace all fractional evidence in one transaction; partial failures leave the previous evaluation intact.
  const vars: Record<string, unknown> = { task, employee };
  let sql =
    "BEGIN; DELETE model_scorecard WHERE task=$task AND employee=$employee;";
  let i = 0;
  for (const [key, r] of counts) {
    const model = key.split("\0")[1]!;
    vars[`card${i}`] = new RecordId(
      "model_scorecard",
      digest(`${taskId}\0${employee}\0${key}`),
    );
    vars[`data${i}`] = {
      task,
      employee,
      model,
      domain: r.domain,
      overall,
      weight: r.n / rows.length,
      at: new Date(),
      basis: "completed-request-share",
    };
    sql += `CREATE ONLY $card${i} CONTENT $data${i};`;
    i++;
  }
  await db.query(sql + "COMMIT;", vars);
  return [...new Set(rows.flatMap((r) => (r.model ? [r.model] : [])))].sort();
}
export async function readModelResults(db: Surreal): Promise<ModelResult[]> {
  const [rows] = await db.query<[ModelResult[]]>(
    "SELECT model,domain,overall,weight,<string>at AS at FROM model_scorecard WHERE at>time::now()-180d ORDER BY at DESC LIMIT 10000;",
  );
  return rows;
}
export { domainOf };
