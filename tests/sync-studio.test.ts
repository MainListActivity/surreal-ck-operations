import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../src/core-errors.ts';
import { SYNC_TOOLS, SyncStudio, type SyncDeps } from '../src/media/sync.ts';
import type { MediaVault, VaultReply } from '../src/media/vault.ts';

// All fixtures here are simulated: they prove the code path, never that a real sync account is ready.

interface VaultCall { kind: string; params: Record<string, any> }
const KEY_FP = 'FP-SYNC-01';
let root = '';
let home = '';
let role = 'qa';
let counts: Record<string, number> = {};
let audits: Array<{ task: string; action: string; evidence: string }> = [];
let vaultCalls: VaultCall[] = [];
let fetches: Array<{ url: string; method: string }> = [];
let syncConfigured = true;
let accountFp = KEY_FP;
let clock = 1_700_000_000_000;
let reply: (call: VaultCall) => VaultReply = () => json({});
let seq = 0;

const json = (value: unknown, status = 200, headers?: Record<string, string>): VaultReply =>
  ({ status, contentType: 'application/json', body: Buffer.from(JSON.stringify(value)), headers });
const text = (value: string, status = 200): VaultReply => ({ status, contentType: 'text/plain', body: Buffer.from(value) });
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

// ---------- minimal valid media fixtures ----------

const box = (type: string, payload: Buffer): Buffer => {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 'latin1');
  payload.copy(out, 8);
  return out;
};
const times = (timescale: number, duration: number): Buffer => {
  const payload = Buffer.alloc(32);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return payload;
};
const mp4 = (seconds: number, fps = 30, vfr = false): Buffer => {
  const timescale = 90_000;
  const frames = Math.round(seconds * fps);
  const delta = Math.round(timescale / fps);
  const sttsEntries = vfr ? [[frames - 1, delta], [1, delta + 100]] : [[frames, delta]];
  const stts = Buffer.alloc(8 + sttsEntries.length * 8);
  stts.writeUInt32BE(sttsEntries.length, 4);
  sttsEntries.forEach(([count, d], i) => { stts.writeUInt32BE(count, 8 + i * 8); stts.writeUInt32BE(d, 8 + i * 8 + 4); });
  const hdlr = Buffer.alloc(24);
  hdlr.write('vide', 8, 'latin1');
  const trak = box('trak', box('mdia', Buffer.concat([
    box('mdhd', times(timescale, frames * delta)),
    box('hdlr', hdlr),
    box('minf', box('stbl', box('stts', stts))),
  ])));
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\x00\x00\x00\x01isom', 'latin1')),
    box('moov', Buffer.concat([box('mvhd', times(timescale, frames * delta)), trak])),
  ]);
};
const wav = (seconds: number, rate = 48_000): Buffer => {
  const blockAlign = 2;
  const byteRate = rate * blockAlign;
  const dataSize = Math.floor(seconds * byteRate);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  const chunk = (id: string, payload: Buffer) => {
    const out = Buffer.alloc(8 + payload.length + (payload.length % 2));
    out.write(id, 0, 'latin1');
    out.writeUInt32LE(payload.length, 4);
    payload.copy(out, 8);
    return out;
  };
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + 8 + fmt.length + 8 + dataSize, 4);
  riff.write('WAVE', 8, 'latin1');
  return Buffer.concat([riff, chunk('fmt ', fmt), chunk('data', Buffer.alloc(dataSize))]);
};

// ---------- mocks ----------

const vault: MediaVault = {
  status: async () => ({ configured: true, providers: { sync: { configured: syncConfigured, keyFp: syncConfigured ? accountFp : undefined } } }),
  call: async (kind, params) => {
    const call = { kind, params };
    vaultCalls.push(call);
    return reply(call);
  },
};

const core = {
  opsScope: async (credential: string, taskId: string) => {
    if (credential !== 'holder') throw new CompanyError('forbidden', 'Ops tools are only available to the current lease holder of the task');
    return { actor: { employeeId: 'emp-1', role, capabilities: ['execute'] }, taskId, project: 'proj-1' };
  },
  auditOps: async (scope: { taskId: string }, action: string, evidence: string) => { audits.push({ task: scope.taskId, action, evidence }); },
  opsCount: async (_project: string, action: string) => counts[action] ?? 0,
};

const fakeFetch: typeof fetch = (async (url: any, init: any) => {
  fetches.push({ url: String(url), method: init?.method ?? 'GET' });
  if (init?.method === 'PUT') return new Response('', { status: 200 });
  if (String(url).includes('out.mp4')) return new Response('VIDEO-RESULT', { status: 200 });
  return new Response('nope', { status: 404 });
}) as typeof fetch;

const studio = (extra: Partial<SyncDeps> = {}) =>
  new SyncStudio({ core: core as never, vault, evidenceRoot: root, serviceHome: home, now: () => clock, fetch: fakeFetch, ...extra });
const call = (s: SyncStudio, tool: string, args: Record<string, unknown> = {}, credential = 'holder', taskId = 'task-1') =>
  s.call(credential, taskId, tool, args);
async function fail(promise: Promise<unknown>): Promise<CompanyError> {
  try { await promise; } catch (error) { return error as CompanyError; }
  throw new Error('expected a rejection');
}
const kinds = () => vaultCalls.map(item => item.kind);
const priv = (rel: string) => join(home, 'private', 'sync', rel);

const approval = (over: Record<string, unknown> = {}, name = 'ap-1.json') => {
  mkdirSync(priv('approvals'), { recursive: true, mode: 0o700 });
  writeFileSync(join(priv('approvals'), name), JSON.stringify({
    schema: 'sync-spend-approval/1', approvalId: 'ap-1', issuer: 'owner', project: 'proj-1', taskId: 'task-1',
    accountRef: KEY_FP, kind: 'paid', models: ['sync-3'], maxGenerations: 1, maxUsdPerJob: 10, maxUsdTotal: 10,
    maxJobSeconds: 30, issuedAt: new Date(clock - 60_000).toISOString(), expiresAt: new Date(clock + 3_600_000).toISOString(),
    ...over,
  }), { mode: 0o600 });
};

const inbox = (taskId: string, name: string, bytes: Buffer) => {
  const dir = join(root, taskId, 'sync', 'in');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), bytes);
};

