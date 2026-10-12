import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../src/core-errors.ts';
import { MEDIA_TOOLS, MediaStudio, type MediaDeps } from '../src/media/elevenlabs.ts';

const KEY = 'xi-test-SECRET-7f3a';
const BASE = 'https://api.elevenlabs.io';
const OUT = 'output_format=mp3_44100_128';
const NOW = Date.parse('2026-10-11T00:00:00Z');
const DESC = 'A warm, calm middle-aged narrator with a gentle smile';
const DESIGN = {
  previews: [
    { audio_base_64: Buffer.from('PREVIEW-0').toString('base64'), generated_voice_id: 'gen-0', duration_secs: 5.2 },
    { audio_base_64: Buffer.from('PREVIEW-1').toString('base64'), generated_voice_id: 'gen-1', duration_secs: 6.1 },
  ],
  text: 'auto sample text',
};

interface Sent { url: string; method: string; headers: Record<string, string>; body?: Record<string, any> }

let root = '';
let role = 'ai-content';
let counts: Record<string, number> = {};
let sent: Sent[] = [];
let audits: Array<{ task: string; action: string; evidence: string }> = [];
let respond: (req: Sent) => Response = () => json({});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const audio = (text: string) => new Response(text, { status: 200 });
const outDir = () => join(root, 'task-1', 'media');

const core = {
  opsScope: async (credential: string, taskId: string) => {
    if (credential !== 'holder') throw new CompanyError('forbidden', 'Ops tools are only available to the current lease holder of the task');
    return { actor: { employeeId: 'emp-1', role, capabilities: ['execute'] }, taskId, project: 'proj-1' };
  },
  auditOps: async (scope: { taskId: string }, action: string, evidence: string) => { audits.push({ task: scope.taskId, action, evidence }); },
  opsCount: async (_project: string, action: string) => counts[action] ?? 0,
};

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const req: Sent = {
    url: String(input), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  };
  sent.push(req);
  return respond(req);
};

