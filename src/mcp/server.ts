import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, hostHeaderValidationResponse, McpServer, originValidationResponse } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { CompanyCore, Credential, Evidence, LeaseProof, TaskView } from '../contracts';
import { REQUIRED_TRACKS } from '../core';
import type { Role } from '../contracts';
import { isPaged, parseReclaimInput } from '../query-input';
import { arrivedAt, arriving, currentTool, noteTool, SNAPSHOT_TOOLS, withinReplyCeiling } from '../reply-clock';
import { answerBytes, answerResult, echoClaim, MAX_REQUEST_ID_BYTES, oversizeRequestId, RESPONSE_BUDGET_BYTES } from '../response-budget';
import { REPLY_CEILING_MS, untilAt } from '../snapshot-store';

const roles = ['gm', 'product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'screenwriter', 'story-author', 'cinematography', 'qa', 'cs'] as const;
const defRoles = [...roles, 'eval'] as const;
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
  // Structured reasons (independence conflicts name the task, source and employee) travel in structuredContent only; never credentials.
  const details = typeof error === 'object' && error !== null && 'details' in error && typeof error.details === 'object' && error.details !== null
    ? error.details : undefined;
  // The message is written for the caller (CompanyError, budget refusals). Unknown errors are reported by code alone.
  const message = code !== 'internal_error' && typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message.slice(0, 500)
    : '';
  const structured = { ok: false as const, code, retryable, error: message || code, ...(details ? { details } : {}) };
  // The text copy is the same JSON as structuredContent, for refusals as for answers, so every result parses the same way (SYS01, D1).
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured,  };
}

