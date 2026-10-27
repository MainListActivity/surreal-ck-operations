import type { ModelRankingTable } from "./types.ts";
import type { MetricTrend } from './model-trends.ts';
/** Same wording on the Paseo card and the browser card. No runtime imports from the server. */
export function rankingTrendDetail(t?: MetricTrend): string {
  if(!t || !t.baseline.samples)return '趋势未知：暂无有效历史';
  const format=(v?:number)=>{
    if(v===undefined)return '未知';
    if(t.unit==='ms')return (v/1000).toFixed(2)+'秒';
    if(t.unit==='ratio')return (v*100).toFixed(1)+'%';
    return v.toFixed(2)+(t.unit==='percent'?'%':t.unit==='tokens/s'?' tok/s':'');
  };
  const changed=t.change.detected?(t.change.direction==='up'?'突升':'突降'):'未检出突变';
  const age=t.ageMs===undefined?'':` · 距最新样本${Math.floor(t.ageMs/60000)}分钟`;
  return `当前 ${format(t.current)} · EWMA ${format(t.ewma)} · 斜率 ${t.slopePerMinute!==undefined&&(t.unit==='ratio'||t.unit==='percent')?(t.slopePerMinute*(t.unit==='ratio'?100:1)).toFixed(2)+'百分点':format(t.slopePerMinute)}/分钟 · ${changed} · 7天基线 ${format(t.baseline.mean)} · 近期${t.samples}个${t.sampleUnit==='task'?'任务':t.sampleUnit==='snapshot'?'变动快照':'请求'} · ${t.sufficient?'样本充分':'样本不足或过期'}${age}`;
}

/** Shared by the Paseo page and the web review console (embedded there by toString, so self-contained). */
export function rankingHealthMetric(health: ModelRankingTable["rows"][number]["health"]): { value: string; detail: string } {
  const reasons = { unavailable: "被拒绝（无权限，或订阅不提供）", consecutive_errors: "连续报错", error_rate: "报错率过高" };
  if (!health) return { value: "未知", detail: "近 24 小时没有路由尝试记录" };
  const last = health.lastStatus === undefined ? "" : `，最近一次 HTTP ${health.lastStatus}`;
  return { value: `${health.errors}/${health.attempts} 失败`,
    detail: health.excluded ? `${reasons[health.reason ?? "consecutive_errors"]}${last}：已移到组末尾，不参与正常优先排序，恢复成功后自动回到排序` : `近 24 小时含被转给下一个成员的尝试${last}` };
}

/** A rule label, never presented as a probabilistic model score. */
export function rankingRuleLabel(row:{pinned?:boolean;health?:{excluded:boolean};decision?:{tail?:string;band?:number;coldStart?:boolean}}):string {
 if(row.health?.excluded||row.decision?.tail)return '置后';
 if(row.decision?.coldStart)return '新模型试用';
 if(row.pinned)return '置顶';
 return row.decision?.band===undefined?'待测':`能力档 ${row.decision.band+1}`;
}
