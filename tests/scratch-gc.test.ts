import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scratchKeepReason } from '../src/dispatcher/scratch-gc.ts';
import { sweepInstanceDirs } from '../src/dispatcher/lifecycle-gc.ts';
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), 'scratch-gc-')); roots.push(path); return path; };
const git = (cwd: string, ...args: string[]) => { const out = Bun.spawnSync(['git', '-C', cwd, ...args]); if (out.exitCode !== 0) throw new Error('fixture git failed'); };

test('registered descendants and open files keep an old inactive scratch directory', async () => {
 const home = root(), path = join(home, 'engineering-codex-aaaaaa'); mkdirSync(path);
 utimesSync(path, new Date(0), new Date(0));
 for (const refs of [{registered:[join(path,'checkout')],open:[]},{registered:[],open:[join(path,'db/data')]}]) {
  const result = await sweepInstanceDirs({ root: home, now: new Date(), graceMs: 1, keep: new Set(), protect: p => scratchKeepReason(p,refs) });
  expect(result.removed).toEqual([]); expect(result.kept).toHaveLength(1); expect(existsSync(path)).toBe(true);
 }
});
test('uncommitted work and unknown/unmerged commits stay; only a clean merged clone is disposable', async () => {
 const path=root(); git(path,'init','-q'); git(path,'config','user.email','fixture@example.invalid'); git(path,'config','user.name','fixture');
 writeFileSync(join(path,'source.txt'),'base'); git(path,'add','.'); git(path,'commit','-qm','base');
 const refs={registered:[],open:[]};
 expect(await scratchKeepReason(path,refs)).toBe('unmerged-or-unknown-git-head');
 git(path,'update-ref','refs/remotes/origin/main','HEAD');
 expect(await scratchKeepReason(path,refs)).toBeUndefined();
 writeFileSync(join(path,'source.txt'),'work');
 expect(await scratchKeepReason(path,refs)).toBe('uncommitted-git-work');
 git(path,'commit','-qam','unmerged');
 expect(await scratchKeepReason(path,refs)).toBe('unmerged-or-unknown-git-head');
});
test('an inspection failure retains data, and a dry-run does not delete disposable bytes', async () => {
 const home=root(),path=join(home,'qa-codex-bbbbbb');mkdirSync(path);writeFileSync(join(path,'temp.bin'),'disposable');
 const base={root:home,now:new Date(Date.now()+1000),graceMs:0,keep:new Set<string>()};
 const failed=await sweepInstanceDirs({...base,protect:async()=>{throw new Error('unavailable');}});
 expect(failed.kept?.[0]?.reason).toBe('inspection-failed');expect(existsSync(path)).toBe(true);
 expect((await sweepInstanceDirs({...base,dryRun:true})).removed).toEqual(['qa-codex-bbbbbb']);expect(existsSync(path)).toBe(true);
 expect((await sweepInstanceDirs(base)).removed).toEqual(['qa-codex-bbbbbb']);expect(existsSync(path)).toBe(false);
});
test('recent nested evidence keeps a scratch root even when its root mtime is stale', async () => {
 const path=root(),nested=join(path,'evidence');mkdirSync(nested);writeFileSync(join(nested,'checkpoint.json'),'{}');
 utimesSync(path,new Date(0),new Date(0));
 expect(await scratchKeepReason(path,{registered:[],open:[],activeAfterMs:Date.now()-60000})).toBe('recent-nested-file');
 expect(await scratchKeepReason(path,{registered:[],open:[],activeAfterMs:Date.now()+60000})).toBeUndefined();
});
