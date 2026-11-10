import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { RetirementKind } from '../contracts.ts';
import { CompanyError } from '../core-errors.ts';

import { MAINTENANCE_WORKSPACE, workspaceTitleOf } from '../runner/contracts.ts';
import type { AgentInfo, SpawnInput, AgentRuntime as PaseoGateway, RuntimeWorkspace as PaseoWorkspaceInfo,
  RuntimeProject as PaseoProjectInfo, RuntimePlugin as PaseoPluginInfo, SceneCleanupResult, SceneEmployees } from '../runner/contracts.ts';
export { MAINTENANCE_WORKSPACE, workspaceTitleOf };
export type { AgentInfo, SpawnInput, AgentRuntime as PaseoGateway, RuntimeWorkspace as PaseoWorkspaceInfo,
  RuntimeProject as PaseoProjectInfo, RuntimePlugin as PaseoPluginInfo, SceneCleanupResult, SceneEmployee, SceneEmployees } from '../runner/contracts.ts';

/** Paseo mode needed for unattended work; grok exposes no modes. */
export const UNATTENDED_MODE: Record<string, string | undefined> = { codex: 'full-access', claude: 'bypassPermissions', devin: 'bypass', 'factory-droid': 'auto-high' };

/** A Paseo CLI call that did not answer: non-zero exit, a spawn failure, or a timeout. `stderr` is what the CLI wrote. */
export class PaseoCliError extends Error {
  constructor(message: string, readonly stderr: string, readonly timedOut: boolean) {
    super(message);
    this.name = 'PaseoCliError';
  }
}

/** Observation gap: the CLI did not give a usable answer. Never a substitute for idle or busy. */
const UNOBSERVED = { status: 'unknown', pendingPermissions: 0 } as const;

/** The CLI's own not-found answer: `{"error":{"code":"AGENT_NOT_FOUND",...}}` on stderr, exit 1. */
const isAgentNotFound = (error: unknown): boolean => {
  if (!(error instanceof PaseoCliError)) return false;
  try {
    return (JSON.parse(error.stderr) as { error?: { code?: unknown } }).error?.code === 'AGENT_NOT_FOUND';
  } catch {
    return false;
  }
};

