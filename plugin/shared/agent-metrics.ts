import {defineRpc} from '@getpaseo/plugin';
import {z} from 'zod';
const n=z.number().finite().nonnegative();
export const requestMetricsSchema=z.object({
 id:z.string(),at:n,endedAt:n.optional(),model:z.string().optional(),status:n,completed:z.boolean().optional(),
 source:z.enum(['company-gateway','magpie-session']),turnKey:z.string().optional(),
 total_ms:n.optional(),ttft_ms:n.optional(),first_text_ms:n.optional(),output_tokens:n.optional(),input_tokens:n.optional(),cache_read_tokens:n.optional(),reported_model:z.string().optional(),decodeTokensPerSecond:n.optional(),decodeDurationMs:n.optional(),
});
export const turnMetricsSchema=z.object({
 requests:n,successful:n,failed:n,inFlight:n,models:z.array(z.object({id:z.string(),requests:n})),
 firstResponseMs:n.optional(),firstTextMs:n.optional(),meanResponseMs:n.optional(),outputTokens:n.optional(),tokensPerSecond:n.optional(),decodeTokensPerSecond:n.optional(),timedRequests:n,tokenRequests:n,partial:z.boolean(),
});
export const agentMetricsViewSchema=z.object({
 agentId:z.string(),source:z.enum(['company-gateway','magpie-session','unavailable']),
 turn:z.object({key:z.string(),startedAt:n,endedAt:n.optional(),partial:z.boolean()}).optional(),
 summary:turnMetricsSchema,latest:requestMetricsSchema.optional(),updatedAt:n,note:z.string().optional(),
});
export type AgentMetricsView=z.output<typeof agentMetricsViewSchema>;
export const agentMetrics=defineRpc({name:'company.agent-model-metrics.get',input:z.object({agentId:z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)}),output:agentMetricsViewSchema});
export const metricNumber=(v:number|undefined,decimals=1)=>v===undefined?'未知':v.toFixed(decimals);
export const metricSeconds=(v:number|undefined)=>v===undefined?'未知':`${(v/1000).toFixed(2)} 秒`;
