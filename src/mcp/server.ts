import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, hostHeaderValidationResponse, McpServer, originValidationResponse } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { CompanyCore, Credential, Evidence, LeaseProof, TaskView } from '../contracts';

const roles = ['gm', 'product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'qa', 'cs'] as const;
const reviewerRoles = [...roles, 'owner'] as const;
const states = ['blocked', 'ready', 'doing', 'review', 'done', 'void'] as const;
const proofShape = {
  taskId: z.string().min(1),
  deliveryId: z.string().min(1),
  fence: z.number().int().nonnegative(),
  expectedVersion: z.number().int().nonnegative(),
};
const evidenceShape = {
  text: z.string().min(1),
  idempotencyKey: z.string().min(1),
};

export type McpServiceOptions = Readonly<{
  core: CompanyCore;
  hostname?: '127.0.0.1';
  port: number;
  // Public hostname accepted in Host/Origin when the service sits behind a reverse proxy.
  publicHost?: string;
  // Shared gate token provider (DB-backed); when set, /mcp demands ?token= or X-SCK-Token
  // before employee Bearer auth. Absent => loopback-only deployment, no gate.
  gateToken?: () => Promise<string | undefined>;
  ready?: () => Promise<boolean>;
  heal?: () => Promise<void>;
}>;

function tokenEqual(provided: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

function toolError(error: unknown) {
  const raw = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const code = /^[a-z][a-z0-9_]{1,63}$/.test(raw) ? raw : 'internal_error';
  const retryable = code === 'temporarily_unavailable' && typeof error === 'object' && error !== null
    && 'retryable' in error && error.retryable === true;
  return {
    isError: true,
    content: [{ type: 'text' as const, text: code }],
    structuredContent: { ok: false, code, retryable },
  };
}

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: { ok: true, data },
  };
}

function evidence(input: { text: string; idempotencyKey: string }): Evidence {
  return input;
}

function proof(input: LeaseProof): LeaseProof {
  return {
    taskId: input.taskId,
    deliveryId: input.deliveryId,
    fence: input.fence,
    expectedVersion: input.expectedVersion,
  };
}