export function createPaseoCli(
  bin = process.env.SCK_PASEO_BIN ?? '/Applications/Paseo.app/Contents/Resources/bin/paseo',
  options: { timeoutMs?: number; runtimeMcpUrl?: string } = {},
): PaseoGateway {
  const defaultTimeoutMs = options.timeoutMs ?? 60_000;
  const run = async (args: string[], timeoutMs = defaultTimeoutMs): Promise<string> => {
    const child = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race the timeout against the streams: a wrapper that keeps stdout open after being killed must not hang the caller.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child.kill();
        reject(new PaseoCliError(`paseo ${args[0]} timed out after ${timeoutMs} ms`, '', true));
      }, timeoutMs);
    });
    const finished = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    finished.catch(() => undefined);
    try {
      const [out, err, code] = await Promise.race([finished, timedOut]);
      if (code !== 0) throw new PaseoCliError(`paseo ${args[0]} failed (exit ${code}): ${err.trim().slice(0, 300)}`, err, false);
      return out.trim();
    } finally {
      clearTimeout(timer);
    }
  };
  const json = async <T>(args: string[]): Promise<T> => JSON.parse(await run([...args, '--json'])) as T;
  const projects = new Map<string, Promise<string>>();
  const ensureProject = (path: string): Promise<string> => {
    const root = canonicalPath(path);
    const known = projects.get(root);
    if (known) return known;
    const found = (async () => {
      const rows = await json<PaseoProjectInfo[]>(['project', 'ls']);
      const existing = rows.find(p => canonicalPath(p.path) === root);
      if (existing) return existing.projectId;
      const created = await json<{ projectId?: string; id?: string }>(['project', 'create', root]);
      const id = created.projectId ?? created.id;
      if (!id) throw new Error('paseo project create did not return a project ID');
      return id;
    })();
    projects.set(root, found);
    found.catch(() => projects.delete(root));
    return found;
  };
  const createWorkspace = async (title: string, cwd: string, project?: string): Promise<string> => {
    const created = await json<{ workspaceId?: string; id?: string }>(['workspace', 'create', '--isolation', 'local', '--path', cwd, '--title', title, ...(project ? ['--project', project] : [])]);
    const id = created.workspaceId ?? created.id;
    if (!id) throw new Error('paseo workspace create did not return a workspace ID');
    return id;
  };
  const workspaces = new Map<string, Promise<string>>();
  const ensureWorkspace = (title: string, cwd: string, project?: string, scope?: string): Promise<string> => {
    const key = `${project ?? ''}\0${scope ?? title}\0${cwd}`;
    const known = workspaces.get(key);
    if (known) return known;
    const found = (async () => {
      const rows = await json<PaseoWorkspaceInfo[]>(['workspace', 'ls']);
      const existing = rows.find(w => canonicalPath(w.cwd) === canonicalPath(cwd) &&
        (scope ? w.name.endsWith(`[${scope}]`) : w.name === title));
      if (existing) return existing.workspaceId;
      return createWorkspace(title, cwd, project);
    })();
    workspaces.set(key, found);
    found.catch(() => workspaces.delete(key));
    return found;
  };
  return {
    async list() {
      const rows = await json<Array<{ id: string; status: string; provider?: string }>>(['ls', '-g']);
      return new Map(rows.map(r => {
        // `provider` is "<providerId>/<modelId>"; a model id may itself contain slashes
        // (`pi/magpie/stepfun/…`), so only the first one separates.
        const slash = typeof r.provider === 'string' ? r.provider.indexOf('/') : -1;
        const model = slash > 0 ? r.provider!.slice(slash + 1) : undefined;
        return [r.id, { id: r.id, status: r.status, model }];
      }));
    },
    async status(agentId) {
      let text: string;
      try {
        text = await run(['inspect', agentId, '--json']);
      } catch (error) {
        return isAgentNotFound(error) ? undefined : { ...UNOBSERVED };
      }
      let row: unknown;
      try {
        row = JSON.parse(text);
      } catch {
        return { ...UNOBSERVED };
      }
      if (typeof row !== 'object' || row === null) return { ...UNOBSERVED };
      const fields = row as { Status?: unknown; Archived?: unknown; PendingPermissions?: unknown };
      const pendingPermissions = Array.isArray(fields.PendingPermissions) ? fields.PendingPermissions.length : 0;
      // An archived session still reports its last status; it can no longer take work.
      if (fields.Archived === true) return { status: 'archived', pendingPermissions };
      if (typeof fields.Status !== 'string' || fields.Status === '') return { ...UNOBSERVED };
      return { status: fields.Status, pendingPermissions };
    },
    async lastError(agentId) {
      const text = await run(['logs', agentId, '--tail', '12', '--no-color']).catch(() => '');
      // Paseo reports the failure as a timeline entry, not as a bare marker. The real line reads
      //   Error: Agent turn ended: model_usage_exhausted[System Error] Internal error: …
      // so matching only a *leading* "[System Error]" never matched a single real failure and
      // every quota exhaustion was read as an empty error and retired as "session error: unknown".
      const marked = text.split('\n')
        .map(line => line.trim())
        .filter(line => line && (/\[System Error\]/.test(line) || /^(?:Internal error:|Error:)/.test(line)));
      return (marked.at(-1) ?? '').replace(/\[System Error\]/g, ' ').replace(/\s+/g, ' ').trim();
    },
    async logsTail(agentId, entries) {
      return run(['logs', agentId, '--tail', String(entries), '--no-color']).catch(error => `（无法读取会话日志：${error.message}）`);
    },
    async lastInputTokens(agentId) {
      const row = await json<{ LastUsage?: { InputTokens?: number } }>(['agent', 'inspect', agentId]).catch(() => undefined);
      return row?.LastUsage?.InputTokens;
    },
    async archive(agentId) {
      await run(['archive', agentId]);
    },
    async listWorkspaces() {
      return json<PaseoWorkspaceInfo[]>(['workspace', 'ls']);
    },
    async listProjects() {
      return json<PaseoProjectInfo[]>(['project', 'ls']);
    },
    async plugins() {
      return json<PaseoPluginInfo[]>(['plugin', 'ls']);
    },
    async createWorkspace(title, cwd, repoHome) {
      return createWorkspace(title, cwd, repoHome ? await ensureProject(repoHome) : undefined);
    },
    async archiveWorkspace(workspaceId) {
      await run(['workspace', 'archive', workspaceId]);
      // A title or scope must not resolve to the container that just went away.
      workspaces.clear();
    },
    async deleteProject(projectId) {
      await run(['project', 'delete', projectId]);
    },
    async spawn(input) {
      const project = !input.workspaceId && input.workspaceScope && input.repoHome ? await ensureProject(input.repoHome) : undefined;
      const workspace = input.workspaceId ?? await ensureWorkspace(input.workspaceTitle, input.cwd, project, input.workspaceScope);
      const args = ['run', '-d', '--json', '--provider', `${input.provider}/${input.model}`, '--title', input.title, '--workspace', workspace];
      if (input.thinking) args.push('--thinking', input.thinking);
      if (input.mode) args.push('--mode', input.mode);
      for (const [k, v] of Object.entries(input.labels)) args.push('--label', `${k}=${v}`);
      for (const [k, v] of Object.entries(input.env)) args.push('--env', `${k}=${v}`);
      args.push(input.prompt);
      const out = JSON.parse(await run(args, 120_000)) as { agentId?: string };
      if (!out.agentId) throw new Error('paseo run did not return an agent ID');
      return out.agentId;
    },
    async send(agentId, prompt) {
      const dir = await mkdtemp(join(tmpdir(), 'sck-dispatch-'));
      try {
        const file = join(dir, 'prompt.md');
        await writeFile(file, prompt, { mode: 0o600 });
        await run(['send', agentId, '--no-wait', '--json', '--prompt-file', file]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async sleep(agentId, beforeClose) {
      const { closePaseoRuntime } = await import('./runtime-sleep.ts');
      await closePaseoRuntime(agentId, options.runtimeMcpUrl, beforeClose);
    },
    async stop(agentId) {
      await run(['stop', agentId]);
    },
    async reload(agentId) {
      await run(['agent', 'reload', agentId]);
    },
  };
}

const canonicalPath = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const withinTree = (candidate: string, root: string) => candidate === root || candidate.startsWith(root + sep);
/**
 * "Already gone" is success for an idempotent teardown; anything else must surface for retry.
 * Only phrases that reliably mean the object no longer exists classify as gone — usage errors
 * ("unknown flag", "missing required argument") must stay real failures, or a CLI misuse would
 * pass for success, leave the scene behind, and destroy the retry anchor with the tree.
 */
export const goneSceneError = (error: unknown) =>
  /not.?found|no such|already|archived/i.test(error instanceof Error ? error.message : String(error));

/** The stable code of a failed employee retirement, or a short message for an unknown failure. It is kept on the scene for the retry. */
const failureLabel = (error: unknown): string =>
  error instanceof CompanyError ? error.code : (error instanceof Error ? error.message : String(error)).slice(0, 80);

/**
 * Release the Paseo side of a task scene: archive every workspace whose cwd points at the
 * tree, then delete each project rooted at the tree that no longer hosts a live workspace.
 * Both steps are idempotent — a missing object counts as done. Every object is attempted so
 * one failure does not mask the others; the collected failures throw so the caller can keep
 * the scene and retry at the next event point. An employee whose retirement does not complete,
 * for any reason, keeps its own session (no detach, no archive) and holds back the teardown of the
 * whole tree: no workspace or project is torn down while it remains (SYS-DISP R1). Employees already
 * retired in the same tree are detached and archived as usual.
 */
export function createSceneCleaner(
  paseo: Pick<PaseoGateway, 'listWorkspaces' | 'listProjects' | 'archiveWorkspace' | 'deleteProject' | 'archive'>,
  employees?: SceneEmployees,
): (treePath: string) => Promise<SceneCleanupResult> {
  return async (treePath) => {
    const target = canonicalPath(treePath);
    const failures: string[] = [];
    // Employee agents live inside the scene's Paseo workspace, so the teardown below
    // cascades onto them. Retire those instances first — their work scene is gone, so
    // they can never take another task — and record the real cause on the roster row.
    // Otherwise the archived agent fires agent.archived, the sidecar quarantines the
    // instance, and the next tick blames a dead binding as 通道隔离.
    let employeesRetired = 0;
    const kept: string[] = [];
    if (employees) {
      for (const inst of await employees.insts()) {
        if (!inst.cwd || !withinTree(canonicalPath(inst.cwd), target)) continue;
        try {
          await employees.retire(inst.id, '场景回收：会话随任务现场销毁', 'archive');
        } catch (error) {
          // Refused (in-flight work is still here) or failed for another reason (the facts are unconfirmed). Either way the session
          // stays: no detach, no archive, and the teardown below does not run for this tree.
          kept.push(`${inst.id}（${failureLabel(error)}）`);
          continue;
        }
        employeesRetired++;
        employees.detach?.(inst);
        if (inst.paseoAgentId) await paseo.archive(inst.paseoAgentId).catch(() => undefined);
      }
      // The workspace teardown below ends every session in the tree, so a tree with an employee not retired waits for a retry, with its cause.
      if (kept.length) throw new CompanyError('temporarily_unavailable', `scene kept: employee retirement not completed for ${kept.join('、')}`, true);
    }
    const workspaces = await paseo.listWorkspaces();
    const doomed = workspaces.filter(w => withinTree(canonicalPath(w.cwd), target));
    let workspacesArchived = 0;
    for (const w of doomed) {
      try { await paseo.archiveWorkspace(w.workspaceId); workspacesArchived++; }
      catch (error) {
        if (goneSceneError(error)) workspacesArchived++;
        else failures.push(`workspace ${w.workspaceId}: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
      }
    }
    // A project dies only when no live workspace remains under it; re-list after archiving,
    // and on re-list failure keep the pre-archive list so projects err on the retained side.
    const remaining = doomed.length ? await paseo.listWorkspaces().catch(() => workspaces) : workspaces;
    const projects = (await paseo.listProjects()).filter(p => withinTree(canonicalPath(p.path), target));
    let projectsDeleted = 0;
    for (const p of projects) {
      if (remaining.some(w => w.project === p.name || w.project === p.projectId)) continue;
      try { await paseo.deleteProject(p.projectId); projectsDeleted++; }
      catch (error) {
        if (goneSceneError(error)) projectsDeleted++;
        else failures.push(`project ${p.projectId}: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
      }
    }
    if (failures.length) throw new Error(failures.join('; ').slice(0, 280));
    return { workspacesArchived, projectsDeleted, ...(employeesRetired ? { employeesRetired } : {}) };
  };
}
