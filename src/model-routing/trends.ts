import {createHash} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MINUTE = 60_000, DAY = 1440 * MINUTE;
const MIN_TREND_SPAN_MS = 1000;
export interface Sample { at: number; value: number }
export interface MetricTrend {
  unit: string;
  sampleUnit: 'request' | 'task' | 'snapshot';
  current?: number; ewma?: number; slopePerMinute?: number;
  samples: number; lastSampleAt?: string; ageMs?: number; sufficient: boolean;
  change: { detected: boolean; direction?: 'up' | 'down'; at?: string; before?: number; after?: number };
  baseline: { samples: number; mean?: number };
  windows: Record<string, { samples: number; mean?: number; p50?: number; p90?: number }>;
}
export type ModelTrends = Record<string, MetricTrend>;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mean = (rows: Sample[]) => rows.length ? rows.reduce((sum, r) => sum + r.value, 0) / rows.length : undefined;
const round = (v: number | undefined) => v === undefined ? undefined : Math.round(v * 10000) / 10000;
function summary(rows: Sample[]) {
  const values = rows.map(r => r.value).sort((a,b) => a-b);
  const quantile = (q: number) => values.length ? values[Math.ceil(q * values.length)-1] : undefined;
  return { samples: rows.length, mean: round(mean(rows)), p50: round(quantile(.5)), p90: round(quantile(.9)) };
}
/** Last 20 observations stop a high-volume past from swallowing a recent change. All time decay and slopes use timestamps. */
export function metricTrend(input: Sample[], now: number, unit: string, sampleUnit: MetricTrend['sampleUnit']): MetricTrend {
  const rows = input.filter(r => finite(r.at) && finite(r.value) && r.at <= now && r.at >= now-7*DAY).sort((a,b) => a.at-b.at);
  // Task results and value-change gauges are sparse; request-scale freshness would
  // incorrectly mark a daily accepted task or AA update as stale within minutes.
  const windowMs=sampleUnit==='request'?60*MINUTE:7*DAY;
  const halfLifeMs=sampleUnit==='request'?5*MINUTE:DAY;
  const staleAfterMs=sampleUnit==='request'?15*MINUTE:7*DAY;
  const recent = rows.filter(r => r.at >= now-windowMs).slice(-20);
  const last = rows.at(-1);
  const age = last ? now-last.at : undefined;
  let ewma: number | undefined, slope: number | undefined;
  if (recent.length) {
    const end = recent.at(-1)!.at;
    const weights = recent.map(r => Math.exp(-Math.LN2*(end-r.at)/halfLifeMs));
    ewma = recent.reduce((s,r,i) => s+r.value*weights[i]!,0)/weights.reduce((s,w)=>s+w,0);
    const origin = recent[0]!.at;
    const xs = recent.map(r => (r.at-origin)/MINUTE);
    const mx = xs.reduce((s,x)=>s+x,0)/xs.length, my = mean(recent)!;
    const variance = xs.reduce((s,x)=>s+(x-mx)**2,0);
    if (recent.length >= 5 && end-origin >= MIN_TREND_SPAN_MS && variance > 0)
      slope = recent.reduce((s,r,i)=>s+(xs[i]!-mx)*(r.value-my),0)/variance;
  }
  // Two consecutive small batches: one outlier never declares a change point.
  const previous = recent.slice(-10,-5), current = recent.slice(-5);
  const before = mean(previous), after = mean(current);
  const spread = previous.length ? Math.sqrt(previous.reduce((s,r)=>s+(r.value-before!)**2,0)/previous.length) : 0;
  const floor = unit === 'ms' ? 500 : unit === 'ratio' ? .05 : unit === 'score' ? .25 : unit === 'percent' ? 5 : unit === 'USD/1M' ? .001 : 1;
  const delta = before === undefined || after === undefined ? 0 : after-before;
  const detected = previous.length === 5 && current.length === 5 && current[0]!.at>previous.at(-1)!.at && age! <= staleAfterMs &&
    Math.abs(delta) > Math.max(floor,Math.abs(before!)*.25,spread*3) &&
    current.filter(r => delta > 0 ? r.value>before! : r.value<before!).length >= 4;
  return {
    unit, sampleUnit, current: round(last?.value), ewma: round(ewma), slopePerMinute: round(slope), samples: recent.length,
    lastSampleAt: last ? new Date(last.at).toISOString() : undefined, ageMs: age,
    sufficient: recent.length >= 5 && age! <= staleAfterMs && recent.at(-1)!.at-recent[0]!.at >= MIN_TREND_SPAN_MS,
    change: detected ? { detected, direction: delta>0?'up':'down', at:new Date(current[0]!.at).toISOString(),before:round(before),after:round(after) } : { detected:false },
    baseline: { samples:rows.length, mean:round(mean(rows)) },
    windows:rows.length ? Object.fromEntries([['15m',15*MINUTE],['1h',60*MINUTE],['24h',DAY],['7d',7*DAY]].map(([name,ms])=>[name,summary(rows.filter(r=>r.at>=now-Number(ms)))])) : {},
  };
}

