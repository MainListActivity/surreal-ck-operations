import { z } from 'zod';
import { hostIO } from './host-io.ts';
import { CompanyError } from './core-errors.ts';
export const releaseNotesSchema = z.object({
  version:z.string().max(32).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  title:z.string().min(2).max(100),
  changes:z.array(z.string().min(2).max(240)).min(1).max(10),
  impact:z.array(z.string().min(2).max(240)).min(1).max(8),
  migration:z.string().min(2).max(400),
  rollback:z.string().min(2).max(400),
}).strict().refine(v=>Buffer.byteLength(JSON.stringify(v))<=5000,'Release notes exceed 5000 bytes');
export type ReleaseNotes = z.infer<typeof releaseNotesSchema>;
export function compareRelease(a:string,b:string):number {
 const aa=a.split('.').map(BigInt),bb=b.split('.').map(BigInt);
 for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]!>bb[i]!?1:-1;
 return 0;
}
/**
 * The schema a target version must have reached before it may be recorded as verified.
 *
 * A version only carries the requirements of the releases up to it: an older target keeps the older
 * minimum, so upgrading (or rolling back) to a historical version is not forced through a newer schema.
 * Each entry names the schema marker and the tables that must exist in the running database.
 */
export interface ReleaseSchemaRequirement { version: string; schema: number; tables: string[] }
/** The three tables schema 049 creates (removed again by schema 052). */
export const RECOVERY_READ_TABLES = ['recovery_read_grant', 'recovery_read_chain', 'recovery_read_call'] as const;
/** The oldest schema marker any release may be verified against. */
export const LEGACY_SCHEMA_MINIMUM = 41;
export const RELEASE_SCHEMA_REQUIREMENTS: ReleaseSchemaRequirement[] = [
  { version: '0.3.76', schema: 49, tables: [] },
  { version: '0.3.77', schema: 50, tables: [] },
  { version: '0.3.78', schema: 51, tables: ['outbound_message'] },
  { version: '0.3.79', schema: 52, tables: ['route'] },
  { version: '0.3.80', schema: 52, tables: [] },
  { version: '0.3.81', schema: 53, tables: ['lane_note'] },
  { version: '0.3.82', schema: 53, tables: [] },
  { version: '0.3.83', schema: 53, tables: [] },
  { version: '0.3.84', schema: 53, tables: [] },
  { version: '0.3.85', schema: 53, tables: [] },
  { version: '0.3.86', schema: 53, tables: [] },
  { version: '0.3.87', schema: 53, tables: [] },
  { version: '0.3.88', schema: 53, tables: [] },
  { version: '0.3.89', schema: 53, tables: [] },
  { version: '0.3.90', schema: 53, tables: [] },
  { version: '0.4.0', schema: 58, tables: ['protected_command', 'agent_policy', 'ops_audit', 'runner_heartbeat', 'ops_job', 'agent_identity', 'note_consolidation'] },
  { version: '0.4.1', schema: 58, tables: [] },
  { version: '0.4.2', schema: 59, tables: [] },
  { version: '0.4.3', schema: 59, tables: [] },
  { version: '0.5.0', schema: 60, tables: [] },
  { version: '0.6.0', schema: 61, tables: ['node_release', 'node_rollback'] },
  { version: '0.6.1', schema: 61, tables: [] },
  { version: '0.7.0', schema: 61, tables: [] },
  { version: '0.7.1', schema: 62, tables: [] },
  { version: '0.8.0', schema: 62, tables: [] },
  { version: '0.9.0', schema: 63, tables: ['product_iteration', 'product_feedback', 'product_feedback_rate', 'product_requirement', 'requirement_approval', 'requirement_plan', 'requirement_execution', 'requirement_release_approval'] },
  { version: '0.9.1', schema: 63, tables: [] },
  { version: '0.10.0', schema: 64, tables: ['task', 'outbound_message', 'route'] },
  { version: '0.10.1', schema: 64, tables: ['task', 'outbound_message', 'route'] },
  { version: '0.10.2', schema: 64, tables: ['task', 'outbound_message', 'route'] },
];
/** The requirement that applies to a target version: the newest one that is not newer than the target. */
export function schemaRequirementFor(version: string): { schema: number; tables: string[] } {
  let chosen: ReleaseSchemaRequirement | undefined;
  for (const requirement of RELEASE_SCHEMA_REQUIREMENTS) {
    if (compareRelease(requirement.version, version) > 0) continue;
    if (!chosen || compareRelease(requirement.version, chosen.version) > 0) chosen = requirement;
  }
  return chosen ? { schema: chosen.schema, tables: [...chosen.tables] } : { schema: LEGACY_SCHEMA_MINIMUM, tables: [] };
}
export async function git(repo:string,args:string[]):Promise<string>{
 const host=hostIO();
 try{
  const result=await host.proc.run('git',['-C',repo,...args],{timeoutMs:30_000,maxBytes:128_000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
  if(result.code!==0)throw new Error('git exited with a failure code');
  return result.stdout.trim();
 }
 catch{throw new CompanyError('invalid','版本校验失败：目标必须已合入 origin/main，且可从本机仓库读取');}
}
