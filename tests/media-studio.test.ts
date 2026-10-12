import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../src/core-errors.ts';
import { MEDIA_TOOLS, MediaStudio, type MediaDeps } from '../src/media/elevenlabs.ts';
import type { MediaVault, VaultReply } from '../src/media/vault.ts';

const DESC = 'A warm, calm middle-aged narrator with a gentle smile';

interface VaultCall { kind: string; params: Record<string, any> }

let root = '';
let role = 'ai-content';
let counts: Record<string, number> = {};
let audits: Array<{ task: string; action: string; evidence: string }> = [];
let vaultCalls: VaultCall[] = [];
let configured = true;
let reply: (call: VaultCall) => VaultReply = () => json({});

const json = (value: unknown, status = 200): VaultReply => ({ status, contentType: 'application/json', body: Buffer.from(JSON.stringify(value)) });
const audio = (text: string): VaultReply => ({ status: 200, contentType: 'audio/mpeg', body: Buffer.from(text) });
const outDir = () => join(root, 'task-1', 'media');

const vault: MediaVault = {
  status: async () => ({ configured, grants: [] }),
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

const studio = (extra: Partial<MediaDeps> = {}) => new MediaStudio({ core: core as never, vault, evidenceRoot: root, ...extra });
const call = (media: MediaStudio, tool: string, args: Record<string, unknown> = {}, credential = 'holder') => media.call(credential, 'task-1', tool, args);
async function fail(promise: Promise<unknown>): Promise<CompanyError> {
  try { await promise; } catch (error) { return error as CompanyError; }
  throw new Error('expected a rejection');
}
const kinds = () => vaultCalls.map(item => item.kind);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sck-media-'));
  role = 'ai-content';
  counts = {};
  audits = [];
  vaultCalls = [];
  configured = true;
  reply = () => json({});
  for (const name of Object.keys(process.env)) if (name.startsWith('SCK_MEDIA_')) delete process.env[name];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('media_info', () => {
  test('lists the tools; without a configured vault it says so and asks the vault for nothing else', async () => {
    configured = false;
    const info = await call(studio(), 'media_info') as Record<string, any>;
    expect(info).toMatchObject({ configured: false, outputDir: join(root, 'task-1', 'media') });
    expect(Object.keys(info.tools)).toEqual(MEDIA_TOOLS.filter(tool => tool !== 'media_info'));
    expect(info.tips.length).toBeGreaterThan(0);
    expect(kinds()).toEqual([]);
    expect(audits).toEqual([{ task: 'task-1', action: 'ops_call', evidence: 'media_info' }]);
  });

  test('a vault that is not running reads as not configured, not as a crash', async () => {
    const down: MediaVault = { status: async () => { throw new CompanyError('not_configured', 'sck-vault 未运行'); }, call: vault.call };
    const info = await call(studio({ vault: down }), 'media_info') as Record<string, any>;
    expect(info.configured).toBe(false);
  });

  test('with a configured vault it shows the subscription, the grants that cover the boss budget, and today\'s usage', async () => {
    reply = () => json({ tier: 'creator', character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1760000000 });
    counts = { ops_media_tts: 3 };
    const withGrant: MediaVault = { status: async () => ({ configured: true, grants: [{ id: 'g1', expiresAt: 'later', callsLeft: { tts: 5 } }] }), call: vault.call };
    const info = await call(studio({ vault: withGrant }), 'media_info') as Record<string, any>;
    expect(kinds()).toEqual(['subscription']);
    expect(info.subscription).toEqual({ tier: 'creator', character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1760000000 });
    expect(info.grants).toEqual([{ expiresAt: 'later', callsLeft: { tts: 5 } }]);
    expect(info.quotas.tts).toEqual({ used: 3, limit: 1500 });
  });

  test('when the subscription call is refused the info still reports configured, grants and the reason', async () => {
    const refusing: MediaVault = {
      status: async () => ({ configured: true, grants: [] }),
      call: async () => { throw new CompanyError('forbidden', '未获授权：老板未批准该操作'); },
    };
    const info = await call(studio({ vault: refusing }), 'media_info') as Record<string, any>;
    expect(info.configured).toBe(true);
    expect(info.grants).toEqual([]);
    expect(info.subscription).toBeUndefined();
    expect(info.subscriptionError).toContain('未获授权');
    expect(info.quotas.tts).toEqual({ used: 0, limit: 1500 });
  });
});

describe('media_voices', () => {
  test('passes the search through and keeps only the public fields', async () => {
    reply = () => json({ voices: [{ voice_id: 'v1', name: 'Ann', category: 'premade', labels: { age: 'adult' }, description: 'calm', samples: [{ file_id: 'x' }], preview_url: 'https://cdn/x.mp3' }] });
    const res = await call(studio(), 'media_voices', { search: 'narrator' });
    expect(vaultCalls).toEqual([{ kind: 'voices', params: { search: 'narrator' } }]);
    expect(res).toEqual({ voices: [{ voice_id: 'v1', name: 'Ann', category: 'premade', labels: { age: 'adult' }, description: 'calm' }] });
    expect(audits.at(-1)?.action).toBe('ops_call');
  });
});

describe('media_voice_design', () => {
  const design = {
    previews: [
      { audio_base_64: Buffer.from('PREVIEW-0').toString('base64'), generated_voice_id: 'gen-0', duration_secs: 5.2 },
      { audio_base_64: Buffer.from('PREVIEW-1').toString('base64'), generated_voice_id: 'gen-1', duration_secs: 6.1 },
    ],
    text: 'auto sample text',
  };

  test('designs a voice without a human: every preview is kept, the chosen one becomes the voice', async () => {
    reply = call => (call.kind === 'voice_design' ? json(design) : json({ voice_id: 'VOICE123' }));
    const res = await call(studio(), 'media_voice_design', { name: 'Narrator', description: DESC, previewIndex: 1 }) as Record<string, any>;
    expect(vaultCalls[0]).toEqual({ kind: 'voice_design', params: { voice_description: DESC, model_id: 'eleven_ttv_v3', auto_generate_text: true } });
    expect(vaultCalls[1]).toEqual({ kind: 'voice_create', params: { voice_name: 'Narrator', voice_description: DESC, generated_voice_id: 'gen-1' } });
    expect(res.voice_id).toBe('VOICE123');
    expect(res.previews.map((preview: { path: string }) => readFileSync(preview.path, 'utf8'))).toEqual(['PREVIEW-0', 'PREVIEW-1']);
    expect(audits.at(-1)).toMatchObject({
      task: 'task-1', action: 'ops_media_voice_design',
      evidence: 'name=Narrator voice_id=VOICE123 files=voice-Narrator-preview0.mp3,voice-Narrator-preview1.mp3 bytes=18',
    });
  });

  test('a supplied sample text switches off auto-generation', async () => {
    reply = call => (call.kind === 'voice_design' ? json(design) : json({ voice_id: 'V' }));
    const text = 'a'.repeat(120);
    await call(studio(), 'media_voice_design', { name: 'N', description: DESC, text });
    expect(vaultCalls[0]?.params).toMatchObject({ text, auto_generate_text: false });
  });

  test('bad description, sample text or preview index are refused before a voice is created', async () => {
    reply = call => (call.kind === 'voice_design' ? json(design) : json({ voice_id: 'V' }));
    expect((await fail(call(studio(), 'media_voice_design', { name: 'N', description: 'too short' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_voice_design', { name: 'N', description: DESC, text: 'short' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_voice_design', { name: 'N', description: DESC, previewIndex: 5 }))).code).toBe('invalid');
    expect(kinds()).not.toContain('voice_create');
    expect(existsSync(outDir())).toBe(false);
  });
});

describe('media_tts', () => {
  test('synthesises one line into the task folder and audits it', async () => {
    reply = () => audio('MP3DATA');
    const res = await call(studio(), 'media_tts', { voiceId: 'abc123', text: '你好，[whispers] 小心门口', file: 'hero-line.mp3' }) as Record<string, any>;
    expect(vaultCalls).toEqual([{ kind: 'tts', params: { voiceId: 'abc123', text: '你好，[whispers] 小心门口', model_id: 'eleven_v3' } }]);
    expect(readFileSync(join(outDir(), 'hero-line.mp3'), 'utf8')).toBe('MP3DATA');
    expect(res).toMatchObject({ path: join(outDir(), 'hero-line.mp3'), bytes: 7 });
    expect(audits.at(-1)).toMatchObject({ task: 'task-1', action: 'ops_media_tts' });
    expect(audits.at(-1)?.evidence).toContain('file=hero-line.mp3 bytes=7');
  });

  test('model and language are passed through when chosen', async () => {
    reply = () => audio('X');
    await call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hello there', file: 'a.mp3', modelId: 'eleven_multilingual_v2', languageCode: 'en' });
    expect(vaultCalls[0]?.params).toEqual({ voiceId: 'abc123', text: 'hello there', model_id: 'eleven_multilingual_v2', language_code: 'en' });
  });
});

describe('media_dialogue', () => {
  test('maps the speakers into one vault request and writes the mixed file', async () => {
    reply = () => audio('DIALOGUE');
    const inputs = [{ voiceId: 'v1', text: 'Hi [laughs]' }, { voiceId: 'v2', text: 'Hello.' }, { voiceId: 'v1', text: 'Bye.' }];
    const res = await call(studio(), 'media_dialogue', { inputs, file: 'scene-1.mp3' }) as Record<string, any>;
    expect(vaultCalls[0]).toEqual({
      kind: 'dialogue',
      params: { inputs: [{ text: 'Hi [laughs]', voice_id: 'v1' }, { text: 'Hello.', voice_id: 'v2' }, { text: 'Bye.', voice_id: 'v1' }], model_id: 'eleven_v3' },
    });
    expect(readFileSync(join(outDir(), 'scene-1.mp3'), 'utf8')).toBe('DIALOGUE');
    expect(res).toMatchObject({ bytes: 8, voices: 2, lines: 3 });
    expect(audits.at(-1)?.action).toBe('ops_media_dialogue');
  });

  test('more than ten voices, or more than 2000 characters, are refused before the vault is asked', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ voiceId: `v${i}`, text: 'line' }));
    expect((await fail(call(studio(), 'media_dialogue', { inputs: many, file: 'a.mp3' }))).code).toBe('invalid');
    const long = [{ voiceId: 'v1', text: 'x'.repeat(1000) }, { voiceId: 'v2', text: 'y'.repeat(1001) }];
    const err = await fail(call(studio(), 'media_dialogue', { inputs: long, file: 'a.mp3' }));
    expect(err.code).toBe('invalid');
    expect(err.message).toContain('2000');
    expect(vaultCalls).toEqual([]);
  });
});

