import type {ModelFacts,RankingRequestPayload} from "./ranking.ts";
import type {ModelTrends} from "./trends.ts";
/** Compact wire columns keep the shared state within Jev's per-question context. */
export const TREND_COLUMNS = ["current","ewma","slopePerMinute","change","baselineMean","baselineSamples","samples","lastSampleAtMs","ageMs","sufficient"] as const;
const METRIC_UNITS:Record<string,string> = {ttftMs:"ms",tokensPerSecond:"tokens/s",errorRate:"ratio",cacheHitRate:"ratio",ttftOver10sRate:"ratio",performanceScore:"score",aaScore:"score",aaRank:"rank",remainingPct:"percent",inputPrice:"USD/1M",outputPrice:"USD/1M",cacheHitPrice:"USD/1M"};
const sampleUnitOf = (key:string) => key === "performanceScore" ? "task" as const : ["aaScore","aaRank","remainingPct","inputPrice","outputPrice","cacheHitPrice"].includes(key) ? "snapshot" as const : "request" as const;
/** Full facts remain in successful UI snapshots; only the transport uses shared columns. */
export function rankingInputFact(f:ModelFacts) {
  if(!f.trends)return f;
  return {...f,trends:Object.fromEntries(Object.entries(f.trends).map(([key,t])=>[key,t.baseline.samples ? [
    t.current??null,t.ewma??null,t.slopePerMinute??null,t.change.detected?[t.change.direction,t.change.at?Date.parse(t.change.at):null,t.change.before??null,t.change.after??null]:false,
    t.baseline.mean??null,t.baseline.samples,t.samples,t.lastSampleAt?Date.parse(t.lastSampleAt):null,t.ageMs??null,t.sufficient,
  ] : null]))};
}
/** Legacy/first-attempt cards can read the exact compact request even before any successful score. */
export function expandRankingInput(f:ModelFacts):ModelFacts {
  if(!f.trends)return f;
  const trends:ModelTrends={};
  for(const [key,input] of Object.entries(f.trends)) {
    if(input && !Array.isArray(input)){trends[key]=input;continue;}
    const row=input as unknown[]|null;
    const value=(i:number)=>typeof row?.[i]==='number'&&Number.isFinite(row[i])?row[i] as number:undefined;
    const at=value(7);
    trends[key]={unit:METRIC_UNITS[key]??"unknown",sampleUnit:sampleUnitOf(key),current:value(0),ewma:value(1),slopePerMinute:value(2),
      change:Array.isArray(row?.[3])?{detected:true,direction:row[3][0] as 'up'|'down',at:typeof row[3][1]==='number'?new Date(row[3][1]).toISOString():undefined,before:row[3][2]??undefined,after:row[3][3]??undefined}:{detected:false},
      baseline:{mean:value(4),samples:value(5)??0},samples:value(6)??0,lastSampleAt:at===undefined?undefined:new Date(at).toISOString(),ageMs:value(8),sufficient:row?.[9]===true,windows:{}};
  }
  return {...f,trends};
}
// Conservative UTF-8 engineering budgets, not a tokenizer. Upstream rejections still retain the previous order.
// https://docs.typesafe.ai/models: 32k state+one question; 64k state+all questions.
export const RANKING_INPUT_BUDGET = {stateBytes:48_000,requestBytes:128_000};

