import {defineRpc} from '@getpaseo/plugin';
import {z} from 'zod';
export interface HistoryEntry {role:string;at?:string;text:string}
export interface SessionHistory {title:string;provider:string;entries:HistoryEntry[];next?:number;nextTextOffset?:number;notice?:string}
export const sessionHistory=defineRpc({name:'company.session.history',input:z.object({agentId:z.string().uuid(),cursor:z.number().int().min(0).default(0),textOffset:z.number().int().min(0).max(262144).default(0)}),output:z.custom<SessionHistory>(v=>!!v&&typeof v==='object')});
