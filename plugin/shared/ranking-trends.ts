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