/** Explicit units/estimators travel with every request, rather than relying on field names. */
export const TREND_DICTIONARY = {
  columns:TREND_COLUMNS,
  encoding:"trends每项是按columns列名对应的数组；整个指标null表示无有效历史，数组里的null表示该字段未知。规则引用指标.current等字段时按相应列读取。change=false表示未检出突变；突变数组为[direction,atMs,before,after]（direction=up或down，atMs为Unix毫秒）。lastSampleAtMs为Unix毫秒。详细窗口保留在公司页面成功快照，本次输入只传当前、趋势与基线摘要。",
  metricInfo:Object.fromEntries(Object.entries(METRIC_UNITS).map(([key,unit])=>[key,{unit,sampleUnit:sampleUnitOf(key)}])),
  scope:"每个完整供应商/模型通道独立统计，沿用 usage 的跨历史思考等级口径，不混用其他供应商。绩效按现有 canonical model 映射归并。",
  metrics:{ttftMs:"首个内容（含思考或工具调用）的延迟，毫秒；仅成功且有计时的请求",tokensPerSecond:"Magpie DecodeOf 原生生成速度（token/s），排除未计时、隐式思考和突发释放等不可测速请求",errorRate:"失败请求占比0–1，含没有首token的失败",cacheHitRate:"每次成功请求的缓存token/全部提示token，窗口为请求比例的均值；与usage的token加权命中率区分",ttftOver10sRate:"成功且有首token计时的请求中超过10000ms的比例",performanceScore:"最终验收任务的1–5分绩效，同一任务多名员工按原评分权重归并成一个样本",aaScore:"AA智能分",aaRank:"AA全榜名次，越小越好",remainingPct:"各订阅最紧窗口剩余比例的最小值，0–100",inputPrice:"输入价格USD/百万token",outputPrice:"输出价格USD/百万token",cacheHitPrice:"缓存命中价格USD/百万token"},
  current:"最新一次有效实测值，不是均值；lastSampleAt与ageMs标明它是否过期；没有数据是未知，不是0。",
  ewma:"请求使用最近1小时最多20个有效样本、半衰期5分钟；任务绩效与变动快照使用最近7天最多20个样本、半衰期24小时。按相对最新样本的真实时间指数加权。限制样本数防止高流量旧数据淹没最近变化。",
  slopePerMinute:"同EWMA的近期窗口最多20个样本对实际时间做最小二乘回归；单位=该指标unit/分钟。至少5样本且覆盖1秒才提供。正负只代表上升下降，延迟/错误率/排名上升通常变差，速度/绩效/命中率上升通常变好。",
  change:"启发式突变信号而非统计显著性概率：最近10样本前后各5个均值相差超过25%、前5样本3倍标准差与单位最小变化量（ms为500、ratio为0.05、score为0.25、percent为5、USD/1M为0.001、其他为1），且后5中至少4个同方向；最新请求须在15分钟内，任务/变动快照须在7天内。detected=false不证明没有变化。",
  confidence:"samples是相应近期窗口最多20样本数；sufficient要求至少5样本、覆盖至少1秒，请求最新不超过15分钟，稀疏任务/变动快照不超过7天。false时降低采信，不据此断言趋势；快照是变动记录，重复读取相同值不增加样本，不能冒充独立请求或任务。",
  baseline:"最近7天有效样本的均值与样本数，只作长期参照。公司页面的完整快照windows给出15m/1h/24h/7d分布，本次请求不重复发送这些窗口；不重叠前后5样本用于突变检测。",
  rules:"老板明确的优先级和排最后条件优先；缺失、样本不足或过期数据不代表优秀或满足限制。趋势辅助排序，不自行修改老板阈值或统计口径。AA与价格等稀疏指标没有变动历史时趋势未知。",
};