/** Uploads one 8s mp4 + one 8s wav through the whole real path; returns the bound assetIds. */
const seedAssets = async (s: SyncStudio, taskId = 'task-1') => {
  const video = mp4(8);
  const audio = wav(8);
  inbox(taskId, 'v.mp4', video);
  inbox(taskId, 'a.wav', audio);
  const v = await call(s, 'sync_upload', { file: 'v.mp4', sha256: sha(video) }, 'holder', taskId) as any;
  const a = await call(s, 'sync_upload', { file: 'a.wav', sha256: sha(audio) }, 'holder', taskId) as any;
  return { videoAssetId: v.assetId as string, audioAssetId: a.assetId as string, videoSha: sha(video), audioSha: sha(audio) };
};

const readAction = (id: string) => JSON.parse(readFileSync(priv(`actions/${id}.json`), 'utf8'));
const readBudget = () => JSON.parse(readFileSync(priv('budget.json'), 'utf8'));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sck-sync-ev-'));
  home = mkdtempSync(join(tmpdir(), 'sck-sync-home-'));
  role = 'qa';
  counts = {};
  audits = [];
  vaultCalls = [];
  fetches = [];
  syncConfigured = true;
  accountFp = KEY_FP;
  seq = 0;
  reply = call => {
    switch (call.kind) {
      case 'sync_asset_presign': return json({ uploadUrl: `https://store.test/put/${seq}`, url: `https://cdn.test/asset/${seq}` });
      case 'sync_asset_register': return json({ id: `ast-${++seq}` });
      case 'sync_estimate': return json({ estimatedFrameCount: 240, estimatedGenerationCost: 0.5, estimatedCredits: null });
      case 'sync_generate': return json({ id: 'gen-1', status: 'PENDING' }, 201);
      case 'sync_get': return json({ id: 'gen-1', status: 'COMPLETED' });
      case 'sync_download_url': return text('https://cdn.test/out.mp4?sig=SECRETVALUE');
      default: return json({});
    }
  };
  for (const name of Object.keys(process.env)) if (name.startsWith('SCK_SYNC_')) delete process.env[name];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

// ---------- gates ----------

