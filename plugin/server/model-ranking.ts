import type { Surreal } from 'surrealdb';
import { rankingSettings, rankingRequests, rankingTables, type RankingGates, type RankingAttempt, type RankingResultSnapshot } from './vendor/src/model-routing/ranking.ts';
import { readMagpieGroups } from './vendor/src/model-routing/controller.ts';


/** Shared owner view for the Paseo surface and the browser review console. Reads never trigger Jev. */
export async function modelRankingView(db: Surreal) {
  const settings=await rankingSettings(db);
  const [status]=await db.query<[{at?:Date;error?:string;results?:Record<string,RankingResultSnapshot>;orders?:Record<string,string[]>;pins?:Record<string,string[]>;gates?:RankingGates;attempts?:Record<string,RankingAttempt>}|undefined]>(
    'SELECT at,error,orders,results,pins,gates,attempts FROM ONLY company_meta:model_ranking;');
  const requests=await rankingRequests(db);
  return {...settings,requests,attempts:{},tables:rankingTables(readMagpieGroups(),status?.results,requests,status?.pins,status?.gates),configured:true,engine:'quality-pace-v5',
    at:status?.at?String(status.at):undefined,error:status?.error,orders:status?.orders??{}};
}

interface ModelManagementContext {
 db:{db:Surreal};
 modelRanking:import('./vendor/src/model-routing/ranking.ts').RankingRefresher;
 modelRouting:import('./vendor/src/model-routing/controller.ts').ModelRoutingController;
}
/** One mutation path shared by both owner surfaces; invalidate stale ranking writes first. */
export async function updateModelMembership(ctx:ModelManagementContext,input:Parameters<ModelManagementContext['modelRouting']['setMembership']>[0]) {
 const settings=await rankingSettings(ctx.db.db);
 await ctx.modelRanking.configure(()=>ctx.modelRouting.setMembership(input),settings.refreshMinutes);
 ctx.modelRanking.trigger();
 return {ok:true};
}
export async function updateModelAlias(ctx:ModelManagementContext,input:{model:string;slug:string|null}) {
 const settings=await rankingSettings(ctx.db.db);let result={synchronized:false};
 await ctx.modelRanking.configure(async()=>{result=await ctx.modelRouting.setAlias(input.model,input.slug);},settings.refreshMinutes);
 ctx.modelRanking.trigger();
 return {ok:true,...result};
}
