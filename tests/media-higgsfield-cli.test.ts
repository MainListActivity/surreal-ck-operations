import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../src/core-errors.ts';
import { BrowserStudio } from '../src/media/browser.ts';
import { hfImage, spentLastDay, type HfExec, type HfRun } from '../src/media/higgsfield-cli.ts';

const NOW = Date.parse('2026-11-13T22:00:00Z');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ok = (value: unknown): HfExec => ({ code: 0, stdout: JSON.stringify(value), timedOut: false });

let root = '';
let calls: string[][] = [];
let spend: Array<{ action: string; credits: number; created_at: string }> = [];
let costs: Record<string, HfExec> = {};
let create: HfExec;
let body: Buffer = PNG;

const run: HfRun = async (args) => {
  calls.push(args);
  if (args[0] === 'account') return ok({ items: spend });
  if (args[1] === 'cost') return costs[args[2]] ?? ok({ credits: 9 });
  return create;
};
const fetchFn = (async () => new Response(new Uint8Array(body))) as unknown as typeof fetch;
const job = () => ({ prompt: 'a lighthouse at dusk', outDir: root, file: 'x.png', refs: [], timeoutMs: 300_000 });
const deps = { run, now: () => NOW, fetchFn, limits: { daily: 20, perJob: 0.5 } };
const created = () => calls.some(args => args[1] === 'create');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sck-hf-'));
  calls = [];
  spend = [{ action: 'spend', credits: -1, created_at: '2026-11-13T21:00:00Z' }, { action: 'grant', credits: 600, created_at: '2026-11-12T14:00:00Z' }];
  costs = { gpt_image_2_6: ok({ credits: 0.25 }), kling_omni_image: ok({ credits: 0.5 }) };
  create = ok([{ status: 'completed', result_url: 'https://cdn.example/x.png' }]);
  body = PNG;
});

describe('higgsfield CLI lane', () => {
  test('cheapest allowed model is cost-checked, created and saved as PNG', async () => {
    const result = await hfImage(job(), deps);
    expect(result).toMatchObject({ ok: true, via: 'gpt_image_2_6', credits: 0.25, bytes: PNG.length });
    expect(readFileSync(join(root, 'x.png'))).toEqual(PNG);
    expect(calls.find(args => args[1] === 'create')?.slice(0, 3)).toEqual(['generate', 'create', 'gpt_image_2_6']);
  });

  test('spend log counts only the trailing 24h of spends', async () => {
    spend.push({ action: 'spend', credits: -5, created_at: '2026-11-12T21:59:00Z' }, { action: 'refund', credits: 0.5, created_at: '2026-11-13T21:30:00Z' });
    expect(await spentLastDay(run, NOW)).toBe(0.5);
  });

  test('a job that would cross the daily cap never reaches create', async () => {
    spend.push({ action: 'spend', credits: -18.9, created_at: '2026-11-13T20:00:00Z' });
    const result = await hfImage(job(), deps);
    expect(result).toMatchObject({ ok: false, code: 'limit_reached' });
    expect(created()).toBe(false);
  });

  test('models above the per-job ceiling are skipped; none left means no create', async () => {
    costs = { gpt_image_2_6: ok({ credits: 2 }), kling_omni_image: ok({ credits: 0.5 }) };
    expect(await hfImage(job(), deps)).toMatchObject({ ok: true, via: 'kling_omni_image' });
    calls = [];
    costs = { gpt_image_2_6: ok({ credits: 2 }), kling_omni_image: ok({ credits: 1 }) };
    expect(await hfImage(job(), deps)).toMatchObject({ ok: false, code: 'limit_reached' });
    expect(created()).toBe(false);
  });

  test('an unreadable spend log fails closed', async () => {
    spend = [{ action: 'spend', credits: 'x' as never, created_at: '2026-11-13T21:00:00Z' }];
    expect(await hfImage(job(), deps)).toMatchObject({ ok: false, code: 'failed' });
    expect(created()).toBe(false);
  });

  test('logged-out CLI reports login_required without echoing output', async () => {
    costs.gpt_image_2_6 = { code: 1, stdout: '', stderr: 'Not authenticated. secret-prompt', timedOut: false };
    const result = await hfImage(job(), deps);
    expect(result).toMatchObject({ ok: false, code: 'login_required' });
    expect(result.message).not.toContain('secret-prompt');
  });

  test('a non-PNG result is rejected and nothing is written', async () => {
    body = Buffer.from('RIFF....WEBP');
    expect(await hfImage(job(), deps)).toMatchObject({ ok: false, code: 'failed' });
    expect(existsSync(join(root, 'x.png'))).toBe(false);
  });
});

describe('studio routing', () => {
  const core = {
    opsScope: async (_c: string, taskId: string) => ({ actor: { employeeId: 'emp-1', role: 'asset-production', capabilities: ['execute'] }, taskId, project: 'proj-1' }),
    auditOps: async () => {},
    opsCount: async () => 0,
  };
  let browserRan: string[] = [];
  const studio = (browserOk: boolean) => new BrowserStudio({
    core: core as never, evidenceRoot: root, hfRun: run, fetchFn, now: () => NOW,
    runner: async (provider) => {
      browserRan.push(provider);
      if (!browserOk) return { ok: false, code: 'login_required', message: 'x' };
      const file = join(root, 'task-1', 'media', 'x.png');
      mkdirSync(join(root, 'task-1', 'media'), { recursive: true });
      return { ok: true, file, bytes: 1 };
    },
  });
  beforeEach(() => { browserRan = []; for (const k of Object.keys(process.env)) if (k.startsWith('SCK_HIGGSFIELD_')) delete process.env[k]; });

  test('auto uses the paid CLI only after every free lane failed', async () => {
    const value = await studio(false).call('holder', 'task-1', 'media_image', { prompt: 'a lighthouse at dusk', file: 'x.png' }) as { provider: string; credits: number };
    expect(browserRan).toEqual(['chatgpt', 'higgsfield', 'gemini', 'grok']);
    expect(value).toMatchObject({ provider: 'higgsfield-cli', credits: 0.25 });
  });

  test('a free lane that succeeds never touches the CLI', async () => {
    await studio(true).call('holder', 'task-1', 'media_image', { prompt: 'a lighthouse at dusk', file: 'x.png' });
    expect(calls).toEqual([]);
  });

  test('video never routes to the CLI', async () => {
    const error = await studio(false).call('holder', 'task-1', 'media_video', { prompt: 'a lighthouse at dusk', file: 'x.mp4', provider: 'higgsfield-cli' })
      .then(() => undefined, (e: unknown) => e as CompanyError);
    expect(error?.code).toBe('invalid');
    expect(calls).toEqual([]);
  });
});