function toolResult(data: unknown) {
  // SYS01: a response over the byte budget becomes a recoverable, JSON-legal error, never a cut stream. The budget counts the
  // whole tool result with its frame (answerBytes). The answer's JSON is the text, and the same data is in structuredContent,
  // so both copies are counted (SYS01, D1).
  const bytes = answerBytes(data);
  if (bytes > RESPONSE_BUDGET_BYTES) {
    return toolError({
      code: 'response_too_large',
      message: `response is ${bytes} bytes, over the ${RESPONSE_BUDGET_BYTES}-byte budget; narrow it with pageSize and cursor, a taskId, or read_task_text for one long text`,
    });
  }
  return answerResult(data);
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
      // A snapshot-backed listing is answered within the reply ceiling of its request (SYS01 M1); other tools keep their own time.
      const answer = SNAPSHOT_TOOLS.has(currentTool() ?? '') ? await withinReplyCeiling(async () => action()) : await action();
      return toolResult(answer);
    } catch (error) {
      return toolError(error);
    }
  };
  const token = (ctx: { http?: { authInfo?: { token?: string } } }): Credential => ctx.http?.authInfo?.token ?? '';

  // SYS01: every paged read takes the same pageSize/cursor pair; the cursor is sealed to the caller and the query.
  // null means absent on every read argument, as in core and the sidecar (same-source rule, one predicate: isPaged).
  const pageArgs = {
    pageSize: z.number().int().min(1).max(100).nullish(),
    cursor: z.string().min(1).max(2048).nullish(),
  };
  server.registerTool('get_context', {
    description: 'Show the authenticated employee and the working set of company tasks (ready, doing, review, blocked) within a 48 KiB UTF-8 response budget. Without scope, or with scope "tasks": without pageSize or cursor the answer is complete (keys principal, companyIncluded, companyRead, tasks, and company when includeCompany is true) or refused as response_too_large with retry guidance; it is never cut. With pageSize (1 to 100) or cursor it returns one stored page: continue with the same arguments plus cursor set to page.nextCursor, until page.hasMore is false. includeCompany defaults to false; companyRead names the arguments that read the company block. A task too large for one page is echoed with a long dependency list cut and flagged (listsTruncated), and a context still too large cut and flagged (contextTruncated, contextNextOffset); read_task_text returns any cut part whole. A task read by taskId is whole or refused. A blocked task carries `waiting`: kind (manager/owner/dependency), the phase it restores (`resumeState`, unknown when absent), the role that phase belongs to (a review wait names the reviewing role) and the number of dependencies (the ids stay in the task `dependencies` field). With scope "company" the answer is the company block (directions, goals, projects, paused), optionally one section; project environments (envs, credential aliases and roles) are shown only to gm and to the holder of a valid task lease, and to anyone else envs is empty with envsWithheld true; it is complete (key company) or, with pageSize or cursor, one stored page of parts (keys section, key, part, parts, offset, totalBytes, sha256, json): join the json of the parts of one section and key in part order, check the byte length and sha256 against totalBytes and sha256, then parse; continue with the same arguments plus cursor set to page.nextCursor until page.hasMore is false.',
    inputSchema: z.object({
      scope: z.enum(['tasks', 'company']).nullish(),
      section: z.enum(['directions', 'goals', 'projects']).nullish(),
      taskId: z.string().min(1).max(200).nullish(),
      state: z.enum(states).nullish(),
      goalId: z.string().min(1).max(100).nullish(),
      role: z.enum(roles).nullish(),
      since: z.string().min(1).max(40).nullish(),
      includeCompany: z.boolean().nullish(),
      fields: z.array(z.string().min(1).max(60)).min(1).max(40).nullish(),
      ...pageArgs,
    }),
  }, async (input, ctx) => {
    const credential = token(ctx);
    if (!core.contextView) {
      // Cores that predate SYS01 keep the single-shot listing, with the same defaults: the company block only when includeCompany is true.
      // This branch ignores scope and paging (SYS01 AC-A note), so scope "company" is answered only by a core with contextView.
      const withCompany = input.includeCompany === true;
      return run(credential, async () => ({
        principal: await core.authenticate(credential),
        companyIncluded: withCompany,
        companyRead: { scope: 'company', pageSize: 25 },
        ...(withCompany ? { company: await core.companyBrief(credential) } : {}),
        tasks: input.taskId ? [await core.getTask(credential, input.taskId)] : await core.listTasks(credential, input.state ?? undefined),
      }));
    }
    return run(credential, () => core.contextView!(credential, input));
  });

  server.registerTool('reclaim_worktrees', {
    description: 'GM: ownership-based worktree reclaim or dry-run. Uses persistent refs and durable audit; never force-deletes dirty trees. A value other than the documented ones is refused as invalid before any tree is touched.',
    inputSchema: z.object({
      // The rule is parseReclaimInput, shared with core and the sidecar (SYS01, D3). The schema documents the shape only: a schema
      // error would be a plain-text refusal, while parseReclaimInput gives the same structured `invalid` on every layer.
      dryRun: z.unknown().optional().describe('true for a dry run; omit to reclaim. Any other value is refused as invalid.'),
      repos: z.unknown().optional().describe('Optional list of repository paths, each a non-empty string. Any other value is refused as invalid.'),
    }),
  }, async ({ dryRun, repos }, ctx) => run(token(ctx), () => {
    // SYS01, D3: checked before any tree is touched.
    const params = parseReclaimInput({ dryRun, repos });
    return core.reclaimWorktrees
      ? core.reclaimWorktrees(token(ctx), params)
      : Promise.resolve({ scanId: '', removed: [], kept: [], branchesDeleted: [], branchesRetained: [], audited: 0 });
  }));
  server.registerTool('list_worktree_audits', {
    description: 'GM: query durable worktree reclaim audit rows (delete/skip/fail/branch_retain/orphan_scan).',
    // A null limit is absent, as on the sidecar (read-only audit list; reclaim_worktrees is left as it is).
    inputSchema: z.object({ limit: z.number().int().min(1).max(500).nullish() }),
  }, async ({ limit }, ctx) => run(token(ctx), () => core.listWorktreeAudits
    ? core.listWorktreeAudits(token(ctx), limit ?? undefined)
    : Promise.resolve([])));
  server.registerTool('list_worktrees', {
    description: 'Authenticated persistent worktree inventory with compact references (released ones are counted, and listed only with includeReleased). Without pageSize or cursor it returns the complete array, or response_too_large when over the 48 KiB budget (retry with pageSize 25, then cursor set to page.nextCursor, or narrow with taskId); with either it pages by path and returns { worktrees, page }. A worktree whose whole entry cannot fit a page has its references cut and flagged (referencesTruncated: count, sha256, includeReleased, tool); read_worktree_refs returns the whole list in byte segments. Task-scoped reads, or gm global reads.',
    inputSchema: z.object({ taskId: z.string().min(1).max(200).nullish(), includeReleased: z.boolean().nullish(), ...pageArgs }),
  }, async (input, ctx) => run(token(ctx), () => {
    // C1 default: a call that names neither pageSize nor cursor (null counts as absent) keeps the pre-SYS01 array shape.
    if (isPaged(input) && core.worktreePage) return core.worktreePage(token(ctx), input);
    if (core.worktreeList) return core.worktreeList(token(ctx), input);
    return core.listWorktrees ? core.listWorktrees(token(ctx), input.taskId ?? undefined) : Promise.resolve([]);
  }));
  server.registerTool('read_worktree_refs', {
    description: 'Read one byte segment of one worktree\'s references as JSON: the recovery entry a paged list_worktrees item names when its references were cut (referencesTruncated carries the whole count, SHA-256 and includeReleased). Pass the same taskId and includeReleased the listing used. Returns the total size and SHA-256 of the whole text, so a reader can reassemble and verify. Segments never split a character. expectSha256 (from the first segment) is required on every segment past offset 0: a list that changed in between is refused with conflict instead of mixing two versions. Same access as list_worktrees: a task id scopes the read to that task repository, a global read is gm only.',
    inputSchema: z.object({
      taskId: z.string().min(1).max(200).nullish(),
      worktreePath: z.string().min(1).max(4096),
      includeReleased: z.boolean().nullish(),
      offset: z.number().int().min(0).max(1_000_000_000).nullish(),
      limit: z.number().int().min(4).max(24576).nullish(),
      expectSha256: z.string().regex(/^[0-9a-f]{64}$/).nullish(),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.worktreeRefs
    ? core.worktreeRefs(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));
  server.registerTool('get_admin_summary', {
    description: 'gm only: read-only company summary at one stated cutoffAt. tasks counts each task by the state it holds at cutoffAt (optionally for one goal; since does not apply to tasks). audit counts entries from since (default: the 24 hours before the cutoff) up to cutoffAt, limited to the tasks of the goal when goalId is given. Returns scope, outboxSequence and integrity; integrity.complete is true only for a proven consistent read, and false means retry. Never returns task text.',
    inputSchema: z.object({ since: z.string().min(1).max(40).nullish(), goalId: z.string().min(1).max(100).nullish() }),
  }, async (input, ctx) => run(token(ctx), () => core.adminSummary ? core.adminSummary(token(ctx), input) : Promise.reject({ code: 'temporarily_unavailable' })));
  server.registerTool('read_task_text', {
    description: 'Read one byte segment of a task text: context, evidence (one audit entry, auditId from get_task_history), project (the project environment as JSON; the task holder or gm only), or the lists dependencies, workIntentPaths and worktreePaths as JSON arrays. A claim or heartbeat echo that cut one of them names it and its size; this reads the rest. Returns the total size and SHA-256 of the full text, so a reader can reassemble and verify. Segments never split a character. expectSha256 (from the first segment) is required on every segment past offset 0: if the text changed in between, the read is refused with conflict instead of mixing two versions.',
    inputSchema: z.object({
      taskId: z.string().min(1).max(200),
      field: z.enum(['context', 'evidence', 'project', 'dependencies', 'workIntentPaths', 'worktreePaths']),
      auditId: z.string().min(1).max(200).nullish(),
      offset: z.number().int().min(0).max(1_000_000_000).nullish(),
      limit: z.number().int().min(4).max(24576).nullish(),
      expectSha256: z.string().regex(/^[0-9a-f]{64}$/).nullish(),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.taskText ? core.taskText(token(ctx), input) : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('claim_next', {
    description: 'Atomically claim a task from the authenticated employee queue. The answer echoes the claim within the 48 KiB budget: deliveryId, fence and leaseExpiresAt always come back; a long context is cut and flagged (contextTruncated, contextNextOffset), and read_task_text returns the rest.',
    inputSchema: z.object({ taskId: z.string().min(1).nullish() }),
  }, async ({ taskId }, ctx) => {
    const credential = token(ctx);
    return run(credential, async () => {
      // SYS01 (return of 04195c93): the claim has committed by now, so its answer is an echo; core keeps the whole claim for claim.json.
      if (taskId) return echoClaim(await core.claim(credential, taskId));
      const principal = await core.authenticate(credential);
      const tasks = await core.listTasks(credential);
      const now = Date.now();
      const abandoned = (task: TaskView) => task.state === 'doing' && task.executorRole === principal.role &&
        task.currentEmployee !== principal.employeeId && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= now);
      // Track filter mirrors the claim check: defs with a tracks list only see covered disciplines.
      // Required-track roles (e.g. screenwriter) additionally need an exact required-track match.
      const requiredTrack = REQUIRED_TRACKS[principal.role as Role];
      const trackOk = (task: TaskView) => requiredTrack !== undefined
        ? task.discipline === requiredTrack && (principal.tracks ?? []).includes(requiredTrack)
        : !task.discipline || !principal.tracks?.length || principal.tracks.includes(task.discipline);
      const candidates = tasks.filter((task: TaskView) => trackOk(task) &&
        (task.state === 'review' && task.reviewerRole === principal.role && task.submittedBy !== principal.employeeId) ||
        (task.state === 'ready' && task.executorRole === principal.role) || abandoned(task),
      );
      const rank = (task: TaskView) => task.state === 'review' ? 0 : task.state === 'doing' ? 1 : 2;
      candidates.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
      // The core remains the sole authority for concurrent claims and dependencies.
      for (const candidate of candidates) {
        try {
          return echoClaim(await core.claim(credential, candidate.id));
        } catch (error) {
          if (typeof error !== 'object' || error === null || !('code' in error) ||
            !['conflict', 'already_claimed', 'worktree_busy'].includes(String(error.code))) throw error;
        }
      }
      throw { code: 'no_available_task' };
    });
  });

  server.registerTool('heartbeat', {
    description: 'Extend the current delivery lease using the core server clock. The answer echoes the task within the 48 KiB budget (deliveryId, fence and leaseExpiresAt always come back); a long context is cut and flagged (contextTruncated, contextNextOffset), and read_task_text returns the rest.',
    inputSchema: z.object(proofShape),
  }, async (input, ctx) => run(token(ctx), async () => echoClaim(await core.heartbeat(token(ctx), proof(input)))));

  server.registerTool('checkpoint', {
    description: 'Record resumable progress for the current delivery. Limited to a few per task per holder (checkpoint_limit); use heartbeat for liveness and merge progress notes.',
    inputSchema: z.object({ ...proofShape, ...evidenceShape }),
  }, async (input, ctx) => run(token(ctx), () => core.checkpoint(token(ctx), proof(input), evidence(input))));

  server.registerTool('submit', {
    description: 'Submit the current delivery for independent review.',
    inputSchema: z.object({ ...proofShape, ...evidenceShape }),
  }, async (input, ctx) => run(token(ctx), () => core.submit(token(ctx), proof(input), evidence(input))));

  server.registerTool('report_blocker', {
    description: 'Block the current delivery for gm or owner input. For a subscription quota or rate limit, pass quotaResetsAt: the reset time the provider reported, as ISO 8601 with a timezone offset.',
    inputSchema: z.object({ ...proofShape, ...evidenceShape, to: z.enum(['gm', 'owner']),
      quotaResetsAt: z.string().min(1).optional() }),
  }, async (input, ctx) => run(token(ctx), () => core.block(token(ctx), proof(input), input.to, evidence(input), input.quotaResetsAt)));

  server.registerTool('review', {
    description: 'Independently accept or return the current review delivery.',
    inputSchema: z.object({ ...proofShape, ...evidenceShape, decision: z.enum(['accept', 'return']) }),
  }, async (input, ctx) => run(token(ctx), () => input.decision === 'accept'
    ? core.accept(token(ctx), proof(input), evidence(input))
    : core.returnTask(token(ctx), proof(input), evidence(input))));

  server.registerTool('create_task', {
    description: 'Create a managed company task; requires core manage capability. project optionally binds this one task to a registered project (takes precedence over the goal\'s project). revises=<直接上一版任务id> creates the controlled screenplay-revision edge: gm/product only, both drafts must be owner-reviewed screenwriter tasks on the 编剧 track (kind=task) in the same goal and project, and the target must be the unapproved chain tip whose latest submission was really rejected by the owner; the old draft voids with a supersededBy pointer and downstreams resolve to the chain tip.',
    inputSchema: z.object({
      modelTier: z.enum(['fable','opus','sonnet','haiku','high','medium','low']).optional(),
      title: z.string().min(1), context: z.string().min(1),
      executorRole: z.enum(roles), reviewerRole: z.enum(reviewerRoles),
      discipline: z.string().min(1).max(60).optional(),
      project: z.string().min(1).max(60).optional(),
      // The 50-dependency and asset-path limits are enforced by core.createTask, the same
      // validator the sidecar reaches. Keeping them out of this schema preserves the structured
      // `invalid` result; a schema failure here would be a plain protocol error instead.
      workIntent: z.object({ kind: z.enum(['read', 'code', 'assets']), paths: z.array(z.string()).optional(), lane: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/).optional() }).optional(),
      kind: z.enum(['task', 'gate']).optional(), goalId: z.string().min(1).optional(),
      dependencies: z.array(z.string().min(1)).optional(), idempotencyKey: z.string().min(1),
      revises: z.string().min(1).optional(),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.createTask(token(ctx), input)));

  // Workforce administration tools: manage capability only (gm/product), every write audited.
  server.registerTool('def_list', {
    description: 'manage only (gm/product): list employee_def rows (id/role/provider/model/thinking/tracks/enabled/max_instances/priority/weight/quota_limited).',
    inputSchema: z.object({}),
  }, async (_input, ctx) => run(token(ctx), () => core.listDefs(token(ctx))));

  server.registerTool('def_ensure', {
    description: 'manage only (gm/product): create or update an employee_def (audited). tracks [] clears tracks, omitted keeps; enabled=false disables; quotaLimited=false keeps the def dispatchable even at 0% quota (omitted keeps the stored value). Basic fields are required on every call.',
    inputSchema: z.object({
      id: z.string().min(1).max(60), role: z.enum(defRoles), provider: z.string().min(1).max(60), model: z.string().min(1).max(120),
      thinking: z.string().min(1).max(40).optional(), tracks: z.array(z.string().min(1).max(60)).max(50).optional(),
      maxInstances: z.number().int().min(0).max(8).optional(), priority: z.number().int().optional(),
      weight: z.number().int().min(0).max(1000).optional(), enabled: z.boolean().optional(),
      quotaLimited: z.boolean().optional(),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.ensureDef(token(ctx), input)));

  server.registerTool('project_disciplines_update', {
    description: 'manage only (gm/product): replace a project disciplines vocabulary (unique non-empty names, audited); no other project field is touched.',
    inputSchema: z.object({
      project: z.string().min(1).max(60),
      disciplines: z.array(z.object({ name: z.string().min(1).max(60), description: z.string().max(500).optional() })).max(50),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.updateProjectDisciplines(token(ctx), input)));

  server.registerTool('get_task_history', {
    description: 'Read the audited history of a task (claims, checkpoints, submissions, returns, owner decisions, handover packets). Without pageSize or cursor it returns the complete history, oldest first, or response_too_large with retry guidance when it does not fit the 48 KiB budget (retry with pageSize 10, then cursor set to page.nextCursor). With pageSize or cursor, newest entries come first in pages that fit the budget; each page is returned oldest first. Evidence too large for a page is cut and flagged (evidenceTruncated, evidenceNextOffset), with evidenceBytes and evidenceSha256; read the full text with read_task_text (field evidence, auditId).',
    inputSchema: z.object({ taskId: z.string().min(1).max(200), ...pageArgs }),
  }, async (input, ctx) => run(token(ctx), () => {
    // C2 default: a call that names neither pageSize nor cursor (null counts as absent) keeps the pre-SYS01 bare array, complete or refused.
    if (isPaged(input) && core.historyView) return core.historyView(token(ctx), input.taskId, input);
    return core.history(token(ctx), input.taskId);
  }));

  const relayShape = { ownerQuote: z.string().min(2), idempotencyKey: z.string().min(1) };
  const tiers = ['quick', 'standard', 'program'] as const;
  server.registerTool('create_goal', {
    description: 'gm only: record a goal the owner gave in direct conversation. Without tier the goal waits in triage (Jev or gm picks quick/standard/program); project links a project environment; pipeline picks the production line template (software, video or story; defaults to the project\'s line).',
    inputSchema: z.object({ text: z.string().min(2), tier: z.enum(tiers).optional(), project: z.string().min(1).optional(), pipeline: z.enum(['software', 'video', 'story']).optional(), ...relayShape }),
  }, async (input, ctx) => run(token(ctx), () => core.relayGoal(token(ctx), input)));

  server.registerTool('triage_goal', {
    description: 'gm only: choose the flow for a goal waiting in triage. quick = one delivery chain, product acceptance closes it, owner not involved; standard = gm plans deliveries, owner G3; program = product scope proposal first, then plan, owner G3.',
    inputSchema: z.object({ goalId: z.string().min(1), tier: z.enum(tiers), reason: z.string().min(4) }),
  }, async (input, ctx) => run(token(ctx), () => core.triageGoal(token(ctx), input)));

  server.registerTool('create_delivery', {
    description: 'gm/product: create the delivery chain for one code change under a goal: implement (engineering, peer review) -> release request (product or Jev decides go-live) -> merge, deploy and production verification (qa). project optionally binds all three legs to a registered project. The three legs form one worktree lane (one tree, one branch); pass lane to put related deliveries of the same goal into the same lane, otherwise every delivery gets its own lane and runs in parallel with the others. The explicit dependencies are external input: at most 50 raw entries, each a 1-200 character task id, checked before de-duplication by the same core validator create_task uses; a refusal writes no task, audit, outbox or idempotency row.',
    inputSchema: z.object({
      goalId: z.string().min(1), title: z.string().min(3), spec: z.string().min(20),
      discipline: z.string().min(1).max(60).optional(),
      project: z.string().min(1).max(60).optional(),
      lane: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/).optional(),
      // The 50-dependency limit is enforced by core.createDelivery, the same validator the sidecar
      // reaches. Keeping it out of this schema preserves the structured `invalid` result.
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
    description: 'gm only: turn a gm-blocked execute task, or a normal non-owner review block with a provable original submit and reviewer block, into a dependency wait — it stays blocked (the manager is no longer woken for it), the gm flag clears, and it restores ready (execute) or review (review) when every dependency is done; with all dependencies already done it restores immediately. Owner gates and unprovable review history are refused.',
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

  server.registerTool('goal_acceptance_preview', {
    description: 'gm only (manage): read-only dry-run for repointing a quick/software goal whose manual/acceptance reference still points at an erroneously voided acceptance task. Returns the live references, the unfinished goal work, the candidate checks and the snapshot hash that goal_acceptance_repair must echo. Writes nothing.',
    inputSchema: z.object({ goalId: z.string().min(1).max(100), candidateTaskId: z.string().min(1).max(200).optional() }),
  }, async (input, ctx) => run(token(ctx), () => core.goalAcceptancePreview
    ? core.goalAcceptancePreview(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('goal_acceptance_repair', {
    description: 'gm only (manage): commit the acceptance reference repair in one audited compare-and-set transaction. Repoints manual/acceptance and anchors from the expected void task to a blocked product→gm candidate that depends on all unfinished goal work. Needs the snapshotHash from goal_acceptance_preview, a reason and an idempotencyKey; the same key with the same payload returns the original result. The repairing gm cannot claim, accept, return or block the repaired candidate; another gm must review it.',
    inputSchema: z.object({
      goalId: z.string().min(1).max(100),
      expectedOldTaskId: z.string().min(1).max(200),
      candidateTaskId: z.string().min(1).max(200),
      snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
      text: z.string().min(4).max(8000),
      idempotencyKey: z.string().min(8).max(200),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.goalAcceptanceRepair
    ? core.goalAcceptanceRepair(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('contributor_dryrun', {
    description: 'gm only, read-only: for up to 20 tasks, who authored and reviewed each one from its audit stream, the implementer status with a suggestion that writes nothing, and the audit timeline with each row role. Use it before any implementer repair; it never changes a lease, submitter, gate or history.',
    inputSchema: z.object({ taskIds: z.array(z.string().min(1).max(200)).min(1).max(20) }),
  }, async (input, ctx) => run(token(ctx), () => core.contributorDryRun
    ? core.contributorDryRun(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('implementer_takeover', {
    description: 'gm only (manage): record a new code implementer for an execute-phase engineering task whose bound implementer cannot continue (withdrawn, departed, durable quota or runtime failure). Compare-and-set on expectedVersion. A current reviewer taking over needs a named independent replacementReviewer. Authorship is never removed; a lease held by someone else is revoked in the same write. The same idempotencyKey with the same payload returns the original result.',
    inputSchema: z.object({
      taskId: z.string().min(1).max(200),
      toEmployee: z.string().min(1).max(200),
      replacementReviewer: z.string().min(1).max(200).optional(),
      expectedVersion: z.number().int().positive(),
      reason: z.string().min(8).max(2000),
      idempotencyKey: z.string().min(8).max(200),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.implementerTakeover
    ? core.implementerTakeover(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('independence_set', {
    description: 'Manager (manage capability) only: write a task independence policy. Contributors of the source tasks (every execute-phase handler, including a claim that never submitted; with all_handlers also the reviewers), the named employees, and anyone sharing a registered identity principal with either, may not take the task (execute) or decide it (review). A definition, provider, model, name or directory is never an identity, so its other employees stay independent (SYS-DISP Q3). Compare-and-set on expectedVersion; refused while the task is leased; a second write with the same idempotencyKey and payload returns the original result.',
    inputSchema: z.object({
      taskId: z.string().min(1).max(200),
      stages: z.array(z.enum(['execute', 'review'])).min(1).max(2),
      sources: z.array(z.string().min(1).max(200)).max(20),
      mode: z.enum(['execute_handlers', 'all_handlers']),
      excluded: z.array(z.string().min(1).max(200)).max(100).optional(),
      reason: z.string().min(1).max(2048),
      expectedVersion: z.number().int().positive(),
      idempotencyKey: z.string().min(8).max(200),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.setIndependence
    ? core.setIndependence(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('independence_check', {
    description: 'gm or qa, read-only: the formal candidate-level preflight of the independence gate. Answers whether one employee would be refused by one task independence policy at one stage: clear (the gate would admit them), conflict (it would refuse, with the same via/source/matched/role/principal and the contribution auditRef its refusal cites), unverifiable (the exclusion could not be read, so the gate fails closed — never a pass), or not_applicable (the task has no policy). The policy field echoes the registered revision, stages, mode, sources, excluded, setBy and setAt so qa can read the real values back. stage defaults to the task current phase (review while in review, else execute). Writes nothing at all: no lease, no version, no audit, no dispatch — so a done or void task is still readable. gm always, qa always; every other role is refused.',
    inputSchema: z.object({
      taskId: z.string().min(1).max(200),
      employeeId: z.string().min(1).max(200),
      stage: z.enum(['execute', 'review']).optional(),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.independenceCheck
    ? core.independenceCheck(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('identity_principal_set', {
    description: 'Manager (manage capability) only: register an identity principal, or set its exact employee set, under a compare-and-set. A principal is the ONLY link that makes two employeeIds one person for independence purposes: contributors of a source task, and employees a manager names, may not take (execute) or decide (review) a task, and neither may anyone who shares a registered principal with them. A definition, provider, model, name or directory never implies the link, and an unregistered link is never recognized. Requires a reason (audited); refused while any named employee holds a live lease; a second write with the same idempotencyKey and payload returns the original result.',
    inputSchema: z.object({
      principalId: z.string().min(1).max(200).optional(),
      employees: z.array(z.string().min(1).max(200)).min(1).max(20),
      reason: z.string().min(8).max(2000),
      expectedVersion: z.number().int().positive().optional(),
      idempotencyKey: z.string().min(8).max(200),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.setIdentityPrincipal
    ? core.setIdentityPrincipal(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('task_project_update', {
    description: 'gm only: rebind a blocked, un-leased, never-submitted task to a registered project (task-level override over goal.project). Version-guarded, idempotent, audited; releases the stale worktree assignment through the normal lifecycle. Refuses doing/review/done tasks, active leases, submitted results and owner-blocked tasks.',
    inputSchema: z.object({
      taskId: z.string().min(1), project: z.string().min(1).max(60),
      expectedVersion: z.number().int().positive(), ...evidenceShape,
    }),
  }, async (input, ctx) => run(token(ctx), () => core.taskProjectUpdate
    ? core.taskProjectUpdate(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('bind_task_code_repo', {
    description: 'gm only: bind an explicit code repository to a blocked execute-phase task (blocked_to=gm or a formal dependency wait; owner gates and review-phase blocks refuse). Only workspace allocation and dispatch repoHome/cwd follow the binding — the business project (opsScope/claim.json.project) is untouched. Targets are limited to the ops repo or a registered project repo_path, canonicalised (symlink/traversal escapes and unregistered paths refuse). Version-guarded, idempotent, audited; releases the stale worktree assignment through the normal lifecycle.',
    inputSchema: z.object({
      taskId: z.string().min(1), codeRepoPath: z.string().min(1).max(1000),
      expectedVersion: z.number().int().positive(), ...evidenceShape,
    }),
  }, async (input, ctx) => run(token(ctx), () => core.bindTaskCodeRepo
    ? core.bindTaskCodeRepo(token(ctx), input)
    : Promise.reject({ code: 'temporarily_unavailable' })));

  server.registerTool('get_model_evidence', {
    description:'eval/gm only: actual models and execution fences for final task evaluation. Combine with full submission/return/accept history; request counts are not quality scores.',
    inputSchema:z.object({taskId:z.string().min(1).max(200)}),
  },async(input,ctx)=>run(token(ctx),()=> {
    if(!core.modelEvidence) throw new Error('Model evidence unavailable');
    return core.modelEvidence(token(ctx),input.taskId);
  }));
  server.registerTool('record_score', {
    description: 'eval employees only: record a performance scorecard for every participant of a finished task.',
    inputSchema: z.object({
      taskId: z.string().min(1),
      summary: z.string().min(1).max(20000),
      scores: z.array(z.object({
        employee: z.string().min(1),
        modelScores: z.array(z.object({model:z.string().min(1).max(200),overall:z.number().min(1).max(5),notes:z.string().max(2000).optional()})).max(50).optional(),
        quality: z.number().min(1).max(5),
        evidence: z.number().min(1).max(5),
        discipline: z.number().min(1).max(5),
        timeliness: z.number().min(1).max(5),
        overall: z.number().min(1).max(5),
        notes: z.string().max(4000).optional(),
      })).max(50),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.recordScore(token(ctx), input)));
  // ---- QA 受限只读取证（SYS-DISP 7454fc89） ----
  const qaRelease = (): string | undefined => {
    try { return process.env.SCK_RELEASE ?? basename(realpathSync(process.cwd())); } catch { return undefined; }
  };
  const withRelease = <T extends { meta: object }>(value: T): T => {
    const release = qaRelease();
    return (release ? { ...value, meta: { ...value.meta, runtimeRelease: release } } : value) as T;
  };
  server.registerTool('qa_observation_grant', {
    description: 'gm only (manage): register a time-bounded, read-only QA observation scope. It binds one deployment task in QA review, its live review lease holder and fence, the same goal, an allowlist of subject task ids, an expiry (1 minute to 24 hours), a reason and an idempotency key. The scope cannot expand itself, read other goals, or expose SQL/files. The same key with the same payload returns the original scope; a different payload is a conflict.',
    inputSchema: z.object({
      goalId: z.string().min(1).max(100), deploymentTaskId: z.string().min(1).max(200),
      qaEmployee: z.string().min(1).max(200), leaseFence: z.number().int().positive(),
      subjects: z.array(z.string().min(1).max(200)).min(1).max(50),
      expiresAt: z.string().min(10).max(40), reason: z.string().min(8).max(2000),
      idempotencyKey: z.string().min(8).max(200),
    }),
  }, async (input, ctx) => run(token(ctx), () => core.qaObservationGrant
    ? core.qaObservationGrant(token(ctx), input) : Promise.reject({ code: 'temporarily_unavailable' })));
  server.registerTool('qa_observation_revoke', {
    description: 'gm only (manage): revoke a QA observation scope with compare-and-set on its version. The revoked scope fails closed on the QA side immediately; the same idempotency key with the same payload returns the original result.',
    inputSchema: z.object({ scopeId: z.string().min(1).max(200), expectedVersion: z.number().int().positive(),
      reason: z.string().min(8).max(2000), idempotencyKey: z.string().min(8).max(200) }),
  }, async (input, ctx) => run(token(ctx), () => core.qaObservationRevoke
    ? core.qaObservationRevoke(token(ctx), input) : Promise.reject({ code: 'temporarily_unavailable' })));
  server.registerTool('qa_observation_status', {
    description: 'gm sees every QA observation scope; a qa employee sees its own. Never returns a code, token or session hash. Read-only.',
    inputSchema: z.object({}),
  }, async (_input, ctx) => run(token(ctx), () => core.qaObservationStatus
    ? core.qaObservationStatus(token(ctx)) : Promise.reject({ code: 'temporarily_unavailable' })));
  server.registerTool('qa_observation_session', {
    description: 'qa only: exchange the caller\'s live sck session and its active observation scope for a one-time login code for the dedicated read-only QA console (5 minutes). The code is a restricted, single-use login seam, not the employee credential and not the owner token; the console at the preview LAN /q/ page (returned as pagePath) exchanges it for an HttpOnly 30-minute read-only session. The console has no owner RPC and no write route.',
    inputSchema: z.object({ scopeId: z.string().min(1).max(200).nullish() }),
  }, async (input, ctx) => run(token(ctx), () => core.qaObservationSession
    ? core.qaObservationSession(token(ctx), { ...(input.scopeId ? { scopeId: input.scopeId } : {}) }) : Promise.reject({ code: 'temporarily_unavailable' })));
  server.registerTool('qa_observation_read', {
    description: 'qa only (the scope must still bind the live QA review lease holder and fence): read one allowlisted subject of the scope. A task subject returns its full state (a long context is omitted and flagged, read it with qa_observation_text), contribution facts with unknown rows fail-closed, the last dispatcher pass\'s verdicts and all reasons for the task, and checkedAt/dataSource/instanceAt/runtimeRelease/scope/completeness. A goal subject returns the controlled goal summary only. Read-only; no task text of unlisted tasks is ever returned.',
    inputSchema: z.object({ scopeId: z.string().min(1).max(200).nullish(), taskId: z.string().min(1).max(200).nullish(), goalId: z.string().min(1).max(100).nullish() }),
  }, async (input, ctx) => run(token(ctx), async () => {
    if (!core.qaObservationRead) return Promise.reject({ code: 'temporarily_unavailable' });
    return withRelease(await core.qaObservationRead({ credential: token(ctx) }, {
      ...(input.scopeId ? { scopeId: input.scopeId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
    }));
  }));
  server.registerTool('qa_observation_timeline', {
    description: 'qa only: one stored page of an allowlisted task\'s audit history (newest-first pages, oldest-first within a page), within the 48 KiB budget. Evidence too large for a page is cut and flagged; read it whole with qa_observation_text. Continue with page.nextCursor until page.hasMore is false; a cursor is bound to the scope, task and caller.',
    inputSchema: z.object({ scopeId: z.string().min(1).max(200).nullish(), taskId: z.string().min(1).max(200), ...pageArgs }),
  }, async (input, ctx) => run(token(ctx), async () => {
    if (!core.qaObservationTimeline) return Promise.reject({ code: 'temporarily_unavailable' });
    return withRelease(await core.qaObservationTimeline({ credential: token(ctx) }, {
      ...(input.scopeId ? { scopeId: input.scopeId } : {}), taskId: input.taskId,
      ...(input.pageSize !== undefined && input.pageSize !== null ? { pageSize: input.pageSize } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    }));
  }));
  server.registerTool('qa_observation_text', {
    description: 'qa only: one byte segment of an allowlisted task\'s context or one audit entry\'s evidence. Returns the whole text\'s size and SHA-256; a segment past offset 0 requires expectSha256 from the first segment, so a changed text is refused instead of mixed. Segments never split a character.',
    inputSchema: z.object({ scopeId: z.string().min(1).max(200).nullish(), taskId: z.string().min(1).max(200),
      field: z.enum(['context', 'evidence']), auditId: z.string().min(1).max(200).nullish(),
      offset: z.number().int().min(0).max(1_000_000_000).nullish(), limit: z.number().int().min(4).max(24576).nullish(),
      expectSha256: z.string().regex(/^[0-9a-f]{64}$/).nullish() }),
  }, async (input, ctx) => run(token(ctx), async () => {
    if (!core.qaObservationText) return Promise.reject({ code: 'temporarily_unavailable' });
    return withRelease(await core.qaObservationText({ credential: token(ctx) }, {
      ...(input.scopeId ? { scopeId: input.scopeId } : {}), taskId: input.taskId, field: input.field,
      ...(input.auditId ? { auditId: input.auditId } : {}),
      ...(input.offset !== undefined && input.offset !== null ? { offset: input.offset } : {}),
      ...(input.limit !== undefined && input.limit !== null ? { limit: input.limit } : {}),
      ...(input.expectSha256 ? { expectSha256: input.expectSha256 } : {}),
    }));
  }));
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
      // The request's arrival is stamped here, before heal: a listing answer counts its reply ceiling from it (SYS01 M1).
      const work = arriving(() => respond(request, credential));
      work.catch(() => {}); // a rejection after the budget wins must not become an unhandled rejection
      try {
        return await Promise.race([work, budget]);
      } finally {
        clearTimeout(budgetTimer);
      }

      async function respond(req: Request, cred: Credential): Promise<Response> {
        const t0 = Date.now();
        const mark = (stage: string) => console.log(`req ${req.method} ${stage} +${Date.now() - t0}ms`);
        // The tool a tools/call names is read from a copy of the body, so that its reply ceiling applies from the arrival on.
        noteTool(await req.clone().json().then(
          (body: { method?: unknown; params?: { name?: unknown } }) => body.method === 'tools/call' && typeof body.params?.name === 'string' ? body.params.name : undefined,
          () => undefined));
        try {
          if (SNAPSHOT_TOOLS.has(currentTool() ?? '')) {
            // A listing answer is not kept waiting past its reply ceiling for a reconnect: the heal goes on in the background.
            const healed = await untilAt(Promise.resolve(options.heal?.()).then(() => 'healed' as const), arrivedAt() + REPLY_CEILING_MS);
            if (healed !== 'healed') {
              mark('heal not done within the reply ceiling');
              return new Response('Service unavailable', { status: 503 });
            }
          } else {
            await options.heal?.();
          }
          mark('heal');
        } catch {
          mark('heal failed');
          return new Response('Service unavailable', { status: 503 });
        }
        if (options.gateToken) {
          let expected: string | undefined;
          try {
            // The gate lookup is part of a listing answer's wait too, so it is cut at the same reply ceiling (SYS01 M1).
            const lookup = options.gateToken().then(value => ({ value }));
            const found = SNAPSHOT_TOOLS.has(currentTool() ?? '') ? await untilAt(lookup, arrivedAt() + REPLY_CEILING_MS) : await lookup;
            if (found === undefined) {
              mark('gate lookup not done within the reply ceiling');
              return new Response('Service unavailable', { status: 503 });
            }
            expected = found.value;
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
          // SYS01 M1: one deadline from arrival covers the whole request, authentication included. A stalled auth on a
          // snapshot-backed listing is refused recoverably at the same moment as its answer, not left to the 55s budget.
          principal = SNAPSHOT_TOOLS.has(currentTool() ?? '')
            ? await withinReplyCeiling(async () => core.authenticate(cred))
            : await core.authenticate(cred);
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
        // SYS01, D2: a request id over MAX_REQUEST_ID_BYTES is refused before any tool runs, since the frame reserve of the budget
        // assumes that bound. Nothing is written for the refused request, and its refusal carries a null id: no valid id is known.
        if (req.method === 'POST') {
          const oversize = oversizeRequestId(await req.clone().text());
          if (oversize !== undefined) {
            return new Response(JSON.stringify({
              jsonrpc: '2.0', id: null,
              error: { code: -32600, message: `request id is ${oversize} bytes; ids are limited to ${MAX_REQUEST_ID_BYTES} bytes` },
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }
        }
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