const studio = (extra: Partial<MediaDeps> = {}) => new MediaStudio({ core: core as never, apiKey: () => KEY, fetch: fetchFake, evidenceRoot: root, now: () => NOW, ...extra });
const call = (media: MediaStudio, tool: string, args: Record<string, unknown> = {}, credential = 'holder') => media.call(credential, 'task-1', tool, args);
async function fail(promise: Promise<unknown>): Promise<CompanyError> {
  try { await promise; } catch (error) { return error as CompanyError; }
  throw new Error('expected a rejection');
}
const designRoute = (req: Sent) => (req.url.endsWith('/design') ? json(DESIGN) : json({ voice_id: 'VOICE123' }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sck-media-'));
  role = 'ai-content';
  counts = {};
  sent = [];
  audits = [];
  respond = () => json({});
  for (const name of Object.keys(process.env)) if (name.startsWith('SCK_MEDIA_')) delete process.env[name];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('media_info', () => {
  test('lists the tools; without a key it says so and sends nothing upstream', async () => {
    const info = await call(studio({ apiKey: () => undefined }), 'media_info') as Record<string, any>;
    expect(info).toMatchObject({ configured: false, outputDir: outDir() });
    expect(Object.keys(info.tools)).toEqual(MEDIA_TOOLS.filter(tool => tool !== 'media_info'));
    expect(info.tips.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
    expect(audits).toEqual([{ task: 'task-1', action: 'ops_call', evidence: 'media_info' }]);
  });

  test('with a key it reads the subscription and today\'s usage', async () => {
    respond = () => json({ tier: 'creator', character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1760000000 });
    counts = { ops_media_tts: 3 };
    const info = await call(studio(), 'media_info') as Record<string, any>;
    expect(sent[0]).toMatchObject({ url: `${BASE}/v1/user/subscription`, method: 'GET' });
    expect(sent[0].headers['xi-api-key']).toBe(KEY);
    expect(info.subscription).toEqual({ tier: 'creator', character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1760000000 });
    expect(info.quotas.tts).toEqual({ used: 3, limit: 1500 });
  });
});

describe('media_voices', () => {
  test('searches with the page size and keeps only the public fields', async () => {
    respond = () => json({ voices: [{ voice_id: 'v1', name: 'Ann', category: 'premade', labels: { age: 'adult' }, description: 'calm', samples: [{ file_id: 'x' }], preview_url: 'https://cdn/x.mp3' }] });
    const res = await call(studio(), 'media_voices', { search: 'narrator' });
    expect(sent[0]).toMatchObject({ url: `${BASE}/v2/voices?search=narrator&page_size=50`, method: 'GET' });
    expect(res).toEqual({ voices: [{ voice_id: 'v1', name: 'Ann', category: 'premade', labels: { age: 'adult' }, description: 'calm' }] });
    expect(audits.at(-1)?.action).toBe('ops_call');
  });
});

describe('media_voice_design', () => {
  test('designs a voice without a human: every preview is kept, the chosen one becomes the voice', async () => {
    respond = designRoute;
    const res = await call(studio(), 'media_voice_design', { name: 'Narrator', description: DESC, previewIndex: 1 }) as Record<string, any>;
    expect(sent[0]).toMatchObject({ url: `${BASE}/v1/text-to-voice/design`, method: 'POST' });
    expect(sent[0].body).toEqual({ voice_description: DESC, model_id: 'eleven_ttv_v3', auto_generate_text: true });
    expect(sent[1]).toMatchObject({ url: `${BASE}/v1/text-to-voice`, method: 'POST' });
    expect(sent[1].body).toEqual({ voice_name: 'Narrator', voice_description: DESC, generated_voice_id: 'gen-1' });
    expect(res.voice_id).toBe('VOICE123');
    expect(res.previews.map((preview: { path: string }) => readFileSync(preview.path, 'utf8'))).toEqual(['PREVIEW-0', 'PREVIEW-1']);
    expect(audits.at(-1)).toMatchObject({ task: 'task-1', action: 'ops_media_voice_design', evidence: 'name=Narrator voice_id=VOICE123 files=voice-Narrator-preview0.mp3,voice-Narrator-preview1.mp3 bytes=18' });
  });

  test('a supplied sample text switches off auto-generation', async () => {
    respond = designRoute;
    const text = 'a'.repeat(120);
    await call(studio(), 'media_voice_design', { name: 'N', description: DESC, text });
    expect(sent[0].body).toMatchObject({ text, auto_generate_text: false });
  });

  test('bad description, sample text or preview index are refused before a voice is created', async () => {
    respond = designRoute;
    expect((await fail(call(studio(), 'media_voice_design', { name: 'N', description: 'too short' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_voice_design', { name: 'N', description: DESC, text: 'short' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_voice_design', { name: 'N', description: DESC, previewIndex: 5 }))).code).toBe('invalid');
    expect(sent.filter(req => req.url.endsWith('/v1/text-to-voice'))).toHaveLength(0);
    expect(existsSync(outDir())).toBe(false);
  });
});

describe('media_tts', () => {
  test('synthesises a line into the task folder and audits it', async () => {
    respond = () => audio('MP3DATA');
    const res = await call(studio(), 'media_tts', { voiceId: 'abc123', text: '你好，[whispers] 小心门口', file: 'hero-line.mp3' }) as Record<string, any>;
    expect(sent[0]).toMatchObject({ url: `${BASE}/v1/text-to-speech/abc123?${OUT}`, method: 'POST' });
    expect(sent[0].headers).toEqual({ 'xi-api-key': KEY, 'content-type': 'application/json' });
    expect(sent[0].body).toEqual({ text: '你好，[whispers] 小心门口', model_id: 'eleven_v3' });
    expect(readFileSync(join(outDir(), 'hero-line.mp3'), 'utf8')).toBe('MP3DATA');
    expect(res).toMatchObject({ path: join(outDir(), 'hero-line.mp3'), bytes: 7 });
    expect(audits.at(-1)).toMatchObject({ task: 'task-1', action: 'ops_media_tts' });
    expect(audits.at(-1)?.evidence).toContain('file=hero-line.mp3 bytes=7');
  });

  test('model and language are passed through when chosen', async () => {
    respond = () => audio('X');
    await call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hello there', file: 'a.mp3', modelId: 'eleven_multilingual_v2', languageCode: 'en' });
    expect(sent[0].body).toEqual({ text: 'hello there', model_id: 'eleven_multilingual_v2', language_code: 'en' });
  });
});

describe('media_dialogue', () => {
  test('maps the speakers into one request and writes the mixed file', async () => {
    respond = () => audio('DIALOGUE');
    const inputs = [{ voiceId: 'v1', text: 'Hi [laughs]' }, { voiceId: 'v2', text: 'Hello.' }, { voiceId: 'v1', text: 'Bye.' }];
    const res = await call(studio(), 'media_dialogue', { inputs, file: 'scene-1.mp3' }) as Record<string, any>;
    expect(sent[0]).toMatchObject({ url: `${BASE}/v1/text-to-dialogue?${OUT}`, method: 'POST' });
    expect(sent[0].body).toEqual({
      inputs: [{ text: 'Hi [laughs]', voice_id: 'v1' }, { text: 'Hello.', voice_id: 'v2' }, { text: 'Bye.', voice_id: 'v1' }],
      model_id: 'eleven_v3',
    });
    expect(readFileSync(join(outDir(), 'scene-1.mp3'), 'utf8')).toBe('DIALOGUE');
    expect(res).toMatchObject({ bytes: 8, voices: 2, lines: 3 });
    expect(audits.at(-1)?.action).toBe('ops_media_dialogue');
  });

  test('more than ten voices, or more than 2000 characters, are refused', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ voiceId: `v${i}`, text: 'line' }));
    expect((await fail(call(studio(), 'media_dialogue', { inputs: many, file: 'a.mp3' }))).code).toBe('invalid');
    const long = [{ voiceId: 'v1', text: 'x'.repeat(1000) }, { voiceId: 'v2', text: 'y'.repeat(1001) }];
    const err = await fail(call(studio(), 'media_dialogue', { inputs: long, file: 'a.mp3' }));
    expect(err.code).toBe('invalid');
    expect(err.message).toContain('2000');
    expect(sent).toHaveLength(0);
  });
});

