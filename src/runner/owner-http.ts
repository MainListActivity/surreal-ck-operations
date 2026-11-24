/** /api/owner/* JSON 接口：Bearer <owner-token> 鉴权，`sck owner` 与编制外 agent 都走这套接口，由执行端的预览服务承载。 */
import { timingSafeEqual } from 'node:crypto';
import { listTaskAttachments, resolveTaskAttachment } from '../attachments.ts';
import { previewLanBase } from '../deliverables.ts';
import { LocalEnrollmentAdmin } from '../enrollment.ts';
import { OutboundMessageStore } from '../outbound-messages.ts';
import { OwnerDesk } from '../owner.ts';
import { ownerApi } from '../owner-api.ts';
import { ensureOwnerToken, OWNER_AGENT_HEADER } from '../owner-token.ts';
import { Workforce } from '../workforce.ts';
import type { Company } from './company.ts';

export type OwnerExtraCommand = (c: Company, input: Record<string, unknown>) => Promise<{ handled: true; value: unknown } | { handled: false }>;

export interface OwnerHttpOptions {
  home: string;
  company: () => Promise<Company>;
  opsRepo?: string;
  /** 宿主专属命令（先于通用命令处理）；没有处理就交给 src/owner-api.ts。 */
  extra?: OwnerExtraCommand;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid ${field}`);
  return value.trim();
};

/** 任务附件列表（老板 CLI/HTTP 命令）。 */
export async function taskAttachmentsFor(home: string, taskId: string) {
  return { attachments: await listTaskAttachments(home, taskId) };
}

/** 任务附件的局域网打开地址：统一走预览服务的 /e/ 路由（无时效）。 */
export async function taskAttachmentUrlFor(home: string, taskId: string, name: string) {
  const abs = await resolveTaskAttachment(home, taskId, name);
  if (!abs) throw new Error('附件不存在或越界');
  const rel = name.split('/').map(encodeURIComponent).join('/');
  return { url: `${previewLanBase(home)}/e/${encodeURIComponent(taskId)}/${rel}` };
}

/** 执行端承载的命令：读本机证据目录的附件，其余交给 src/owner-api.ts。 */
export const hostOwnerCommand = (home: string): OwnerExtraCommand => async (_c, input) => {
  switch (String(input.command ?? '')) {
    case 'task.attachments': return { handled: true, value: await taskAttachmentsFor(home, requiredText(input.taskId, 'taskId')) };
    case 'attachment.url': return { handled: true, value: await taskAttachmentUrlFor(home, requiredText(input.taskId, 'taskId'), requiredText(input.file, 'file')) };
    default: return { handled: false };
  }
};

export function createOwnerHttp(opts: OwnerHttpOptions): (req: Request) => Promise<Response> {
  const token = ensureOwnerToken(opts.home);
  process.env.SCK_OWNER_TOKEN = token; // core.authenticate needs the same token for owner-principal writes
  const extra = opts.extra ?? hostOwnerCommand(opts.home);
  // The owner control-plane principal (employee:owner) must exist in this database for core writes under the token.
  let ownerReady: Promise<void> | undefined;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/owner/')) return json({ error: 'not found' }, 404);
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json({ error: 'owner token required' }, 401);
    const provided = Buffer.from(auth.slice(7).trim(), 'utf-8');
    const expected = Buffer.from(token, 'utf-8');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json({ error: 'invalid owner token' }, 401);
    const via = req.headers.get(OWNER_AGENT_HEADER)?.trim() || 'web';
    try {
      const body = req.method === 'GET'
        ? Object.fromEntries(url.searchParams) as Record<string, unknown>
        : await req.json() as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad input' }, 400);
      const c = await opts.company();
      const hosted = await extra(c, body);
      if (hosted.handled) return json(hosted.value);
      ownerReady ??= new LocalEnrollmentAdmin(c.db).ensureOwner(opts.home);
      await ownerReady;
      const opsRepo = opts.opsRepo ?? c.opsRepo;
      const result = await ownerApi({
        db: c.db, core: c.core as never, owner: c.owner ?? new OwnerDesk(c.db, opsRepo),
        workforce: c.workforce ?? new Workforce(c.db), messages: c.messages ?? new OutboundMessageStore(c.db.db),
        opsRepo, steward: c.steward,
      }, body, via);
      return json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message) ? 404 : /invalid|bad input|unknown owner command/i.test(message) ? 400
        : /forbidden|conflict|temporarily_unavailable/i.test(message) ? 409 : 500;
      return json({ error: message.slice(0, 500) }, status);
    }
  };
}
