import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../src/core-errors.ts';
import { BROWSER_TOOLS, BrowserStudio } from '../src/media/browser.ts';

let root = '';
let role = 'asset-production';
let counts: Record<string, number> = {};
let audits: Array<{ task: string; action: string; evidence: string }> = [];
let ran: Array<{ provider: string; script: string }> = [];
// Scripted per-provider results, consumed in call order; last entry repeats.
let results: Array<{ ok: boolean; code?: string; message?: string; file?: string; bytes?: number; notebook?: string; url?: string; notebooks?: unknown; text?: string; title?: string; turns?: unknown; sha256?: string; source?: string }> = [];
let ref = '';

const core = {
  opsScope: async (credential: string, taskId: string) => {
    if (credential !== 'holder') throw new CompanyError('forbidden', 'Ops tools are only available to the current lease holder of the task');
    return { actor: { employeeId: 'emp-1', role, capabilities: ['execute'] }, taskId, project: 'proj-1' };
  },
  auditOps: async (scope: { taskId: string }, action: string, evidence: string) => { audits.push({ task: scope.taskId, action, evidence }); },
  opsCount: async (_project: string, action: string) => counts[action] ?? 0,
};

const studio = () => new BrowserStudio({
  core: core as never,
  evidenceRoot: root,
  runner: async (provider, script) => {
    ran.push({ provider, script });
    const result = results.length > 1 ? results.shift()! : results[0];
    if (result?.ok && !result.file) {
      const name = script.match(/"file":"([^"]+)"/)?.[1] ?? 'x.png';
      const file = join(root, 'task-1', 'media', name);
      writeFileSync(file, 'px');
      result.file = file;
      result.bytes = 2;
    }
    return result ?? { ok: false, code: 'failed', message: 'no scripted result' };
  },
});

const call = (s: BrowserStudio, tool: string, args: Record<string, unknown> = {}, credential = 'holder') => s.call(credential, 'task-1', tool, args);
async function fail(promise: Promise<unknown>): Promise<CompanyError> {
  try { await promise; } catch (error) { return error as CompanyError; }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sck-browser-'));
  role = 'asset-production';
  counts = {};
  audits = [];
  ran = [];
  results = [{ ok: true }];
  ref = join(root, 'ref.png');
  writeFileSync(ref, 'ref');
  for (const name of Object.keys(process.env)) if (name.startsWith('SCK_BROWSER_')) delete process.env[name];
});

