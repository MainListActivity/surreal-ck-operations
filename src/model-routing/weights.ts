/** Fixed reference scales: adding a candidate cannot change another candidate's score. */
export const WEIGHT_LABELS={pace:'额度消耗意愿',latency:'首 token 延迟',intelligence:'AA 能力',speed:'输出速度',performance:'验收绩效',price:'预计费用'};
export const BILLING_LABELS={free:'免费',included:'套餐/积分覆盖',unknown:'计费未知',paid:'额外付费'};
export type BillingClass=keyof typeof BILLING_LABELS;
/** bandWidth is retained only to read old saved policies; v5 never partitions by it. */
export interface RankingPolicy {bandWidth:number;weights:Record<keyof typeof WEIGHT_LABELS,number>;billingOverrides:Record<string,BillingClass>}
export const DEFAULT_POLICY:RankingPolicy={bandWidth:2,weights:{pace:35,latency:30,intelligence:15,speed:10,performance:5,price:5},billingOverrides:{}};
export function rankingPolicy(input:unknown=DEFAULT_POLICY):RankingPolicy {
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('排序配置无效');
 const p=input as RankingPolicy;
 if(Object.keys(p).some(k=>!['bandWidth','weights','billingOverrides'].includes(k))||!Number.isFinite(p.bandWidth)||p.bandWidth<0||p.bandWidth>10)throw Error('能力档宽度须为0到10');
 if(!p.weights||Object.keys(p.weights).length!==Object.keys(WEIGHT_LABELS).length||Object.keys(p.weights).some(k=>!Object.hasOwn(WEIGHT_LABELS,k)))throw Error('权重字段无效');
 const weights={...p.weights};
 if(Object.values(weights).some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>100)||!Object.values(weights).some(n=>n>0))throw Error('权重须为0到100，且至少一项大于0');
 if(!p.billingOverrides||typeof p.billingOverrides!=='object'||Array.isArray(p.billingOverrides)||Object.keys(p.billingOverrides).length>1000||Object.entries(p.billingOverrides).some(([id,v])=>!id||id.length>300||!Object.hasOwn(BILLING_LABELS,v)))throw Error('计费分类无效');
 return {bandWidth:p.bandWidth,weights,billingOverrides:{...p.billingOverrides}};
}
