import { z } from 'zod';
import { createHash } from 'node:crypto';
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
export type CompanyRelease = ReleaseNotes & {sha:string;digest:string};
export const releaseDigest=(v:ReleaseNotes&{sha:string})=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
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
/**
 * The local release gates a version must have passed on this host before it may be installed.
 *
 * The two historical gates are always required. The recovery-fork gate is part of the contract of the releases
 * that carry it (0.3.76 and later): a release before that does not know the gate, so demanding its record would
 * make a rollback to an older release impossible — and a rollback has to keep working. The same rule is mirrored
 * in scripts/company-service.sh (required_gates), which reads the version from the release's own package.json.
 */
export const BASE_GATES = ['comm-slow-pipe', 'sidecar-review'] as const;
/** The script argument of each gate, as scripts/release-gate.sh names it. */
export const GATE_ARGUMENTS: Record<string, string> = {
  'comm-slow-pipe': 'slow-pipe',
  'sidecar-review': 'sidecar-review',
  'recovery-fork': 'recovery-fork',
};
export const RELEASE_GATE_SETS: { version: string; gates: string[] }[] = [
  { version: '0.3.76', gates: [...BASE_GATES, 'recovery-fork'] },
];
/** The gates a target version must have passed: the newest set that is not newer than the target. */
export function gatesFor(version: string): string[] {
  let chosen: { version: string; gates: string[] } | undefined;
  for (const set of RELEASE_GATE_SETS) {
    if (compareRelease(set.version, version) > 0) continue;
    if (!chosen || compareRelease(set.version, chosen.version) > 0) chosen = set;
  }
  return chosen ? [...chosen.gates] : [...BASE_GATES];
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
export async function readCompanyRelease(repo:string,sha:string):Promise<CompanyRelease>{
 if(!/^[a-f0-9]{40}$/.test(sha))throw new CompanyError('invalid','升级需要完整的 main 提交 SHA');
 await git(repo,['merge-base','--is-ancestor',sha,'origin/main']);
 const raw=await git(repo,['show',`${sha}:company-release.json`]);
 let notes:ReleaseNotes;
 try{notes=releaseNotesSchema.parse(JSON.parse(raw));}catch{throw new CompanyError('invalid','缺少有效版本号或升级说明，请工程完善 company-release.json');}
 const pkg=JSON.parse(await git(repo,['show',`${sha}:package.json`]));
 if(pkg.version!==notes.version)throw new CompanyError('invalid','版本说明与 package.json 版本不一致');
 const plan={...notes,sha};return {...plan,digest:releaseDigest(plan)};
}
export async function installedRelease(home:string):Promise<{version:string;sha:string;path:string}>{
 const io=hostIO();
 const path=await io.fs.realpathAsync(io.path.join(home,'active'));
 const sha=io.path.basename(path);
 if(!/^[a-f0-9]{40}$/.test(sha))throw new CompanyError('invalid','现役版本目录无法核验');
 const pkg=JSON.parse(await io.fs.readTextAsync(io.path.join(path,'package.json')));
 if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new CompanyError('invalid','现役版本号无效');
 return {version:pkg.version,sha,path};
}
