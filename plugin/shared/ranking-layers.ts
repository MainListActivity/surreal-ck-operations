import type {ModelRankingTable} from './types.ts';

/** Presentation only: preserve native order. Self-contained for embedding in the web console. */
export function rankingLayers(table:ModelRankingTable) {
 const rows=table.rows,costs:Record<string,string>={free:'免费',included:'套餐/积分覆盖',unknown:'计费未知',paid:'额外付费'};
 const keys=rows.map(r=>r.pinned?'manual-pins':r.decision?JSON.stringify([r.decision.tail??'',!!r.decision.coldStart,r.decision.band??null,r.decision.costClass??'unknown']):'unscored');
 const numbers=new Map<string,number>();if(rows.some(r=>r.pinned))numbers.set("manual-pins",1);for(const key of keys)if(!numbers.has(key))numbers.set(key,numbers.size+1);
 const seen=new Set<string>();
 const result:Array<{start:number;end:number;number:number;count:number;total:number;title:string;explanation:string;ability:string;abilitySummary:string;comparison:string}>=[];
 for(let start=0;start<rows.length;){
  const key=keys[start]!,row=rows[start]!,d=row.decision;let end=start;while(keys[end+1]===key)end++;
  const continued=seen.has(key);seen.add(key);const number=numbers.get(key)!;
  const count=end-start+1,total=keys.filter(k=>k===key).length;
  if(key==='manual-pins'){
    const risks=rows.filter(r=>r.pinned).flatMap(r=>r.decision?.tail?[`${r.model}：${r.decision.tail}`]:r.health?.excluded?[`${r.model}：该模型持续报错`]:[]);
    result.push({start,end,number,count,total,title:`第1层${continued?'（续）':''} · 手动置顶`,explanation:'所有手动置顶模型合并为独立第一层，优先于自动安全分层、新模型试用、AA能力档和计费层；状态异常仍保留提示。Magpie继续执行实际额度、可用性检查和失败回退。'+(risks.length?' 当前风险：'+risks.join('；'):'') ,ability:'本层不再按照AA能力档或计费类型拆分。各模型的AA、额度、延迟和报错观测仍可展开查看。',abilitySummary:`独立最高优先级 · ${risks.length?risks.length+'个模型有状态异常':'按置顶先后排列'}`,comparison:'本层按置顶先后排列，分数仅供参考；取消置顶后恢复自动分层。'});start=end+1;continue;
  }
  if(!d){result.push({start,end,number,count,total,title:`第${number}层${continued?'（续）':''} · 待分层`,explanation:'这些成员尚无排序决策快照，不能从当前名次推断能力档、计费层或试用状态。',ability:'等待下一次成功排序后显示实际分层依据。',abilitySummary:'无排序快照，等待分层',comparison:'暂无层内分，不与已评分模型比较。'});start=end+1;continue;}
  const safety=d.tail??'正常可用',trial=d.coldStart?'新模型试用':'常规候选',band=d.band===undefined?'AA未知档':`能力档${d.band+1}`,cost=costs[d.costClass??'unknown']??'计费未知';
  const range=table.bandRanges?.[JSON.stringify([d.tail??'',d.band])],top=range?.top,width=table.bandWidth;
  const num=(n:number)=>Number(n.toFixed(2)).toString();
  const ability=d.band===undefined?'未匹配到 AA 分数，单独归为未知档，排在同试用状态的已知能力档之后。':top===undefined?'快照缺少本档 AA 分数，无法还原分数范围。':width===undefined?`本档已记录的 AA 最高分为${num(top)}；快照未记录档宽，不推断范围。`:`本档 AA 范围 ${num(top-width)}–${num(top)}：以本安全层中该档最高分${num(top)}为基准，分差≤${num(width)}归为同档；更低分另开下一档。`;
  const abilitySummary=d.band===undefined?'未匹配到 AA 分数，归为未知档':range?`AA ${num(range.bottom)}–${num(range.top)} · 档顶 ${num(range.top)} · 档宽 ${width===undefined?'未记录':num(width)}`:'快照未记录 AA 档位范围';
  const explanation=[d.tail?`安全状态：${d.tail}。这些模型已置后，其他得分不能抵消。`:'安全状态相同：未触发持续报错、额度耗尽或首 token 超过20秒的置后条件。',d.coldStart?'没有请求及路由尝试记录，先试用获取观测；安全限制仍优先。':'已有请求或路由尝试记录，按常规层级排序。',`计费类型同为${cost}；同能力档内依次为免费、套餐/积分覆盖、计费未知、额外付费。`].join(' ');
  result.push({start,end,number,count,total,title:`第${number}层${continued?'（续）':''} · ${safety} · ${trial} · ${band} · ${cost}`,explanation,ability,abilitySummary,comparison:'仅在这一层内比较分数：层内分从高到低；跨层不比较分数。手动置顶模型独立归入第一层。'});start=end+1;
 }
 return result;
}