/** Magpie usage.Record.DecodeOf/DecodeWindow: reasoning and burst exclusions match its native summary. */
export function nativeDecode(r: Record<string, unknown>): number | undefined {
  let out = r.out, start = r.ttft_ms;
  const ms=r.ms, think=finite(r.reasoning)?r.reasoning:0, first=r.first_text_ms, flow=finite(r.flow_ms)?r.flow_ms:0;
  if (!finite(out) || !finite(start) || !finite(ms) || start<=0 || (r.reasoning_hidden===true && !(finite(first)&&first>0))) return;
  if (think>0) {
    if(finite(first)&&first>0) {out-=think;start=first;}
    else if(finite(r.first_reasoning_ms)&&r.first_reasoning_ms>=start&&flow>0&&think<=out) start=r.first_reasoning_ms;
    else return;
  }
  const window=ms-Number(start);
  if(out<=0 || window<100 || out*1000>10000*window || (flow>0&&flow*4<window)) return;
  if(think>0&&finite(first)&&first>0&&out*(first-Number(r.ttft_ms))>20*think*window) return;
  return out*1000/window;
}
export interface LargeRequest {id:string;model:string;at:number;accountKey?:string}
export interface UsageSamples { lastRequestAt?:Map<string,string>; largeRequests?:LargeRequest[]; rows: Map<string, Record<string,Sample[]>>; invalid: number }
/** Stream only numeric observations into memory. Accounts, request bodies and session IDs never enter the trend store. */
export async function readUsageSamples(now: number, file = join(homedir(),'.config/magpie/usage.jsonl')): Promise<UsageSamples> {
  const rows = new Map<string,Record<string,Sample[]>>(); let invalid=0;const latestRequests=new Map<string,number>();const largeRequests:LargeRequest[]=[];
  const records:Array<{key:string;at:number;metrics:Record<string,number>;failed:boolean;rejected:boolean;handedOn:boolean}>=[];
  const routes=new Map<string,number>();
  const stream=createReadStream(file,{encoding:'utf8'});
  const lines=createInterface({input:stream,crlfDelay:Infinity});
  try {
    for await (const line of lines) {
      let r:Record<string,unknown>;try{r=JSON.parse(line);}catch{invalid++;continue;}
      if(!r||typeof r!=='object'||Array.isArray(r)){invalid++;continue;}
      const at=typeof r.t==='string'?Date.parse(r.t):NaN;
      if(!finite(at)||at>now||typeof r.provider!=='string'||typeof r.model!=='string')continue;
      if(!finite(r.status)||r.status<0){invalid++;continue;}
      const modelKey=`${r.provider}/${r.model}`;
      if(at>(latestRequests.get(modelKey)??-Infinity))latestRequests.set(modelKey,at);
      if(at<now-7*DAY)continue;
      const metrics:Record<string,number>={};
      const put=(name:string,value:unknown)=>{if(finite(value))metrics[name]=value;};
      const failed=(typeof r.err==='string'&&r.err.length>0)||r.status>=400;
      put('errorRate',failed?1:0);
      if(!failed) {
        if(finite(r.ttft_ms)&&r.ttft_ms>0) {put('ttftMs',r.ttft_ms);put('ttftOver10sRate',r.ttft_ms>10000?1:0);put('ttftOver20sRate',r.ttft_ms>20000?1:0);}
        put('tokensPerSecond',nativeDecode(r));
        if([r.in,r.cache_read??0,r.cache_write??0].every(v=>finite(v)&&v>=0)) {
          const prompt=Number(r.in)+Number(r.cache_read??0)+Number(r.cache_write??0);
          if(prompt>0)put('cacheHitRate',Number(r.cache_read??0)/prompt);
        }
      }
      const prompt=[r.in,r.cache_read??0,r.cache_write??0];
      const endedAt=at+(finite(r.ms)&&r.ms>=0?r.ms:0);
      if(!failed&&r.status>=200&&r.status<300&&r.rejected!==true&&r.handed_on!==true&&finite(r.ms)&&r.ms>=0&&endedAt<=now&&prompt.every(v=>finite(v)&&v>=0)&&prompt.reduce<number>((s,v)=>s+Number(v),0)>50_000)
        largeRequests.push({id:createHash('sha256').update(line).digest('hex'),model:`${r.provider}/${r.model}`,at:endedAt,accountKey:typeof r.providerAccount==='string'&&r.providerAccount?createHash('sha256').update(`${r.provider}/${r.model}`.slice(0,`${r.provider}/${r.model}`.lastIndexOf('/'))+'|'+r.providerAccount).digest('hex'):undefined});
      // Older Magpie logs infer handed-on attempts from a later row of the same route.
      // Keep the integer text: route IDs can exceed JavaScript's safe integer range.
      const route=finite(r.route_id)&&r.route_id!==0?line.match(/"route_id"\s*:\s*(\d+)/)?.[1]:undefined;
      const previous=route===undefined?undefined:records[routes.get(route)??-1];
      if(previous?.failed&&!previous.rejected)previous.handedOn=true;
      if(route!==undefined)routes.set(route,records.length);
      records.push({key:`${r.provider}/${r.model}`,at,metrics,failed,rejected:r.rejected===true,handedOn:r.handed_on===true});
    }
  } finally {lines.close();stream.destroy();}
  for(const r of records) {
    if(r.handedOn)continue;
    const metrics=rows.get(r.key)??{};
    for(const [name,value] of Object.entries(r.metrics))(metrics[name]??=[]).push({at:r.at,value});
    rows.set(r.key,metrics);
  }
  return {rows,invalid,largeRequests,lastRequestAt:new Map([...latestRequests].map(([key,at])=>[key,new Date(at).toISOString()]))};
}