describe('media_image', () => {
  test('writes to the leased task evidence dir, audits provider and prompt', async () => {
    const value = await call(studio(), 'media_image', { prompt: 'painterly portrait of the heroine, transparent background', file: 'hero.png' }) as any;
    expect(value.provider).toBe('chatgpt'); // ROUTES.image[0]
    expect(value.file).toContain(join('task-1', 'media'));
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('ops_browser_image');
    expect(audits[0].evidence).toContain('media_image chatgpt hero.png');
  });

  test('provider=auto fails over on limit_reached and reports attempts', async () => {
    results = [
      { ok: false, code: 'limit_reached', message: 'weekly limit' },
      { ok: true },
    ];
    const value = await call(studio(), 'media_image', { prompt: 'a hallway scene, 16:9, painterly', file: 'hall.png' }) as any;
    expect(value.provider).toBe('gemini');
    expect(value.attempts).toEqual(['chatgpt: limit_reached']);
    expect(ran.map(r => r.provider)).toEqual(['chatgpt', 'gemini']);
  });

  test('last provider failure maps code: login_required → not_configured, limit_reached → limit_reached', async () => {
    results = [
      { ok: false, code: 'login_required', message: 'session expired' },
      { ok: false, code: 'limit_reached', message: 'Resets Oct 16' },
      { ok: false, code: 'login_required', message: 'session expired' },
    ];
    const error = await fail(call(studio(), 'media_image', { prompt: 'a portrait of the character', file: 'p.png' }));
    expect(error.code).toBe('not_configured');
    expect(error.message).toContain('chatgpt');
    results = [{ ok: false, code: 'limit_reached', message: 'Resets Oct 16' }];
    const limited = await fail(call(studio(), 'media_image', { prompt: 'a portrait of the character', file: 'p.png', provider: 'grok' }));
    expect(limited.code).toBe('limit_reached');
    expect(limited.message).toContain('Resets Oct 16');
  });

  test('single requested provider skips failover', async () => {
    results = [{ ok: false, code: 'failed', message: 'timeout' }];
    await fail(call(studio(), 'media_image', { prompt: 'a portrait of the character', file: 'p.png', provider: 'gemini' }));
    expect(ran.map(r => r.provider)).toEqual(['gemini']);
  });

  test('rejects bad file name, oversized refs, unknown provider, non-lease-holder, wrong role', async () => {
    const s = studio();
    expect((await fail(call(s, 'media_image', { prompt: 'a portrait of the character', file: '../x.png' }))).code).toBe('invalid');
    expect((await fail(call(s, 'media_image', { prompt: 'a portrait of the character', file: 'x.png', refs: [ref, ref, ref, ref, ref] }))).code).toBe('invalid');
    expect((await fail(call(s, 'media_image', { prompt: 'a portrait of the character', file: 'x.png', refs: ['relative/ref.png'] }))).code).toBe('invalid');
    expect((await fail(call(s, 'media_image', { prompt: 'a portrait of the character', file: 'x.png', provider: 'midjourney' }))).code).toBe('invalid');
    expect((await fail(call(s, 'media_image', { prompt: 'a portrait of the character', file: 'x.png' }, 'intruder'))).code).toBe('forbidden');
    role = 'product';
    expect((await fail(call(s, 'media_image', { prompt: 'a portrait of the character', file: 'x.png' }))).code).toBe('forbidden');
  });

  test('daily cap blocks before any browser run', async () => {
    counts['ops_browser_image'] = 120;
    const error = await fail(call(studio(), 'media_image', { prompt: 'a portrait of the character', file: 'x.png' }));
    expect(error.code).toBe('limit_reached');
    expect(ran).toHaveLength(0);
  });
});

