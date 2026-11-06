// Sync-3 video media studio (sync.so). Employees hand this trusted code a video+audio pair from
// their task evidence inbox; it uploads through sck-vault (the only key holder), quotes without
// generating, and submits lip-sync jobs only under an owner spend-approval artifact — never an
// env flag. Two artifact kinds can open the gate: `paid` (USD budget caps) and `free-trial`
// (owner console attestation landed by sck-sync-attest: JIT≤2h, single-use, count-only, bound to
// an input SHA allowlist). Every call is lease- and role-gated, capped per project per day,
// audited, and writes only into the task's own sync/ evidence folder. Authoritative bindings,
// spend approvals and the submit state machine live in <serviceHome>/private/sync/ (0600,
// employees cannot write); the ledger under evidence is a review mirror and never participates
// in authorization.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { CompanyCore, OpsScope } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';
import type { MediaVault, VaultReply } from './vault.ts';

export const SYNC_TOOLS = ['sync_info', 'sync_models', 'sync_errors', 'sync_projects', 'sync_project_prepare', 'sync_generations', 'sync_upload', 'sync_estimate', 'sync_generate', 'sync_status', 'sync_download'] as const;
export type SyncTool = typeof SYNC_TOOLS[number];

type Args = Record<string, unknown>;
interface Out { value: unknown; audit?: { action: string; evidence: string } }
type Handler = (scope: OpsScope, args: Args) => Promise<Out>;

const MODEL = 'sync-3';
const DAY_SECONDS = 86_400;
const DEFAULT_ROLES = ['ai-content', 'concept-design', 'asset-production', 'qa', 'engineering'];
const DEFAULT_LIMITS = { upload: 60, read: 240, download: 120 };
const DEFAULT_MAX_JOB_SECONDS = 30;
const MAX_UPLOAD_BYTES = 1 << 30; // far past anything a <=30s sync-3 job needs; upstream hard cap is 5 GiB
const MAX_DOWNLOAD_BYTES = 2 * (1 << 30);
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const FETCH_MS = 180_000;
const LOCK_WAIT_MS = 5_000;
const RETRY_MAX = 5;           // bounded same-key retries after an unknown send outcome
const RETRY_BASE_MS = 10_000;  // exponential backoff base
const RETRY_WINDOW_MS = 600_000;
const REPLAY_DAYS = 7;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FREE_TRIAL_JIT_MS = 2 * 3_600_000;      // attestation freshness window: capturedAt ≤ 2h at submit
const FREE_TRIAL_MAX_JOB_SECONDS = 8;         // free-tier single-shot ceiling pinned to this D01
const PREPARE_LOCK_WAIT_MS = 60_000;          // per-key prepare decision is atomic; waiters queue, not re-mint

const invalid = (message: string) => new CompanyError('invalid', message);
const notConfigured = () => new CompanyError('not_configured', 'Sync 密钥未配置：请老板运行 sck-vault setup sync，并确认 sck-vault 正在运行');
const approvalRequired = (message = 'Sync 生成需要老板落盘的授权工件（private/sync/approvals/）；无工件、工件过期、账户/任务不符或次数用尽一律拒绝') =>
  new CompanyError('payment_approval_required', message);
const record = (value: unknown): Args => (value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {});
const pick = (fields: Record<string, unknown>): Args => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const iso = (now: number) => new Date(now).toISOString();

/** Error text that ever reaches an employee is stripped of URLs and key material, then cut. */
const scrub = (text: string): string =>
  text.replace(/https?:\/\/[^\s"'<>]+/g, '[url]').replace(/[?&](X-Amz-[A-Za-z-]+|Signature|Expires|Credential|x-api-key|xi-api-key)=[^&\s]+/gi, '$1=[redacted]').slice(0, 300);

const UPLOAD_USAGE = '{"file":"<in/里的 xxx.mp4|xxx.wav>","sha256":"<内容SHA256>","expectedMedia?":{"durationSeconds?","fps?","sampleRate?"}} 受控上传：文件须先放在本任务 sync/in/，校验 SHA 与实测媒体参数后返回可消费的 assetId';
const USAGE: Record<Exclude<SyncTool, 'sync_info'>, string> = {
  sync_models: '{} 列出供应商可见模型（只读探测）',
  sync_errors: '{} 供应商机器可读错误目录（只读探测）',
  sync_projects: '{"limit"?1-100,"cursor"?} 列密封 key 所属组织的项目（只读）：只证组织归属（控制台↔keyFp 绑定证据），不证计划/余量',
  sync_project_prepare: '{} 唯一项目与组织绑定就绪（受控，零费用）：GET 回读先行并严格校验契约（items 缺失/null/非数组即拒，不归一为空集），projects 已非空则复用现有项目不新建（取 id 最小者，确定可复现）；空则按台账持久化的固定 client UUID 幂等 POST /v2/projects 至多一次，再回读校验 ≥1 项目且全组织唯一 organizationId；多组织/回读不一致/创建被拒一律 fail-closed 记真实错误码。同 key 跨执行体互斥：并发首调锁内重读台账归并同键，绝不各生成一键。无参数、无 --org 降级',
  sync_generations: '{"since"?(ISO 默认当月初),"limit"?1-100,"cursor"?} 列本组织已消耗生成（只读）：只证消耗侧，不证剩余上限',
  sync_upload: UPLOAD_USAGE,
  sync_estimate: '{"durationSeconds","fps"?} 试算 或 {"videoAssetId","audioAssetId"?} 按已注册资产实测报价；零生成',
  sync_generate: '{"videoAssetId","audioAssetId","outputFileName?":"xxx.mp4"} 提交 sync-3 口型任务：需老板落盘的 paid 或 free-trial 授权工件，model/sync_mode=silence/同长音画全部锁死；返回 actionId 与幂等键，同音画同参数重复调用归并同一动作',
  sync_status: '{"actionId"|"generationId","wait?","timeout?"(1-10),"includeProgress?"} 查询本任务已提交动作；wait 与 includeProgress 互斥',
  sync_download: '{"actionId"|"generationId","file":"xxx.mp4"} 下载已完成结果到本任务 sync/ 目录',
};
const TIPS = [
  '输入先放到 <任务证据目录>/sync/in/，只接受 .mp4/.wav；上传按 SHA256 去重，同账户同项目命中直接复用 assetId',
  'generate 默认拒绝（payment_approval_required）：新增支出为 0，只有老板落盘的授权工件放行——paid 按 USD 预算闸；free-trial 走 sck-sync-attest 控制台目证落盘（每份证据须声明截图真实采集时点，JIT≤2h 自最早证据起算、单次即作废、maxGenerations=1、maxJobSeconds≤8、输入 SHA allowlist 绑定），env/声明一律不放行',
  '上传、estimate、projects、generations、status、download 等零费用检查在无密钥时报 not_configured，如实上报不要绕过',
  'sync_projects/sync_generations 只证组织归属与已消耗：剩余次数上限无官方端点，绝不合成',
  'free-trial 落件前置：先 sync_project_prepare 就绪（唯一 organizationId+projectId 入台账），sck-sync-attest 据此建立控制台↔keyFp 绑定——空项目组织 attest 必拒，这不是可绕过的检查',
  'sync_status 的 wait 与 includeProgress 官方互斥，一次只能用一个',
  '所有查询/下载只认本任务台账绑定的 actionId/generationId，跨任务探测一律 forbidden',
];

export interface MediaMeta {
  durationSeconds: number;
  fps?: number; frameCount?: number;
  sampleRate?: number; channels?: number; sampleCount?: number;
  vfr?: false;
}
interface AssetEntry {
  assetId: string; type: 'VIDEO' | 'AUDIO'; project: string; accountRef: string; sha256: string;
  media: MediaMeta; firstTaskId: string; grants: Array<{ taskId: string; via: string }>; at: string;
}
interface Registry { schema: 'sync-assets/1'; entries: Record<string, Record<string, Record<string, AssetEntry>>> } // accountRef→project→sha256
interface Approval {
  schema: 'sync-spend-approval/1'; approvalId: string; issuer: 'owner'; project: string; taskId: string; accountRef: string;
  kind: 'paid' | 'free-trial'; models: string[]; maxGenerations: number; maxUsdPerJob: number; maxUsdTotal: number;
  maxJobSeconds: number; inputSha256Allowlist?: string[]; issuedAt: string; expiresAt: string;
  // free-trial attestation fields (required for that branch to qualify; ignored for paid):
  plan?: string; paymentMethod?: string; sync3Remaining?: number; capturedAt?: string;
  evidenceHashes?: Record<string, string>; evidenceCapturedAt?: Record<string, string>; accountOrg?: string;
  consumedAt?: string; consumedByActionId?: string;
}
type ActionState = 'reserved' | 'sending' | 'accepted' | 'unknown' | 'completed' | 'failed' | 'rejected' | 'void';
interface SyncAction {
  actionId: string; taskId: string; project: string; accountRef: string; approvalId: string;
  idempotencyKey: string; requestDigest: string; requestBody: Args;
  inputs: { videoAssetId: string; audioAssetId: string; videoSha256: string; audioSha256: string; billableSeconds: number; fps: number };
  estimate: { frameCount: number; usd: number; credits: number | null };
  state: ActionState; generationId?: string; sendIntentAt?: string; lastError?: string;
  reservedUsd: number; reservedCount: 1; replayProtectedUntil?: string; replayed?: boolean;
  recovery?: { attempts: number; firstAt: number; nextAt: number };
  history: Array<{ state: ActionState; at: string; note: string }>;
}
interface Budget { schema: 'sync-budget/1'; byAction: Record<string, { count: number; usd: number; approvalId: string }> }
/**
 * Authoritative per-key prepare state under private/sync/prepare/. `ready` is the only state
 * attest trusts: it means a full GET readback saw ≥1 project with exactly one organizationId,
 * bound to this keyFp. `creating` persists the client UUID before the POST so a crash can only
 * ever replay the SAME idempotency key; `failed` records the real upstream status/code.
 */
interface PrepareRecord {
  schema: 'sync-prepare/1'; accountRef: string; clientUuid: string;
  state: 'creating' | 'ready' | 'failed';
  organizationId?: string; projectId?: string; projectName?: string; reused?: boolean;
  at: string; readbackAt?: string; projectsSeen?: number; lastError?: string;
  history: Array<{ at: string; action: string; note: string }>;
}

export interface SyncDeps {
  core: Pick<CompanyCore, 'opsScope' | 'auditOps' | 'opsCount'>;
  vault: MediaVault;
  /** Per-task folders live under here: inbox is <evidenceRoot>/<taskId>/sync/in/, output sync/. */
  evidenceRoot: string;
  /** Authoritative sync state lives in <serviceHome>/private/sync/ alongside credentials. */
  serviceHome: string;
  now?: () => number;
  roles?: readonly string[];
  limits?: Partial<typeof DEFAULT_LIMITS>;
  maxJobSeconds?: number;
  fetch?: typeof fetch;
  /** Lock-acquire budget in ms; tests shorten it. */
  lockWaitMs?: number;
}

// ---------- controlled media probes (pure TS; the employee's numbers never reach upstream) ----------

function* boxes(buf: Buffer, start: number, end: number): Generator<{ type: string; at: number; size: number; end: number }> {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) return;
    yield { type, at: p + header, size: size - header, end: p + size };
    p += size;
  }
}