describe('media_sfx', () => {
  test('sound effects pass duration, loop and prompt influence', async () => {
    reply = () => audio('SFX');
    await call(studio(), 'media_sfx', { text: 'heavy wooden door creaks open', file: 'door.mp3', durationSeconds: 4, loop: true, promptInfluence: 0.6 });
    expect(vaultCalls[0]).toEqual({ kind: 'sfx', params: { text: 'heavy wooden door creaks open', duration_seconds: 4, loop: true, prompt_influence: 0.6 } });
    expect(audits.at(-1)?.action).toBe('ops_media_sfx');
  });

  test('a duration outside 0.5-30 seconds is refused', async () => {
    expect((await fail(call(studio(), 'media_sfx', { text: 'click', file: 'c.mp3', durationSeconds: 31 }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_sfx', { text: 'click', file: 'c.mp3', durationSeconds: 0.1 }))).code).toBe('invalid');
    expect(vaultCalls).toEqual([]);
  });
});

describe('media_music', () => {
  test('a background score is an instrumental prompt with a fixed length', async () => {
    reply = () => audio('SCORE');
    await call(studio(), 'media_music', { prompt: 'soft piano bed for a night scene', file: 'bgm.mp3', lengthMs: 60000, instrumental: true });
    expect(vaultCalls[0]).toEqual({
      kind: 'music',
      params: { prompt: 'soft piano bed for a night scene', model_id: 'music_v1', music_length_ms: 60000, force_instrumental: true },
    });
    expect(audits.at(-1)?.action).toBe('ops_media_music');
  });

  test('a theme song from a composition plan carries its lyrics, without length or instrumental flags', async () => {
    reply = () => audio('SONG');
    const compositionPlan = {
      positive_global_styles: ['pop', 'warm'], negative_global_styles: ['metal'],
      sections: [{ section_name: 'chorus', positive_local_styles: ['big'], negative_local_styles: [], duration_ms: 15000, lines: ['我们一起出发', '星光照亮路'] }],
    };
    await call(studio(), 'media_music', { compositionPlan, file: 'theme.mp3' });
    expect(vaultCalls[0]?.params).toEqual({ composition_plan: compositionPlan, model_id: 'music_v1' });
  });

  test('prompt and plan are exclusive, the prompt is capped, and length or instrumental only go with a prompt', async () => {
    const plan = { sections: [{ section_name: 's', positive_local_styles: [], negative_local_styles: [], duration_ms: 3000, lines: ['la'] }] };
    expect((await fail(call(studio(), 'media_music', { prompt: 'x'.repeat(20), compositionPlan: plan, file: 'a.mp3' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_music', { file: 'a.mp3' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_music', { prompt: 'x'.repeat(4101), file: 'a.mp3' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_music', { compositionPlan: plan, lengthMs: 60000, file: 'a.mp3' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_music', { compositionPlan: plan, instrumental: true, file: 'a.mp3' }))).code).toBe('invalid');
    expect(vaultCalls).toEqual([]);
  });
});

describe('gate', () => {
  test('a caller who does not hold the lease is refused before anything happens', async () => {
    const err = await fail(call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' }, 'someone-else'));
    expect(err.code).toBe('forbidden');
    expect(vaultCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test('roles outside the list are refused; the list can be overridden by the constructor', async () => {
    role = 'cs';
    expect((await fail(call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' }))).code).toBe('forbidden');
    expect((await call(studio({ roles: ['cs'] }), 'media_info') as Record<string, any>).configured).toBe(true);
  });

  test('SCK_MEDIA_ROLES overrides the role list from the environment', async () => {
    process.env.SCK_MEDIA_ROLES = 'cs, story-author';
    role = 'story-author';
    expect((await call(studio(), 'media_info') as Record<string, any>).configured).toBe(true);
  });

  test('the daily quota stops generation before the vault is asked', async () => {
    counts = { ops_media_tts: 1500 };
    const err = await fail(call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' }));
    expect(err.code).toBe('limit_reached');
    expect(vaultCalls).toEqual([]);
    expect(existsSync(join(outDir(), 'a.mp3'))).toBe(false);
  });

  test('per-kind caps come from SCK_MEDIA_DAILY_* and from the constructor', async () => {
    process.env.SCK_MEDIA_DAILY_SFX = '2';
    counts = { ops_media_sfx: 2 };
    expect((await fail(call(studio(), 'media_sfx', { text: 'click', file: 'c.mp3' }))).code).toBe('limit_reached');
    counts = { ops_media_tts: 5 };
    expect((await fail(call(studio({ limits: { tts: 5 } }), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' }))).code).toBe('limit_reached');
    expect(vaultCalls).toEqual([]);
  });

  test('listing voices never counts against the quota', async () => {
    counts = { ops_media_tts: 1500 };
    reply = () => json({ voices: [] });
    expect(await call(studio(), 'media_voices')).toEqual({ voices: [] });
    expect(kinds()).toEqual(['voices']);
  });

  test('without a configured key generation is not_configured and nothing is asked of the vault', async () => {
    configured = false;
    const err = await fail(call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' }));
    expect(err.code).toBe('not_configured');
    expect(err.message).toContain('sck-vault setup');
    expect(vaultCalls).toEqual([]);
  });

  test('an unknown media tool is invalid', async () => {
    expect((await fail(call(studio(), 'media_nope'))).code).toBe('invalid');
  });
});

describe('file names and output', () => {
  test('only plain mp3 file names are accepted', async () => {
    reply = () => audio('X');
    for (const file of ['../x.mp3', 'a/b.mp3', 'x.wav', '.hidden.mp3', 'sp ace.mp3', '']) {
      expect((await fail(call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file }))).code).toBe('invalid');
    }
    expect(vaultCalls).toEqual([]);
    expect(existsSync(outDir())).toBe(false);
  });

  test('writes are private and atomic: the same name overwrites and nothing else is left behind', async () => {
    reply = () => audio('FIRST');
    await call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'take.mp3' });
    reply = () => audio('SECOND');
    await call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi again', file: 'take.mp3' });
    expect(readFileSync(join(outDir(), 'take.mp3'), 'utf8')).toBe('SECOND');
    expect(readdirSync(outDir())).toEqual(['take.mp3']);
    expect(statSync(outDir()).mode & 0o777).toBe(0o700);
  });
});

describe('upstream replies come back through the vault', () => {
  const tts = (media: MediaStudio) => call(media, 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' });

  test('401 is not_configured and points at sck-vault setup, not at any environment variable', async () => {
    reply = () => json({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401);
    const err = await fail(tts(studio()));
    expect(err).toMatchObject({ code: 'not_configured', retryable: false });
    expect(err.message).toContain('sck-vault setup');
  });

  test('429 and quota_exceeded are limit_reached and retryable', async () => {
    reply = () => json({ detail: 'Too many requests' }, 429);
    expect(await fail(tts(studio()))).toMatchObject({ code: 'limit_reached', retryable: true });
    reply = () => json({ detail: { status: 'quota_exceeded', message: 'You have run out of credits' } }, 401);
    expect(await fail(tts(studio()))).toMatchObject({ code: 'limit_reached', retryable: true });
  });

  test('400 and 422 are invalid and carry the upstream reason, cut to 300 characters', async () => {
    reply = () => json({ detail: { status: 'invalid_text', message: 'x'.repeat(500) } }, 422);
    const err = await fail(tts(studio()));
    expect(err.code).toBe('invalid');
    expect(err.message.length).toBeLessThan(400);
    reply = () => json({ detail: [{ loc: ['body', 'text'], msg: 'field required', type: 'missing' }] }, 422);
    expect(await fail(tts(studio()))).toMatchObject({ code: 'invalid', message: expect.stringContaining('field required') });
  });

  test('other upstream failures are upstream_error; 5xx is retryable', async () => {
    reply = () => json({ detail: 'internal' }, 500);
    expect(await fail(tts(studio()))).toMatchObject({ code: 'upstream_error', retryable: true });
  });

  test('a vault that refuses (no grant, busy, down) passes its own code through', async () => {
    const refusing: MediaVault = { status: vault.status, call: async () => { throw new CompanyError('forbidden', '未获授权：老板未批准该操作'); } };
    expect(await fail(tts(studio({ vault: refusing })))).toMatchObject({ code: 'forbidden' });
  });
});
