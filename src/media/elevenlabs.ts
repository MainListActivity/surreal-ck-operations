// ElevenLabs media studio. An employee asks for a voice, a line, a sound or a score; this trusted code (inside the
// Paseo plugin, the only place ELEVENLABS_API_KEY is visible) makes the request, writes the audio into the task's
// evidence folder and returns paths and sizes only. Every call is gated on the live task lease, role-checked, capped
// per project per day and audited. The key never reaches a result, an error or an audit line.
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompanyCore, OpsScope } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { describeTransportFailure, type Fetcher } from '../ops/fetcher.ts';

export const MEDIA_TOOLS = ['media_info', 'media_voices', 'media_voice_design', 'media_tts', 'media_dialogue', 'media_sfx', 'media_music'] as const;
export type MediaTool = typeof MEDIA_TOOLS[number];

const KINDS = ['tts', 'dialogue', 'sfx', 'music', 'voice_design'] as const;
type Kind = typeof KINDS[number];
const DEFAULT_ROLES = ['ai-content', 'concept-design', 'asset-production', 'screenwriter', 'qa', 'engineering'];
const DEFAULT_LIMITS: Record<Kind, number> = { tts: 1500, dialogue: 600, sfx: 300, music: 60, voice_design: 30 };
const DAY_SECONDS = 86_400;
const OUTPUT = 'output_format=mp3_44100_128';
const DEFAULT_MODEL = 'eleven_v3';
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.mp3$/;
const VOICE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_MS = 120_000;
const MUSIC_MS = 300_000;

const USAGE: Record<Exclude<MediaTool, 'media_info'>, string> = {
  media_voices: '{"search?"} 查声线，返回 voice_id、名称、标签',
  media_voice_design: '{"name","description"(20-1000 字),"text?"(100-1000 字，给出则用作试听词),"previewIndex?"(默认 0)} 零人工设计新声线，返回 voice_id 与各试听 mp3',
  media_tts: '{"voiceId","text"(<=5000 字),"file":"xxx.mp3","modelId?"(默认 eleven_v3),"languageCode?"} 单句配音',
  media_dialogue: '{"inputs":[{"voiceId","text"}],"file","modelId?","languageCode?"} 多人对白：最多 10 个声线，总字数 <=2000，超出请拆段',
  media_sfx: '{"text","file","durationSeconds?"(0.5-30),"loop?","promptInfluence?"(0-1)} 音效',
  media_music: '{"file","prompt"(<=4100 字) 或 "compositionPlan","lengthMs?"(3000-600000),"instrumental?","modelId?"} 配乐用 prompt 加 instrumental:true；主题曲用 compositionPlan（歌词写在 sections[].lines）；二选一',
};
const TIPS = [
  '台词与对白可加音频标签，如 [whispers] [laughs] [sighs]（eleven_v3 支持）',
  '声线先 media_voices 查现成的；没有合适的就 media_voice_design 设计，返回的 voice_id 直接用于 media_tts / media_dialogue',
  'file 只能是纯文件名 xxx.mp3（不含路径），产物写在 outputDir；需要进产品仓库的文件自行拷贝',
];

type Args = Record<string, unknown>;
interface Out { value: unknown; audit?: { action: string; evidence: string } }
type Handler = (scope: OpsScope, args: Args) => Promise<Out>;
interface Preview { audio_base_64: string; generated_voice_id: string; duration_secs: number }
interface Subscription { tier: string; character_count: number; character_limit: number; next_character_count_reset_unix: number }

export interface MediaDeps {
  core: Pick<CompanyCore, 'opsScope' | 'auditOps' | 'opsCount'>;
  apiKey: () => string | undefined;
  fetch?: Fetcher;
  /** Per-task folders live under here: audio lands in `<evidenceRoot>/<taskId>/media/`. */
  evidenceRoot: string;
  now?: () => number;
  /** Defaults to SCK_MEDIA_ROLES, then the built-in list. */
  roles?: readonly string[];
  /** Per-project daily caps; default to SCK_MEDIA_DAILY_<KIND>, then the built-in caps. */
  limits?: Partial<Record<Kind, number>>;
  baseUrl?: string;
}

