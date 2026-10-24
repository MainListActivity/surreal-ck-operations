import type { Surreal } from 'surrealdb';
import { rankingSettings, rankingRequests, rankingTables, type RankingResultSnapshot } from './vendor/src/model-routing/ranking.ts';
import { readMagpieGroups } from './vendor/src/model-routing/controller.ts';
import { jevFromEnv } from './vendor/src/dispatcher/jev.ts';

/** Shared owner view for the Paseo surface and the browser review console. Reads never trigger Jev. */
export async function modelRankingView(db: Surreal) {
  const settings=await rankingSettings(db);
  const [status]=await db.query<[{at?:Date;error?:string;results?:Record<string,RankingResultSnapshot>;orders?:Record<string,string[]>;pins?:Record<string,string[]>}|undefined]>(
    'SELECT at,error,orders,results,pins FROM ONLY company_meta:model_ranking;');
  const requests=await rankingRequests(db);
  return {...settings,requests,tables:rankingTables(readMagpieGroups(),status?.results,requests,status?.pins),configured:!!jevFromEnv(),
    at:status?.at?String(status.at):undefined,error:status?.error,orders:status?.orders??{}};
}
