// Browser media lane: image and video generation through the owner's logged-in consumer
// sessions (ChatGPT / Gemini / Grok web UIs), driven by ego-browser. The studio enforces the
// same discipline as the paid media studio — live lease via opsScope, role list, per-project
// daily caps, audit on every call — and one shared browser means all jobs serialize.
// Provider failover: 'auto' walks the provider list on limit_reached/login_required/failed.
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { CompanyCore, OpsScope } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import { buildScript } from './browser-scripts.ts';

export const BROWSER_TOOLS = ['media_browser_info', 'media_image', 'media_video', 'notebook_list', 'notebook_create', 'notebook_query', 'notebook_add_source'] as const;
export type BrowserTool = typeof BROWSER_TOOLS[number];
export const BROWSER_PROVIDERS = ['chatgpt', 'gemini', 'grok', 'notebook'] as const;
export type Provider = typeof BROWSER_PROVIDERS[number];

const KINDS = ['image', 'video', 'notebook'] as const;
type Kind = typeof KINDS[number];
const DAY_SECONDS = 86_400;
const DEFAULT_ROLES = ['ai-content', 'concept-design', 'asset-production', 'screenwriter', 'story-author', 'qa', 'engineering'];
const DEFAULT_LIMITS: Record<Kind, number> = { image: 120, video: 40, notebook: 200 };
// Image gen ~20-60s observed; video ~45s+ per clip, plus realtime-recapture headroom.
// Notebook queries draft long Chinese chapters: allow up to 8 minutes.
const TIMEOUT: Record<Kind, number> = { image: 300_000, video: 420_000, notebook: 480_000 };
// Which providers can serve each kind, in failover order. Sora is discontinued (no ChatGPT video);
// grok works but carries a shared weekly cap, so it stays last.
// 'notebook' is the NotebookLM lane — a pseudo-provider covering notebook_* tools only.
const ROUTES = { image: ['chatgpt', 'gemini', 'grok'], video: ['gemini', 'grok'], notebook: ['notebook'] } as const;

const IMG_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png$/;
const VID_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(mp4|webm)$/;
const MD_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/;
const REF_FILE = /\.(png|jpe?g|webp)$/i;
const MAX_REFS = 4;
const MAX_REF_BYTES = 20 * 1024 * 1024;

type Args = Record<string, unknown>;
interface Out { value: unknown; audit?: { action: string; evidence: string } }
interface RunResult { ok: boolean; code?: string; message?: string; file?: string; bytes?: number; via?: string; notebook?: string; url?: string; notebooks?: unknown }
type Runner = (provider: Provider, script: string, timeoutMs: number) => Promise<RunResult>;

export interface BrowserDeps {
  core: Pick<CompanyCore, 'opsScope' | 'auditOps' | 'opsCount'>;
  evidenceRoot: string;
  now?: () => number;
  roles?: readonly string[];
  limits?: Partial<Record<Kind, number>>;
  /** Injected in tests; default runs `ego-browser nodejs -e <script>` as a subprocess. */
  runner?: Runner;
}

const invalid = (message: string) => new CompanyError('invalid', message);

function str(args: Args, key: string, min: number, max: number): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw invalid(`${key} 需为 ${min}-${max} 字的文本`);
  return value.trim();
}
const num = (args: Args, key: string, min: number, max: number): number | undefined => {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(`${key} 需在 ${min}-${max} 之间`);
  return value;
};

function providerArg(args: Args, kind: 'image' | 'video'): Provider[] {
  const routes: readonly Provider[] = ROUTES[kind];
  const value = args.provider;
  if (value === undefined || value === 'auto') return [...routes];
  if (typeof value === 'string' && routes.includes(value as Provider)) return [value as Provider];
  throw invalid(`provider 仅支持 auto 或 ${routes.join('/')}`);
}