function child(buf: Buffer, box: { at: number; size: number }, type: string) {
  for (const b of boxes(buf, box.at, box.at + box.size)) if (b.type === type) return b;
  return undefined;
}

function times(buf: Buffer, at: number): { timescale: number; duration: number } {
  const version = buf.readUInt8(at);
  return version === 1
    ? { timescale: buf.readUInt32BE(at + 20), duration: Number(buf.readBigUInt64BE(at + 24)) }
    : { timescale: buf.readUInt32BE(at + 12), duration: buf.readUInt32BE(at + 16) };
}

export function probeMp4(buf: Buffer): MediaMeta {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') throw invalid('不是可解析的 mp4（缺少 ftyp 头）');
  let moov: { at: number; size: number } | undefined;
  for (const b of boxes(buf, 0, buf.length)) if (b.type === 'moov') moov = b;
  if (!moov) throw invalid('不是可解析的 mp4（缺少 moov）');
  let movie: { timescale: number; duration: number } | undefined;
  let track: { timescale: number; duration: number } | undefined;
  let frames: { count: number; deltas: Set<number> } | undefined;
  for (const box of boxes(buf, moov.at, moov.at + moov.size)) {
    if (box.type === 'mvhd') movie = times(buf, box.at);
    if (box.type !== 'trak') continue;
    const mdia = child(buf, box, 'mdia');
    if (!mdia) continue;
    const hdlr = child(buf, mdia, 'hdlr');
    const mdhd = child(buf, mdia, 'mdhd');
    if (!hdlr || !mdhd || buf.toString('latin1', hdlr.at + 8, hdlr.at + 12) !== 'vide') continue;
    const minf = child(buf, mdia, 'minf');
    const stbl = minf && child(buf, minf, 'stbl');
    const stts = stbl && child(buf, stbl, 'stts');
    track = times(buf, mdhd.at);
    if (stts && stts.size >= 8) {
      const total = buf.readUInt32BE(stts.at + 4);
      const deltas = new Set<number>();
      let count = 0;
      for (let i = 0; i < total; i += 1) {
        const at = stts.at + 8 + i * 8;
        if (at + 8 > stts.end) break;
        count += buf.readUInt32BE(at);
        deltas.add(buf.readUInt32BE(at + 4));
      }
      frames = { count, deltas };
    }
  }
  const span = track ?? movie;
  if (!span || span.timescale <= 0 || span.duration <= 0 || !frames || frames.count === 0) throw invalid('mp4 探测失败：读不到视频轨时长或帧表');
  if (frames.deltas.size > 1) throw invalid('VFR 不支持：stts 帧间隔不一致，请用恒定帧率源文件');
  const durationSeconds = span.duration / span.timescale;
  return { durationSeconds, fps: frames.count / durationSeconds, frameCount: frames.count, vfr: false };
}

export function probeWav(buf: Buffer): MediaMeta {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw invalid('不是可解析的 wav（缺少 RIFF/WAVE 头）');
  let fmt: { format: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number } | undefined;
  let dataBytes = 0;
  let p = 12;
  while (p + 8 <= buf.length) {
    const type = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const at = p + 8;
    if (at + size > buf.length) break;
    if (type === 'fmt ' && size >= 16) {
      fmt = { format: buf.readUInt16LE(at), channels: buf.readUInt16LE(at + 2), sampleRate: buf.readUInt32LE(at + 4), byteRate: buf.readUInt32LE(at + 8), blockAlign: buf.readUInt16LE(at + 12) };
    }
    if (type === 'data') dataBytes = size;
    p = at + size + (size % 2);
  }
  if (!fmt || dataBytes <= 0) throw invalid('wav 探测失败：缺少 fmt 或 data 块');
  if (![1, 3, 0xfffe].includes(fmt.format)) throw invalid('wav 探测失败：仅支持 PCM/float/extensible');
  if (fmt.byteRate <= 0 || fmt.blockAlign <= 0 || fmt.sampleRate <= 0 || fmt.channels <= 0) throw invalid('wav 探测失败：fmt 参数异常');
  return {
    durationSeconds: dataBytes / fmt.byteRate,
    sampleRate: fmt.sampleRate, channels: fmt.channels, sampleCount: Math.floor(dataBytes / fmt.blockAlign),
  };
}

// ---------- kernel-held flock (same binding family as the worktree repo lock) ----------
// A tiny helper process opens the resident lock file and holds flock(LOCK_EX|LOCK_NB); the lock
// file is never deleted. A live holder can never be preempted, a crashed holder's lock is released
// by the kernel, and helper stdin EOF ends the hold. Acquire retries every 50ms up to a bounded
// window; a busy or broken lock answers temporarily_unavailable and never enters the budget
// critical section. The plugin runtime is Node (no bun:ffi), so the portable fcntl binding is used.
const LOCK_HELPER = `import fcntl,sys,time
f=open(sys.argv[1],'a')
end=time.monotonic()+float(sys.argv[2])/1000.0
while True:
    try:
        fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        break
    except OSError:
        if time.monotonic()>=end:
            sys.exit(3)
        time.sleep(0.05)
sys.stdout.write('locked\\n')
sys.stdout.flush()
sys.stdin.buffer.read()`;