/** Sparse gauges are recorded only when their value/source version changes, never once per Jev read. */
export class GaugeHistory {
  private pending?: Promise<Record<string,Record<string,Sample[]>>>;
  constructor(private readonly file:string) {}
  update(values: Record<string,Record<string,number|undefined>>, now:number): Promise<Record<string,Record<string,Sample[]>>> {
    const prior=this.pending;
    const operation=(prior??Promise.resolve()).catch(()=>undefined).then(()=>this.write(values,now));
    const tracked=operation.finally(()=>{if(this.pending===tracked)this.pending=undefined;});
    this.pending=tracked;return tracked;
  }
  private async write(values:Record<string,Record<string,number|undefined>>,now:number) {
    let data:Record<string,Record<string,Sample[]>>={};
    try {data=JSON.parse(await readFile(this.file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('trend history unreadable');}
    for(const [id,metrics] of Object.entries(values)) {
      const stored=data[id]??={};
      for(const [name,value] of Object.entries(metrics)) {
        const history=(stored[name]??[]).filter(r=>finite(r.at)&&finite(r.value)&&r.at>=now-7*DAY&&r.at<=now);
        if(finite(value)&&history.at(-1)?.value!==value)history.push({at:now,value});
        stored[name]=history;
      }
    }
    // Removed models and old observations cannot grow this file forever.
    data=Object.fromEntries(Object.entries(data).filter(([id])=>id in values));
    await mkdir(join(this.file,'..'),{recursive:true,mode:0o700});
    await writeFile(this.file+'.tmp',JSON.stringify(data),{mode:0o600});await rename(this.file+'.tmp',this.file);
    return data;
  }
}