const invalid = (message: string) => new CompanyError('invalid', message);
const record = (value: unknown): Args => (value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {});
const scrub = (text: string, key: string | undefined) => (key ? text.split(key).join('[已遮盖]') : text);

function str(args: Args, key: string, min: number, max: number): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw invalid(`${key} 需为 ${min}-${max} 字的文本`);
  return value.trim();
}

const optStr = (args: Args, key: string, min: number, max: number) => (args[key] === undefined ? undefined : str(args, key, min, max));

function num(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(`${key} 需在 ${min}-${max} 之间`);
  return value;
}

function bool(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value !== undefined && typeof value !== 'boolean') throw invalid(`${key} 需为 true 或 false`);
  return value as boolean | undefined;
}

function voiceId(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !VOICE.test(value)) throw invalid(`${key} 不是合法的 voice_id（先用 media_voices 查）`);
  return value;
}

function fileName(args: Args): string {
  const value = args.file;
  if (typeof value !== 'string' || !FILE.test(value)) throw invalid('file 只能是纯文件名 xxx.mp3（字母数字 . _ -，不含路径）');
  return value;
}

function compositionPlan(value: unknown): Args {
  const plan = record(value);
  if (!Array.isArray(plan.sections) || plan.sections.length === 0) throw invalid('compositionPlan 需要 sections 数组（至少一段）');
  return plan;
}

const envRoles = (): string[] | undefined => {
  const roles = (process.env.SCK_MEDIA_ROLES ?? '').split(',').map(item => item.trim()).filter(Boolean);
  return roles.length ? roles : undefined;
};

function envLimits(): Partial<Record<Kind, number>> {
  const out: Partial<Record<Kind, number>> = {};
  for (const kind of KINDS) {
    const raw = process.env[`SCK_MEDIA_DAILY_${kind.toUpperCase()}`]?.trim();
    if (raw && Number.isInteger(Number(raw))) out[kind] = Number(raw);
  }
  return out;
}

const upstreamText = (detail: unknown): string => {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map(item => String(record(item).msg ?? '')).join('; ');
  return String(record(detail).message ?? '');
};

/** Upstream errors are `{detail:{status,message}}`, `{detail:"..."}` or `{detail:[{msg}]}`; only a short, key-free text is kept. */
async function upstreamFailure(res: Response, key: string): Promise<CompanyError> {
  const detail = ((await res.json().catch(() => ({}))) as { detail?: unknown }).detail;
  const message = scrub(upstreamText(detail) || res.statusText || 'no detail', key).slice(0, 300);
  if (res.status === 429 || record(detail).status === 'quota_exceeded') return new CompanyError('limit_reached', `ElevenLabs 额度或频率已达上限：${message}`, true);
  if (res.status === 401) return new CompanyError('not_configured', 'ElevenLabs 拒绝了 API key（401），请老板检查 private/service.env 中的 ELEVENLABS_API_KEY');
  if (res.status === 400 || res.status === 422) return invalid(`ElevenLabs 拒绝了请求：${message}`);
  return new CompanyError('upstream_error', `ElevenLabs 请求失败：HTTP ${res.status} ${message}`, res.status >= 500);
}

export class MediaStudio {
  readonly tools: readonly string[] = MEDIA_TOOLS;
  private readonly roles: readonly string[];
  private readonly limits: Record<Kind, number>;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly fetchImpl: Fetcher;
  private readonly handlers: Record<MediaTool, Handler>;