export class SyncStudio {
  readonly tools: readonly string[] = [...SYNC_TOOLS];
  private readonly roles: readonly string[];
  private readonly limits: typeof DEFAULT_LIMITS;
  private readonly maxJobSeconds: number;
  private readonly now: () => number;
  private readonly lockWaitMs: number;
  private readonly handlers: Record<SyncTool, Handler>;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SyncDeps) {
    this.roles = deps.roles ?? envList('SCK_SYNC_ROLES') ?? DEFAULT_ROLES;
    this.limits = {
      upload: envInt('SCK_SYNC_DAILY_UPLOAD', DEFAULT_LIMITS.upload),
      read: envInt('SCK_SYNC_DAILY_READ', DEFAULT_LIMITS.read),
      download: envInt('SCK_SYNC_DAILY_DOWNLOAD', DEFAULT_LIMITS.download),
      ...deps.limits,
    };
    this.maxJobSeconds = deps.maxJobSeconds ?? envInt('SCK_SYNC_MAX_JOB_SECONDS', DEFAULT_MAX_JOB_SECONDS);
    this.now = deps.now ?? Date.now;
    this.lockWaitMs = deps.lockWaitMs ?? LOCK_WAIT_MS;
    this.handlers = {
      sync_info: scope => this.info(scope),
      sync_models: scope => this.models(scope),
      sync_errors: scope => this.errors(scope),
      sync_projects: (scope, args) => this.projects(scope, args),
      sync_project_prepare: (scope, args) => this.prepareProject(scope, args),
      sync_generations: (scope, args) => this.generations(scope, args),
      sync_upload: (scope, args) => this.upload(scope, args),
      sync_estimate: (scope, args) => this.estimate(scope, args),
      sync_generate: (scope, args) => this.generate(scope, args),
      sync_status: (scope, args) => this.status(scope, args),
      sync_download: (scope, args) => this.download(scope, args),
    };
  }

  /** Employee instances hold no sync state, so there is nothing to drop when a lease ends. */
  release(_employeeId: string): void {}

  async call(credential: string, taskId: string, tool: string, args: Args = {}): Promise<unknown> {
    const scope = await this.deps.core.opsScope(credential, taskId);
    if (!this.roles.includes(scope.actor.role)) throw new CompanyError('forbidden', `role ${scope.actor.role} may not use sync tools`);
    const handler = Object.hasOwn(this.handlers, tool) ? this.handlers[tool as SyncTool] : undefined;
    if (!handler) throw invalid(`unknown sync tool: ${tool}`);
    try {
      const { value, audit = { action: 'ops_call', evidence: tool } } = await handler(scope, args);
      await this.deps.core.auditOps(scope, audit.action, audit.evidence);
      return value;
    } catch (error) {
      throw this.safe(error);
    }
  }

  private safe(error: unknown): CompanyError {
    if (error instanceof CompanyError) return error;
    return new CompanyError('upstream_error', `sync 调用失败：${scrub(String((error as Error)?.message ?? error)).slice(0, 200)}`);
  }

  // ---------- paths ----------

  private get dirs() {
    const root = join(this.deps.serviceHome, 'private', 'sync');
    return {
      root,
      assets: join(root, 'assets.json'),
      actions: join(root, 'actions'),
      approvals: join(root, 'approvals'),
      prepare: join(root, 'prepare'),
      budget: join(root, 'budget.json'),
      lock: join(root, 'budget.lock'),
    };
  }

  private outDir(scope: OpsScope): string { return join(this.deps.evidenceRoot, scope.taskId, 'sync'); }

  /** Trust anchor: the realpath of evidenceRoot — never a symlink-resolved task directory. */
  private evidenceBase(): string {
    try { return realpathSync(this.deps.evidenceRoot); } catch { throw invalid('证据根目录不可用'); }
  }

  private canonicalDir(scope: OpsScope, sub: readonly string[]): string {
    if (!ID.test(scope.taskId)) throw invalid('taskId 异常'); // defense in depth: taskId comes from the lease
    return join(this.evidenceBase(), scope.taskId, ...sub);
  }

  /**
   * Resolve a task's sync subdir for writing. Every existing path component is lstat-checked
   * BEFORE mkdir, so a symlinked ancestor (dangling or not) can never redirect the creation into
   * a foreign directory; the post-mkdir realpath equality re-checks the check→create window.
   */
  private writeDir(scope: OpsScope, sub: readonly string[]): string {
    const canonical = this.canonicalDir(scope, sub);
    let cursor = this.evidenceBase();
    for (const seg of [scope.taskId, ...sub]) {
      cursor = join(cursor, seg);
      const st = (() => { try { return lstatSync(cursor); } catch { return undefined; } })();
      if (st === undefined) continue;
      if (st.isSymbolicLink()) throw invalid('输出目录路径含符号链接：越界拒绝');
      if (!st.isDirectory()) throw invalid('输出目录路径被非目录占用');
    }
    mkdirSync(canonical, { recursive: true, mode: 0o700 });
    let real: string;
    try { real = realpathSync(canonical); } catch { throw invalid('输出目录不可用'); }
    if (real !== canonical) throw invalid('输出目录被替换为越界目标');
    return canonical;
  }

  private mirror(scope: OpsScope, entry: Args): void {
    try {
      const dir = this.writeDir(scope, ['sync']);
      // The directory chain is clean, but the ledger FILE itself can be a planted symlink (or a
      // fifo/socket) inside a legitimate sync/ dir — appendFileSync would follow it across task
      // boundaries. lstat first and skip non-regular/symlink targets; O_NOFOLLOW on the append
      // closes the check→open swap window atomically. Either way the mirror just stays silent.
      const path = join(dir, 'ledger.jsonl');
      const st = (() => { try { return lstatSync(path); } catch { return undefined; } })();
      if (st !== undefined && (!st.isFile() || st.isSymbolicLink())) return;
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, `${JSON.stringify({ ts: iso(this.now()), ...entry })}\n`); } finally { closeSync(fd); }
    } catch { /* the ledger is a review mirror; it must never fail a call */ }
  }

  /**
   * Task evidence inbox: only files the current task itself placed under sync/in/ can be uploaded.
   * The anchor is the canonical evidenceRoot/taskId/sync/in path — if any level (task, sync, in,
   * or the file itself) is a symlink escaping that prefix, realpath deviates and we refuse.
   */
  private inboxFile(scope: OpsScope, name: string): { path: string; bytes: Buffer; size: number } {
    if (!FILE.test(name) || !/\.(mp4|wav)$/i.test(name)) throw invalid('file 只能是 sync/in/ 下纯文件名 xxx.mp4 或 xxx.wav');
    const canonical = this.canonicalDir(scope, ['sync', 'in']);
    let resolved: string;
    try { resolved = realpathSync(join(canonical, name)); } catch { throw invalid(`输入文件不存在：sync/in/${name}`); }
    if (!resolved.startsWith(canonical + sep) || !statSync(resolved).isFile()) throw invalid('输入文件越界或不是普通文件');
    const size = statSync(resolved).size;
    if (size <= 0 || size > MAX_UPLOAD_BYTES) throw invalid(`输入文件大小 ${size} 超出上限`);
    return { path: resolved, bytes: readFileSync(resolved), size };
  }

  // ---------- vault ----------

  private async providerStatus(): Promise<{ configured: boolean; keyFp?: string }> {
    const reply = await this.deps.vault.status();
    const sync = reply.providers?.sync;
    // Older vault builds have no providers map: sync counts as unconfigured rather than crashing.
    return { configured: sync?.configured === true, keyFp: sync?.keyFp };
  }

  private async keyFp(): Promise<string> {
    const status = await this.providerStatus();
    if (!status.configured || !status.keyFp) throw notConfigured();
    return status.keyFp;
  }

  private async run(kind: string, params: Args): Promise<VaultReply> {
    const reply = await this.deps.vault.call(kind, params);
    if (reply.status >= 200 && reply.status < 300) return reply;
    throw upstreamFailure(reply);
  }

  private async json<T>(kind: string, params: Args): Promise<T> {
    return JSON.parse((await this.run(kind, params)).body.toString('utf8')) as T;
  }

  /** Only vault-issued URLs are fetched; employees can never inject a target. */
  private async fetchUrl(url: string, init: { method: string; body?: Buffer; type?: string }): Promise<Buffer> {
    if (!/^https?:\/\//.test(url)) throw new CompanyError('upstream_error', '供应商回执的地址不可使用');
    const f = this.deps.fetch ?? fetch;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FETCH_MS);
    try {
      const reply = await f(url, {
        method: init.method,
        body: init.body as never,
        headers: init.type ? { 'content-type': init.type } : undefined,
        redirect: init.method === 'PUT' ? 'manual' : 'follow',
        signal: abort.signal,
      });
      if (init.method === 'PUT' && reply.status >= 300 && reply.status < 400) {
        throw new CompanyError('upstream_error', '供应商预签名地址发生重定向，已放弃上传', true);
      }
      if (!(reply.status >= 200 && reply.status < 300)) throw new CompanyError('upstream_error', `供应商存储回执 HTTP ${reply.status}`, reply.status >= 500);
      const buf = Buffer.from(await reply.arrayBuffer());
      if (buf.length > MAX_DOWNLOAD_BYTES) throw new CompanyError('upstream_error', '下载结果超出大小上限');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- authoritative state (private/sync/) ----------

  private ensureDirs(): void {
    for (const dir of [this.dirs.root, this.dirs.actions, this.dirs.approvals, this.dirs.prepare]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  }

  private readJson<T>(path: string): T | undefined {
    try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
  }

  private writeJson(path: string, value: unknown): void {
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  }

  private readRegistry(): Registry {
    const raw = this.readJson<Registry>(this.dirs.assets);
    return raw && raw.schema === 'sync-assets/1' && raw.entries ? raw : { schema: 'sync-assets/1', entries: {} };
  }

  private readBudget(): Budget {
    const raw = this.readJson<Budget>(this.dirs.budget);
    return raw && raw.schema === 'sync-budget/1' && raw.byAction ? raw : { schema: 'sync-budget/1', byAction: {} };
  }

  private listActions(): SyncAction[] {
    let files: string[] = [];
    try { files = readdirSync(this.dirs.actions); } catch { return []; }
    return files.filter(f => f.endsWith('.json'))
      .map(f => this.readJson<SyncAction>(join(this.dirs.actions, f)))
      .filter((a): a is SyncAction => !!a && typeof a.actionId === 'string');
  }

  private actionByGeneration(actions: SyncAction[], generationId: string): SyncAction | undefined {
    return actions.find(a => a.generationId === generationId);
  }

  private loadApprovals(): Approval[] {
    let files: string[] = [];
    try { files = readdirSync(this.dirs.approvals); } catch { return []; }
    return files.filter(f => f.endsWith('.json'))
      .map(f => ({ file: f, approval: asApproval(this.readJson(join(this.dirs.approvals, f))) }))
      // The contract stores each artifact at approvals/<approvalId>.json; enforcing filename =
      // approvalId is what lets consumption update exactly the file that passed the gates.
      .filter((entry): entry is { file: string; approval: Approval } =>
        !!entry.approval && ID.test(entry.approval.approvalId) && entry.file === `${entry.approval.approvalId}.json`)
      .map(entry => entry.approval);
  }

  /** Structurally-valid artifacts that bind this scope, this account and have not expired, newest first. */
  private boundApprovals(scope: OpsScope, keyFp: string, approvals = this.loadApprovals()): Approval[] {
    const now = this.now();
    return approvals
      .filter(a => a.issuer === 'owner' && a.project === scope.project && a.taskId === scope.taskId &&
        a.accountRef === keyFp && Date.parse(a.issuedAt) <= now && now < Date.parse(a.expiresAt) && a.models.includes(MODEL))
      .sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt));
  }

  /**
   * Newest bound approval that can actually open the generate gate. `paid` artifacts qualify on
   * their own, unchanged. `free-trial` artifacts additionally need the full owner console-
   * attestation field set (landed by sck-sync-attest, never by an employee): fresh JIT capture,
   * not yet consumed, pinned single-shot bounds and an input allowlist. Anything missing, stale,
   * consumed or mismatched fails closed with payment_approval_required — self-declared
   * freeEvidence-style fields do not count.
   */
  private validApproval(scope: OpsScope, keyFp: string, approvals = this.loadApprovals()): Approval | undefined {
    return this.boundApprovals(scope, keyFp, approvals)
      .find(a => a.kind === 'paid' || this.freeTrialQualifies(a));
  }

  /** Free-trial qualification is all-or-nothing: every attested field must be present and sane. */
  private freeTrialQualifies(a: Approval): boolean {
    const now = this.now();
    const captured = typeof a.capturedAt === 'string' ? Date.parse(a.capturedAt) : NaN;
    const hashes = a.evidenceHashes;
    const times = a.evidenceCapturedAt;
    const hashKeys = hashes ? Object.keys(hashes) : [];
    const timeValues = times && typeof times === 'object'
      ? Object.entries(times).filter(([k]) => hashKeys.includes(k)).map(([, v]) => (typeof v === 'string' ? Date.parse(v) : NaN))
      : [];
    // capturedAt is not a free-standing claim: it must equal the earliest declared per-evidence
    // capture time, so neither a fresher artifact-level value nor a missing per-file binding can
    // extend the JIT window beyond what the screenshots attest.
    return a.plan === 'free'
      && a.paymentMethod === 'none'
      && typeof a.sync3Remaining === 'number' && Number.isFinite(a.sync3Remaining) && a.sync3Remaining >= 1
      && Number.isFinite(captured) && captured <= now && now - captured <= FREE_TRIAL_JIT_MS
      && typeof a.accountOrg === 'string' && a.accountOrg.length >= 1 && a.accountOrg.length <= 128
      && !!hashes && hashKeys.length > 0
      && Object.values(hashes).every(h => typeof h === 'string' && SHA256_HEX.test(h))
      && !!times && typeof times === 'object' && !Array.isArray(times)
      && Object.keys(times).length === hashKeys.length
      && timeValues.length === hashKeys.length && timeValues.every(t => Number.isFinite(t) && t <= now)
      && timeValues.length > 0 && Math.min(...timeValues) === captured
      && a.consumedAt === undefined
      && a.maxGenerations === 1
      && a.maxJobSeconds > 0 && a.maxJobSeconds <= FREE_TRIAL_MAX_JOB_SECONDS
      && Array.isArray(a.inputSha256Allowlist) && a.inputSha256Allowlist.length > 0
      && a.inputSha256Allowlist.every(s => typeof s === 'string' && SHA256_HEX.test(s));
  }

  /**
   * Free-trial artifacts are single-use. Consumption is committed inside the same lock
   * acquisition, after the reservation and BEFORE send-intent is persisted — once 'sending' is
   * on disk the shot may already be upstream, so the artifact must already be spent and can
   * never arm a second submit. A crash before this point leaves a provably-unsent reserved
   * action (voided by reconcile) and an unconsumed artifact.
   */
  private consumeApproval(approval: Approval, actionId: string): void {
    const path = join(this.dirs.approvals, `${approval.approvalId}.json`); // approvalId is ID- and filename-checked at load
    const raw = this.readJson<Args>(path);
    if (!raw || raw.approvalId !== approval.approvalId) throw approvalRequired('授权工件在消费前失效');
    if (typeof raw.consumedAt === 'string') throw approvalRequired('free-trial 授权工件已被消费');
    this.writeJson(path, { ...raw, consumedAt: iso(this.now()), consumedByActionId: actionId });
  }

  /**
   * One lock protocol for every authoritative write: the kernel flock serializes processes, the
   * in-process queue serializes callers here. Inside the lock we always reconcile crash leftovers
   * first (reserved-without-send-intent is provably never sent → void+release; budget rows without
   * an action are orphaned reservations → released; sending → unknown keeping its budget).
   */
  private async withLock<T>(fn: () => Promise<T> | T, waitMs = this.lockWaitMs): Promise<T> {
    const run = this.queue.then(() => this.kernelLock(fn, waitMs));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async kernelLock<T>(fn: () => Promise<T> | T, waitMs = this.lockWaitMs): Promise<T> {
    this.ensureDirs();
    const helper = spawn('/usr/bin/python3', ['-c', LOCK_HELPER, this.dirs.lock, String(waitMs)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let exited = false;
    const closed = new Promise<void>(done => helper.once('close', () => { exited = true; done(); }));
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => { helper.kill(); reject(new CompanyError('temporarily_unavailable', 'Sync 预算锁获取超时')); }, waitMs + 1_000);
        helper.once('error', () => { clearTimeout(timer); reject(new CompanyError('temporarily_unavailable', 'Sync 预算锁不可用')); });
        helper.once('close', () => { clearTimeout(timer); reject(new CompanyError('temporarily_unavailable', 'Sync 预算锁被占用，稍后重试')); });
        helper.stdout.once('data', () => { clearTimeout(timer); done(); });
      });
      if (exited) throw new CompanyError('temporarily_unavailable', 'Sync 预算锁失效');
      this.reconcileLocked();
      const result = await fn();
      if (exited) throw new CompanyError('temporarily_unavailable', 'Sync 预算锁在临界区内丢失');
      return result;
    } finally {
      helper.stdin.end();
      await closed;
    }
  }

  /** Crash reconciliation; callers run it inside every lock acquisition, never over the network. */
  private reconcileLocked(): void {
    const actions = this.listActions();
    const budget = this.readBudget();
    const ids = new Set(actions.map(a => a.actionId));
    let dirty = false;
    for (const id of Object.keys(budget.byAction)) {
      if (!ids.has(id)) { delete budget.byAction[id]; dirty = true; }
    }
    for (const action of actions) {
      if (action.state === 'reserved') {
        // send-intent was never persisted, so the upstream was provably never contacted.
        if (budget.byAction[action.actionId]) { delete budget.byAction[action.actionId]; dirty = true; }
        action.state = 'void';
        action.history.push({ state: 'void', at: iso(this.now()), note: '预留后未持久化发送意图，崩溃回收：未发送' });
        this.writeJson(join(this.dirs.actions, `${action.actionId}.json`), action);
      } else if (action.state === 'sending') {
        action.state = 'unknown';
        action.recovery ??= { attempts: 0, firstAt: this.now(), nextAt: this.now() };
        action.history.push({ state: 'unknown', at: iso(this.now()), note: '发送意图已持久化但结果未落盘：可能已发送，保预算待同键核对' });
        this.writeJson(join(this.dirs.actions, `${action.actionId}.json`), action);
      }
    }
    if (dirty) this.writeJson(this.dirs.budget, budget);
  }

  /** Legal post-send merges; terminal states and void are never overwritten by a stale outcome. */
  private mergeLocked(action: SyncAction, next: { state: ActionState; note: string; generationId?: string; release?: boolean; replayed?: boolean }): SyncAction {
    const terminal: ActionState[] = ['completed', 'failed', 'rejected', 'void'];
    if (terminal.includes(action.state)) return action;
    if (action.state === 'reserved') return action; // a live caller still owns the reserved→sending window
    if (next.release) {
      const budget = this.readBudget();
      if (budget.byAction[action.actionId]) {
        delete budget.byAction[action.actionId];
        this.writeJson(this.dirs.budget, budget);
      }
    }
    if (next.generationId) {
      action.generationId = next.generationId;
      action.replayProtectedUntil = iso(this.now() + REPLAY_DAYS * DAY_SECONDS * 1000);
    }
    if (next.replayed) action.replayed = true;
    action.state = next.state;
    action.history.push({ state: next.state, at: iso(this.now()), note: next.note });
    this.writeJson(join(this.dirs.actions, `${action.actionId}.json`), action);
    return action;
  }

  // ---------- tools ----------

  private async info(scope: OpsScope): Promise<Out> {
    const status = await this.providerStatus().catch((error: unknown) => {
      if (error instanceof CompanyError && error.code === 'not_configured') return undefined;
      throw error;
    });
    const configured = status?.configured === true;
    const bound = status?.keyFp ? this.boundApprovals(scope, status.keyFp) : [];
    const approval = status?.keyFp ? this.validApproval(scope, status.keyFp, bound) : undefined;
    const freeTrialBound = bound.filter(a => a.kind === 'free-trial');
    const actions = this.listActions().filter(a => a.taskId === scope.taskId);
    const registry = this.readRegistry();
    let assets = 0;
    for (const byProject of Object.values(registry.entries)) {
      for (const [project, bySha] of Object.entries(byProject)) {
        if (project !== scope.project) continue;
        for (const entry of Object.values(bySha)) {
          if (entry.grants.some(g => g.taskId === scope.taskId)) assets += 1;
        }
      }
    }
    const quotas = {
      upload: { used: await this.deps.core.opsCount(scope.project, 'ops_sync_upload', DAY_SECONDS), limit: this.limits.upload },
      read: { used: await this.deps.core.opsCount(scope.project, 'ops_sync_read', DAY_SECONDS), limit: this.limits.read },
      download: { used: await this.deps.core.opsCount(scope.project, 'ops_sync_download', DAY_SECONDS), limit: this.limits.download },
      generate: {
        used: approval ? this.reservedFor(approval.approvalId).count : 0,
        limit: approval?.maxGenerations ?? 0,
      },
    };
    return {
      value: pick({
        configured: { sync: configured },
        at: iso(this.now()),
        outputDir: this.outDir(scope),
        account: {
          verdict: 'unproven',
          apiQuotaEndpoint: false,
          accountRef: status?.keyFp ?? null,
          approval: pick({ present: !!approval, approvalId: approval?.approvalId ?? null, kind: approval?.kind }),
          freeTrial: {
            supported: true,
            generation: freeTrialBound.some(a => this.freeTrialQualifies(a)) ? 'attested single-shot armed' : 'closed',
            boundArtifacts: freeTrialBound.length,
            consumedArtifacts: freeTrialBound.filter(a => a.consumedAt !== undefined).length,
            note: '免费资格无官方核定端点；free-trial 工件=老板控制台目证落盘（sck-sync-attest）：JIT≤2h 按最早证据真实采集时点计、逐文件 SHA↔时点绑定、单次即作废、maxGenerations=1、maxJobSeconds≤8、输入 SHA 绑定；资格缺失/过期/不符一律 fail-closed',
          },
          evidence: {
            source: 'vendor-marketing + authenticated probes + owner-attested approval artifacts',
            marketingFreeTier: { lipSyncPerMonth: 3, sync3PerMonth: 1, sync3MaxSeconds: 15, otherMaxSeconds: 20, noCard: true, watermark: true },
            probes: ['sync_models 可见性', 'sync_estimate 报价（USD 标价，非免费证明）'],
            missing: '账户级剩余次数/计划类型——无官方端点，绝不合成',
          },
          validity: '工件有效期见 approvals/<id>.json；marketing 口径随官方页面变动',
          note: '无有效授权工件时 generate 恒拒（payment_approval_required）；env 与自声明一律不放行',
        },
        quotas,
        bindings: { assets, actions: actions.length },
        tools: USAGE,
        tips: TIPS,
      }),
    };
  }

  private async models(scope: OpsScope): Promise<Out> {
    await this.keyFp();
    await this.capCheck(scope, 'read');
    const res = await this.json<unknown>('sync_models', {});
    const list = Array.isArray(res) ? res : record(res).models;
    return {
      value: { models: Array.isArray(list) ? list : res },
      audit: { action: 'ops_sync_read', evidence: 'models catalog probe' },
    };
  }

  private async errors(scope: OpsScope): Promise<Out> {
    await this.keyFp();
    await this.capCheck(scope, 'read');
    const res = await this.json<unknown>('sync_errors', {});
    const list = Array.isArray(res) ? res : record(res).errors;
    return {
      value: { errors: Array.isArray(list) ? list : res },
      audit: { action: 'ops_sync_read', evidence: 'errors catalog probe' },
    };
  }

  /**
   * Org-side read for the console↔keyFp binding: the sealed key's own project list carries
   * organizationId, which is what the owner's console screenshot must match. Whitelist fields
   * only — nested generation objects (signed URLs) are dropped, never persisted.
   */
  private async projects(scope: OpsScope, args: Args): Promise<Out> {
    const keyFp = await this.keyFp();
    await this.capCheck(scope, 'read');
    const limit = args.limit === undefined ? 100 : num(args, 'limit', 1, 100);
    const cursor = optStr(args, 'cursor', 1, 512);
    const res = record(await this.json<Args>('sync_projects', pick({ limit, cursor })));
    const items = Array.isArray(res.items) ? res.items : [];
    const projects = items.map(item => {
      const p = record(item);
      return pick({
        id: typeof p.id === 'string' ? p.id : undefined,
        name: typeof p.name === 'string' ? p.name : undefined,
        organizationId: typeof p.organizationId === 'string' ? p.organizationId : undefined,
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : undefined,
        updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
        generationsCount: typeof p.generationsCount === 'number' ? p.generationsCount : undefined,
        completedGenerationsCount: typeof p.completedGenerationsCount === 'number' ? p.completedGenerationsCount : undefined,
      });
    }).filter(p => p.id !== undefined);
    const organizationIds = [...new Set(projects.map(p => p.organizationId).filter((v): v is string => typeof v === 'string'))];
    const nextCursor = typeof res.nextCursor === 'string' && res.nextCursor.length > 0 ? res.nextCursor : undefined;
    this.mirror(scope, { op: 'projects', count: projects.length, organizations: organizationIds.length });
    return {
      value: pick({
        accountRef: keyFp,
        count: projects.length,
        organizationIds,
        projects,
        nextCursor,
        proves: '组织归属（控制台截图↔keyFp 绑定证据）；不证计划类型与剩余余量',
      }),
      audit: { action: 'ops_sync_read', evidence: `projects count=${projects.length} orgs=${organizationIds.length}` },
    };
  }

  // ---------- controlled project prepare (the only write on this surface; free & generation-free) ----------

  private preparePath(keyFp: string): string {
    // keyFp is a vault-side hex fingerprint; only a filename-safe charset may reach a path —
    // anything else (a compromised or future vault reply) is refused rather than trusted.
    if (!/^[A-Za-z0-9._-]{8,64}$/.test(keyFp)) throw invalid('密钥指纹异常，拒绝写 prepare 台账');
    return join(this.dirs.prepare, `prepare-${keyFp}.json`);
  }

  /** Malformed or foreign records are refused loudly, never silently re-minted into a second create. */
  private readPrepare(keyFp: string): PrepareRecord | undefined {
    let raw: string | undefined;
    try { raw = readFileSync(this.preparePath(keyFp), 'utf8'); } catch { return undefined; } // no file → no record
    let parsed: Args | undefined;
    try { parsed = JSON.parse(raw) as Args; } catch {
      throw new CompanyError('conflict', 'prepare 台账损坏（非 JSON）：需人工确认后移除该文件重跑，禁止自动换键重创');
    }
    const value = parsed as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CompanyError('conflict', 'prepare 台账损坏（非对象）：需人工确认后移除该文件重跑，禁止自动换键重创');
    }
    const raw2 = value as PrepareRecord;
    if (raw2.schema !== 'sync-prepare/1' || raw2.accountRef !== keyFp ||
        typeof raw2.clientUuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw2.clientUuid) ||
        !['creating', 'ready', 'failed'].includes(raw2.state)) {
      throw new CompanyError('conflict', 'prepare 台账损坏（无法解析或字段不符）：需人工确认后移除该文件重跑，禁止自动换键重创');
    }
    return raw2;
  }

  private writePrepare(record: PrepareRecord): void {
    this.writeJson(this.preparePath(record.accountRef), record);
  }

  /**
   * Full GET /v2/projects readback via the fixed read-only kind, bounded pagination, STRICT
   * contract: a 200 reply whose root is not an object with a well-formed `items` array is a
   * broken readback, never an empty project set — normalizing it to [] would mint a key and
   * create a project on a malformed org. Every contract violation fails closed before any
   * sync_project_create can happen.
   */
  private async readbackProjects(pending: PrepareRecord): Promise<Array<{ id: string; name?: string; organizationId: string }>> {
    try {
      const rows: Array<{ id: string; name?: string; organizationId: string }> = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const res = record(await this.json<Args>('sync_projects', pick({ limit: 100, cursor })));
        if (!Array.isArray(res.items)) {
          throw new CompanyError('conflict', '回读契约不符：HTTP 200 但根结构非对象或 items 缺失/null/非数组，fail-closed');
        }
        for (const item of res.items) {
          const p = record(item);
          const id = typeof p.id === 'string' ? p.id : undefined;
          const organizationId = typeof p.organizationId === 'string' ? p.organizationId : undefined;
          if (id === undefined || organizationId === undefined || organizationId.length === 0) {
            throw new CompanyError('conflict', '回读不一致：项目行缺少 id/organizationId（HTTP 200 但契约不符），fail-closed');
          }
          rows.push({ id, name: typeof p.name === 'string' ? p.name : undefined, organizationId });
        }
        cursor = typeof res.nextCursor === 'string' && res.nextCursor.length > 0 ? res.nextCursor : undefined;
        if (!cursor) return rows;
      }
      throw new CompanyError('conflict', '回读未收敛：项目超过 10 页（>1000），拒绝在未证全量时判定组织唯一性');
    } catch (error) {
      const code = error instanceof CompanyError ? error.code : 'upstream_error';
      this.writePrepare({ ...pending, state: 'failed', lastError: `readback ${code}`, history: [...pending.history, { at: iso(this.now()), action: 'readback', note: `回读失败：${code}（保留同键重入）` }] });
      throw error;
    }
  }

  /** The one upstream write: fixed body + ledger-persisted client UUID; non-2xx fails closed with the real code. */
  private async createProject(pending: PrepareRecord, name: string): Promise<Args> {
    let reply: VaultReply;
    try {
      reply = await this.deps.vault.call('sync_project_create', { name, idempotencyKey: pending.clientUuid });
    } catch (error) {
      // Vault-side rejection (never reached upstream): keep the same key for re-entry.
      const failure = error instanceof CompanyError ? error : new CompanyError('upstream_error', 'sck-vault 调用失败', true);
      this.writePrepare({ ...pending, state: 'failed', lastError: `vault ${failure.code}`, history: [...pending.history, { at: iso(this.now()), action: 'create', note: `vault 拒绝：${failure.code}` }] });
      throw failure;
    }
    if (!(reply.status >= 200 && reply.status < 300)) {
      const body = record(safeJson(reply.body));
      const rawCode = String(body.code ?? body.errorCode ?? body.error_code ?? body.error ?? '').toLowerCase();
      const lastError = `HTTP ${reply.status}${rawCode ? ` ${rawCode}` : ''}`;
      this.writePrepare({ ...pending, state: 'failed', lastError, history: [...pending.history, { at: iso(this.now()), action: 'create', note: `创建被拒：${lastError}（fail-closed，保留同键重入）` }] });
      throw upstreamFailure(reply);
    }
    this.writePrepare({ ...pending, state: 'creating', history: [...pending.history, { at: iso(this.now()), action: 'create', note: `POST /v2/projects 已接受（HTTP ${reply.status}），待回读确认` }] });
    return record(safeJson(reply.body));
  }

  /** Ready-record replay: terminal state, identical fields, zero upstream calls. */
  private prepareHit(scope: OpsScope, keyFp: string, prior: PrepareRecord): Out {
    this.mirror(scope, { op: 'project-prepare', hit: 1, reused: prior.reused ? 1 : 0, projects: prior.projectsSeen });
    return {
      value: pick({
        ready: true, reused: prior.reused ?? false, accountRef: keyFp, clientUuid: prior.clientUuid,
        organizationId: prior.organizationId, projectId: prior.projectId, projectName: prior.projectName,
        readbackAt: prior.readbackAt, at: prior.at,
      }),
      audit: { action: 'ops_sync_prepare', evidence: `hit reuse=${prior.reused ? 1 : 0} project=${prior.projectId} projects=${prior.projectsSeen}` },
    };
  }

  /**
   * The whole fresh-prepare decision runs under one per-key mutual exclusion (kernel flock):
   * re-read the ledger AFTER acquiring the lock, mint the client UUID exactly once and persist
   * it BEFORE the POST, and only then decide on the create. A concurrent executor waits on the
   * same lock and re-reads the ledger here — it either replays the converged ready binding or
   * reuses the SAME persisted UUID (crash leftovers included), so a logical creation happens at
   * most once per key no matter how many executors race. The lock hold includes the readbacks
   * and the single POST: prepare is a rare, short, zero-charge operation, and keeping the
   * decision atomic is worth the hold; everything else on this lock stays millisecond-scale.
   */
  private async prepareLocked(scope: OpsScope, keyFp: string): Promise<Out> {
    this.ensureDirs();
    let prior = this.readPrepare(keyFp);
    if (prior?.state === 'ready') return this.prepareHit(scope, keyFp, prior);

    await this.capCheck(scope, 'read');
    const projectName = 'sck-controlled';
    let pending = prior ?? { schema: 'sync-prepare/1' as const, accountRef: keyFp, clientUuid: randomUUID(), state: 'creating' as const, at: iso(this.now()), history: [] };
    if (!prior) this.writePrepare(pending); // the only mint: inside the lock, before any upstream contact

    // Step 1 — readback before any write: non-empty ⇒ reuse, empty ⇒ one idempotent create.
    let projects = await this.readbackProjects(pending);
    let created: Args | undefined;
    let reused = projects.length > 0;
    if (!reused) {
      created = await this.createProject(pending, projectName);
      pending = this.readPrepare(keyFp) ?? pending;
      projects = await this.readbackProjects(pending);
    } else {
      this.writePrepare({ ...pending, state: 'creating', history: [...pending.history, { at: iso(this.now()), action: 'readback', note: `回读已有 ${projects.length} 个项目：复用不新建` }] });
      pending = this.readPrepare(keyFp) ?? pending;
    }

    // Step 2 — binding validation: ≥1 project, exactly one organizationId, created id visible.
    const organizationIds = [...new Set(projects.map(p => p.organizationId))];
    const failClosed = (lastError: string, note: string): never => {
      this.writePrepare({ ...pending, state: 'failed', lastError, history: [...pending.history, { at: iso(this.now()), action: 'validate', note }] });
      throw new CompanyError('conflict', note);
    };
    if (projects.length === 0) failClosed('readback_empty', '回读不一致：创建回执后项目集仍为空（HTTP 200），fail-closed');
    if (organizationIds.length > 1) failClosed(`multi_org count=${organizationIds.length}`, `项目列表跨 ${organizationIds.length} 个组织，无法唯一绑定，fail-closed（不加 --org 降级）`);
    const organizationId = organizationIds[0];
    if (created) {
      const createdId = typeof created.id === 'string' ? created.id : undefined;
      if (createdId && !projects.some(p => p.id === createdId)) {
        failClosed(`readback_missing_created ${createdId}`, `回读不一致：创建回执的项目 ${createdId} 未出现在回读中，fail-closed`);
      }
    }

    // Step 3 — bind deterministically: the lexicographically-first id, so the same project set
    // always reproduces the same binding.
    const chosen = projects.reduce((best, p) => p.id < best.id ? p : best, projects[0]);
    const now = iso(this.now());
    const ready: PrepareRecord = {
      ...pending, state: 'ready', organizationId, projectId: chosen.id, projectName: chosen.name ?? projectName,
      reused, projectsSeen: projects.length, readbackAt: now,
      history: [...pending.history, { at: now, action: 'ready', note: `绑定 organizationId=${organizationId} projectId=${chosen.id}（${reused ? '复用' : '新建'}）` }],
    };
    this.writePrepare(ready);
    this.mirror(scope, { op: 'project-prepare', hit: 0, reused: reused ? 1 : 0, projects: projects.length });
    return {
      value: pick({
        ready: true, reused, accountRef: keyFp, clientUuid: ready.clientUuid,
        organizationId, projectId: chosen.id, projectName: ready.projectName, readbackAt: now, at: ready.at,
      }),
      audit: { action: 'ops_sync_prepare', evidence: `ready reuse=${reused ? 1 : 0} project=${chosen.id} projects=${projects.length}` },
    };
  }

  /**
   * sync_project_prepare: make the sealed key's org attest-ready. Readback first — a non-empty
   * project set is reused (nothing is created); an empty set triggers exactly one idempotent
   * POST under the ledger-persisted client UUID, then a fresh readback must show ≥1 project,
   * exactly one organizationId and, when the create returned an id, that project present.
   * Every failure mode records the real status/code and refuses; the whole tool is
   * generation-free, allowance-free and charge-free by construction, and the create decision is
   * atomic per key across executors (see prepareLocked).
   */
  private async prepareProject(scope: OpsScope, args: Args): Promise<Out> {
    if (Object.keys(record(args)).length > 0) throw invalid('sync_project_prepare 不接受参数（无 --org 降级，绑定语义固定）');
    const keyFp = await this.keyFp();
    // Read-only fast path: a ready record is terminal, so replaying it needs no lock and no cap.
    const settled = this.readPrepare(keyFp);
    if (settled?.state === 'ready') return this.prepareHit(scope, keyFp, settled);
    return this.withLock(() => this.prepareLocked(scope, keyFp), PREPARE_LOCK_WAIT_MS);
  }

  /**
   * Consumption-side read: generations created inside the window (default = current UTC month).
   * Proves what already ran, never what remains — upstream exposes no quota endpoint. Whitelist
   * fields only: output/segment/synthesized/webhook URLs and input payloads never leave this.
   */
  private async generations(scope: OpsScope, args: Args): Promise<Out> {
    await this.keyFp();
    await this.capCheck(scope, 'read');
    const limit = args.limit === undefined ? 100 : num(args, 'limit', 1, 100);
    const cursor = optStr(args, 'cursor', 1, 512);
    let since: number;
    if (args.since === undefined) {
      const at = new Date(this.now());
      since = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
    } else {
      since = Date.parse(str(args, 'since', 4, 64));
      if (!Number.isFinite(since)) throw invalid('since 需为可解析的 ISO 时间');
    }
    const res = await this.json<unknown>('sync_generations', pick({ limit, cursor }));
    const raw = Array.isArray(res) ? res : record(res).items;
    const list: unknown[] = Array.isArray(raw) ? raw : [];
    const generations: Args[] = [];
    for (const item of list) {
      const g = record(item);
      const createdAt = typeof g.createdAt === 'string' ? g.createdAt : undefined;
      if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < since) continue;
      const row = pick({
        id: typeof g.id === 'string' ? g.id : undefined,
        model: typeof g.model === 'string' ? g.model : undefined,
        status: typeof g.status === 'string' ? g.status : undefined,
        errorCode: typeof g.errorCode === 'string' ? g.errorCode : undefined,
        createdAt,
        projectId: typeof g.projectId === 'string' ? g.projectId : undefined,
        outputDuration: typeof g.outputDuration === 'number' ? g.outputDuration : undefined,
      });
      if (row.id !== undefined) generations.push(row);
    }
    const sync3 = generations.filter(g => g.model === MODEL).length;
    this.mirror(scope, { op: 'generations', since: iso(since), count: generations.length, sync3 });
    return {
      value: pick({
        window: { since: iso(since), until: iso(this.now()) },
        count: generations.length,
        sync3Count: sync3,
        generations,
        proves: '消耗侧事实（窗口内已发生的生成）；不证剩余上限——免费月度锚定组织创建日，以控制台为准',
      }),
      audit: { action: 'ops_sync_read', evidence: `generations since=${iso(since)} count=${generations.length} sync3=${sync3}` },
    };
  }

  private async capCheck(scope: OpsScope, kind: keyof typeof DEFAULT_LIMITS): Promise<void> {
    const action = `ops_sync_${kind}`;
    const used = await this.deps.core.opsCount(scope.project, action, DAY_SECONDS);
    if (used >= this.limits[kind]) throw new CompanyError('limit_reached', `项目今日 ${kind} 次数已达上限 ${this.limits[kind]}（SCK_SYNC_DAILY_${kind.toUpperCase()} 可调），明天再试`);
  }

  /** Probe the declared media metadata assertions against the measured ones. */
  private assertExpected(media: MediaMeta, expected: unknown): void {
    if (expected === undefined) return;
    const want = record(expected);
    const check = (key: keyof MediaMeta, tol: number) => {
      const value = want[key];
      if (value === undefined) return;
      const actual = media[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || typeof actual !== 'number' || Math.abs(actual - value) > tol) {
        throw invalid(`expectedMedia.${key} 与实测 ${String(actual)} 不符`);
      }
    };
    check('durationSeconds', 0.05);
    check('fps', 0.5);
    check('frameCount', 0);
    check('sampleRate', 1);
    check('channels', 0);
    check('sampleCount', 0);
  }

  private async upload(scope: OpsScope, args: Args): Promise<Out> {
    const file = str(args, 'file', 1, 121);
    const declaredSha = str(args, 'sha256', 64, 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(declaredSha)) throw invalid('sha256 需为 64 位十六进制');
    const keyFp = await this.keyFp();
    await this.capCheck(scope, 'upload');
    const input = this.inboxFile(scope, file);
    const sha = sha256hex(input.bytes);
    if (sha !== declaredSha) throw invalid('文件实际 SHA256 与声明不符');
    const media = /\.mp4$/i.test(file) ? probeMp4(input.bytes) : probeWav(input.bytes);
    this.assertExpected(media, args.expectedMedia);
    const type: AssetEntry['type'] = /\.mp4$/i.test(file) ? 'VIDEO' : 'AUDIO';
    const contentType = type === 'VIDEO' ? 'video/mp4' : 'audio/wav';

    const hit = this.readRegistry().entries[keyFp]?.[scope.project]?.[sha];
    if (hit) {
      const entry = await this.withLock(() => {
        const registry = this.readRegistry();
        const current = registry.entries[keyFp]?.[scope.project]?.[sha];
        if (current && !current.grants.some(g => g.taskId === scope.taskId)) {
          current.grants.push({ taskId: scope.taskId, via: 'upload' });
          this.writeJson(this.dirs.assets, registry);
        }
        return current ?? hit;
      });
      this.mirror(scope, { op: 'upload-reuse', file, sha256: sha, assetId: entry.assetId, type });
      return {
        value: { assetId: entry.assetId, sha256: sha, type: entry.type, bytes: input.size, media: entry.media, reused: true },
        audit: { action: 'ops_sync_upload', evidence: `file=${file} sha256=${sha.slice(0, 16)} assetId=${entry.assetId} bytes=${input.size} reused=1` },
      };
    }

    // New asset: presign → plugin-side PUT of the raw bytes (vault receipt URL only) → register.
    const presign = await this.json<{ uploadUrl?: string; url?: string }>('sync_asset_presign', { fileName: file, contentType, size: input.size });
    if (!presign.uploadUrl || !presign.url) throw new CompanyError('upstream_error', '供应商预签名回执缺少 uploadUrl/url');
    await this.fetchUrl(presign.uploadUrl, { method: 'PUT', body: input.bytes, type: contentType });
    const registered = await this.json<{ id?: string; assetId?: string }>('sync_asset_register', { url: presign.url, type, name: file });
    const assetId = registered.id ?? registered.assetId;
    if (typeof assetId !== 'string' || !ID.test(assetId)) throw new CompanyError('upstream_error', '供应商资产注册回执缺少 assetId');

    const entry = await this.withLock(() => {
      const registry = this.readRegistry();
      const existing = registry.entries[keyFp]?.[scope.project]?.[sha];
      if (existing) return { entry: existing, fresh: false };
      registry.entries[keyFp] ??= {};
      registry.entries[keyFp][scope.project] ??= {};
      const fresh: AssetEntry = {
        assetId, type, project: scope.project, accountRef: keyFp, sha256: sha, media,
        firstTaskId: scope.taskId, grants: [{ taskId: scope.taskId, via: 'self' }], at: iso(this.now()),
      };
      registry.entries[keyFp][scope.project][sha] = fresh;
      this.writeJson(this.dirs.assets, registry);
      return { entry: fresh, fresh: true };
    });
    this.mirror(scope, { op: entry.fresh ? 'upload' : 'upload-reuse', file, sha256: sha, assetId: entry.entry.assetId, type, bytes: input.size });
    return {
      value: { assetId: entry.entry.assetId, sha256: sha, type: entry.entry.type, bytes: input.size, media: entry.entry.media, reused: !entry.fresh },
      audit: { action: 'ops_sync_upload', evidence: `file=${file} sha256=${sha.slice(0, 16)} assetId=${entry.entry.assetId} bytes=${input.size} reused=${entry.fresh ? 0 : 1}` },
    };
  }

  /** Consume check (contract §3.6 gate 2): entry must sit under this account+project and carry a grant for this task. */
  private requireAsset(scope: OpsScope, keyFp: string, assetId: string): AssetEntry {
    if (!ID.test(assetId)) throw invalid('assetId 不合法');
    const registry = this.readRegistry();
    const bySha = registry.entries[keyFp]?.[scope.project] ?? {};
    const entry = Object.values(bySha).find(item => item.assetId === assetId);
    if (!entry) throw new CompanyError('forbidden', 'assetId 不在本任务可用范围（未知、跨账户或跨项目）');
    if (entry.grants.some(g => g.taskId === scope.taskId)) return entry;
    const approval = this.validApproval(scope, keyFp);
    if (approval?.inputSha256Allowlist?.includes(entry.sha256)) {
      // The approval explicitly re-authorizes this input for this task: record the grant, then allow.
      entry.grants.push({ taskId: scope.taskId, via: approval.approvalId });
      this.writeJson(this.dirs.assets, registry);
      return entry;
    }
    throw new CompanyError('forbidden', 'assetId 未授权给当前任务消费');
  }

  private async estimate(scope: OpsScope, args: Args): Promise<Out> {
    const keyFp = await this.keyFp();
    await this.capCheck(scope, 'read');
    const videoAssetId = optStr(args, 'videoAssetId', 1, 128);
    const audioAssetId = optStr(args, 'audioAssetId', 1, 128);
    let duration: number;
    let fps: number;
    let source: 'registry' | 'declared';
    if (videoAssetId !== undefined || audioAssetId !== undefined) {
      if (args.durationSeconds !== undefined) throw invalid('assetId 与 durationSeconds 只能选一种计费依据');
      const metas: MediaMeta[] = [];
      await this.withLock(() => {
        if (videoAssetId) metas.push(this.requireAsset(scope, keyFp, videoAssetId).media);
        if (audioAssetId) metas.push(this.requireAsset(scope, keyFp, audioAssetId).media);
      });
      duration = Math.max(...metas.map(m => m.durationSeconds));
      fps = videoAssetId ? metas[0].fps ?? 30 : (num(args, 'fps', 1, 120) ?? 30);
      source = 'registry';
    } else {
      duration = num(args, 'durationSeconds', 0.1, this.maxJobSeconds)
        ?? (() => { throw invalid('需要 durationSeconds+fps? 或 videoAssetId/audioAssetId'); })();
      fps = num(args, 'fps', 1, 120) ?? 30;
      source = 'declared';
    }
    const quote = await this.quote(duration, fps);
    this.mirror(scope, { op: 'estimate', duration, fps, source, usd: quote.usd });
    return {
      value: { estimatedFrameCount: quote.frameCount, estimatedGenerationCostUsd: quote.usd, estimatedCredits: quote.credits, basis: { durationSeconds: duration, fps, source } },
      audit: { action: 'ops_sync_read', evidence: `estimate source=${source} duration=${duration.toFixed(3)} fps=${fps} usd=${quote.usd}` },
    };
  }

  private async quote(duration: number, fps: number): Promise<{ frameCount: number; usd: number; credits: number | null }> {
    const res = await this.json<Args>('sync_estimate', { model: MODEL, duration, fps });
    return {
      frameCount: Number(res.estimatedFrameCount ?? res.estimated_frame_count ?? 0),
      usd: Number(res.estimatedGenerationCost ?? res.estimated_generation_cost ?? res.estimatedCost ?? 0),
      credits: res.estimatedCredits === null || res.estimatedCredits === undefined ? null : Number(res.estimatedCredits),
    };
  }

  /**
   * Logical generation identity: same task/project authorization domain, same account fingerprint,
   * same video+audio content SHA and the same normalized options → the same ledger action.
   * outputFileName and re-uploaded assetIds are deliberately NOT part of it.
   */
  private findLogicalAction(scope: OpsScope, keyFp: string, requestDigest: string, optionsJson: string, video: AssetEntry, audio: AssetEntry): SyncAction | undefined {
    return this.listActions().find(a => a.taskId === scope.taskId && a.project === scope.project &&
      a.accountRef === keyFp && a.state !== 'void' &&
      (a.requestDigest === requestDigest ||
        (a.inputs?.videoSha256 === video.sha256 && a.inputs?.audioSha256 === audio.sha256 &&
          JSON.stringify(record(a.requestBody).options ?? {}) === optionsJson)));
  }

  /**
   * Fold a repeat call into the existing ledger action: no new action, no new key, no second
   * reservation. `unknown` gets the bounded ORIGINAL-key/original-payload recheck, nothing else.
   */
  private async dedup(scope: OpsScope, found: SyncAction): Promise<Out> {
    let merged = found;
    if (merged.state === 'unknown' && !merged.generationId) {
      await this.reconcileUnknown(merged);
      merged = this.readJson<SyncAction>(join(this.dirs.actions, `${merged.actionId}.json`)) ?? merged;
    }
    this.mirror(scope, { op: 'generate-dedup', actionId: merged.actionId, generationId: merged.generationId, state: merged.state, idempotencyKey: merged.idempotencyKey });
    return {
      value: pick({
        actionId: merged.actionId, generationId: merged.generationId, status: merged.state, deduped: true,
        error: ['rejected', 'void', 'failed'].includes(merged.state) ? merged.history.at(-1)?.note : undefined,
        idempotencyKey: merged.idempotencyKey,
        estimate: {
          estimatedFrameCount: merged.estimate?.frameCount, estimatedGenerationCostUsd: merged.estimate?.usd,
          estimatedCredits: merged.estimate?.credits ?? null,
          basis: { durationSeconds: merged.inputs?.billableSeconds, fps: merged.inputs?.fps, source: 'registry' },
        },
      }),
      audit: { action: 'ops_sync_generate', evidence: `actionId=${merged.actionId} dedup=1 state=${merged.state} key=${merged.idempotencyKey.slice(0, 24)}` },
    };
  }

  private async generate(scope: OpsScope, args: Args): Promise<Out> {
    const videoAssetId = str(args, 'videoAssetId', 1, 128);
    const audioAssetId = str(args, 'audioAssetId', 1, 128);
    // outputFileName expresses submit intent only; it never participates in the supplier-visible
    // generation identity, so a rename can never spawn a second send. Download names come from
    // sync_download's own `file` argument.
    const outputFileName = args.outputFileName === undefined ? 'result.mp4' : str(args, 'outputFileName', 1, 121);
    if (!FILE.test(outputFileName) || !outputFileName.endsWith('.mp4')) throw invalid('outputFileName 只能是纯文件名 xxx.mp4');
    const keyFp = await this.keyFp();

    // Gate 2 — consume rights (authoritative registry only; the evidence ledger is never consulted),
    // plus the first logical-identity lookup inside the same lock acquisition.
    const prepared = await this.withLock(() => {
      const video = this.requireAsset(scope, keyFp, videoAssetId);
      const audio = this.requireAsset(scope, keyFp, audioAssetId);
      if (video.type !== 'VIDEO' || audio.type !== 'AUDIO') throw invalid('输入类型固定为一 video + 一 audio');
      const requestBody = {
        model: MODEL,
        input: [{ type: 'video', assetId: video.assetId }, { type: 'audio', assetId: audio.assetId }],
        options: { sync_mode: 'silence' },
      };
      const requestDigest = sha256hex(JSON.stringify(requestBody));
      const optionsJson = JSON.stringify(requestBody.options);
      const existing = this.findLogicalAction(scope, keyFp, requestDigest, optionsJson, video, audio);
      return { video, audio, requestBody, requestDigest, optionsJson, existing };
    });
    const { video, audio, requestBody, requestDigest, optionsJson } = prepared;
    if (prepared.existing) return this.dedup(scope, prepared.existing);

    // Gate 3 — measured media consistency; billable duration covers silence extending the longer input.
    const tolerance = 1 / (video.media.fps ?? 30) + 1 / (audio.media.sampleRate ?? 48_000);
    if (Math.abs(audio.media.durationSeconds - video.media.durationSeconds) > tolerance) {
      throw invalid(`音画同长检查失败：video ${video.media.durationSeconds.toFixed(3)}s / audio ${audio.media.durationSeconds.toFixed(3)}s 超容差 ${tolerance.toFixed(4)}s（不借 silence 凑数、不截词改速）`);
    }
    const billable = Math.max(video.media.durationSeconds, audio.media.durationSeconds);
    const fps = video.media.fps ?? 30;
    if (billable > this.maxJobSeconds) throw invalid(`计费时长 ${billable.toFixed(2)}s 超过 SCK_SYNC_MAX_JOB_SECONDS=${this.maxJobSeconds}s`);

    // Gate 4 — owner spend-approval artifact; nothing else can ever open this gate.
    const approval = this.validApproval(scope, keyFp);
    if (!approval) {
      const bound = this.boundApprovals(scope, keyFp);
      const freeOnly = bound.length > 0 && bound.every(a => a.kind === 'free-trial');
      throw approvalRequired(freeOnly
        ? 'free-trial 授权工件不满足放行条件（资格字段缺失/捕获超 2h 窗/已消费/上限或绑定不符）；需要老板新目证工件或 paid 工件'
        : undefined);
    }
    if (billable > approval.maxJobSeconds) throw approvalRequired(`计费时长 ${billable.toFixed(2)}s 超过授权单任务上限 ${approval.maxJobSeconds}s`);
    if (approval.kind === 'free-trial') {
      const allow = approval.inputSha256Allowlist ?? [];
      if (!allow.includes(video.sha256) || !allow.includes(audio.sha256)) {
        throw approvalRequired('free-trial 工件绑定的输入 SHA 与本单不符（仅放行目证锁定的两路输入）');
      }
    }

    // Gate 5 — real upstream quote on measured inputs, never on employee-declared numbers.
    // free-trial: the USD figure is recorded for the ledger but is NOT a pass criterion and no
    // USD reservation applies — the attestation already pins the single free shot.
    const quote = await this.quote(billable, fps);
    if (approval.kind === 'paid' && quote.usd > approval.maxUsdPerJob) {
      throw approvalRequired(`报价 $${quote.usd.toFixed(4)} 超过授权单任务上限 $${approval.maxUsdPerJob}`);
    }

    // v2 key = trusted account ref + task/project authorization domain + model + content SHAs +
    // normalized options. The supplier sees one identity per logical request, so a renamed output
    // or a re-registered assetId can never mint a second key.
    const idempotencyKey = `sck-${sha256hex(`v2|${keyFp}|${scope.project}|${scope.taskId}|${MODEL}|${video.sha256}|${audio.sha256}|${optionsJson}`)}`;
    const actionId = `act-${randomUUID()}`;

    // Gate 6 — single critical section (owner ruling): reconcile → dedup re-check → re-validate
    // approval → reserve budget → persist reserved → persist sending+sendIntent, all under one
    // flock acquisition. Concurrent identical calls serialize here and converge on one action.
    const action: SyncAction = {
      actionId, taskId: scope.taskId, project: scope.project, accountRef: keyFp, approvalId: approval.approvalId,
      idempotencyKey, requestDigest, requestBody,
      inputs: {
        videoAssetId: video.assetId, audioAssetId: audio.assetId,
        videoSha256: video.sha256, audioSha256: audio.sha256, billableSeconds: billable, fps,
      },
      estimate: { frameCount: quote.frameCount, usd: quote.usd, credits: quote.credits },
      state: 'reserved', reservedUsd: quote.usd, reservedCount: 1,
      history: [{ state: 'reserved', at: iso(this.now()), note: '预算预留（锁内）' }],
    };
    let folded: SyncAction | undefined;
    await this.withLock(() => {
      const existing = this.findLogicalAction(scope, keyFp, requestDigest, optionsJson, video, audio);
      if (existing) { folded = existing; return; }
      const live = this.validApproval(scope, keyFp);
      if (!live || live.approvalId !== approval.approvalId) throw approvalRequired('授权工件在预留前失效');
      const budget = this.readBudget();
      const used = Object.values(budget.byAction).filter(b => b.approvalId === approval.approvalId)
        .reduce((sum, b) => ({ count: sum.count + b.count, usd: sum.usd + b.usd }), { count: 0, usd: 0 });
      // free-trial spends a count, not dollars: maxGenerations=1 and single-use consumption bound
      // it; USD ceilings stay a paid-branch check only.
      if (used.count + 1 > approval.maxGenerations ||
          (live.kind === 'paid' && used.usd + quote.usd > live.maxUsdTotal)) {
        throw approvalRequired('授权次数或金额已用尽');
      }
      budget.byAction[actionId] = { count: 1, usd: quote.usd, approvalId: approval.approvalId };
      this.writeJson(this.dirs.budget, budget);
      this.writeJson(join(this.dirs.actions, `${actionId}.json`), action);
      // Still inside the same lock hold: a free-trial artifact is spent the moment the shot is
      // committed — before send-intent is persisted and long before the upstream reply exists.
      if (live.kind === 'free-trial') this.consumeApproval(live, actionId);
      // Persist the send-intent before any upstream contact.
      action.state = 'sending';
      action.sendIntentAt = iso(this.now());
      action.history.push({ state: 'sending', at: iso(this.now()), note: '发送意图持久化（同锁），此后可能已发送' });
      this.writeJson(join(this.dirs.actions, `${actionId}.json`), action);
    });
    if (folded) return this.dedup(scope, folded);

    // Gate 7 — the only upstream generate call in this code path, outside the lock.
    let reply: VaultReply | undefined;
    let sendError: CompanyError | undefined;
    try {
      reply = await this.deps.vault.call('sync_generate', { ...requestBody, idempotencyKey });
    } catch (error) {
      sendError = error instanceof CompanyError ? error : new CompanyError('upstream_error', 'sck-vault 调用失败', true);
    }

    // Merge the outcome under the lock; a stale snapshot never overwrites a terminal state.
    const merged = await this.withLock(() => {
      const current = this.readJson<SyncAction>(join(this.dirs.actions, `${actionId}.json`)) ?? action;
      if (!reply) {
        return this.mergeLocked(current, {
          state: 'unknown',
          note: `发送结果不可知：${scrub(sendError?.message ?? '无回执').slice(0, 120)}`,
        });
      }
      if (reply.status === 201 || reply.status === 200) {
        const body = record(safeJson(reply.body));
        const generationId = typeof body.id === 'string' ? body.id : typeof body.generationId === 'string' ? body.generationId : undefined;
        const replayed = reply.status === 200 || String(reply.headers?.['idempotency-replayed'] ?? '') === 'true';
        return this.mergeLocked(current, {
          state: 'accepted', generationId, replayed,
          note: replayed ? '幂等键重放 200：归并既有 generation' : '上游 201 已接受',
        });
      }
      const failure = upstreamFailure(reply);
      if (failure.code === 'conflict' || ['invalid', 'not_found', 'payment_approval_required'].includes(failure.code)) {
        // Confirmed refusal before work (bad input, same-key different payload, or the billing gate
        // saying no): provably no generation was created by this action, so the reservation is
        // released and the action ends. Only truly unobservable outcomes keep the budget as unknown.
        return this.mergeLocked(current, {
          state: failure.code === 'conflict' ? 'void' : 'rejected', release: true,
          note: `上游明确拒绝（${reply.status}）：${failure.message.slice(0, 120)}`,
        });
      }
      return this.mergeLocked(current, {
        state: 'unknown', generationId: record(safeJson(reply.body)).id as string | undefined,
        note: `结果不可知（${reply.status}）：保预算，同键有界重试`,
      });
    });
    this.mirror(scope, {
      op: 'generate', actionId, generationId: merged.generationId, state: merged.state,
      idempotencyKey, billableSeconds: billable, usd: quote.usd,
    });
    return {
      value: pick({
        actionId: merged.actionId, generationId: merged.generationId, status: merged.state,
        error: ['rejected', 'void', 'failed'].includes(merged.state) ? merged.history.at(-1)?.note : undefined,
        idempotencyKey, estimate: { estimatedFrameCount: quote.frameCount, estimatedGenerationCostUsd: quote.usd, estimatedCredits: quote.credits, basis: { durationSeconds: billable, fps, source: 'registry' } },
      }),
      audit: { action: 'ops_sync_generate', evidence: `actionId=${actionId} generationId=${merged.generationId ?? 'none'} state=${merged.state} key=${idempotencyKey.slice(0, 24)} billable=${billable.toFixed(3)}s usd=${quote.usd}` },
    };
  }

  private findAction(scope: OpsScope, args: Args): { action: SyncAction; generationId?: string } {
    const actionId = optStr(args, 'actionId', 1, 80);
    const generationId = optStr(args, 'generationId', 1, 128);
    if ((actionId === undefined) === (generationId === undefined)) throw invalid('actionId 与 generationId 二选一');
    const actions = this.listActions();
    const action = actionId ? actions.find(a => a.actionId === actionId) : generationId ? this.actionByGeneration(actions, generationId) : undefined;
    if (!action || action.taskId !== scope.taskId) throw new CompanyError('forbidden', '动作不在本任务台账内（跨任务探测拒绝）');
    return { action, generationId: action.generationId ?? generationId };
  }

  /** One same-key re-send of a still-unknown action: replay merges, never a fresh charge. */
  private async reconcileUnknown(action: SyncAction): Promise<void> {
    const retry = action.recovery ?? { attempts: 0, firstAt: this.now(), nextAt: this.now() };
    if (retry.attempts >= RETRY_MAX || this.now() < retry.nextAt || this.now() - retry.firstAt > RETRY_WINDOW_MS) return;
    await this.withLock(() => {
      const current = this.readJson<SyncAction>(join(this.dirs.actions, `${action.actionId}.json`));
      if (!current || current.state !== 'unknown') return;
      current.recovery = { attempts: retry.attempts + 1, firstAt: retry.firstAt, nextAt: this.now() + RETRY_BASE_MS * 2 ** retry.attempts };
      this.writeJson(join(this.dirs.actions, `${action.actionId}.json`), current);
      action.recovery = current.recovery;
    });
    let reply: VaultReply | undefined;
    try {
      reply = await this.deps.vault.call('sync_generate', { ...action.requestBody, idempotencyKey: action.idempotencyKey });
    } catch { /* stays unknown; nothing about the budget changes */ }
    await this.withLock(() => {
      const current = this.readJson<SyncAction>(join(this.dirs.actions, `${action.actionId}.json`));
      if (!current || current.state !== 'unknown') return;
      if (reply && (reply.status === 201 || reply.status === 200)) {
        const body = record(safeJson(reply.body));
        this.mergeLocked(current, {
          state: 'accepted', generationId: (body.id ?? body.generationId) as string | undefined,
          note: '同键核对得到回执：归并 accepted', replayed: reply.status === 200,
        });
      } else if (reply && reply.status >= 400 && reply.status < 500 && reply.status !== 409) {
        this.mergeLocked(current, { state: 'rejected', release: true, note: `同键核对确认拒绝（${reply.status}），释放预留` });
      }
      // timeouts/5xx/409-in-progress keep it unknown with the budget retained
    });
  }

  private async status(scope: OpsScope, args: Args): Promise<Out> {
    await this.keyFp();
    await this.capCheck(scope, 'read');
    const wait = args.wait === undefined ? false : bool(args, 'wait');
    const includeProgress = args.includeProgress === undefined ? false : bool(args, 'includeProgress');
    if (wait && includeProgress) throw invalid('wait 与 includeProgress 官方互斥，不能同传');
    const timeout = num(args, 'timeout', 1, 10);
    let found: { action: SyncAction; generationId?: string } | undefined;
    await this.withLock(() => { found = this.findAction(scope, args); });
    let { action, generationId } = found!;
    if (action.state === 'unknown' && !action.generationId) {
      await this.reconcileUnknown(action);
      // The same-key retry may have merged a late acceptance; pick up the fresh state.
      const fresh = this.readJson<SyncAction>(join(this.dirs.actions, `${action.actionId}.json`));
      if (fresh) { action = fresh; generationId = fresh.generationId ?? generationId; }
    }
    if (generationId) {
      const reply = await this.json<Args>('sync_get', pick({ id: generationId, wait: wait || undefined, timeout, include: includeProgress ? 'progress' : undefined }));
      const upstreamStatus = typeof reply.status === 'string' ? reply.status : undefined;
      const merged = await this.withLock(() => {
        const current = this.readJson<SyncAction>(join(this.dirs.actions, `${action.actionId}.json`)) ?? action;
        if (upstreamStatus === 'COMPLETED') return this.mergeLocked(current, { state: 'completed', note: '上游回执 COMPLETED' });
        if (upstreamStatus === 'FAILED') return this.mergeLocked(current, { state: 'failed', note: `上游回执 FAILED：${scrub(String(reply.error ?? '')).slice(0, 120)}` });
        if (upstreamStatus === 'REJECTED') return this.mergeLocked(current, { state: 'rejected', note: `上游回执 REJECTED：${scrub(String(reply.error ?? '')).slice(0, 120)}` });
        return current;
      });
      action = merged;
      const progress = reply.progressPercent ?? reply.progress_percent;
      return {
        value: pick({
          actionId: action.actionId, generationId: action.generationId, state: action.state,
          status: upstreamStatus, errorCode: typeof reply.errorCode === 'string' ? reply.errorCode : typeof reply.error_code === 'string' ? reply.error_code : undefined,
          error: reply.error === undefined ? undefined : scrub(String(record(reply.error).message ?? reply.error)),
          outputDuration: typeof reply.outputDuration === 'number' ? reply.outputDuration : typeof reply.output_duration === 'number' ? reply.output_duration : undefined,
          progressPercent: typeof progress === 'number' ? progress : undefined,
        }),
        audit: { action: 'ops_sync_read', evidence: `status actionId=${action.actionId} state=${action.state} upstream=${upstreamStatus ?? 'unknown'}` },
      };
    }
    const fresh = this.readJson<SyncAction>(join(this.dirs.actions, `${action.actionId}.json`)) ?? action;
    return {
      value: { actionId: fresh.actionId, generationId: fresh.generationId, state: fresh.state },
      audit: { action: 'ops_sync_read', evidence: `status actionId=${fresh.actionId} state=${fresh.state}` },
    };
  }

  private async download(scope: OpsScope, args: Args): Promise<Out> {
    const file = str(args, 'file', 1, 121);
    if (!FILE.test(file) || !file.endsWith('.mp4')) throw invalid('file 只能是纯文件名 xxx.mp4');
    await this.keyFp();
    await this.capCheck(scope, 'download');
    let found: { action: SyncAction; generationId?: string } | undefined;
    await this.withLock(() => { found = this.findAction(scope, args); });
    let { action, generationId } = found!;
    if (!generationId) throw new CompanyError('conflict', '该动作尚无 generationId，不能下载');
    if (action.state !== 'completed') {
      // One refresh before refusing: a terminal state may have arrived since the last poll.
      const reply = await this.json<Args>('sync_get', { id: generationId });
      await this.withLock(() => {
        const current = this.readJson<SyncAction>(join(this.dirs.actions, `${action.actionId}.json`)) ?? action;
        if (reply.status === 'COMPLETED') this.mergeLocked(current, { state: 'completed', note: '下载前刷新得到 COMPLETED' });
        else if (reply.status === 'FAILED') this.mergeLocked(current, { state: 'failed', note: '下载前刷新得到 FAILED' });
        else if (reply.status === 'REJECTED') this.mergeLocked(current, { state: 'rejected', note: '下载前刷新得到 REJECTED' });
      });
      action = this.readJson<SyncAction>(join(this.dirs.actions, `${action.actionId}.json`)) ?? action;
      if (action.state !== 'completed') throw new CompanyError('conflict', `动作状态 ${action.state}，结果不可下载（generation_not_ready）`);
    }
    // Boundary check before asking upstream for anything: a symlinked sync/ dir must never pull a
    // signed URL, let alone write the foreign target or mirror into it.
    const dir = this.writeDir(scope, ['sync']);
    const url = (await this.run('sync_download_url', { id: generationId })).body.toString('utf8').trim();
    const bytes = await this.fetchUrl(url, { method: 'GET' });
    const path = join(dir, file);
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, path);
    let host = 'unknown';
    try { host = new URL(url).host; } catch { /* url already validated */ }
    this.mirror(scope, { op: 'download', actionId: action.actionId, generationId, file, bytes: bytes.length, host });
    return {
      value: { path, bytes: bytes.length },
      audit: { action: 'ops_sync_download', evidence: `file=${file} bytes=${bytes.length} host=${host}` },
    };
  }

  private reservedFor(approvalId: string): { count: number; usd: number } {
    return Object.values(this.readBudget().byAction).filter(b => b.approvalId === approvalId)
      .reduce((sum, b) => ({ count: sum.count + b.count, usd: sum.usd + b.usd }), { count: 0, usd: 0 });
  }
}

