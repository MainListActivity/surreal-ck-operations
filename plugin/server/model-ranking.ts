import type { Surreal } from 'surrealdb';
import { rankingSettings, rankingRequests, rankingTables, type RankingGates, type RankingAttempt, type RankingResultSnapshot } from './vendor/src/model-routing/ranking.ts';
import { readMagpieGroups } from './vendor/src/model-routing/controller.ts';


/** Shared owner view for the Paseo surface and the browser review console. Reads never trigger Jev. */
export async function modelRankingView(db: Surreal) {
  const settings=await rankingSettings(db);
  const [status]=await db.query<[{at?:Date;error?:string;results?:Record<string,RankingResultSnapshot>;orders?:Record<string,string[]>;pins?:Record<string,string[]>;gates?:RankingGates;attempts?:Record<string,RankingAttempt>}|undefined]>(
    'SELECT at,error,orders,results,pins,gates,attempts FROM ONLY company_meta:model_ranking;');
  const requests=await rankingRequests(db);
  return {...settings,requests,attempts:{},tables:rankingTables(readMagpieGroups(),status?.results,requests,status?.pins,status?.gates),configured:true,engine:'quality-pace-v3',
    at:status?.at?String(status.at):undefined,error:status?.error,orders:status?.orders??{}};
}