describe('lease and role gates', () => {
  test('a caller without the lease is refused before anything happens', async () => {
    const err = await fail(call(studio(), 'sync_info', {}, 'someone-else'));
    expect(err.code).toBe('forbidden');
    expect(vaultCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test('roles outside the list are refused; SCK_SYNC_ROLES only widens read-side access, never generation', async () => {
    role = 'cs';
    expect((await fail(call(studio(), 'sync_info'))).code).toBe('forbidden');
    process.env.SCK_SYNC_ROLES = 'cs';
    const info = await call(studio(), 'sync_info') as any;
    expect(info.configured.sync).toBe(true);
  });

  test('the tool list carries all eight sync tools', () => {
    expect([...studio().tools]).toEqual([...SYNC_TOOLS]);
    expect([...studio().tools].sort()).toEqual(
      ['sync_info', 'sync_models', 'sync_errors', 'sync_upload', 'sync_estimate', 'sync_generate', 'sync_status', 'sync_download'].sort());
  });
});

describe('sync_info', () => {
  test('reports configured state, honest unproven account verdict and per-kind quotas', async () => {
    const info = await call(studio(), 'sync_info') as any;
    expect(info.configured.sync).toBe(true);
    expect(info.account.accountRef).toBe(KEY_FP);
    expect(info.account.verdict).toBe('unproven');
    expect(info.account.approval).toEqual({ present: false, approvalId: null });
    expect(info.quotas.upload.limit).toBe(60);
    expect(info.bindings).toEqual({ assets: 0, actions: 0 });
    expect(Object.keys(info.tools)).toEqual(SYNC_TOOLS.filter(t => t !== 'sync_info'));
  });

  test('without a configured vault it says so; a dead vault still answers', async () => {
    syncConfigured = false;
    const info = await call(studio(), 'sync_info') as any;
    expect(info.configured.sync).toBe(false);
    const down: MediaVault = { status: async () => { throw new CompanyError('not_configured', 'down'); }, call: vault.call };
    expect((await call(studio({ vault: down }), 'sync_info') as any).configured.sync).toBe(false);
  });
});

describe('sync_models / sync_errors', () => {
  test('pass through the supplier catalogs and need a configured key', async () => {
    reply = call => call.kind === 'sync_models' ? json({ models: [{ id: 'sync-3' }] }) : json({ errors: [{ code: 'invalid_asset_id_format' }] });
    expect(await call(studio(), 'sync_models')).toEqual({ models: [{ id: 'sync-3' }] });
    expect(await call(studio(), 'sync_errors')).toEqual({ errors: [{ code: 'invalid_asset_id_format' }] });
    expect(kinds()).toEqual(['sync_models', 'sync_errors']);
  });

  test('unconfigured key refuses before any upstream call', async () => {
    syncConfigured = false;
    expect((await fail(call(studio(), 'sync_models'))).code).toBe('not_configured');
    expect(vaultCalls).toEqual([]);
  });
});

// ---------- upload ----------

describe('sync_upload', () => {
  const goodMp4 = () => mp4(8);

  test('rejects traversal, absolute paths, subdirs, extensions and missing files before any vault call', async () => {
    for (const file of ['../x.mp4', 'a/b.mp4', '/tmp/x.mp4', 'x.txt', '.hidden.mp4', 'sp ace.mp4']) {
      expect((await fail(call(studio(), 'sync_upload', { file, sha256: sha('x') }))).code).toBe('invalid');
    }
    expect((await fail(call(studio(), 'sync_upload', { file: 'missing.mp4', sha256: sha('x') }))).code).toBe('invalid');
    expect(vaultCalls).toEqual([]);
  });

  test('a symlink pointing outside the inbox is refused even with a valid name', async () => {
    const outside = join(root, 'outside.mp4');
    writeFileSync(outside, goodMp4());
    const dir = join(root, 'task-1', 'sync', 'in');
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, 'linked.mp4'));
    const err = await fail(call(studio(), 'sync_upload', { file: 'linked.mp4', sha256: sha(goodMp4()) }));
    expect(err.code).toBe('invalid');
    expect(vaultCalls).toEqual([]);
  });

  test('a wrong SHA256 or a malformed container never reaches upstream', async () => {
    inbox('task-1', 'v.mp4', goodMp4());
    expect((await fail(call(studio(), 'sync_upload', { file: 'v.mp4', sha256: sha('other') }))).code).toBe('invalid');
    inbox('task-1', 'bad.mp4', Buffer.from('not-a-video'));
    expect((await fail(call(studio(), 'sync_upload', { file: 'bad.mp4', sha256: sha('not-a-video') }))).code).toBe('invalid');
    inbox('task-1', 'vfr.mp4', mp4(8, 30, true));
    expect((await fail(call(studio(), 'sync_upload', { file: 'vfr.mp4', sha256: sha(mp4(8, 30, true)) }))).code).toBe('invalid');
    inbox('task-1', 'bad.wav', Buffer.from('RIFFxxxxWAVEjunk'));
    expect((await fail(call(studio(), 'sync_upload', { file: 'bad.wav', sha256: sha('RIFFxxxxWAVEjunk') }))).code).toBe('invalid');
    expect(vaultCalls).toEqual([]);
  });

  test('expectedMedia must match the probe, not the claim', async () => {
    const video = mp4(8, 30);
    inbox('task-1', 'v.mp4', video);
    expect((await fail(call(studio(), 'sync_upload', { file: 'v.mp4', sha256: sha(video), expectedMedia: { fps: 24 } }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'sync_upload', { file: 'v.mp4', sha256: sha(video), expectedMedia: { durationSeconds: 9 } }))).code).toBe('invalid');
    const res = await call(studio(), 'sync_upload', { file: 'v.mp4', sha256: sha(video), expectedMedia: { durationSeconds: 8, fps: 30 } }) as any;
    expect(res.assetId).toBe('ast-1');
  });

  test('uploads bytes through vault-issued URLs only and binds project/account/task in private state', async () => {
    const video = goodMp4();
    inbox('task-1', 'v.mp4', video);
    const res = await call(studio(), 'sync_upload', { file: 'v.mp4', sha256: sha(video) }) as any;
    expect(res).toMatchObject({ assetId: 'ast-1', sha256: sha(video), type: 'VIDEO', reused: false });
    expect(res.media.fps).toBeCloseTo(30, 1);
    expect(kinds()).toEqual(['sync_asset_presign', 'sync_asset_register']);
    // The raw bytes went to the vault-issued uploadUrl via plugin-side PUT.
    expect(fetches).toEqual([{ url: 'https://store.test/put/0', method: 'PUT' }]);
    // Authoritative binding lives in private/sync, the evidence ledger mirrors it without any URL.
    const registry = JSON.parse(readFileSync(priv('assets.json'), 'utf8'));
    const entry = registry.entries[KEY_FP]['proj-1'][sha(video)];
    expect(entry).toMatchObject({ assetId: 'ast-1', project: 'proj-1', accountRef: KEY_FP, firstTaskId: 'task-1' });
    const ledger = readFileSync(join(root, 'task-1', 'sync', 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('ast-1');
    expect(ledger).not.toContain('store.test');
    expect(audits.at(-1)).toMatchObject({ action: 'ops_sync_upload' });
    expect(audits.at(-1)!.evidence).not.toContain('http');
  });

  test('the same bytes re-uploaded reuse the assetId without touching upstream again', async () => {
    const video = goodMp4();
    inbox('task-1', 'v.mp4', video);
    await call(studio(), 'sync_upload', { file: 'v.mp4', sha256: sha(video) });
    vaultCalls = [];
    const res = await call(studio(), 'sync_upload', { file: 'v.mp4', sha256: sha(video) }) as any;
    expect(res.reused).toBe(true);
    expect(res.assetId).toBe('ast-1');
    expect(vaultCalls).toEqual([]);
  });
});

// ---------- estimate ----------

describe('sync_estimate', () => {
  test('declared durations reach the estimate endpoint with the fixed model; generate is never called', async () => {
    const res = await call(studio(), 'sync_estimate', { durationSeconds: 8, fps: 30 }) as any;
    expect(vaultCalls).toEqual([{ kind: 'sync_estimate', params: { model: 'sync-3', duration: 8, fps: 30 } }]);
    expect(res).toMatchObject({ estimatedGenerationCostUsd: 0.5, basis: { durationSeconds: 8, fps: 30, source: 'declared' } });
    expect(kinds()).not.toContain('sync_generate');
  });

  test('asset references bill on measured media, and foreign assetIds are forbidden', async () => {
    const s = studio();
    const { videoAssetId } = await seedAssets(s);
    vaultCalls = [];
    const res = await call(s, 'sync_estimate', { videoAssetId }) as any;
    expect(res.basis).toMatchObject({ source: 'registry', durationSeconds: 8 });
    expect((await fail(call(s, 'sync_estimate', { videoAssetId: 'ast-foreign' }))).code).toBe('forbidden');
    expect(kinds().filter(k => k === 'sync_estimate').length).toBe(1);
  });
});

// ---------- generate: zero-spend gate ----------

describe('sync_generate zero-spend gate', () => {
  test('no approval artifact means payment_approval_required with zero upstream submit calls', async () => {
    const s = studio();
    const { videoAssetId, audioAssetId } = await seedAssets(s);
    vaultCalls = [];
    const err = await fail(call(s, 'sync_generate', { videoAssetId, audioAssetId }));
    expect(err.code).toBe('payment_approval_required');
    expect(kinds()).toEqual([]);
  });

  test('no SCK_SYNC_* environment value can authorize generation', async () => {
    process.env.SCK_SYNC_FREE_TIER = '1';
    process.env.SCK_SYNC_ALLOW_GENERATE = 'true';
    process.env.SCK_SYNC_PAID_OK = 'yes';
    const s = studio();
    const { videoAssetId, audioAssetId } = await seedAssets(s);
    expect((await fail(call(s, 'sync_generate', { videoAssetId, audioAssetId }))).code).toBe('payment_approval_required');
    expect(kinds()).not.toContain('sync_generate');
  });

  test('expired, foreign-task, foreign-account, foreign-project or non-owner artifacts all refuse', async () => {
    const s = studio();
    const { videoAssetId, audioAssetId } = await seedAssets(s);
    const args = { videoAssetId, audioAssetId };
    approval({ expiresAt: new Date(clock - 1).toISOString() }, 'expired.json');
    expect((await fail(call(s, 'sync_generate', args))).code).toBe('payment_approval_required');
    rmSync(priv('approvals/expired.json'));
    approval({ taskId: 'task-2' }, 'wrong-task.json');
    expect((await fail(call(s, 'sync_generate', args))).code).toBe('payment_approval_required');
    rmSync(priv('approvals/wrong-task.json'));
    approval({ accountRef: 'OTHER-ACCOUNT' }, 'wrong-account.json');
    expect((await fail(call(s, 'sync_generate', args))).code).toBe('payment_approval_required');
    rmSync(priv('approvals/wrong-account.json'));
    approval({ project: 'other-project' }, 'wrong-project.json');
    expect((await fail(call(s, 'sync_generate', args))).code).toBe('payment_approval_required');
    rmSync(priv('approvals/wrong-project.json'));
    approval({ issuer: 'gm' }, 'wrong-issuer.json');
    expect((await fail(call(s, 'sync_generate', args))).code).toBe('payment_approval_required');
    writeFileSync(priv('approvals/broken.json'), '{not json');
    expect((await fail(call(s, 'sync_generate', args))).code).toBe('payment_approval_required');
    expect(kinds()).not.toContain('sync_generate');
  });
});

describe('sync_generate submit path', () => {
  test('a valid approval submits once under a deterministic sck- key with persisted intent', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval();
    vaultCalls = [];
    const res = await call(s, 'sync_generate', { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId }) as any;
    expect(res.status).toBe('accepted');
    expect(res.generationId).toBe('gen-1');
    expect(res.idempotencyKey).toMatch(/^sck-[0-9a-f]{64}$/);
    const submit = vaultCalls.find(c => c.kind === 'sync_generate')!;
    expect(submit.params).toMatchObject({
      model: 'sync-3',
      input: [{ type: 'video', assetId: assets.videoAssetId }, { type: 'audio', assetId: assets.audioAssetId }],
      options: { sync_mode: 'silence' },
      idempotencyKey: res.idempotencyKey,
    });
    const action = readAction(res.actionId);
    expect(action.state).toBe('accepted');
    expect(action.sendIntentAt).toBeTruthy();
    expect(action.taskId).toBe('task-1');
    // The post-send merge re-enters the lock, where reconcile records the transient sending→unknown
    // step before the observed 201 folds it into accepted; the trail stays honest.
    expect(action.history.map((h: any) => h.state)).toEqual(['reserved', 'sending', 'unknown', 'accepted']);
    expect(Object.keys(readBudget().byAction)).toEqual([res.actionId]);
    // The evidence mirror exists but never carries request URLs or credentials.
    const ledger = readFileSync(join(root, 'task-1', 'sync', 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain(res.actionId);
    expect(audits.at(-1)?.action).toBe('ops_sync_generate');
  });

  test('maxGenerations=1 concurrent identical submits converge on one action and one upstream send', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval();
    const args = { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId };
    const [one, two] = await Promise.all([
      call(s, 'sync_generate', args).then(v => ({ ok: v })).catch(e => ({ err: e as CompanyError })),
      call(s, 'sync_generate', args).then(v => ({ ok: v })).catch(e => ({ err: e as CompanyError })),
    ]);
    // Identical logical request: the second caller folds into the first's action instead of
    // burning another reservation. One action, one budget row; a same-key recheck may post once
    // more, but every upstream call must carry the ORIGINAL idempotency key and payload.
    expect('ok' in one && 'ok' in two).toBe(true);
    const firstActionId = (one as { ok: any }).ok.actionId;
    const firstKey = (one as { ok: any }).ok.idempotencyKey;
    expect((two as { ok: any }).ok.actionId).toBe(firstActionId);
    const posts = vaultCalls.filter(c => c.kind === 'sync_generate');
    expect(posts.length).toBeLessThanOrEqual(2);
    for (const post of posts) expect(post.params.idempotencyKey).toBe(firstKey);
    expect(Object.keys(readBudget().byAction)).toEqual([firstActionId]);
    // A sequential retry on the same inputs folds into the same action too, no new reservation.
    const again = await call(s, 'sync_generate', args) as any;
    expect(again.actionId).toBe(firstActionId);
    expect(again.deduped).toBe(true);
    expect(vaultCalls.filter(c => c.kind === 'sync_generate').length).toBe(posts.length);
    // A genuinely different request still hits the cap.
    const v2 = mp4(6);
    inbox('task-1', 'v2.mp4', v2);
    const other = await call(s, 'sync_upload', { file: 'v2.mp4', sha256: sha(v2) }) as any;
    const audio = wav(6);
    inbox('task-1', 'a2.wav', audio);
    const a2 = await call(s, 'sync_upload', { file: 'a2.wav', sha256: sha(audio) }) as any;
    expect((await fail(call(s, 'sync_generate', { videoAssetId: other.assetId, audioAssetId: a2.assetId }))).code).toBe('payment_approval_required');
  });

  test('a paid approval refuses when the measured quote exceeds maxUsdPerJob, before submission', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval({ maxUsdPerJob: 0.1 });
    expect((await fail(call(s, 'sync_generate', { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId }))).code).toBe('payment_approval_required');
    expect(kinds()).not.toContain('sync_generate');
  });

  test('mismatched video/audio duration fails on measured metadata, independent of approvals', async () => {
    const s = studio();
    const video = mp4(8);
    const audio = wav(8.8);
    inbox('task-1', 'v.mp4', video);
    inbox('task-1', 'a.wav', audio);
    const v = await call(s, 'sync_upload', { file: 'v.mp4', sha256: sha(video) }) as any;
    const a = await call(s, 'sync_upload', { file: 'a.wav', sha256: sha(audio) }) as any;
    const err = await fail(call(s, 'sync_generate', { videoAssetId: v.assetId, audioAssetId: a.assetId }));
    expect(err.code).toBe('invalid');
    expect(kinds()).not.toContain('sync_generate');
  });

  test('cross-task assetIds are forbidden unless an approval allowlist grants them', async () => {
    const s = studio();
    const assets = await seedAssets(s, 'task-1');
    const args = { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId };
    const err = await fail(call(s, 'sync_generate', args, 'holder', 'task-2'));
    expect(err.code).toBe('forbidden');
    // A forged ledger line in the other task's evidence dir changes nothing: the ledger is a mirror.
    const foreignLedger = join(root, 'task-2', 'sync');
    mkdirSync(foreignLedger, { recursive: true });
    writeFileSync(join(foreignLedger, 'ledger.jsonl'), `${JSON.stringify({ op: 'grant', taskId: 'task-2', assetId: assets.videoAssetId })}\n`);
    expect((await fail(call(s, 'sync_generate', args, 'holder', 'task-2'))).code).toBe('forbidden');
    // The explicit allowlist is the trusted grant.
    approval({ taskId: 'task-2', inputSha256Allowlist: [assets.videoSha, assets.audioSha] });
    const res = await call(s, 'sync_generate', args, 'holder', 'task-2') as any;
    expect(res.status).toBe('accepted');
  });

  test('a confirmed pre-work refusal releases the reservation and ends the action rejected', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval();
    reply = call => call.kind === 'sync_generate' ? json({ code: 'invalid_asset_id_format', message: 'asset missing' }, 422) : json({});
    const res = await call(s, 'sync_generate', { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId }) as any;
    expect(res.status).toBe('rejected');
    expect(readAction(res.actionId).state).toBe('rejected');
    expect(readBudget().byAction).toEqual({});
  });

  test('an unknown send outcome keeps the budget and retries with the SAME key', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval();
    reply = call => call.kind === 'sync_generate' ? json({ code: 'IDEMPOTENCY_OUTCOME_UNKNOWN', message: 'unknown' }, 503) : json({});
    const res = await call(s, 'sync_generate', { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId }) as any;
    expect(res.status).toBe('unknown');
    const action = readAction(res.actionId);
    expect(action.state).toBe('unknown');
    expect(readBudget().byAction[res.actionId]).toMatchObject({ count: 1 });
    // The same-key reconcile merges a late 200 replay into the same action.
    reply = call => call.kind === 'sync_generate' ? json({ id: 'gen-9', status: 'PENDING' }, 200, { 'idempotency-replayed': 'true' }) : json({});
    const status = await call(s, 'sync_status', { actionId: res.actionId }) as any;
    const posts = vaultCalls.filter(c => c.kind === 'sync_generate');
    expect(posts.length).toBe(2);
    expect(posts[0].params.idempotencyKey).toBe(posts[1].params.idempotencyKey);
    expect(posts[0].params.input).toEqual(posts[1].params.input);
    expect(status.state).toBe('accepted');
    expect(readAction(res.actionId).state).toBe('accepted');
    // Retries are bounded: after the cap the action stays unknown instead of re-posting forever.
    const dead = { ...action, state: 'unknown', generationId: undefined, recovery: { attempts: 9, firstAt: clock, nextAt: clock } };
    delete (dead as any).generationId;
    writeFileSync(priv(`actions/${res.actionId}.json`), JSON.stringify(dead));
    vaultCalls = [];
    await call(s, 'sync_status', { actionId: res.actionId });
    expect(vaultCalls.filter(c => c.kind === 'sync_generate').length).toBe(0);
  });
});