export interface RankingAttempt {
  at: string; modelCount: number; encoding: 'shared-v2'|'columns-v2';
  stateBytes: number; requestBytes: number;
  limits: typeof RANKING_INPUT_BUDGET;
  status: 'prepared'|'success'|'budget_exceeded'|'upstream_error'|'invalid_answer';
}
export class RankingInputBudgetError extends Error {
  constructor(readonly attempt:RankingAttempt) {
    super(`ranking input exceeds Jev safety budget: encoding=${attempt.encoding}, models=${attempt.modelCount}, state=${attempt.stateBytes}/${attempt.limits.stateBytes}, request=${attempt.requestBytes}/${attempt.limits.requestBytes}`);
  }
}
const FACT_COLUMNS=['id','accounts','aa','price','usage','performance','health','trendSource','trends'] as const;
const POOL_FIELDS=['accounts','trendSource'] as const;
function precise(v:unknown,metric:string):unknown {
  if(typeof v!=='number')return v;
  const digits=metric.endsWith('Price')?8:4;
  return Number(v.toFixed(digits));
}
/** References are group-local, contain no omitted facts, and never reference another request. */
export function buildRankingInput(model:string,tier:string,rules:string,facts:ModelFacts[],levels:readonly string[],now=Date.now()): {payload:RankingRequestPayload;attempt:RankingAttempt} {
  const refs:Record<string,unknown>={},lookup=new Map<string,string>();
  const ref=(value:unknown)=>{
    const key=JSON.stringify(value);let id=lookup.get(key);
    if(id===undefined){id=`r${lookup.size}`;lookup.set(key,id);refs[id]=value;}
    return {$ref:id};
  };
  const models=Object.fromEntries(facts.map((f,i)=>{
    const wire=JSON.parse(JSON.stringify(rankingInputFact(f))) as Record<string,any>;
    for(const key of POOL_FIELDS)if(wire[key]!==undefined)wire[key]=ref(wire[key]);
    if(wire.usage){
      const {source,period,since,collectedAt,scope,...counts}=wire.usage;
      wire.usage={...counts,metadata:ref({source,period,since,collectedAt,scope})};
    }
    if(wire.health){const {source,...counts}=wire.health;wire.health={...counts,metadata:ref({source})};}
    if(wire.trends)for(const [key,row] of Object.entries(wire.trends)) {
      if(!Array.isArray(row))continue;
      // Counts, timestamps and booleans remain exact. Presentation precision applies only to measured values.
      const rounded=row.map((v,j)=>[0,1,2,4].includes(j)?precise(v,key):j===3&&Array.isArray(v)?[v[0],v[1],precise(v[2],key),precise(v[3],key)]:v);
      wire.trends[key]=ref(rounded);
    }
    return [`m${i}`,wire];
  }));
  const metricColumns=[...new Set([...Object.keys(METRIC_UNITS),...facts.flatMap(f=>Object.keys(f.trends??{}))])];
  const state:Record<string,unknown>={group:`group/sck-${tier}`,ownerRules:rules,encoding:'shared-v2',collectedAt:new Date(now).toISOString(),refs,models,
    rankingPolicy:{levels,instructions:'完整老板规则在 ownerRules；明确优先关系和排最后条件优先，其他优势不能抵消。按 trendDictionary 解读数据，结合当前水平和趋势。老板未指定口径时阈值沿用 usage 的原生平均值，不改为P90/最新一次/EWMA。未知不代表满足或违反条件。持续报错的通道已由代码排到末尾，不参与本次评分。'},
    trendDictionary:{...TREND_DICTIONARY,encoding:'所有 {$ref:"rN"} 均递归展开为 state.refs.rN，同一请求内共享。模型对象字段含义不变；trends展开后按columns解读。columns-v2 时每个模型是按factColumns排列的数组，且trends按metricColumns排列；null表示未知。usage.metadata与health.metadata展开后补回各自字段。'+TREND_DICTIONARY.encoding,factColumns:FACT_COLUMNS,metricColumns},
    notes:['accounts为匿名订阅列表，remainingPct是最紧窗口剩余百分比。aa.rank越小越强，effort是该档实测思考等级。price单位USD/百万token，free为免费。',
      'usage是排序前实时采集的Magpie近7天原生汇总，严格按完整供应商/模型路径匹配、含历史思考等级。requests含errors；tokensPerSecond为原生decode速度，speedSamples为测速数；ttftMs为平均首token毫秒，ttftSamples为计时数；cacheHitRate为token加权命中率。',
      'health来自近24小时全部路由尝试（含回退），不同于usage最终请求统计。performance为最终验收后的1–5分绩效及样本权重。'],
  };
  const questions=Object.fromEntries(facts.map((_,i)=>[`m${i}`,{type:'score' as const,instructions:`按 state.ownerRules 和 state.rankingPolicy 评价 state.models.m${i}，引用按 trendDictionary 解码。`,
    criteria:['末尾：满足共享规则的排最后条件，其他优势不能抵消；否则综合最低。','靠后：未触发排最后条件，综合偏低。','中等：未触发排最后条件，综合中等。','靠前：未触发排最后条件，综合较高。','首选：未触发排最后条件，综合最优先。']} ]));
  let payload:RankingRequestPayload={model,state,questions};
  const measure=()=>({stateBytes:Buffer.byteLength(JSON.stringify(payload.state),'utf8'),requestBytes:Buffer.byteLength(JSON.stringify(payload),'utf8')});
  let size=measure();
  // Switch before the hard limit, keeping headroom for new channels and growing sample histories.
  if(size.stateBytes>RANKING_INPUT_BUDGET.stateBytes*.7||size.requestBytes>RANKING_INPUT_BUDGET.requestBytes*.7){
    state.encoding='columns-v2';state.models=Object.fromEntries(Object.entries(models).map(([key,f])=>[key,FACT_COLUMNS.map(name=>name==='trends'&&f.trends?metricColumns.map(metric=>f.trends[metric]??null):f[name]??null)]));
    size=measure();
  }
  payload=JSON.parse(JSON.stringify(payload));
  return {payload,attempt:{at:new Date(now).toISOString(),modelCount:facts.length,encoding:state.encoding as RankingAttempt['encoding'],...size,limits:{...RANKING_INPUT_BUDGET},status:size.stateBytes>RANKING_INPUT_BUDGET.stateBytes||size.requestBytes>RANKING_INPUT_BUDGET.requestBytes?'budget_exceeded':'prepared'}};
}
/** Decode both historical v1 snapshots and the exact v2 wire request for the owner surfaces. */
export function expandRankingModels(state:Record<string,unknown>):ModelFacts[] {
  const refs=(state.refs??{}) as Record<string,unknown>;
  const expand=(v:any,depth=0):any=>{
    if(depth>20)return undefined;
    if(v&&typeof v==='object'&&typeof v.$ref==='string')return expand(refs[v.$ref],depth+1);
    if(Array.isArray(v))return v.map(x=>expand(x,depth+1));
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,expand(x,depth+1)]));
    return v;
  };
  return Object.values((state.models??{}) as Record<string,any>).map(input=>{
    const expanded=expand(input);
    const f=Array.isArray(expanded)?Object.fromEntries(FACT_COLUMNS.map((key,i)=>[key,expanded[i]??undefined])):expanded;
    if(Array.isArray(f.trends)){const columns=(state.trendDictionary as {metricColumns?:string[]})?.metricColumns??Object.keys(METRIC_UNITS);f.trends=Object.fromEntries(columns.map((key,i)=>[key,f.trends[i]??null]));}
    for(const key of ['usage','health'])if(f[key]?.metadata){const {metadata,...rest}=f[key];f[key]={...metadata,...rest};}
    return expandRankingInput(f);
  });
}