describe('media_video', () => {
  test('routes to gemini by default, accepts mp4/webm names only', async () => {
    const value = await call(studio(), 'media_video', { prompt: 'slow push-in on the balcony scene, rain on glass', file: 'clip.mp4', seconds: 6 }) as any;
    expect(value.provider).toBe('gemini');
    expect(ran[0].script).toContain('"kind":"video"');
    expect((await fail(call(studio(), 'media_video', { prompt: 'slow push-in on the balcony scene', file: 'clip.avi' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_video', { prompt: 'slow push-in on the balcony scene', file: 'clip.mp4', seconds: 30 }))).code).toBe('invalid');
  });

  test('chatgpt is not a video provider', async () => {
    expect((await fail(call(studio(), 'media_video', { prompt: 'slow push-in on the balcony scene', file: 'clip.mp4', provider: 'chatgpt' }))).code).toBe('invalid');
  });
});

describe('notebook lane', () => {
  test('notebook_list is ungated and returns notebooks from the runner', async () => {
    counts['ops_browser_notebook'] = 200; // at cap; reads still allowed
    results = [{ ok: true, notebooks: [{ id: '7104ed40-x', title: '科幻主题故事', sources: '2' }] }];
    const value = await call(studio(), 'notebook_list') as any;
    expect(value.notebooks[0].title).toBe('科幻主题故事');
    expect(audits[0].action).toBe('ops_browser_notebook');
  });

  test('notebook_query validates args, gates quota, writes md to evidence dir', async () => {
    const s = studio();
    expect((await fail(call(s, 'notebook_query', { notebook: '梦痕纪元·卷1', prompt: '根据圣经写第一章开场段落' }))).code).toBe('invalid'); // missing file
    expect((await fail(call(s, 'notebook_query', { notebook: 'xx', prompt: '根据圣经写第一章开场段落', file: 'a.txt' }))).code).toBe('invalid'); // wrong ext
    results = [{ ok: true, file: join(root, 'task-1', 'media', 'draft.md'), bytes: 1200, text: '2089年，林深扣紧骨传导耳机。' }];
    const value = await call(s, 'notebook_query', { notebook: '梦痕纪元·卷1', prompt: '根据圣经写第一章开场，500字', file: 'draft.md' }) as any;
    expect(value.file).toContain('draft.md');
    expect(value.text).toContain('林深'); // inline answer doubles as the lookup path
    expect(ran[0].provider).toBe('notebook');
    expect(ran[0].script).toContain('"notebookOp":"query"');
    expect(audits.at(-1)!.evidence).toContain('notebook_query');
    counts['ops_browser_notebook'] = 200;
    expect((await fail(call(s, 'notebook_query', { notebook: 'x', prompt: '写第二章', file: 'b.md' }))).code).toBe('limit_reached');
  });

  test('notebook_add_source and notebook_create route to the notebook provider', async () => {
    const s = studio();
    results = [{ ok: true, notebook: '7104ed40-20f5' }];
    await call(s, 'notebook_add_source', { notebook: '科幻主题故事', title: 'v01c01-开场', text: '第一章正文内容，足够长的测试文本。' });
    expect(ran[0].script).toContain('"notebookOp":"add_source"');
    expect(ran[0].script).toContain('第一章正文内容');
    results = [{ ok: true, notebook: 'new-id-123', url: 'https://notebook.google.com/notebook/new-id-123' }];
    const created = await call(s, 'notebook_create', { title: '梦痕纪元·卷2' }) as any;
    expect(created.url).toContain('new-id-123');
    expect((await fail(call(s, 'notebook_add_source', { notebook: 'x', text: 'short' }))).code).toBe('invalid');
  });

  test('notebook errors map codes like the media lane', async () => {
    results = [{ ok: false, code: 'login_required', message: 'session expired' }];
    const e1 = await fail(call(studio(), 'notebook_query', { notebook: 'xx', prompt: '根据圣经写第一章开场段落', file: 'a.md' }));
    expect(e1.code).toBe('not_configured');
    expect(e1.message).toContain('session expired');
  });

  test('notebook_write routes to the Gemini notebook shell and returns text', async () => {
    const s = studio();
    results = [{ ok: true, file: join(root, 'task-1', 'media', 'draft.md'), bytes: 800, text: '地下二十八公里的死寂……', url: 'https://gemini.google.com/app/abc123' }];
    const value = await call(s, 'notebook_write', { notebook: '梦痕纪元', prompt: '根据卷一概要写第三章开场，文风与已写两章一致，500字', file: 'draft.md' }) as any;
    expect(value.text).toContain('地下二十八公里');
    expect(value.url).toContain('gemini.google.com/app/');
    expect(ran[0].provider).toBe('notebook');
    expect(ran[0].script).toContain('"notebookOp":"write"');
    expect(ran[0].script).toContain('gemini.google.com/notebook/');
    expect(audits.at(-1)!.action).toBe('ops_browser_notebook');
    expect((await fail(call(s, 'notebook_write', { notebook: 'x', prompt: '写点东西出来看看效果如何', file: 'a.txt' }))).code).toBe('invalid');
    // 一章一个会话：chat 参数回链到既有会话继续写
    results = [{ ok: true, file: join(root, 'task-1', 'media', 'p2.md'), bytes: 500, text: '第二段……', url: 'https://gemini.google.com/app/abc123' }];
    await call(s, 'notebook_write', { notebook: '梦痕纪元', prompt: '继续写下一段正文，承接上一段', file: 'p2.md', chat: 'https://gemini.google.com/app/abc123' });
    expect(ran.at(-1)!.script).toContain('"chat":"https://gemini.google.com/app/abc123"');
    expect(ran.at(-1)!.script).toContain('gemini.google.com/app/');
    // 产物文件尾自动落会话标记，供返修补丁回到同一会话
    expect(ran.at(-1)!.script).toContain('gemini-session');
  });

  test('notebook_recover: authorized chat only, probe lists turns, turn+file extracts', async () => {
    const s = studio();
    // chat is mandatory — recover is bound to an authorized existing conversation
    expect((await fail(call(s, 'notebook_recover', { turn: 2, file: 'a.md' }))).code).toBe('invalid');
    // turn + file travel together: extraction needs a destination
    expect((await fail(call(s, 'notebook_recover', { chat: 'https://gemini.google.com/app/abc123', turn: 2 }))).code).toBe('invalid');
    expect((await fail(call(s, 'notebook_recover', { chat: 'abc123', turn: 2, file: 'a.txt' }))).code).toBe('invalid');
    // probe mode (no turn): lists the turn map, no file needed
    results = [{ ok: true, url: 'https://gemini.google.com/app/abc123', turns: [{ i: 0, role: 'user', len: 100 }, { i: 1, role: 'model', len: 8000 }] }];
    const map = await call(s, 'notebook_recover', { chat: 'https://gemini.google.com/app/abc123' }) as any;
    expect(map.turns[1].role).toBe('model');
    expect(ran[0].provider).toBe('notebook');
    expect(ran[0].script).toContain('"notebookOp":"recover"');
    expect(ran[0].script).toContain('gemini.google.com/app/');
    const recoverBlock = ran[0].script.slice(ran[0].script.indexOf("ARGS.notebookOp === 'recover'"), ran[0].script.indexOf('const nbId'));
    expect(recoverBlock).not.toContain('notebook.google.com'); // never opens the notebook
    // ungated read like list: still allowed at the daily cap (no model quota spent)
    counts['ops_browser_notebook'] = 200;
    results = [{ ok: true, file: join(root, 'task-1', 'media', 'r.md'), bytes: 10, sha256: 'deadbeef', source: 'gemini:abc123#i3' }];
    const got = await call(s, 'notebook_recover', { chat: 'abc123', turn: 2, file: 'r.md' }) as any;
    expect(got.source).toContain('abc123');
    expect(got.sha256).toBe('deadbeef');
    expect(ran.at(-1)!.script).toContain('"turn":2');
    expect(audits.at(-1)!.evidence).toContain('notebook_recover');
  });

  test('notebook_remove_source routes with title and gates quota', async () => {
    const s = studio();
    expect((await fail(call(s, 'notebook_remove_source', { notebook: 'x' }))).code).toBe('invalid'); // missing title
    results = [{ ok: true, notebook: 'nb-1', title: '卷一 正文汇编' }];
    const value = await call(s, 'notebook_remove_source', { notebook: '梦痕纪元', title: '卷一 正文汇编' }) as any;
    expect(value.op).toBe('remove_source');
    expect(ran[0].script).toContain('"notebookOp":"remove_source"');
    expect(ran[0].script).toContain('卷一 正文汇编');
    counts['ops_browser_notebook'] = 200;
    expect((await fail(call(s, 'notebook_remove_source', { notebook: 'x', title: 'y' }))).code).toBe('limit_reached');
  });
});

describe('media_browser_info and serialisation', () => {
  test('info reports routes, quotas and last provider error', async () => {
    counts['ops_browser_image'] = 3;
    const s = studio();
    results = [{ ok: false, code: 'login_required', message: 'expired' }];
    await fail(call(s, 'media_image', { prompt: 'a portrait of the character', file: 'x.png', provider: 'grok' }));
    const info = await call(s, 'media_browser_info') as any;
    expect(info.providers.image).toEqual(['chatgpt', 'gemini', 'grok']);
    expect(info.quotas.image.used).toBe(3);
    expect(info.providerStatus.grok).toContain('login_required');
  });

  test('jobs serialize on the shared browser profile', async () => {
    let active = 0;
    let maxActive = 0;
    const s = new BrowserStudio({
      core: core as never,
      evidenceRoot: root,
      runner: async (provider, script) => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise(res => setTimeout(res, 20));
        active--;
        const file = join(root, 'task-1', 'media', 'x.png');
        writeFileSync(file, 'px');
        return { ok: true, file, bytes: 2 };
      },
    });
    await Promise.all([
      call(s, 'media_image', { prompt: 'first portrait of the heroine', file: 'x.png', provider: 'grok' }),
      call(s, 'media_image', { prompt: 'second portrait of the heroine', file: 'x.png', provider: 'grok' }),
      call(s, 'media_image', { prompt: 'third portrait of the heroine', file: 'x.png', provider: 'grok' }),
    ]);
    expect(maxActive).toBe(1);
  });
});