// ---------- status ----------

describe('sync_status', () => {
  test('foreign or unknown action and generation ids are forbidden', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval();
    const res = await call(s, 'sync_generate', { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId }) as any;
    expect((await fail(call(s, 'sync_status', { actionId: 'act-nope' }))).code).toBe('forbidden');
    expect((await fail(call(s, 'sync_status', { generationId: 'gen-foreign' }))).code).toBe('forbidden');
    expect((await fail(call(s, 'sync_status', { actionId: res.actionId }, 'holder', 'task-2'))).code).toBe('forbidden');
    expect((await fail(call(s, 'sync_status', {}))).code).toBe('invalid');
    expect((await fail(call(s, 'sync_status', { actionId: res.actionId, generationId: 'gen-1' }))).code).toBe('invalid');
    expect((await fail(call(s, 'sync_status', { actionId: res.actionId, wait: true, includeProgress: true }))).code).toBe('invalid');
  });

  test('polls the bound generation and merges terminal states, including very late completion', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval();
    const res = await call(s, 'sync_generate', { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId }) as any;
    reply = call => call.kind === 'sync_get' ? json({ id: 'gen-1', status: 'PROCESSING' }) : json({});
    expect((await call(s, 'sync_status', { actionId: res.actionId }) as any).status).toBe('PROCESSING');
    expect(readAction(res.actionId).state).toBe('accepted');
    // Far past the nominal replay window: completion still merges into the same action.
    clock += 9 * 86_400_000;
    reply = call => call.kind === 'sync_get' ? json({ id: 'gen-1', status: 'COMPLETED', outputDuration: 8 }) : json({});
    const status = await call(s, 'sync_status', { actionId: res.actionId }) as any;
    expect(status).toMatchObject({ state: 'completed', status: 'COMPLETED', outputDuration: 8 });
    expect(readAction(res.actionId).state).toBe('completed');
  });

  test('wait and includeProgress reach upstream as mutually exclusive query forms', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval();
    const res = await call(s, 'sync_generate', { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId }) as any;
    await call(s, 'sync_status', { actionId: res.actionId, wait: true, timeout: 3 });
    expect(vaultCalls.at(-1)).toEqual({ kind: 'sync_get', params: { id: 'gen-1', wait: true, timeout: 3 } });
    await call(s, 'sync_status', { actionId: res.actionId, includeProgress: true });
    expect(vaultCalls.at(-1)).toEqual({ kind: 'sync_get', params: { id: 'gen-1', include: 'progress' } });
  });
});