describe('media_sfx', () => {
  test('sound effects pass duration, loop and prompt influence', async () => {
    respond = () => audio('SFX');
    await call(studio(), 'media_sfx', { text: 'heavy wooden door creaks open', file: 'door.mp3', durationSeconds: 4, loop: true, promptInfluence: 0.6 });
    expect(sent[0]).toMatchObject({ url: `${BASE}/v1/sound-generation?${OUT}`, method: 'POST' });
    expect(sent[0].body).toEqual({ text: 'heavy wooden door creaks open', duration_seconds: 4, loop: true, prompt_influence: 0.6 });
    expect(audits.at(-1)?.action).toBe('ops_media_sfx');
  });

  test('a duration outside 0.5-30 seconds is refused', async () => {
    expect((await fail(call(studio(), 'media_sfx', { text: 'click', file: 'c.mp3', durationSeconds: 31 }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_sfx', { text: 'click', file: 'c.mp3', durationSeconds: 0.1 }))).code).toBe('invalid');
    expect(sent).toHaveLength(0);
  });
});

describe('media_music', () => {
  test('a background score is an instrumental prompt with a fixed length', async () => {
    respond = () => audio('SCORE');
    await call(studio(), 'media_music', { prompt: 'soft piano bed for a night scene', file: 'bgm.mp3', lengthMs: 60000, instrumental: true });
    expect(sent[0]).toMatchObject({ url: `${BASE}/v1/music?${OUT}`, method: 'POST' });
    expect(sent[0].body).toEqual({ prompt: 'soft piano bed for a night scene', model_id: 'music_v1', music_length_ms: 60000, force_instrumental: true });
    expect(audits.at(-1)?.action).toBe('ops_media_music');
  });

  test('a theme song from a composition plan carries its lyrics, without length or instrumental flags', async () => {
    respond = () => audio('SONG');
    const compositionPlan = {
      positive_global_styles: ['pop', 'warm'], negative_global_styles: ['metal'],
      sections: [{ section_name: 'chorus', positive_local_styles: ['big'], negative_local_styles: [], duration_ms: 15000, lines: ['我们一起出发', '星光照亮路'] }],
    };
    await call(studio(), 'media_music', { compositionPlan, file: 'theme.mp3' });
    expect(sent[0].body).toEqual({ composition_plan: compositionPlan, model_id: 'music_v1' });
  });

  test('prompt and plan are exclusive, the prompt is capped, and length or instrumental only go with a prompt', async () => {
    const plan = { sections: [{ section_name: 's', positive_local_styles: [], negative_local_styles: [], duration_ms: 3000, lines: ['la'] }] };
    expect((await fail(call(studio(), 'media_music', { prompt: 'x'.repeat(20), compositionPlan: plan, file: 'a.mp3' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_music', { file: 'a.mp3' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_music', { prompt: 'x'.repeat(4101), file: 'a.mp3' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_music', { compositionPlan: plan, lengthMs: 60000, file: 'a.mp3' }))).code).toBe('invalid');
    expect((await fail(call(studio(), 'media_music', { compositionPlan: plan, instrumental: true, file: 'a.mp3' }))).code).toBe('invalid');
    expect(sent).toHaveLength(0);
  });
});

describe('gate', () => {
  test('a caller who does not hold the lease is refused before anything happens', async () => {
    const err = await fail(call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' }, 'someone-else'));
    expect(err.code).toBe('forbidden');
    expect(sent).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  test('roles outside the list are refused; the list can be overridden by the constructor', async () => {
    role = 'cs';
    expect((await fail(call(studio(), 'media_info'))).code).toBe('forbidden');
    respond = () => json({});
    expect((await call(studio({ roles: ['cs'] }), 'media_info') as Record<string, any>).configured).toBe(true);
  });

  test('SCK_MEDIA_ROLES overrides the role list from the environment', async () => {
    process.env.SCK_MEDIA_ROLES = 'cs, story-author';
    role = 'story-author';
    expect((await call(studio({ apiKey: () => undefined }), 'media_info') as Record<string, any>).configured).toBe(false);
  });

  test('the daily quota stops generation before any upstream request', async () => {
    counts = { ops_media_tts: 1500 };
    const err = await fail(call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' }));
    expect(err.code).toBe('limit_reached');
    expect(sent).toHaveLength(0);
    expect(existsSync(join(outDir(), 'a.mp3'))).toBe(false);
  });

  test('per-kind caps come from SCK_MEDIA_DAILY_* and from the constructor', async () => {
    process.env.SCK_MEDIA_DAILY_SFX = '2';
    counts = { ops_media_sfx: 2 };
    expect((await fail(call(studio(), 'media_sfx', { text: 'click', file: 'c.mp3' }))).code).toBe('limit_reached');
    counts = { ops_media_tts: 5 };
    expect((await fail(call(studio({ limits: { tts: 5 } }), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' }))).code).toBe('limit_reached');
    expect(sent).toHaveLength(0);
  });

  test('listing voices and reading info never count against the quota', async () => {
    counts = { ops_media_tts: 1500 };
    respond = () => json({ voices: [] });
    expect(await call(studio(), 'media_voices')).toEqual({ voices: [] });
    expect(sent).toHaveLength(1);
  });

  test('without a key generation is not_configured and nothing is sent', async () => {
    const err = await fail(call(studio({ apiKey: () => undefined }), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' }));
    expect(err.code).toBe('not_configured');
    expect(err.message).toContain('ELEVENLABS_API_KEY');
    expect(sent).toHaveLength(0);
  });

  test('an unknown media tool is invalid', async () => {
    expect((await fail(call(studio(), 'media_nope'))).code).toBe('invalid');
  });
});

describe('file names and output', () => {
  test('only plain mp3 file names are accepted', async () => {
    respond = () => audio('X');
    for (const file of ['../x.mp3', 'a/b.mp3', 'x.wav', '.hidden.mp3', 'sp ace.mp3', '']) {
      expect((await fail(call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file }))).code).toBe('invalid');
    }
    expect(sent).toHaveLength(0);
    expect(existsSync(outDir())).toBe(false);
  });

  test('writes are private and atomic: the same name overwrites and nothing else is left behind', async () => {
    respond = () => audio('FIRST');
    await call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'take.mp3' });
    respond = () => audio('SECOND');
    await call(studio(), 'media_tts', { voiceId: 'abc123', text: 'hi again', file: 'take.mp3' });
    expect(readFileSync(join(outDir(), 'take.mp3'), 'utf8')).toBe('SECOND');
    expect(readdirSync(outDir())).toEqual(['take.mp3']);
    expect(statSync(outDir()).mode & 0o777).toBe(0o700);
  });
});

describe('upstream errors', () => {
  const tts = (media: MediaStudio) => call(media, 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' });

  test('401 is not_configured and points at the variable to check', async () => {
    respond = () => json({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401);
    const err = await fail(tts(studio()));
    expect(err).toMatchObject({ code: 'not_configured', retryable: false });
    expect(err.message).toContain('ELEVENLABS_API_KEY');
  });

  test('429 and quota_exceeded are limit_reached and retryable', async () => {
    respond = () => json({ detail: 'Too many requests' }, 429);
    expect(await fail(tts(studio()))).toMatchObject({ code: 'limit_reached', retryable: true });
    respond = () => json({ detail: { status: 'quota_exceeded', message: 'You have run out of credits' } }, 401);
    expect(await fail(tts(studio()))).toMatchObject({ code: 'limit_reached', retryable: true });
  });

  test('400 and 422 are invalid and carry the upstream reason, cut to 300 characters', async () => {
    respond = () => json({ detail: { status: 'invalid_text', message: 'x'.repeat(500) } }, 422);
    const err = await fail(tts(studio()));
    expect(err.code).toBe('invalid');
    expect(err.message.length).toBeLessThan(400);
    respond = () => json({ detail: [{ loc: ['body', 'text'], msg: 'field required', type: 'missing' }] }, 422);
    expect(await fail(tts(studio()))).toMatchObject({ code: 'invalid', message: expect.stringContaining('field required') });
  });

  test('other failures are upstream_error, and 5xx and transport failures are retryable', async () => {
    respond = () => json({ detail: 'internal' }, 500);
    expect(await fail(tts(studio()))).toMatchObject({ code: 'upstream_error', retryable: true });
    respond = () => { throw new TypeError('fetch failed'); };
    expect(await fail(tts(studio()))).toMatchObject({ code: 'upstream_error', retryable: true });
  });

  test('the key never shows up in a result, an error or an audit line', async () => {
    const media = studio();
    respond = () => json({ tier: 'creator' });
    const info = await call(media, 'media_info');
    respond = () => audio('OK');
    const ok = await call(media, 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'a.mp3' });
    respond = () => json({ detail: { status: 'invalid_text', message: `rejected key ${KEY}` } }, 422);
    const bad = await fail(call(media, 'media_tts', { voiceId: 'abc123', text: 'hi', file: 'b.mp3' }));
    respond = () => json({ detail: `echo ${KEY}` }, 500);
    const down = await fail(call(media, 'media_sfx', { text: 'boom', file: 'c.mp3' }));
    expect(JSON.stringify([info, ok, bad.message, down.message, audits])).not.toContain(KEY);
    expect(bad.message).toContain('[已遮盖]');
  });
});