function refsArg(args: Args): string[] {
  const value = args.refs;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REFS) throw invalid(`refs 最多 ${MAX_REFS} 张`);
  const out = value.map(item => {
    const p = String(item);
    if (!p.startsWith('/') || !REF_FILE.test(p)) throw invalid('refs 必须是绝对路径的 png/jpg/webp 文件');
    try {
      const st = statSyncSafe(p);
      if (!st || st > MAX_REF_BYTES) throw invalid(`refs 文件不存在或超过 ${MAX_REF_BYTES / 1024 / 1024}MB：${p.split('/').pop()}`);
    } catch (error) {
      if (error instanceof CompanyError) throw error;
      throw invalid(`refs 文件不可读：${p.split('/').pop()}`);
    }
    return p;
  });
  return out;
}
const statSyncSafe = (p: string): number | undefined => { try { return statSync(p).size; } catch { return undefined; } };

const envRoles = (): string[] | undefined => {
  const roles = (process.env.SCK_BROWSER_ROLES ?? process.env.SCK_MEDIA_ROLES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return roles.length ? roles : undefined;
};
function envLimits(): Partial<Record<Kind, number>> {
  const out: Partial<Record<Kind, number>> = {};
  for (const kind of KINDS) {
    const raw = process.env[`SCK_BROWSER_DAILY_${kind.toUpperCase()}`]?.trim();
    if (raw && Number.isInteger(Number(raw))) out[kind] = Number(raw);
  }
  return out;
}

const egoBin = (): string => process.env.SCK_EGO_BROWSER ?? join(process.env.HOME ?? '/nonexistent', '.local/bin/ego-browser');

/** Default runner: one ego-browser nodejs subprocess per job; last __RESULT__ line wins. */
const defaultRunner: Runner = (provider, script, timeoutMs) => new Promise<RunResult>((resolve) => {
  const child = spawn(egoBin(), ['nodejs', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 30_000);
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', error => { clearTimeout(kill); resolve({ ok: false, code: 'failed', message: `ego-browser 启动失败：${error.message}` }); });
  child.on('close', () => {
    clearTimeout(kill);
    const line = out.split('\n').filter(l => l.startsWith('__RESULT__')).pop();
    if (!line) { resolve({ ok: false, code: 'failed', message: `脚本无结果输出：${(err || out).slice(-200)}` }); return; }
    try { resolve(JSON.parse(line.slice(10)) as RunResult); }
    catch { resolve({ ok: false, code: 'failed', message: '结果解析失败' }); }
  });
});

export class BrowserStudio {
  readonly tools = BROWSER_TOOLS;
  private readonly roles: readonly string[];
  private readonly limits: Record<Kind, number>;
  private readonly now: () => number;
  private readonly run: Runner;
  /** One shared browser profile: every job takes a turn, no parallel pages across providers. */
  private tail: Promise<unknown> = Promise.resolve();
  private readonly lastError = new Map<Provider, { code: string; message: string; at: number }>();

  constructor(private readonly deps: BrowserDeps) {
    this.roles = deps.roles ?? envRoles() ?? DEFAULT_ROLES;
    this.limits = { ...DEFAULT_LIMITS, ...envLimits(), ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.run = deps.runner ?? defaultRunner;
  }

  release(_employeeId: string): void {}

  async call(credential: string, taskId: string, tool: string, args: Args = {}): Promise<unknown> {
    const scope = await this.deps.core.opsScope(credential, taskId);
    if (!this.roles.includes(scope.actor.role)) throw new CompanyError('forbidden', `role ${scope.actor.role} may not use browser media tools`);
    const handler = tool === 'media_browser_info' ? () => this.info(scope)
      : tool === 'media_image' ? () => this.generate(scope, 'image', args)
      : tool === 'media_video' ? () => this.generate(scope, 'video', args)
      : tool === 'notebook_list' ? () => this.notebookOp(scope, 'list', args)
      : tool === 'notebook_create' ? () => this.notebookOp(scope, 'create', args)
      : tool === 'notebook_query' ? () => this.notebookOp(scope, 'query', args)
      : tool === 'notebook_add_source' ? () => this.notebookOp(scope, 'add_source', args)
      : undefined;
    if (!handler) throw invalid(`unknown browser media tool: ${tool}`);
    try {
      const { value, audit } = await handler();
      await this.deps.core.auditOps(scope, audit?.action ?? 'ops_call', audit?.evidence ?? tool);
      return value;
    } catch (error) {
      throw this.safe(error);
    }
  }

  private safe(error: unknown): CompanyError {
    if (error instanceof CompanyError) return error;
    return new CompanyError('upstream_error', `浏览器媒体调用失败：${String((error as Error)?.message ?? error).slice(0, 200)}`);
  }

  private outputDir(scope: OpsScope): string {
    return join(this.deps.evidenceRoot, scope.taskId, 'media');
  }

  /** Checked before launching the browser so an exhausted day cap wastes nothing. */
  private async gate(scope: OpsScope, kind: Kind): Promise<void> {
    const used = await this.deps.core.opsCount(scope.project, `ops_browser_${kind}`, DAY_SECONDS);
    if (used >= this.limits[kind]) throw new CompanyError('limit_reached', `项目今日 browser ${kind} 次数已达上限 ${this.limits[kind]}（SCK_BROWSER_DAILY_${kind.toUpperCase()} 可调），明天再试`);
  }

  private async info(scope: OpsScope): Promise<Out> {
    const quotas = Object.fromEntries(await Promise.all(KINDS.map(async kind => [kind, {
      used: await this.deps.core.opsCount(scope.project, `ops_browser_${kind}`, DAY_SECONDS), limit: this.limits[kind],
    }])));
    return { value: {
      at: new Date(this.now()).toISOString(),
      providers: ROUTES,
      quotas,
      providerStatus: Object.fromEntries([...this.lastError].map(([p, e]) => [p, `${e.code}: ${e.message.slice(0, 120)}`])),
      outputDir: this.outputDir(scope),
      notes: [
        '网页会话生成：provider=auto 按 ' + ROUTES.image.join(' → ') + ' 顺序 failover',
        '图片产物为 PNG（透明底能力以会话实际支持为准）；视频产物 mp4 优先、提取失败回落 webm',
        'notebook_* 为 NotebookLM 知识库通道：query 基于笔记本源 grounded 生成章节草稿（带源引用），add_source 把已批文本注入笔记本，约定每卷一本（如 作品名·卷N）',
        'login_required 错误 = 对应平台网页会话过期，需要老板在 ego 浏览器里重新登录该站',
        'limit_reached 为账号级配额（Grok 按周），等重置或换 provider',
      ],
      tools: {
        media_image: '{"prompt","file":"x.png","refs?"[:至多4张参考图绝对路径],"provider?"[:auto/chatgpt/gemini/grok]}',
        media_video: '{"prompt","file":"x.mp4","seconds?"(4-10),"provider?"[:auto/gemini/grok]}',
        notebook_list: '{}',
        notebook_create: '{"title":"作品名·卷N"}',
        notebook_query: '{"notebook":"<笔记本id或标题>","prompt","file":"draft.md"}',
        notebook_add_source: '{"notebook":"<笔记本id或标题>","title":"v01c03-章名","text":"<正文markdown>"}',
      },
    } };
  }

  private async generate(scope: OpsScope, kind: 'image' | 'video', args: Args): Promise<Out> {
    await this.gate(scope, kind);
    const prompt = str(args, 'prompt', 10, kind === 'image' ? 4000 : 2000);
    const fileRe = kind === 'image' ? IMG_FILE : VID_FILE;
    const file = String(args.file ?? '');
    if (!fileRe.test(file)) throw invalid(kind === 'image' ? 'file 只能是纯文件名 xxx.png' : 'file 只能是纯文件名 xxx.mp4/.webm');
    const refs = refsArg(args);
    const seconds = kind === 'video' ? num(args, 'seconds', 4, 10) : undefined;
    const providers = providerArg(args, kind);
    const timeoutMs = TIMEOUT[kind];
    const outDir = this.outputDir(scope);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });

    const attempts: string[] = [];
    for (const provider of providers) {
      const script = buildScript(provider, { kind, prompt, outDir, file, refs, seconds, timeoutMs });
      const result = await this.enqueue(() => this.run(provider, script, timeoutMs));
      if (result.ok && result.file) {
        const rel = join(scope.taskId, 'media', file);
        return { value: {
          file: result.file, bytes: result.bytes, provider, via: result.via,
          evidencePath: rel,
          attempts: attempts.length ? attempts : undefined,
        }, audit: { action: `ops_browser_${kind}`, evidence: `media_${kind} ${provider} ${file} refs=${refs.length} prompt=${prompt.slice(0, 80)}` } };
      }
      const code = result.code ?? 'failed';
      const message = result.message ?? '未知错误';
      attempts.push(`${provider}: ${code}`);
      this.lastError.set(provider, { code, message, at: this.now() });
      if (providers.length === 1 || providers.indexOf(provider) === providers.length - 1) {
        const cls = code === 'login_required' ? 'not_configured' : code === 'limit_reached' ? 'limit_reached' : 'upstream_error';
        throw new CompanyError(cls, `${provider} ${kind} 失败：${message}${attempts.length > 1 ? `（已尝试 ${attempts.join('，')}）` : ''}`);
      }
    }
    throw new CompanyError('upstream_error', '无可用浏览器 provider');
  }

  /** NotebookLM lane: query drafts text into the evidence dir; add_source pushes approved
      text back into the notebook so canon grows. list/create are ungated reads. */
  private async notebookOp(scope: OpsScope, op: 'list' | 'create' | 'query' | 'add_source', args: Args): Promise<Out> {
    const outDir = this.outputDir(scope);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const timeoutMs = TIMEOUT.notebook;
    const base = { kind: 'notebook' as const, prompt: '', outDir, file: 'notebook-result.md', refs: [], timeoutMs };
    let scriptArgs: Parameters<typeof buildScript>[1];
    switch (op) {
      case 'list': {
        scriptArgs = { ...base, notebookOp: 'list' };
        break;
      }
      case 'create': {
        const title = str(args, 'title', 2, 120);
        scriptArgs = { ...base, notebookOp: 'create', title };
        break;
      }
      case 'query': {
        await this.gate(scope, 'notebook');
        const notebook = str(args, 'notebook', 2, 200);
        const prompt = str(args, 'prompt', 10, 8000);
        const file = String(args.file ?? '');
        if (!MD_FILE.test(file)) throw invalid('file 只能是纯文件名 xxx.md');
        scriptArgs = { ...base, notebookOp: 'query', notebook, prompt, file };
        break;
      }
      case 'add_source': {
        await this.gate(scope, 'notebook');
        const notebook = str(args, 'notebook', 2, 200);
        const text = str(args, 'text', 10, 120000);
        const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : undefined;
        scriptArgs = { ...base, notebookOp: 'add_source', notebook, text, title };
        break;
      }
    }
    const result = await this.enqueue(() => this.run('notebook', buildScript('notebook', scriptArgs), timeoutMs));
    if (!result.ok) {
      const code = result.code ?? 'failed';
      this.lastError.set('notebook', { code, message: result.message ?? '未知错误', at: this.now() });
      const cls = code === 'login_required' ? 'not_configured' : code === 'limit_reached' ? 'limit_reached' : 'upstream_error';
      throw new CompanyError(cls, `notebook ${op} 失败：${result.message ?? '未知错误'}`);
    }
    if (op === 'query' && !result.file) throw new CompanyError('upstream_error', 'notebook query 未产出文件');
    const evidenceBits = [op, scriptArgs.notebook ?? '', scriptArgs.title ?? '', scriptArgs.file ?? ''].join(' ').trim();
    return { value: {
      op,
      notebook: result.notebook ?? scriptArgs.notebook,
      notebooks: result.notebooks,
      file: result.file, bytes: result.bytes, url: result.url,
    }, audit: { action: 'ops_browser_notebook', evidence: `notebook_${op} ${evidenceBits}`.slice(0, 160) } };
  }

  /** Serial execution over the single shared ego profile. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => {});
    return next;
  }
}