// ---------- download ----------

describe('sync_download', () => {
  test('only completed actions download; the signed URL never leaks into results or audit', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval();
    const res = await call(s, 'sync_generate', { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId }) as any;
    reply = call => call.kind === 'sync_get' ? json({ id: 'gen-1', status: 'PROCESSING' }) : json({});
    expect((await fail(call(s, 'sync_download', { actionId: res.actionId, file: 'out.mp4' }))).code).toBe('conflict');
    reply = call => {
      if (call.kind === 'sync_get') return json({ id: 'gen-1', status: 'COMPLETED' });
      if (call.kind === 'sync_download_url') return text('https://cdn.test/out.mp4?sig=SECRETVALUE');
      return json({});
    };
    const done = await call(s, 'sync_download', { actionId: res.actionId, file: 'out.mp4' }) as any;
    expect(done.bytes).toBe(12);
    expect(readFileSync(done.path, 'utf8')).toBe('VIDEO-RESULT');
    expect(done.path).not.toContain('sig');
    const lastAudit = audits.at(-1)!;
    expect(lastAudit.action).toBe('ops_sync_download');
    expect(lastAudit.evidence).toContain('host=cdn.test');
    expect(lastAudit.evidence).not.toContain('sig=');
    const ledger = readFileSync(join(root, 'task-1', 'sync', 'ledger.jsonl'), 'utf8');
    expect(ledger).not.toContain('SECRETVALUE');
  });

  test('bad file names are refused before any network work', async () => {
    const s = studio();
    for (const file of ['../x.mp4', 'a/b.mp4', 'out.txt']) {
      expect((await fail(call(s, 'sync_download', { generationId: 'gen-1', file }))).code).toBe('invalid');
    }
    expect(vaultCalls).toEqual([]);
  });
});

// ---------- lock protocol ----------