  constructor(private readonly deps: MediaDeps) {
    this.roles = deps.roles ?? envRoles() ?? DEFAULT_ROLES;
    this.limits = { ...DEFAULT_LIMITS, ...envLimits(), ...deps.limits };
    this.baseUrl = deps.baseUrl ?? 'https://api.elevenlabs.io';
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.handlers = {
      media_info: scope => this.info(scope),
      media_voices: (_scope, args) => this.voices(args),
      media_voice_design: (scope, args) => this.voiceDesign(scope, args),
      media_tts: (scope, args) => this.tts(scope, args),
      media_dialogue: (scope, args) => this.dialogue(scope, args),
      media_sfx: (scope, args) => this.sfx(scope, args),
      media_music: (scope, args) => this.music(scope, args),
    };
  }

  /** Employee instances hold no media state, so there is nothing to drop when a lease ends. */
  release(_employeeId: string): void {}

  async call(credential: string, taskId: string, tool: string, args: Args = {}): Promise<unknown> {
    const scope = await this.deps.core.opsScope(credential, taskId);
    if (!this.roles.includes(scope.actor.role)) throw new CompanyError('forbidden', `role ${scope.actor.role} may not use media tools`);
    const handler = Object.hasOwn(this.handlers, tool) ? this.handlers[tool as MediaTool] : undefined;
    if (!handler) throw invalid(`unknown media tool: ${tool}`);
    try {
      const { value, audit = { action: 'ops_call', evidence: tool } } = await handler(scope, args);
      await this.deps.core.auditOps(scope, audit.action, audit.evidence);
      return value;
    } catch (error) {
      throw this.safe(error);
    }
  }

  private safe(error: unknown): CompanyError {
    const key = this.deps.apiKey();
    if (error instanceof CompanyError) return new CompanyError(error.code, scrub(error.message, key), error.retryable);
    return new CompanyError('upstream_error', `media 调用失败：${scrub(String((error as Error)?.message ?? error), key).slice(0, 200)}`);
  }

  private key(): string {
    const key = this.deps.apiKey();
    if (!key) throw new CompanyError('not_configured', '未配置 ELEVENLABS_API_KEY：请老板在 private/service.env 中添加后执行 paseo plugin reload sck-company');
    return key;
  }

