import { createMcpHandler, hostHeaderValidationResponse, McpServer, originValidationResponse } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { CompanyCore, Credential, Evidence, LeaseProof, TaskView } from '../contracts';

const roles = ['gm', 'product', 'engineering', 'ai-content', 'qa', 'cs'] as const;
const states = ['blocked', 'ready', 'doing', 'review', 'done'] as const;
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
}>;

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
      const candidates = tasks.filter((task: TaskView) =>
        (task.state === 'review' && task.reviewerRole === principal.role && task.submittedBy !== principal.employeeId) ||
        (task.state === 'ready' && task.executorRole === principal.role),
      );
      candidates.sort((a, b) => (a.state === 'review' ? 0 : 1) - (b.state === 'review' ? 0 : 1) || a.id.localeCompare(b.id));
      // The core remains the sole authority for concurrent claims and dependencies.
      for (const candidate of candidates) {
        try {
          return await core.claim(credential, candidate.id);
        } catch (error) {
          if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'conflict') throw error;
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
    description: 'Record resumable progress for the current delivery.',
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
      executorRole: z.enum(roles), reviewerRole: z.enum(roles),
      dependencies: z.array(z.string().min(1)).optional(), idempotencyKey: z.string().min(1),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.createTask(token(ctx), input)));

  server.registerTool('resume_task', {
    description: 'Resume a blocked task; requires core manage capability.',
    inputSchema: z.object({ taskId: z.string().min(1), ...evidenceShape }),
  }, async (input, ctx) => run(token(ctx), () => core.resume(token(ctx), input.taskId, evidence(input))));
}

export function createMcpHttpService(options: McpServiceOptions) {
  const { core } = options;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'surreal-ck-company', version: '0.1.0' });
    registerTools(server, core);
    return server;
  });
  const hostname = options.hostname ?? '127.0.0.1';
  const server = Bun.serve({
    hostname,
    port: options.port,
    async fetch(request) {
      const rejected = hostHeaderValidationResponse(request, ['127.0.0.1'])
        ?? originValidationResponse(request, ['127.0.0.1']);
      if (rejected) return rejected;
      if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
      const authorization = request.headers.get('authorization');
      if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) return new Response('Unauthorized', { status: 401 });
      const credential = authorization.slice(7);
      let principal;
      try {
        principal = await core.authenticate(credential);
      } catch (error) {
        const invalidCredential = typeof error === 'object' && error !== null
          && 'code' in error && error.code === 'unauthorized';
        return new Response(invalidCredential ? 'Unauthorized' : 'Service unavailable', {
          status: invalidCredential ? 401 : 503,
        });
      }
      if (!principal) return new Response('Unauthorized', { status: 401 });
      return handler.fetch(request, { authInfo: { token: credential, clientId: principal.employeeId, scopes: [] } });
    },
  });
  return {
    port: server.port,
    async close() { await handler.close(); server.stop(); },
  };
}
