import type {ModelRankingTable} from './types.ts';
export const ROUTING_WEIGHTS={pace:'额度消耗意愿',latency:'首 token 延迟',intelligence:'AA 能力',speed:'输出速度',performance:'验收绩效',price:'预计费用'};
export const ROUTING_DEFAULTS={bandWidth:2,weights:{pace:35,latency:30,intelligence:15,speed:10,performance:5,price:5},billingOverrides:{}};
export const ROUTING_FORMULA='总分 = 几何效用 × 延迟因子 × 额度可用性 × 可靠性² × 临期加成 + 探索加分（0–100）。手动置顶保留人工顺序；其余只按总分降序。';
export const ROUTING_COST_HELP='费用按 100万输入＋25万输出估算并考虑缓存命中。免费及订阅/积分覆盖为零额外费用，费用原始分为100；权重不是模型价格。';
export function routingNumber(value:number|undefined|null,decimals=1){return typeof value==='number'&&Number.isFinite(value)?value.toFixed(decimals):'未知';}
export function routingMetrics(row:ModelRankingTable['rows'][number]){
 const d=row.decision,f=d?.factors,n=routingNumber;
 return [
  ['AA 智能分',n(row.aaScore),row.aaRank===undefined?'尚未关联 AA':`AA 第 ${row.aaRank} 名 · ${row.effort??'默认思考'}`],
  ['首 token',row.ttftMs===undefined?'未知':`${n(row.ttftMs/1000,2)} 秒`,d?.latencySource??'尚无采样'],
  ['输出速度',row.tokensPerSecond===undefined?'未知':`${n(row.tokensPerSecond,0)} tok/s`,'Magpie 原生实测'],
  ['验收绩效',row.performanceScore===undefined?'未知':`${n(row.performanceScore,2)} / 5`,`${n(row.performanceSamples,0)} 个样本 · 渠道隔离`],
  ['费用原始分',d?.contributions?.price?.value===undefined?'未知':n(d.contributions.price.value*100),f?.estimatedCost===undefined?'预计费用未知':`预计 $${n(f.estimatedCost,3)} · ${d?.costClass??'未知计费'}`],
  ['供应商额度',d?.costClass==='free'?'免费，不扣分':row.accounts.map(a=>`${n(a.remainingPct,2)}%`).join(' / ')||'未知','免费不受额度耗尽影响'],
  ['可靠性因子',f?`${n(f.reliability*100)}%`:'未知',row.health?`${row.health.errors}/${row.health.attempts} 次路由错误`:'暂无路由样本'],
  ['临期额度',row.urgency?.active?`${row.urgency.amount} ${row.urgency.unit}`:'无有效临期额度',row.urgency?.reason??'只使用新鲜、明确的到期数据'],
  ['AA 参考价',`入 $${n(row.price?.input,3)} / 出 $${n(row.price?.output,3)}`,`缓存命中 $${n(row.price?.cacheHit,3)} / M token`],
 ] as const;
}
