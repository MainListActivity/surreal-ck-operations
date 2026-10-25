import { expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { CompanyDatabase } from "../src/database.ts";
import { loadDatabaseConfig } from "../src/config.ts";
import {
  databaseGateway,
  startModelGateway,
} from "../src/model-routing/gateway.ts";
import { scoreModels, readModelResults } from "../src/model-routing/store.ts";
import { rank } from "../src/model-routing/policy.ts";
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
      const {Workforce}=await import('../src/workforce.ts');
      const {planRoutingRoster}=await import('../src/model-routing/roster.ts');
      const wf=new Workforce(db,'/unused-fixture-credentials');
      await wf.upsertDef('gm-grok',{role:'gm',provider:'grok',model:'old-gm'});
      await wf.upsertDef('story-claude',{role:'story-author',provider:'claude',model:'keep-story',tracks:['原著']});
      const before=await wf.defs();
      for(const d of planRoutingRoster(before)) await wf.upsertDef(d.id,{role:d.role as any,provider:d.provider,model:d.model,enabled:d.enabled,tracks:d.tracks,maxInstances:d.maxInstances,quotaLimited:d.quotaLimited});
      const migrated=await wf.defs();
      expect(migrated.find(d=>d.id==='gm-grok')?.enabled).toBe(false);
      expect(migrated.find(d=>d.id==='gm-claude')).toMatchObject({model:'group/sck-opus',provider:'claude',quotaLimited:false});
      expect(migrated.find(d=>d.id==='story-claude')?.model).toBe('keep-story');
      await db.db
        .query(`CREATE task:fixture CONTENT {title:'fixture',context:'fixture',state:'doing',executor_role:'engineering',reviewer_role:'qa',model_tier:'medium',current_employee:'fixture-worker',lease_expires_at:time::unix(time::now())+120,fence:3};
   CREATE employee:⟨fixture-worker⟩ CONTENT {role:'engineering',paseo_agent_id:'fixture-agent',active_task:task:fixture,provider:'claude',model:'configured-group-alias'};`);
      const deps = databaseGateway(db.db);
      expect(await deps.lease("fixture-agent")).toMatchObject({
        task: "fixture",
        employee: "fixture-worker",
        fence: 3,
        tier: "sonnet",
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
            new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fixture"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\ndata: {"type":"message_stop"}\n\n', {
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
      const [measured] = await db.db.query<[any[]]>("SELECT completed,output_tokens,ttft_ms,first_text_ms,total_ms,model FROM model_execution WHERE model='relay/actual-model';");
      expect(measured).toHaveLength(1);
      expect(measured[0]).toMatchObject({completed:true,output_tokens:12,model:'relay/actual-model'});
      expect(measured[0].total_ms).toBeGreaterThanOrEqual(measured[0].ttft_ms);
      expect(measured[0].first_text_ms).toBe(measured[0].ttft_ms);
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
        modelExecutions:[{employee:'fixture-worker',model:'relay/actual-model',fence:3,phase:'execute',at:new Date().toISOString()},{employee:'fixture-worker',model:'relay/second',fence:4,phase:'execute',at:new Date().toISOString()}],
        metrics: {},
        timeline: [],
      };
      // No model credit while execution/rework/review is still in progress.
      await db.db.query("UPDATE task:fixture SET state='review';");
      await expect(scoreModels(db.db,'fixture','fixture-worker',5)).rejects.toThrow('final task acceptance');
      await db.db.query("UPDATE task:fixture SET state='done';");
      await expect(scoreModels(db.db,'fixture','fixture-worker',5)).rejects.toThrow('Missing final model assessments');
      expect(await readModelResults(db.db)).toHaveLength(0); // mixed executions need explicit model judgements
      await writeScorecards(db.db, {
        taskId: "fixture",
        summary: "fixture",
        judge: "test-judge",
        judgeKind: "jev",
        state,
        scores: [
          {
            employee: "fixture-worker",
            modelScores:[{model:"relay/actual-model",overall:5},{model:"relay/second",overall:2}],
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
      expect(results.every(r=>r.task === "task:fixture")).toBe(true);
      expect(results.every((r) => Math.abs(r.weight - 1 / 2) < 1e-8)).toBe(
        true,
      );
      expect(
        rank(
          ["relay/actual-model", "relay/untried"].map((id) => ({ id, model: id.slice(6), tier: "sonnet" as const, prior: 2.5, estimated: true, context: 32768 })),
          results,
          "engineering",
        )[0]?.id,
      ).toBe("relay/actual-model");
      await scoreModels(db.db, "fixture", "fixture-worker", 5,[{model:"relay/actual-model",overall:5},{model:"relay/second",overall:2}]);
      expect(await readModelResults(db.db)).toHaveLength(2);
      await db.db.query(
        'UPDATE task:fixture SET state="doing",current_employee="fixture-worker",lease_expires_at=1;',
      );
      expect(await deps.lease("fixture-agent")).toBeUndefined();
      expect(await readModelResults(db.db)).toHaveLength(0);
      const [reopened]=await db.db.query<[any]>("SELECT evaluated_at FROM ONLY task:fixture;");
      expect(reopened.evaluated_at).toBeUndefined();
    } finally {
      await db.close();
    }
  },
);

run('fork: Factory roster physically removes other native defs, preserves authors and native settings, and retries safely',async()=>{
 const db=new CompanyDatabase({...loadDatabaseConfig(),namespace:'factory_roster_fixture',database:'control_plane'});
 try{
  await db.connect();await db.bootstrap();
  const {Workforce}=await import('../src/workforce.ts');const {applyRoutingRoster}=await import('../src/model-routing/roster.ts');
  const wf=new Workforce(db,'/unused-fixture-credentials');
  await wf.upsertDef('engineering-factory',{role:'engineering',provider:'factory-droid',model:'native-model',thinking:'high',tracks:['web'],enabled:false,maxInstances:3,quotaLimited:false});
  await wf.upsertDef('engineering-claude',{role:'engineering',provider:'claude',model:'old',thinking:'medium',tracks:['mobile']});
  await wf.upsertDef('engineering-codex',{role:'engineering',provider:'codex',model:'old',tracks:['web']});
  await wf.upsertDef('qa-grok',{role:'qa',provider:'grok',model:'old',enabled:false});
  await wf.upsertDef('story-native',{role:'story-author',provider:'codex',model:'unchanged',thinking:'high',tracks:['原著']});
  const before=(await wf.defs()).find(d=>d.id==='story-native');
  await expect(applyRoutingRoster(wf,db.db)).rejects.toThrow('Pause dispatch');
  await db.db.query('UPSERT company_meta:config MERGE {paused:true};');
  await db.db.query("CREATE employee:historical CONTENT {def:employee_def:`engineering-codex`,role:'engineering',provider:'codex'};");
  await applyRoutingRoster(wf,db.db);const after=await wf.defs();
  expect(after.some(d=>['engineering-codex','qa-grok'].includes(d.id))).toBe(false);
  expect(after.find(d=>d.id==='engineering-factory')).toMatchObject({provider:'factory-droid',model:'native-model',thinking:'high',enabled:true,maxInstances:3});
  expect(after.find(d=>d.id==='engineering-factory')?.quotaLimited).not.toBe(false);
  expect(after.find(d=>d.id==='engineering-claude')).toMatchObject({model:'group/sck-haiku',thinking:'medium'});
  expect(after.find(d=>d.id==='engineering-claude')?.tracks?.slice().sort()).toEqual(['mobile','web']);
  expect(after.find(d=>d.id==='story-native')).toEqual(before);
  const [history]=await db.db.query<[any]>('SELECT * FROM ONLY employee:historical;');expect(String(history.def)).toContain('engineering-codex');
  await applyRoutingRoster(wf,db.db);expect((await wf.defs()).find(d=>d.id==='engineering-factory')).toEqual(after.find(d=>d.id==='engineering-factory'));
 }finally{await db.close();}
});