describe('kernel lock protocol', () => {
  test('a live lock holder is never preempted; contenders fail bounded and closed', async () => {
    const s = studio({ lockWaitMs: 300 });
    await seedAssets(s);
    mkdirSync(priv(''), { recursive: true });
    const holder = spawn('/usr/bin/python3', ['-c',
      'import fcntl,sys,time; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX); time.sleep(2)', priv('budget.lock')]);
    try {
      await new Promise(resolve => setTimeout(resolve, 300)); // holder settles into the lock
      const err = await fail(call(s, 'sync_status', { actionId: 'act-any' }));
      expect(err.code).toBe('temporarily_unavailable');
    } finally {
      holder.kill();
      await new Promise(resolve => holder.once('close', resolve));
    }
  });

  test('crash leftovers reconcile closed: reserved-without-intent voids, sending degrades to unknown', async () => {
    const s = studio();
    await seedAssets(s);
    mkdirSync(priv('actions'), { recursive: true });
    const reserved = {
      actionId: 'act-r1', taskId: 'task-1', project: 'proj-1', accountRef: KEY_FP, approvalId: 'ap-1',
      idempotencyKey: 'sck-x', requestDigest: 'd', requestBody: {}, inputs: {}, estimate: {},
      state: 'reserved', reservedUsd: 0.5, reservedCount: 1, history: [],
    };
    const sending = { ...reserved, actionId: 'act-s1', state: 'sending', sendIntentAt: new Date(clock).toISOString() };
    writeFileSync(priv('actions/act-r1.json'), JSON.stringify(reserved));
    writeFileSync(priv('actions/act-s1.json'), JSON.stringify(sending));
    writeFileSync(priv('budget.json'), JSON.stringify({
      schema: 'sync-budget/1',
      byAction: { 'act-r1': { count: 1, usd: 0.5, approvalId: 'ap-1' }, 'act-s1': { count: 1, usd: 0.5, approvalId: 'ap-1' }, 'act-ghost': { count: 1, usd: 0.2, approvalId: 'ap-9' } },
    }));
    reply = call => call.kind === 'sync_generate' ? json({ code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' }, 503) : json({});
    const status = await call(s, 'sync_status', { actionId: 'act-s1' }) as any;
    expect(status.state).toBe('unknown'); // provably sent-or-unknown: budget kept
    expect(readBudget().byAction['act-s1']).toMatchObject({ count: 1 });
    expect(readAction('act-r1').state).toBe('void'); // never sent: reservation released
    expect(readBudget().byAction['act-r1']).toBeUndefined();
    expect(readBudget().byAction['act-ghost']).toBeUndefined(); // orphan reservation released
  });
});

// ---------- errors and redaction ----------

describe('supplier errors and redaction', () => {
  test('billing-style upstream errors map to payment_approval_required; 401 maps to not_configured', async () => {
    const s = studio();
    const assets = await seedAssets(s);
    approval();
    reply = call => call.kind === 'sync_generate' ? json({ code: 'insufficient_credits', message: 'no credits' }, 402) : json({});
    const res = await call(s, 'sync_generate', { videoAssetId: assets.videoAssetId, audioAssetId: assets.audioAssetId }) as any;
    expect(res.status).toBe('rejected'); // confirmed billing refusal: the reservation is released, not pinned
    expect(readBudget().byAction).toEqual({});
    syncConfigured = true;
    reply = () => json({ message: 'bad key' }, 401);
    expect((await fail(call(s, 'sync_models'))).code).toBe('not_configured');
  });

  test('error text reaching the caller is scrubbed of URLs and cut short', async () => {
    reply = () => json({ message: 'failed with https://signed.example.com/private?sig=SECRETSTUFF inside' }, 400);
    const err = await fail(call(studio(), 'sync_estimate', { durationSeconds: 8 }));
    expect(err.message).not.toContain('signed.example.com');
    expect(err.message).not.toContain('SECRETSTUFF');
    expect(err.message.length).toBeLessThan(400);
  });

  test('daily caps stop calls before the vault is asked', async () => {
    counts = { ops_sync_read: 240 };
    expect((await fail(call(studio(), 'sync_estimate', { durationSeconds: 8 }))).code).toBe('limit_reached');
    counts = { ops_sync_upload: 60 };
    inbox('task-1', 'v.mp4', mp4(8));
    expect((await fail(call(studio(), 'sync_upload', { file: 'v.mp4', sha256: sha(mp4(8)) }))).code).toBe('limit_reached');
    expect(vaultCalls).toEqual([]);
  });
});

// ---------- release-boundary rework (task aff27795): R1 free-trial closed, R2 SHA-identity dedup, R3 dir anchoring ----------

describe('R1: free-trial generation stays closed', () => {
  test('a free-trial artifact deterministically refuses before upstream, even with self-declared freeEvidence', async () => {
    const s = studio();
    const args = await seedAssets(s);
    approval({
      kind: 'free-trial', maxUsdPerJob: 0, maxUsdTotal: 0,
      freeEvidence: { source: 'self-declared', observedAt: new Date(clock).toISOString(), freeRemaining: 99, noPaymentSource: true, autoRecharge: false },
    });
    const err = await fail(call(s, 'sync_generate', args));
    expect(err.code).toBe('payment_approval_required');
    expect(kinds()).not.toContain('sync_generate');
    const info = await call(s, 'sync_info') as any;
    expect(info.account.verdict).toBe('unproven');
    expect(info.account.freeTrial.supported).toBe(false);
    expect(info.account.freeTrial.boundArtifacts).toBe(1);
    // A free-trial artifact is not a generation approval: the paid gate reports absent.
    expect(info.account.approval.present).toBe(false);
  });

  test('paid approvals still gate generation exactly as before', async () => {
    const s = studio();
    const args = await seedAssets(s);
    approval({ maxGenerations: 1 });
    const res = await call(s, 'sync_generate', args) as any;
    expect(res.status).toBe('accepted');
    expect(kinds().filter(k => k === 'sync_generate')).toHaveLength(1);
  });
});

describe('R2: generation identity is content-anchored, dedup folds repeats into one action', () => {
  test('same SHAs with a renamed output dedupe to the original action; unknown rechecks the SAME key', async () => {
    const s = studio();
    const args = await seedAssets(s);
    approval({ maxGenerations: 3 });
    const original = reply;
    let attempts = 0;
    reply = c => {
      if (c.kind === 'sync_generate' && ++attempts === 1) throw new Error('simulated timeout');
      return original(c);
    };
    const first = await call(s, 'sync_generate', { ...args, outputFileName: 'first.mp4' }) as any;
    expect(first.status).toBe('unknown');
    // A fresh studio instance over the same dirs: a restart still finds the same ledger action.
    const second = await call(studio(), 'sync_generate', { ...args, outputFileName: 'second.mp4' }) as any;
    expect(second.actionId).toBe(first.actionId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.deduped).toBe(true);
    expect(second.status).toBe('accepted'); // the bounded same-key recheck merged the late 201
    const posts = vaultCalls.filter(c => c.kind === 'sync_generate');
    expect(posts).toHaveLength(2); // original send + same-key recheck, never a fresh key
    expect(posts[1].params.idempotencyKey).toBe(first.idempotencyKey);
    expect(posts[1].params.input).toEqual(posts[0].params.input);
    expect(Object.keys(readBudget().byAction)).toEqual([first.actionId]);
    expect(readdirSync(priv('actions')).filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  test('the same SHA pair re-registered under a fresh assetId still merges into the original action', async () => {
    const s = studio();
    const args = await seedAssets(s);
    approval({ maxGenerations: 3 });
    const first = await call(s, 'sync_generate', args) as any;
    expect(first.status).toBe('accepted');
    // The registry re-bound the same video bytes to a new upstream assetId (re-upload semantics).
    const registry = JSON.parse(readFileSync(priv('assets.json'), 'utf8'));
    registry.entries[KEY_FP]['proj-1'][args.videoSha].assetId = 'ast-video-reup';
    writeFileSync(priv('assets.json'), JSON.stringify(registry));
    vaultCalls = [];
    const second = await call(s, 'sync_generate', { videoAssetId: 'ast-video-reup', audioAssetId: args.audioAssetId }) as any;
    expect(second.actionId).toBe(first.actionId);
    expect(second.deduped).toBe(true);
    expect(vaultCalls.filter(c => c.kind === 'sync_generate')).toHaveLength(0);
    expect(Object.keys(readBudget().byAction)).toEqual([first.actionId]);
  });

  test('a v1-keyed unknown action dedupes by content identity and rechecks under its ORIGINAL key', async () => {
    const s = studio();
    const args = await seedAssets(s);
    approval({ maxGenerations: 3 });
    const requestBody = {
      model: 'sync-3',
      input: [{ type: 'video', assetId: args.videoAssetId }, { type: 'audio', assetId: args.audioAssetId }],
      options: { sync_mode: 'silence' },
    };
    mkdirSync(priv('actions'), { recursive: true });
    writeFileSync(priv('actions/act-legacy.json'), JSON.stringify({
      actionId: 'act-legacy', taskId: 'task-1', project: 'proj-1', accountRef: KEY_FP, approvalId: 'ap-1',
      idempotencyKey: 'sck-v1legacy', requestDigest: sha(JSON.stringify(requestBody)), requestBody,
      inputs: { videoAssetId: args.videoAssetId, audioAssetId: args.audioAssetId, videoSha256: args.videoSha, audioSha256: args.audioSha, billableSeconds: 8, fps: 30 },
      estimate: { frameCount: 240, usd: 0.5, credits: null },
      state: 'unknown', reservedUsd: 0.5, reservedCount: 1,
      recovery: { attempts: 0, firstAt: clock, nextAt: clock },
      history: [{ state: 'sending', at: new Date(clock).toISOString(), note: 'pre-upgrade send intent persisted' }],
    }));
    writeFileSync(priv('budget.json'), JSON.stringify({ schema: 'sync-budget/1', byAction: { 'act-legacy': { count: 1, usd: 0.5, approvalId: 'ap-1' } } }));
    const res = await call(s, 'sync_generate', { ...args, outputFileName: 'renamed.mp4' }) as any;
    expect(res.actionId).toBe('act-legacy');
    expect(res.deduped).toBe(true);
    const posts = vaultCalls.filter(c => c.kind === 'sync_generate');
    expect(posts).toHaveLength(1);
    expect(posts[0].params.idempotencyKey).toBe('sck-v1legacy'); // original key+payload resent, never a new v2 key
    expect(posts[0].params.input).toEqual(requestBody.input);
    expect(res.status).toBe('accepted');
  });

  test('only a void action (proven unsent) may retry the same logical key', async () => {
    const s = studio();
    const args = await seedAssets(s);
    approval({ maxGenerations: 3 });
    const first = await call(s, 'sync_generate', args) as any;
    const action = readAction(first.actionId);
    action.state = 'void';
    action.history.push({ state: 'void', at: new Date(clock).toISOString(), note: 'test: provably unsent' });
    writeFileSync(priv(`actions/${first.actionId}.json`), JSON.stringify(action));
    const budget = readBudget();
    delete budget.byAction[first.actionId];
    writeFileSync(priv('budget.json'), JSON.stringify(budget));
    const second = await call(s, 'sync_generate', args) as any;
    expect(second.actionId).not.toBe(first.actionId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey); // same logical identity, fresh action
    expect(second.status).toBe('accepted');
    expect(vaultCalls.filter(c => c.kind === 'sync_generate')).toHaveLength(2);
  });

  test('different task or account domains never fold into each other\'s actions', async () => {
    const s = studio();
    const args = await seedAssets(s);
    approval({ maxGenerations: 3 });
    const one = await call(s, 'sync_generate', args) as any;
    // task-2 uploads the same bytes: the registry reuses assetIds but the task domain differs.
    inbox('task-2', 'v.mp4', mp4(8));
    inbox('task-2', 'a.wav', wav(8));
    const v2 = await call(s, 'sync_upload', { file: 'v.mp4', sha256: sha(mp4(8)) }, 'holder', 'task-2') as any;
    const a2 = await call(s, 'sync_upload', { file: 'a.wav', sha256: sha(wav(8)) }, 'holder', 'task-2') as any;
    approval({ approvalId: 'ap-2', taskId: 'task-2', maxGenerations: 3 }, 'ap-2.json');
    const two = await call(s, 'sync_generate', { videoAssetId: v2.assetId, audioAssetId: a2.assetId }, 'holder', 'task-2') as any;
    expect(two.actionId).not.toBe(one.actionId);
    expect(two.idempotencyKey).not.toBe(one.idempotencyKey);
    // A different account fingerprint is a different domain even inside the same task.
    accountFp = 'FP-SYNC-02';
    inbox('task-1', 'v2.mp4', mp4(8));
    inbox('task-1', 'a2.wav', wav(8));
    const v3 = await call(s, 'sync_upload', { file: 'v2.mp4', sha256: sha(mp4(8)) }) as any;
    const a3 = await call(s, 'sync_upload', { file: 'a2.wav', sha256: sha(wav(8)) }) as any;
    expect(v3.assetId).not.toBe(v2.assetId);
    approval({ approvalId: 'ap-b', accountRef: 'FP-SYNC-02', maxGenerations: 3 }, 'ap-b.json');
    const three = await call(s, 'sync_generate', { videoAssetId: v3.assetId, audioAssetId: a3.assetId }) as any;
    expect(three.actionId).not.toBe(one.actionId);
    expect(three.idempotencyKey).not.toBe(one.idempotencyKey);
    expect(vaultCalls.filter(c => c.kind === 'sync_generate')).toHaveLength(3);
  });
});

describe('R3: evidence dirs anchor to the canonical root; symlinks never widen the boundary', () => {
  test('a symlinked sync/in pointing at another task\'s inbox is refused before any upload', async () => {
    const s = studio();
    const bytes = mp4(8);
    inbox('task-2', 'foreign.mp4', bytes);
    mkdirSync(join(root, 'task-1', 'sync'), { recursive: true });
    symlinkSync(join(root, 'task-2', 'sync', 'in'), join(root, 'task-1', 'sync', 'in'));
    const err = await fail(call(s, 'sync_upload', { file: 'foreign.mp4', sha256: sha(bytes) }));
    expect(err.code).toBe('invalid');
    expect(vaultCalls).toEqual([]);
  });

  test('symlinks at the task dir, sync dir, or an outside path are all refused', async () => {
    const s = studio();
    const bytes = mp4(8);
    inbox('task-2', 'foreign.mp4', bytes);
    mkdirSync(join(root, 'task-1'), { recursive: true });
    symlinkSync(join(root, 'task-2', 'sync'), join(root, 'task-1', 'sync'));
    expect((await fail(call(s, 'sync_upload', { file: 'foreign.mp4', sha256: sha(bytes) }))).code).toBe('invalid');
    rmSync(join(root, 'task-1'), { recursive: true, force: true });
    symlinkSync(join(root, 'task-2'), join(root, 'task-1'));
    expect((await fail(call(s, 'sync_upload', { file: 'foreign.mp4', sha256: sha(bytes) }))).code).toBe('invalid');
    const outside = mkdtempSync(join(tmpdir(), 'sck-foreign-'));
    try {
      mkdirSync(join(outside, 'in'), { recursive: true });
      writeFileSync(join(outside, 'in', 'x.mp4'), bytes);
      rmSync(join(root, 'task-1'), { recursive: true, force: true });
      mkdirSync(join(root, 'task-1', 'sync'), { recursive: true });
      symlinkSync(join(outside, 'in'), join(root, 'task-1', 'sync', 'in'));
      expect((await fail(call(s, 'sync_upload', { file: 'x.mp4', sha256: sha(bytes) }))).code).toBe('invalid');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(vaultCalls).toEqual([]);
  });

  test('a file symlink to foreign evidence is refused; an in-inbox alias still uploads', async () => {
    const s = studio();
    const bytes = mp4(8);
    inbox('task-2', 'foreign.mp4', bytes);
    const dir = join(root, 'task-1', 'sync', 'in');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(root, 'task-2', 'sync', 'in', 'foreign.mp4'), join(dir, 'linked.mp4'));
    expect((await fail(call(s, 'sync_upload', { file: 'linked.mp4', sha256: sha(bytes) }))).code).toBe('invalid');
    inbox('task-1', 'real.mp4', bytes);
    symlinkSync(join(dir, 'real.mp4'), join(dir, 'alias.mp4'));
    const res = await call(s, 'sync_upload', { file: 'alias.mp4', sha256: sha(bytes) }) as any;
    expect(res.assetId).toBe('ast-1');
  });

  test('download refuses a symlinked sync dir and never writes the foreign target', async () => {
    const s = studio();
    const args = await seedAssets(s);
    approval();
    const res = await call(s, 'sync_generate', args) as any;
    rmSync(join(root, 'task-1', 'sync'), { recursive: true, force: true });
    mkdirSync(join(root, 'task-2', 'sync'), { recursive: true });
    symlinkSync(join(root, 'task-2', 'sync'), join(root, 'task-1', 'sync'));
    vaultCalls = [];
    const err = await fail(call(s, 'sync_download', { actionId: res.actionId, file: 'out.mp4' }));
    expect(err.code).toBe('invalid');
    expect(existsSync(join(root, 'task-2', 'sync', 'out.mp4'))).toBe(false);
    expect(existsSync(join(root, 'task-2', 'sync', 'ledger.jsonl'))).toBe(false);
    expect(kinds()).not.toContain('sync_download_url'); // refused before asking upstream for a URL
  });

  test('the evidence mirror never writes through a symlinked sync dir', async () => {
    const s = studio();
    await seedAssets(s);
    rmSync(join(root, 'task-1', 'sync'), { recursive: true, force: true });
    mkdirSync(join(root, 'task-2', 'sync'), { recursive: true });
    symlinkSync(join(root, 'task-2', 'sync'), join(root, 'task-1', 'sync'));
    const res = await call(s, 'sync_estimate', { durationSeconds: 8 }) as any;
    expect(res.estimatedGenerationCostUsd).toBe(0.5);
    expect(existsSync(join(root, 'task-2', 'sync', 'ledger.jsonl'))).toBe(false);
  });

  test('the evidence mirror never appends through a planted ledger.jsonl file symlink', async () => {
    const s = studio();
    await seedAssets(s); // task-1/sync is a real dir with a real ledger so far
    const foreignLedger = join(root, 'task-2', 'sync', 'ledger.jsonl');
    mkdirSync(join(root, 'task-2', 'sync'), { recursive: true });
    writeFileSync(foreignLedger, 'FOREIGN-LINE\n');
    rmSync(join(root, 'task-1', 'sync', 'ledger.jsonl'));
    symlinkSync(foreignLedger, join(root, 'task-1', 'sync', 'ledger.jsonl'));
    const res = await call(s, 'sync_estimate', { durationSeconds: 8 }) as any;
    expect(res.estimatedGenerationCostUsd).toBe(0.5); // the call itself still succeeds
    expect(readFileSync(foreignLedger, 'utf8')).toBe('FOREIGN-LINE\n'); // foreign ledger untouched
    expect(lstatSync(join(root, 'task-1', 'sync', 'ledger.jsonl')).isSymbolicLink()).toBe(true); // planted link preserved
  });
});
