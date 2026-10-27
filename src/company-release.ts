import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { CompanyError } from './core-errors.ts';
const exec = promisify(execFile);
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
export async function git(repo:string,args:string[]):Promise<string>{
 try{return (await exec('git',['-C',repo,...args],{timeout:30_000,maxBuffer:128_000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();}
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
 const path=await realpath(join(home,'active'));
 const sha=basename(path);
 if(!/^[a-f0-9]{40}$/.test(sha))throw new CompanyError('invalid','现役版本目录无法核验');
 const pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8'));
 if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new CompanyError('invalid','现役版本号无效');
 return {version:pkg.version,sha,path};
}
