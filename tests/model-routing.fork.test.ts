import { expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { CompanyDatabase } from "../src/database.ts";
import { loadDatabaseConfig } from "../src/config.ts";
import {
  databaseGateway,
  startModelGateway,
} from "../src/model-routing/gateway.ts";
import { scoreModels, readModelResults } from "../src/model-routing/store.ts";
import { rank, classify } from "../src/model-routing/policy.ts";
import { writeScorecards, type EvalState } from "../src/scoring.ts";
const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === "1" ? test : test.skip;
run(
  "fork: live lease -> actual model evidence -> task score -> model priority; errors/unknowns never get invented credit",
  async () => {
    const db = new CompanyDatabase({
      ...loadDatabaseConfig(),
      namespace: "model_routing_fixture",
      database: "control_plane",
    });
    try {
      await db.connect();
      await db.bootstrap();
      await db.db
        .query(`CREATE task:fixture CONTENT {title:'fixture',context:'fixture',state:'doing',executor_role:'engineering',reviewer_role:'qa',model_tier:'medium',current_employee:'fixture-worker',lease_expires_at:time::unix(time::now())+120,fence:3};
   CREATE employee:⟨fixture-worker⟩ CONTENT {role:'engineering',paseo_agent_id:'fixture-agent',active_task:task:fixture,provider:'claude',model:'configured-group-alias'};`);
      const deps = databaseGateway(db.db);
      expect(await deps.lease("fixture-agent")).toMatchObject({
        task: "fixture",
        employee: "fixture-worker",
        fence: 3,
        tier: "medium",
      });
      expect(await deps.lease("employee:fixture-worker")).toMatchObject({
        task: "fixture",
        employee: "fixture-worker",
      });
      expect(await deps.lease("not-a-company-agent")).toBeUndefined();
      const gateway = await startModelGateway(
        {
          ...deps,
          fetchImpl: (async () =>
            new Response('data: {"type":"message_stop"}\n\n', {
              headers: {
                "content-type": "text/event-stream",
                "x-magpie-provider": "relay",
                "x-magpie-model": "actual-model",
              },
            })) as unknown as typeof fetch,
        },
        0,
      );
      try {
        const r = await fetch(
          `http://127.0.0.1:${gateway.port}/a/fixture-agent/v1/messages`,
          {
            method: "POST",
            body: JSON.stringify({
              model: "configured-group-alias",
              messages: [],
            }),
          },
        );
        expect(r.status).toBe(200);
        await r.text();
        await Bun.sleep(30);
      } finally {
        await gateway.stop();
      }
      await db.db
        .query(`CREATE model_execution CONTENT {task:task:fixture,employee:'fixture-worker',domain:'engineering',model:'relay/second',status:200,completed:true};
    CREATE model_execution CONTENT {task:task:fixture,employee:'fixture-worker',domain:'engineering',status:200,completed:true};
    CREATE model_execution CONTENT {task:task:fixture,employee:'fixture-worker',domain:'engineering',model:'relay/quota',status:429,completed:true};
    CREATE model_execution CONTENT {task:task:fixture,employee:'fixture-worker',domain:'engineering',model:'relay/cancelled',status:200,completed:false};
    UPDATE task:fixture SET state='done',current_employee=NONE;`);
      const state: EvalState = {
        taskId: "fixture",
        title: "fixture",
        context: "fixture",
        state: "done",
        executorRole: "engineering",
        reviewerRole: "qa",
        participants: ["fixture-worker"],
        metrics: {},
        timeline: [],
      };
      await writeScorecards(db.db, {
        taskId: "fixture",
        summary: "fixture",
        judge: "test-judge",
        judgeKind: "jev",
        state,
        scores: [
          {
            employee: "fixture-worker",
            quality: 5,
            evidence: 5,
            discipline: 5,
            timeliness: 5,
            overall: 5,
          },
        ],
      });
      const [cards] = await db.db.query<[any[]]>(
        "SELECT model,configured_model,actual_models,model_attribution FROM scorecard WHERE task=task:fixture;",
      );
      expect(cards[0]).toMatchObject({
        model: "mixed",
        configured_model: "configured-group-alias",
        actual_models: ["relay/actual-model", "relay/second"],
        model_attribution: "gateway-completed-requests",
      });
      const results = await readModelResults(db.db);
      expect(results).toHaveLength(2);
      expect(results.every((r) => Math.abs(r.weight - 1 / 3) < 1e-8)).toBe(
        true,
      );
      expect(
        rank(
          classify([{ id: "relay/actual-model" }, { id: "relay/untried" }]),
          results,
          "engineering",
        )[0]?.id,
      ).toBe("relay/actual-model");
      await scoreModels(db.db, "fixture", "fixture-worker", 5);
      expect(await readModelResults(db.db)).toHaveLength(2);
      await db.db.query(
        'UPDATE task:fixture SET state="doing",current_employee="fixture-worker",lease_expires_at=1;',
      );
      expect(await deps.lease("fixture-agent")).toBeUndefined();
    } finally {
      await db.close();
    }
  },
);
