import type { RuntimeDashboard } from '../../../src/runtime-dashboard.ts';
/**
 * 页面与 Worker 的接口。每个请求带 `Authorization: Bearer <accessToken>`，令牌见 auth.ts（内存 + sessionStorage）。
 * 不读写 cookie，不使用 localStorage。
 */
import { accessToken, clearSession, signOutLocal, type Fetcher } from './auth.ts';
import { errorText } from './model.ts';
import type { OwnerBoard } from './types.ts';
import { readBoardData, readDashboardData, runOwnerCommand, runsInPage, SourceError } from './source.ts';

export type Outcome<T> =
  | { kind: 'ok'; result: T }
  | { kind: 'pending'; jobId?: string; message: string }
  | { kind: 'error'; status: number; code: string; message: string; jobId?: string };

export interface Me {
  sub: string;
  roles: string[];
  /** 令牌过期时间（Unix 秒，来自网关）。 */
  exp: number;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 502: 'upstream_error', 503: 'unavailable',
};

let unauthorizedListener: (() => void) | undefined;

/** 任一接口返回 unauthorized 时清空令牌并通知壳层回到登录页。 */
export function onUnauthorized(listener: () => void): void {
  unauthorizedListener = listener;
}

type Body = Record<string, unknown> | undefined;

async function readBody(res: Response): Promise<Body> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function errorFields(body: Body): { code?: string; message?: string; jobId?: string } {
  const error = body?.error;
  if (typeof error === 'string') return { message: error };
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    return {
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
      jobId: typeof e.jobId === 'string' ? e.jobId : undefined,
    };
  }
  return {};
}

/** 把一次 HTTP 响应归类成 ok / pending / error。401 会清空令牌并通知壳层。 */
export async function outcomeOf<T>(res: Response): Promise<Outcome<T>> {
  const body = await readBody(res);
  if (res.status === 202) {
    // 网关约定：pending 时 error.message 是任务号（jobId），之后用 ops.job.get 查询。
    // 若同时给了 error.jobId 与说明文字，文字原样显示。
    const fields = errorFields(body);
    const jobId = fields.jobId ?? (typeof body?.jobId === 'string' ? body.jobId : undefined) ?? (fields.message || undefined);
    const message = fields.jobId && fields.message ? fields.message : '已排队，执行端处理中';
    return { kind: 'pending', jobId, message };
  }
  if (res.ok && body?.ok === true) return { kind: 'ok', result: body.result as T };
  const fields = errorFields(body);
  const code = fields.code ?? CODE_BY_STATUS[res.status] ?? 'unknown';
  if (res.status === 401 || code === 'unauthorized') {
    clearSession();
    unauthorizedListener?.();
  }
  return { kind: 'error', status: res.status, code, message: fields.message ?? '', jobId: fields.jobId };
}

const networkError = (): Outcome<never> => ({ kind: 'error', status: 0, code: 'network', message: '' });

const unauthorized = (): Outcome<never> => {
  clearSession();
  unauthorizedListener?.();
  return { kind: 'error', status: 401, code: 'unauthorized', message: '登录已过期，请重新登录' };
};

/** 带 Bearer 的请求。没有可用令牌时直接返回 unauthorized。 */
async function call<T>(path: string, method: 'GET' | 'POST', body?: unknown, fetcher: Fetcher = fetch): Promise<Outcome<T>> {
  const token = await accessToken(fetcher);
  if (!token) return unauthorized();
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetcher(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    return networkError();
  }
  return outcomeOf<T>(res);
}

/** 执行老板命令：能在页面里执行的直连公司库执行，其余经 /api/cmd 由服务端执行。结果与错误形状两条路径一致。 */
export async function runCommand<T = unknown>(command: string, input: Record<string, unknown> = {}): Promise<Outcome<T>> {
  if (!runsInPage(command)) return call<T>('/api/cmd', 'POST', { command, input });
  try {
    return { kind: 'ok', result: (await runOwnerCommand(command, input)) as T };
  } catch (error) {
    if (error instanceof SourceError) {
      if (error.code === 'unauthorized') return unauthorized();
      if (error.code === 'unavailable') return { kind: 'error', status: 503, code: 'unavailable', message: error.message };
      return networkError();
    }
    const { failureOf } = await import('../errors.ts');
    const { status, body } = failureOf(error);
    if (body.error.code === 'pending') return { kind: 'pending', jobId: body.error.jobId, message: '已排队，执行端处理中' };
    return { kind: 'error', status, code: body.error.code, message: body.error.message, jobId: body.error.jobId };
  }
}

/** 直连公司库读取（见 source.ts），失败按 HTTP 版的同一套分类返回。 */
async function fromSource<T>(read: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { kind: 'ok', result: await read() };
  } catch (error) {
    if (error instanceof SourceError && error.code === 'unauthorized') return unauthorized();
    if (error instanceof SourceError && error.code === 'unavailable')
      return { kind: 'error', status: 503, code: 'unavailable', message: error.message };
    return networkError();
  }
}

export const readBoard = (): Promise<Outcome<OwnerBoard>> => fromSource(readBoardData);

/**
 * 当前登录的老板。令牌无效返回 undefined；非老板（403）抛出可显示的中文原因；其它失败同样抛出。
 */
export async function readMe(): Promise<{ me: Me } | undefined> {
  const out = await call<Me>('/api/me', 'GET');
  if (out.kind === 'ok') return { me: out.result };
  if (out.kind === 'error' && out.code === 'unauthorized') return undefined;
  if (out.kind === 'error' && out.code === 'forbidden') throw new Error('当前账号不是老板，无法进入老板端');
  throw new Error(out.kind === 'error' ? errorText(out) : '登录状态读取失败');
}

/** 退出：纯前端，清空内存与 sessionStorage，不调用服务端。 */
export async function logout(): Promise<void> {
  signOutLocal();
}

/** 命令结果的一句话文案，用于提示条。 */
export function outcomeText<T>(out: Outcome<T>, okText: string): string {
  if (out.kind === 'ok') return okText;
  if (out.kind === 'pending') return out.jobId ? `已排队，执行端处理中（任务 ${out.jobId}）` : '已排队，执行端处理中';
  return errorText(out);
}

export const readDashboard = (): Promise<Outcome<RuntimeDashboard>> => fromSource(readDashboardData);