  private async api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs: number }, bytes = false): Promise<T> {
    const key = this.key();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw await upstreamFailure(res, key);
      return (bytes ? Buffer.from(await res.arrayBuffer()) : await res.json()) as T;
    } catch (error) {
      if (error instanceof CompanyError) throw error;
      const { detail } = describeTransportFailure(error, init.timeoutMs);
      throw new CompanyError('upstream_error', `ElevenLabs 请求失败：${ctrl.signal.aborted ? `超时（${init.timeoutMs / 1000}s）` : detail}`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  private outputDir(scope: OpsScope): string {
    return join(this.deps.evidenceRoot, scope.taskId, 'media');
  }

  /** Written to a temp name and renamed, so a half-written mp3 never sits under its final name. Same name overwrites. */
  private write(scope: OpsScope, file: string, bytes: Buffer): string {
    const dir = this.outputDir(scope);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, file);
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    return path;
  }

  /** Checked before any upstream request, so a missing key or an exhausted daily cap spends nothing. */
  private async gate(scope: OpsScope, kind: Kind): Promise<void> {
    this.key();
    const used = await this.deps.core.opsCount(scope.project, `ops_media_${kind}`, DAY_SECONDS);
    if (used >= this.limits[kind]) throw new CompanyError('limit_reached', `项目今日 ${kind} 次数已达上限 ${this.limits[kind]}（SCK_MEDIA_DAILY_${kind.toUpperCase()} 可调），明天再试`);
  }

  private async info(scope: OpsScope): Promise<Out> {
    const configured = Boolean(this.deps.apiKey());
    const sub = configured ? await this.api<Subscription>('/v1/user/subscription', { method: 'GET', timeoutMs: REQUEST_MS }) : undefined;
    const quotas = Object.fromEntries(await Promise.all(KINDS.map(async kind => [kind, {
      used: await this.deps.core.opsCount(scope.project, `ops_media_${kind}`, DAY_SECONDS), limit: this.limits[kind],
    }])));
    return { value: {
      configured,
      at: new Date(this.now()).toISOString(),
      subscription: sub && {
        tier: sub.tier, character_count: sub.character_count, character_limit: sub.character_limit, next_character_count_reset_unix: sub.next_character_count_reset_unix,
      },
      outputDir: this.outputDir(scope),
      quotas,
      tips: TIPS,
      tools: USAGE,
    } };
  }

  private async voices(args: Args): Promise<Out> {
    const search = typeof args.search === 'string' ? args.search.trim().slice(0, 200) : '';
    const res = await this.api<{ voices?: Args[] }>(`/v2/voices?${new URLSearchParams({ search, page_size: '50' })}`, { method: 'GET', timeoutMs: REQUEST_MS });
    return { value: { voices: (res.voices ?? []).map(({ voice_id, name, category, labels, description }) => ({ voice_id, name, category, labels, description })) } };
  }

  private async voiceDesign(scope: OpsScope, args: Args): Promise<Out> {
    const name = str(args, 'name', 1, 100);
    const description = str(args, 'description', 20, 1000);
    const text = optStr(args, 'text', 100, 1000);
    const index = num(args, 'previewIndex', 0, 99) ?? 0;
    await this.gate(scope, 'voice_design');
    const design = await this.api<{ previews?: Preview[]; text?: string }>('/v1/text-to-voice/design', {
      body: { voice_description: description, model_id: 'eleven_ttv_v3', text, auto_generate_text: !text }, timeoutMs: REQUEST_MS,
    });
    const previews = design.previews ?? [];
    const chosen = Number.isInteger(index) ? previews[index] : undefined;
    if (!chosen) throw invalid(`previewIndex ${index} 不是可用的试听序号（共 ${previews.length} 个）`);
    const slug = name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'voice';
    const parts = previews.map((preview, i) => ({ file: `voice-${slug}-preview${i}.mp3`, bytes: Buffer.from(preview.audio_base_64, 'base64') }));
    const files = parts.map(part => this.write(scope, part.file, part.bytes));
    const { voice_id } = await this.api<{ voice_id: string }>('/v1/text-to-voice', {
      body: { voice_name: name, voice_description: description, generated_voice_id: chosen.generated_voice_id }, timeoutMs: REQUEST_MS,
    });
    return {
      value: {
        voice_id, name, previewIndex: index, text: design.text,
        previews: previews.map((preview, i) => ({ index: i, path: files[i], duration_secs: preview.duration_secs })),
      },
      audit: { action: 'ops_media_voice_design', evidence: `name=${name} voice_id=${voice_id} files=${parts.map(part => part.file).join(',')} bytes=${parts.reduce((sum, part) => sum + part.bytes.length, 0)}` },
    };
  }

  private async tts(scope: OpsScope, args: Args): Promise<Out> {
    const voice = voiceId(args, 'voiceId');
    const text = str(args, 'text', 1, 5000);
    const file = fileName(args);
    const modelId = optStr(args, 'modelId', 1, 64) ?? DEFAULT_MODEL;
    const languageCode = optStr(args, 'languageCode', 2, 10);
    await this.gate(scope, 'tts');
    const bytes = await this.api<Buffer>(`/v1/text-to-speech/${voice}?${OUTPUT}`, {
      body: { text, model_id: modelId, language_code: languageCode }, timeoutMs: REQUEST_MS,
    }, true);
    const path = this.write(scope, file, bytes);
    return {
      value: { path, bytes: bytes.length, chars: text.length, modelId },
      audit: { action: 'ops_media_tts', evidence: `file=${file} bytes=${bytes.length} chars=${text.length} text=${JSON.stringify(text.slice(0, 60))}` },
    };
  }

  private async dialogue(scope: OpsScope, args: Args): Promise<Out> {
    if (!Array.isArray(args.inputs) || args.inputs.length === 0) throw invalid('inputs 需为 [{voiceId,text}] 数组');
    const lines = args.inputs.map(item => ({ voice: voiceId(record(item), 'voiceId'), text: str(record(item), 'text', 1, 2000) }));
    const voices = new Set(lines.map(line => line.voice));
    if (voices.size > 10) throw invalid('一段对白最多 10 个不同声线');
    const chars = lines.reduce((sum, line) => sum + line.text.length, 0);
    if (chars > 2000) throw invalid(`对白总字符 ${chars} 超过 2000，请拆成几段分别生成后再拼接`);
    const file = fileName(args);
    const modelId = optStr(args, 'modelId', 1, 64) ?? DEFAULT_MODEL;
    const languageCode = optStr(args, 'languageCode', 2, 10);
    await this.gate(scope, 'dialogue');
    const bytes = await this.api<Buffer>(`/v1/text-to-dialogue?${OUTPUT}`, {
      body: { inputs: lines.map(line => ({ text: line.text, voice_id: line.voice })), model_id: modelId, language_code: languageCode }, timeoutMs: REQUEST_MS,
    }, true);
    const path = this.write(scope, file, bytes);
    return {
      value: { path, bytes: bytes.length, chars, lines: lines.length, voices: voices.size },
      audit: { action: 'ops_media_dialogue', evidence: `file=${file} bytes=${bytes.length} chars=${chars} lines=${lines.length} first=${JSON.stringify(lines[0]?.text.slice(0, 60))}` },
    };
  }

  private async sfx(scope: OpsScope, args: Args): Promise<Out> {
    const text = str(args, 'text', 1, 1000);
    const file = fileName(args);
    const durationSeconds = num(args, 'durationSeconds', 0.5, 30);
    const loop = bool(args, 'loop');
    const promptInfluence = num(args, 'promptInfluence', 0, 1);
    await this.gate(scope, 'sfx');
    const bytes = await this.api<Buffer>(`/v1/sound-generation?${OUTPUT}`, {
      body: { text, duration_seconds: durationSeconds, loop, prompt_influence: promptInfluence }, timeoutMs: REQUEST_MS,
    }, true);
    const path = this.write(scope, file, bytes);
    return {
      value: { path, bytes: bytes.length, durationSeconds },
      audit: { action: 'ops_media_sfx', evidence: `file=${file} bytes=${bytes.length} duration=${durationSeconds ?? 'auto'}` },
    };
  }

  private async music(scope: OpsScope, args: Args): Promise<Out> {
    const file = fileName(args);
    const prompt = optStr(args, 'prompt', 1, 4100);
    const plan = args.compositionPlan;
    if ((prompt === undefined) === (plan === undefined)) throw invalid('prompt 与 compositionPlan 二选一，只给其中一个');
    const mode = prompt === undefined ? 'plan' : 'prompt';
    if (mode === 'plan' && (args.lengthMs !== undefined || args.instrumental !== undefined)) {
      throw invalid('lengthMs 与 instrumental 只配合 prompt 使用；compositionPlan 的时长和歌词写在 sections 里');
    }
    const modelId = optStr(args, 'modelId', 1, 64) ?? 'music_v1';
    const body = mode === 'prompt'
      ? { prompt, model_id: modelId, music_length_ms: num(args, 'lengthMs', 3000, 600000), force_instrumental: bool(args, 'instrumental') }
      : { composition_plan: compositionPlan(plan), model_id: modelId };
    await this.gate(scope, 'music');
    const bytes = await this.api<Buffer>(`/v1/music?${OUTPUT}`, { body, timeoutMs: MUSIC_MS }, true);
    const path = this.write(scope, file, bytes);
    return {
      value: { path, bytes: bytes.length, mode },
      audit: { action: 'ops_media_music', evidence: `file=${file} bytes=${bytes.length} mode=${mode}` },
    };
  }
}
