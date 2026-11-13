// Higgsfield CLI image lane: the paid fallback behind the free web lanes. The CLI has no
// unlimited mode (jobs record use_unlim:false and spend plan credits), so every job is
// cost-checked first and the account's own spend log enforces a rolling 24h credit cap.
// Plan credits reset monthly and unused ones are wiped, so a steady daily cap uses them up
// instead of letting them expire. Failure messages never echo CLI output (it can carry the
// prompt and account details).
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Cheapest acceptable image models first (credits per 1:1 image at defaults, 2026-11). */
export const HF_CLI_MODELS = ['gpt_image_2_6', 'kling_omni_image'] as const;
export const HF_DAILY_CREDITS = 20;
export const HF_MAX_JOB_CREDITS = 0.5;
const DAY_MS = 86_400_000;

export interface HfExec { code: number | null; stdout: string; stderr?: string; timedOut: boolean }
export type HfRun = (args: string[], timeoutMs: number) => Promise<HfExec>;
export interface HfResult { ok: boolean; code?: string; message?: string; file?: string; bytes?: number; via?: string; credits?: number }

export const hfBin = (): string => process.env.SCK_HIGGSFIELD_BIN
  ?? join(process.env.HOME ?? '/nonexistent', 'node/lib/node_modules/@higgsfield/cli/vendor/hf');

const envNumber = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]?.trim());
  return Number.isFinite(raw) && raw >= 0 && process.env[name]?.trim() ? raw : fallback;
};
export const hfLimits = () => ({
  daily: envNumber('SCK_HIGGSFIELD_DAILY_CREDITS', HF_DAILY_CREDITS),
  perJob: envNumber('SCK_HIGGSFIELD_MAX_JOB_CREDITS', HF_MAX_JOB_CREDITS),
});

/** Default runner: the vendored Go binary directly, so the host needs no node on PATH. */
export const defaultHfRun = (bin = hfBin()): HfRun => (args, timeoutMs) => new Promise((resolve) => {
  if (!existsSync(bin)) { resolve({ code: 127, stdout: '', stderr: '', timedOut: false }); return; }
  const child = spawn(bin, [...args, '--no-color'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HIGGSFIELD_NO_UPDATE_CHECK: '1' } });
  let out = '', err = '', timedOut = false, done = false;
  const kill = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(kill); resolve({ code, stdout: out, stderr: err, timedOut }); };
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', () => finish(127));
  child.on('close', code => finish(code));
});

/** Classify a failed CLI run without echoing its output. */
function failure(step: string, exec: HfExec): HfResult {
  if (exec.timedOut) return { ok: false, code: 'failed', message: `higgsfield ${step} 超时` };
  if (exec.code === 127) return { ok: false, code: 'not_configured', message: 'higgsfield CLI 未安装（SCK_HIGGSFIELD_BIN）' };
  const text = `${exec.stdout}\n${exec.stderr ?? ''}`;
  if (/Not authenticated|Session expired|unauthori[sz]ed|401/i.test(text)) return { ok: false, code: 'login_required', message: 'higgsfield CLI 未登录或登录过期（终端运行 higgsfield auth login）' };
  if (/insufficient|not enough credits|balance/i.test(text)) return { ok: false, code: 'limit_reached', message: 'higgsfield credits 不足' };
  return { ok: false, code: 'failed', message: `higgsfield ${step} 失败(exit=${exec.code})` };
}

const json = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };

/** Credits spent in the trailing 24h, from the account's own transaction log; undefined = unreadable. */
export async function spentLastDay(run: HfRun, now: number): Promise<number | undefined> {
  const exec = await run(['account', 'transactions', '--size', '100', '--json'], 60_000);
  if (exec.code !== 0) return undefined;
  const parsed = json(exec.stdout) as { items?: Array<{ action?: unknown; credits?: unknown; created_at?: unknown }> } | undefined;
  if (!parsed || !Array.isArray(parsed.items)) return undefined;
  let spent = 0;
  for (const item of parsed.items) {
    const at = typeof item.created_at === 'string' ? Date.parse(item.created_at) : NaN;
    if (!Number.isFinite(at) || typeof item.credits !== 'number') return undefined;
    if (now - at > DAY_MS) continue;
    if (item.action === 'spend') spent += -item.credits;
    else if (item.action === 'refund') spent -= item.credits;
  }
  return Math.max(0, spent);
}

export interface HfJob { prompt: string; outDir: string; file: string; refs: string[]; timeoutMs: number }

/**
 * One cost-guarded image job. Fails closed: unreadable spend log, unreadable cost, a model
 * above the per-job ceiling or a job that would cross the daily cap never reaches `create`.
 */
export async function hfImage(job: HfJob, deps: { run: HfRun; now: () => number; fetchFn?: typeof fetch; limits?: { daily: number; perJob: number } }): Promise<HfResult> {
  const limits = deps.limits ?? hfLimits();
  const spent = await spentLastDay(deps.run, deps.now());
  if (spent === undefined) return { ok: false, code: 'failed', message: 'higgsfield 读取 credits 流水失败，拒绝生成' };
  const params = ['--prompt', job.prompt, '--aspect_ratio', '1:1', ...job.refs.flatMap(ref => ['--image-references', ref])];
  let chosen: { model: string; credits: number } | undefined;
  for (const model of HF_CLI_MODELS) {
    const exec = await deps.run(['generate', 'cost', model, ...params, '--json'], 120_000);
    if (exec.code !== 0) { if (failure('cost', exec).code === 'login_required') return failure('cost', exec); continue; }
    const credits = (json(exec.stdout) as { credits?: unknown } | undefined)?.credits;
    if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) continue;
    if (credits <= limits.perJob) { chosen = { model, credits }; break; }
  }
  if (!chosen) return { ok: false, code: 'limit_reached', message: `higgsfield 没有单张不超过 ${limits.perJob} credits 的可用模型` };
  if (spent + chosen.credits > limits.daily) {
    return { ok: false, code: 'limit_reached', message: `higgsfield 近 24 小时已用 ${spent} credits，日上限 ${limits.daily}（SCK_HIGGSFIELD_DAILY_CREDITS 可调）` };
  }
  const exec = await deps.run(['generate', 'create', chosen.model, ...params, '--wait', '--wait-timeout', `${Math.ceil(job.timeoutMs / 60_000)}m`, '--json'], job.timeoutMs + 30_000);
  if (exec.code !== 0) return failure('create', exec);
  const parsed = json(exec.stdout);
  const jobRow = (Array.isArray(parsed) ? parsed[0] : parsed) as { status?: unknown; result_url?: unknown } | undefined;
  if (jobRow?.status !== 'completed' || typeof jobRow.result_url !== 'string' || !/^https:\/\//.test(jobRow.result_url)) {
    return { ok: false, code: 'failed', message: `higgsfield 任务未完成（status=${String(jobRow?.status ?? '?').slice(0, 20)}）` };
  }
  const response = await (deps.fetchFn ?? fetch)(jobRow.result_url).catch(() => undefined);
  if (!response?.ok) return { ok: false, code: 'failed', message: `higgsfield 结果下载失败(${response?.status ?? 'network'})` };
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return { ok: false, code: 'failed', message: 'higgsfield 结果不是 PNG' };
  const file = join(job.outDir, job.file);
  writeFileSync(file, bytes, { mode: 0o600 });
  return { ok: true, file, bytes: bytes.length, via: chosen.model, credits: chosen.credits };
}