// ---------- shared small helpers ----------

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

function bool(args: Args, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') throw invalid(`${key} 需为 true 或 false`);
  return value;
}

const envList = (name: string): string[] | undefined => {
  const list = (process.env[name] ?? '').split(',').map(item => item.trim()).filter(Boolean);
  return list.length ? list : undefined;
};

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  return raw && Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : fallback;
};

const safeJson = (buf: Buffer): unknown => {
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
};

const asApproval = (value: unknown): Approval | undefined => {
  const a = record(value);
  const isoOk = (s: unknown) => typeof s === 'string' && Number.isFinite(Date.parse(s));
  if (a.schema !== 'sync-spend-approval/1' || a.issuer !== 'owner' ||
      typeof a.approvalId !== 'string' || typeof a.project !== 'string' || typeof a.taskId !== 'string' || typeof a.accountRef !== 'string' ||
      (a.kind !== 'paid' && a.kind !== 'free-trial') || !Array.isArray(a.models) ||
      typeof a.maxGenerations !== 'number' || typeof a.maxUsdPerJob !== 'number' || typeof a.maxUsdTotal !== 'number' || typeof a.maxJobSeconds !== 'number' ||
      !isoOk(a.issuedAt) || !isoOk(a.expiresAt) ||
      (a.inputSha256Allowlist !== undefined && !Array.isArray(a.inputSha256Allowlist))) return undefined;
  return a as unknown as Approval;
};