function registerTools(server: McpServer, core: CompanyCore) {
  const run = async (credential: Credential, action: () => Promise<unknown>) => {
    if (!credential) return toolError({ code: 'unauthorized' });
    try {
      return toolResult(await action());
    } catch (error) {
      return toolError(error);
    }
  };
  const token = (ctx: { http?: { authInfo?: { token?: string } } }): Credential => ctx.http?.authInfo?.token ?? '';

  server.registerTool('get_context', {
    description: 'Show the authenticated employee and available company tasks.',
    inputSchema: z.object({ taskId: z.string().min(1).optional(), state: z.enum(states).optional() }),
  }, async ({ taskId, state }, ctx) => {
    const credential = token(ctx);
    return run(credential, async () => ({
      principal: await core.authenticate(credential),
      company: await core.companyBrief(credential),
      tasks: taskId ? [await core.getTask(credential, taskId)] : await core.listTasks(credential, state),
    }));
  });

  server.registerTool('claim_next', {
    description: 'Atomically claim a task from the authenticated employee queue.',
    inputSchema: z.object({ taskId: z.string().min(1).optional() }),
  }, async ({ taskId }, ctx) => {
    const credential = token(ctx);
    return run(credential, async () => {
      if (taskId) return core.claim(credential, taskId);
      const principal = await core.authenticate(credential);
      const tasks = await core.listTasks(credential);
      const now = Date.now();
      const abandoned = (task: TaskView) => task.state === 'doing' && task.executorRole === principal.role &&
        task.currentEmployee !== principal.employeeId && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= now);
      // Track filter mirrors the claim check: defs with a tracks list only see covered disciplines.
      const trackOk = (task: TaskView) =>
        !task.discipline || !principal.tracks?.length || principal.tracks.includes(task.discipline);
      const candidates = tasks.filter((task: TaskView) => trackOk(task) &&
        (task.state === 'review' && task.reviewerRole === principal.role && task.submittedBy !== principal.employeeId) ||
        (task.state === 'ready' && task.executorRole === principal.role) || abandoned(task),
      );
      const rank = (task: TaskView) => task.state === 'review' ? 0 : task.state === 'doing' ? 1 : 2;
      candidates.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
      // The core remains the sole authority for concurrent claims and dependencies.
      for (const candidate of candidates) {
        try {
          return await core.claim(credential, candidate.id);
        } catch (error) {
          if (typeof error !== 'object' || error === null || !('code' in error) ||
            !['conflict', 'already_claimed'].includes(String(error.code))) throw error;
        }
      }
      throw { code: 'no_available_task' };
    });
  });

  server.registerTool('heartbeat', {
    description: 'Extend the current delivery lease using the core server clock.',
    inputSchema: z.object(proofShape),
  }, async (input, ctx) => run(token(ctx), () => core.heartbeat(token(ctx), proof(input))));

  server.registerTool('checkpoint', {
    description: 'Record resumable progress for the current delivery. Limited to a few per task per holder (checkpoint_limit); use heartbeat for liveness and merge progress notes.',
    inputSchema: z.object({ ...proofShape, ...evidenceShape }),
  }, async (input, ctx) => run(token(ctx), () => core.checkpoint(token(ctx), proof(input), evidence(input))));

  server.registerTool('submit', {
    description: 'Submit the current delivery for independent review.',
    inputSchema: z.object({ ...proofShape, ...evidenceShape }),
  }, async (input, ctx) => run(token(ctx), () => core.submit(token(ctx), proof(input), evidence(input))));

  server.registerTool('report_blocker', {
    description: 'Block the current delivery for gm or owner input.',
    inputSchema: z.object({ ...proofShape, ...evidenceShape, to: z.enum(['gm', 'owner']) }),
  }, async (input, ctx) => run(token(ctx), () => core.block(token(ctx), proof(input), input.to, evidence(input))));

  server.registerTool('review', {
    description: 'Independently accept or return the current review delivery.',
    inputSchema: z.object({ ...proofShape, ...evidenceShape, decision: z.enum(['accept', 'return']) }),
  }, async (input, ctx) => run(token(ctx), () => input.decision === 'accept'
    ? core.accept(token(ctx), proof(input), evidence(input))
    : core.returnTask(token(ctx), proof(input), evidence(input))));

  server.registerTool('create_task', {
    description: 'Create a managed company task; requires core manage capability.',
    inputSchema: z.object({
      title: z.string().min(1), context: z.string().min(1),
      executorRole: z.enum(roles), reviewerRole: z.enum(reviewerRoles),
      discipline: z.string().min(1).max(60).optional(),
      kind: z.enum(['task', 'gate']).optional(), goalId: z.string().min(1).optional(),
      dependencies: z.array(z.string().min(1)).optional(), idempotencyKey: z.string().min(1),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.createTask(token(ctx), input)));

  server.registerTool('get_task_history', {
    description: 'Read the audited history of a task: claims, checkpoints, submissions, returns, owner decisions and handover packets.',
    inputSchema: z.object({ taskId: z.string().min(1) }),
  }, async ({ taskId }, ctx) => run(token(ctx), () => core.history(token(ctx), taskId)));

  const relayShape = { ownerQuote: z.string().min(2), idempotencyKey: z.string().min(1) };
  const tiers = ['quick', 'standard', 'program'] as const;
  server.registerTool('create_goal', {
    description: 'gm only: record a goal the owner gave in direct conversation. Without tier the goal waits in triage (Jev or gm picks quick/standard/program); project links a project environment.',
    inputSchema: z.object({ text: z.string().min(2), tier: z.enum(tiers).optional(), project: z.string().min(1).optional(), ...relayShape }),
  }, async (input, ctx) => run(token(ctx), () => core.relayGoal(token(ctx), input)));

  server.registerTool('triage_goal', {
    description: 'gm only: choose the flow for a goal waiting in triage. quick = one delivery chain, product acceptance closes it, owner not involved; standard = gm plans deliveries, owner G3; program = product scope proposal first, then plan, owner G3.',
    inputSchema: z.object({ goalId: z.string().min(1), tier: z.enum(tiers), reason: z.string().min(4) }),
  }, async (input, ctx) => run(token(ctx), () => core.triageGoal(token(ctx), input)));

  server.registerTool('create_delivery', {
    description: 'gm/product: create the delivery chain for one code change under a goal: implement (engineering, peer review) -> release request (product or Jev decides go-live) -> merge, deploy and production verification (qa).',
    inputSchema: z.object({
      goalId: z.string().min(1), title: z.string().min(3), spec: z.string().min(20),
      discipline: z.string().min(1).max(60).optional(),
      dependencies: z.array(z.string().min(1)).optional(), idempotencyKey: z.string().min(1),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.createDelivery(token(ctx), input)));

  server.registerTool('record_owner_decision', {
    description: 'gm only: record an owner decision given in direct conversation (approve/reject a gate, or reply to an owner question). Quote the owner verbatim.',
    inputSchema: z.object({
      taskId: z.string().min(1), decision: z.enum(['approve', 'reject', 'reply']), note: z.string(), ...relayShape,
    }),
  }, async (input, ctx) => run(token(ctx), () => core.relayOwnerDecision(token(ctx), input)));

  server.registerTool('set_direction', {
    description: 'gm only: record a company direction the owner gave in direct conversation; shown to every employee in get_context.',
    inputSchema: z.object({ text: z.string().min(2), ...relayShape }),
  }, async (input, ctx) => run(token(ctx), async () => { await core.relayDirection(token(ctx), input); return { recorded: true }; }));

  server.registerTool('resume_task', {
    description: 'Resume a blocked task; requires core manage capability.',
    inputSchema: z.object({ taskId: z.string().min(1), ...evidenceShape }),
  }, async (input, ctx) => run(token(ctx), () => core.resume(token(ctx), input.taskId, evidence(input))));

  server.registerTool('defer_task_until', {
    description: 'gm only: turn a gm-blocked execute-phase task into a dependency wait — it stays blocked (the manager is no longer woken for it), the gm flag clears, and it auto-resumes when every dependency is done; with all dependencies already done it resumes immediately.',
    inputSchema: z.object({
      taskId: z.string().min(1),
      dependencies: z.array(z.string().min(1)).min(1).max(20),
      text: z.string().min(20).max(8000),
      idempotencyKey: z.string().min(1),
      expectedVersion: z.number().int().positive().optional(),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.deferTaskUntil(token(ctx), input)));

  server.registerTool('retire_task', {
    description: 'gm/product only: retire a task to the terminal void state. Releases any live lease, and blocked dependents waiting on it re-evaluate (void counts as satisfied) so downstream chains unlock. Repeating on a void task is a no-op; done tasks refuse.',
    inputSchema: z.object({
      taskId: z.string().min(1),
      text: z.string().min(4).max(8000),
      idempotencyKey: z.string().min(1),
      expectedVersion: z.number().int().positive().optional(),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.retireTask(token(ctx), input)));

  server.registerTool('record_score', {
    description: 'eval employees only: record a performance scorecard for every participant of a finished task.',
    inputSchema: z.object({
      taskId: z.string().min(1),
      summary: z.string().min(1).max(20000),
      scores: z.array(z.object({
        employee: z.string().min(1),
        quality: z.number().min(1).max(5),
        evidence: z.number().min(1).max(5),
        discipline: z.number().min(1).max(5),
        timeliness: z.number().min(1).max(5),
        overall: z.number().min(1).max(5),
        notes: z.string().max(4000).optional(),
      })).max(50),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.recordScore(token(ctx), input)));
}

export function createMcpHttpService(options: McpServiceOptions) {
  const { core } = options;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'surreal-ck-company', version: '0.1.0' });
    registerTools(server, core);
    return server;
  });
  const hostname = options.hostname ?? '127.0.0.1';
  const allowedHosts = options.publicHost ? ['127.0.0.1', options.publicHost] : ['127.0.0.1'];
  const server = Bun.serve({
    hostname,
    port: options.port,
    // Remote DB roundtrips make heavy calls (record_score etc.) exceed Bun's 10s default.
    idleTimeout: 120,
    async fetch(request) {
      const rejected = hostHeaderValidationResponse(request, allowedHosts)
        ?? originValidationResponse(request, allowedHosts);
      if (rejected) return rejected;
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') {
        return new Response('ok', { status: 200 });
      }
      if (path === '/ready' && request.method === 'GET') {
        try {
          const ready = await options.ready?.();
          return new Response(ready ? 'ready' : 'unavailable', { status: ready ? 200 : 503 });
        } catch {
          return new Response('unavailable', { status: 503 });
        }
      }
      if (path !== '/mcp') return new Response('Not found', { status: 404 });
      const authorization = request.headers.get('authorization');
      if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) return new Response('Unauthorized', { status: 401 });
      const credential = authorization.slice(7);
      // A half-open DB socket wedges queries forever; the MCP client gives up at 60s,
      // so cap the whole request below that and answer 503 instead of hanging.
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<Response>(resolve => {
        budgetTimer = setTimeout(() => {
          void options.heal?.().catch(() => {});
          resolve(new Response('Service unavailable', { status: 503 }));
        }, 55_000);
      });
      const work = respond(request, credential);
      work.catch(() => {}); // a rejection after the budget wins must not become an unhandled rejection
      try {
        return await Promise.race([work, budget]);
      } finally {
        clearTimeout(budgetTimer);
      }

      async function respond(req: Request, cred: Credential): Promise<Response> {
        const t0 = Date.now();
        const mark = (stage: string) => console.log(`req ${req.method} ${stage} +${Date.now() - t0}ms`);
        try {
          await options.heal?.();
          mark('heal');
        } catch {
          mark('heal failed');
          return new Response('Service unavailable', { status: 503 });
        }
        if (options.gateToken) {
          let expected: string | undefined;
          try {
            expected = await options.gateToken();
            mark('gate');
          } catch {
            mark('gate lookup failed');
            return new Response('Service unavailable', { status: 503 });
          }
          const provided = req.headers.get('x-sck-token')
            ?? new URL(req.url).searchParams.get('token') ?? '';
          if (!expected || !tokenEqual(provided, expected)) {
            mark('gate denied');
            return new Response('Unauthorized', { status: 401 });
          }
        }
        let principal;
        try {
          principal = await core.authenticate(cred);
          mark('auth');
        } catch (error) {
          mark(`auth failed: ${(error as Error)?.message ?? String(error)}`.slice(0, 120));
          const invalidCredential = typeof error === 'object' && error !== null
            && 'code' in error && error.code === 'unauthorized';
          return new Response(invalidCredential ? 'Unauthorized' : 'Service unavailable', {
            status: invalidCredential ? 401 : 503,
          });
        }
        if (!principal) return new Response('Unauthorized', { status: 401 });
        const response = await handler.fetch(req, { authInfo: { token: cred, clientId: principal.employeeId, scopes: [] } });
        mark('handler');
        return response;
      }
    },
  });
  return {
    port: server.port,
    async close() { await handler.close(); server.stop(); },
  };
}
