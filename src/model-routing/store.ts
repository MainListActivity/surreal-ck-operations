import { RecordId, type Surreal } from "surrealdb";
import type { ModelAssessment } from "../contracts.ts";
import { digest, domainOf, type ModelResult } from "./policy.ts";
export class ModelAssessmentRequired extends Error {
  constructor(readonly models:string[]) {super('Missing final model assessments')}
}
/** Final acceptance only. Each actual model receives its own eval judgement, once per participant/task. */
export async function scoreModels(
  db: Surreal,
  taskId: string,
  employee: string,
  overall: number,
  assessments?: ModelAssessment[],
): Promise<string[]> {
  if (!Number.isFinite(overall) || overall < 1 || overall > 5)
    throw Error("invalid model score");
  const task = new RecordId("task", taskId);
  const state = await db.select<{state:string}>(task);
  if (state?.state !== "done") throw Error("model performance settles only after final task acceptance");
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
    const k = `general\0${r.model}`;
    const x = counts.get(k) ?? { n: 0, domain: "general" };
    x.n++;
    counts.set(k, x);
  }
  const actual = [...new Set(rows.flatMap(r=>r.model?[r.model]:[]))].sort();
  if(counts.size>1 && actual.some(model=>!assessments?.some(a=>a.model===model))) throw new ModelAssessmentRequired(actual);
  // Replace all fractional evidence in one transaction; partial failures leave the previous evaluation intact.
  const vars: Record<string, unknown> = { task, employee };
  let sql =
    "BEGIN; DELETE model_scorecard WHERE task=$task AND employee=$employee;";
  let i = 0;
  for (const [key, r] of counts) {
    const model = key.split("\0")[1]!;
    const assessment = assessments?.find(a => a.model === model);
    // A mixed-model task needs an evidence-based judgement per model; call share is not quality.
    const score = assessment?.overall ?? overall;
    if (!Number.isFinite(score) || score<1 || score>5) throw Error("invalid model assessment");
    vars[`card${i}`] = new RecordId(
      "model_scorecard",
      digest(`${taskId}\0${employee}\0${key}`),
    );
    vars[`data${i}`] = {
      task,
      employee,
      model,
      domain: "general",
      overall: score,
      notes:assessment?.notes,
      weight: 1 / counts.size,
      at: new Date(),
      basis: assessment ? "final-eval-model-assessment" : "final-eval-single-model",
    };
    sql += `CREATE ONLY $card${i} CONTENT $data${i};`;
    i++;
  }
  await db.query(sql + "COMMIT;", vars);
  return [...new Set(rows.flatMap((r) => (r.model ? [r.model] : [])))].sort();
}
export async function readModelResults(db: Surreal): Promise<ModelResult[]> {
  const [rows] = await db.query<[ModelResult[]]>(
    "SELECT model,domain,overall,weight,<string>at AS at FROM model_scorecard WHERE at>time::now()-180d AND task.state='done' ORDER BY at DESC LIMIT 10000;",
  );
  return rows;
}
export { domainOf };