/** sync.so reply → CompanyError. Payment/quota signals map to payment_approval_required: the studio never pays. */
function upstreamFailure(reply: VaultReply): CompanyError {
  const body = record(safeJson(reply.body));
  const rawCode = String(body.code ?? body.errorCode ?? body.error_code ?? body.error ?? '').toLowerCase();
  const message = scrub(String(record(body.detail).message ?? body.message ?? `HTTP ${reply.status}`));
  const bill = ['insufficient_credits', 'pilot_allowance_exceeded', 'pilot_expired', 'pilot_not_active',
    'account_payment_required', 'account_on_hold', 'account_suspended', 'free_tier_generations_exhausted', 'plan_feature_unavailable'];
  if (reply.status === 401) return new CompanyError('not_configured', `sync.so 拒绝了 sck-vault 中的 API key（401），请老板检查 sck-vault setup sync`);
  if (reply.status === 402 || bill.some(code => rawCode.includes(code))) return approvalRequired(`上游计费拒绝：${message}`);
  if (reply.status === 403 || reply.status === 404) return new CompanyError('not_found', `资源不存在或无权访问：${message}`);
  if (reply.status === 410 || rawCode.includes('idempotency_generation_deleted')) {
    return new CompanyError('invalid', `幂等键绑定的 generation 已过期删除（不得重建同键）：${message}`);
  }
  if (reply.status === 409) {
    if (rawCode.includes('generation_not_ready')) return new CompanyError('conflict', `结果未就绪：${message}`);
    if (rawCode.includes('idempotency_in_progress')) return new CompanyError('upstream_error', `同键请求仍在处理中：${message}`, true);
    return new CompanyError('conflict', `幂等键冲突（同键异载荷，须原样重发）：${message}`);
  }
  if (reply.status === 422 && rawCode.includes('generation_not_downloadable')) return new CompanyError('conflict', `结果不可下载：${message}`);
  if (reply.status === 429 || rawCode.includes('concurrency_limit_reached') || rawCode.includes('rate_limit_exceeded')) {
    return new CompanyError('limit_reached', `供应商限流：${message}`, true);
  }
  if (reply.status === 400 || reply.status === 422) return invalid(`供应商拒绝了请求：${message}`);
  return new CompanyError('upstream_error', `sync.so 请求失败：HTTP ${reply.status} ${message}`, reply.status >= 500);
}
