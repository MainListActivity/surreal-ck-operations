import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { RetirementKind } from '../contracts.ts';

export interface AgentInfo { id: string; status: string }
export interface PaseoWorkspaceInfo { workspaceId: string; name: string; cwd: string; project?: string }
export interface PaseoProjectInfo { projectId: string; name: string; path: string; kind?: string }
export interface SceneCleanupResult { workspacesArchived: number; projectsDeleted: number; employeesRetired?: number }

/** The dispatcher-facing fields of an employee instance that scene cleanup needs. */
export interface SceneEmployee { id: string; cwd?: string; paseoAgentId?: string | null }
export interface SceneEmployees {
  insts(): Promise<SceneEmployee[]>;
  retire(id: string, reason: string, kind: RetirementKind): Promise<unknown>;
  /** In-process sidecar cleanup — binding drop + quarantine — when the plugin process wires it. */
  detach?(inst: SceneEmployee): void;
}

export interface SpawnInput {
  title: string;
  provider: string;
  model: string;
  thinking?: string;
  mode?: string;
  cwd: string;
  /** One Paseo workspace per employee definition; every instance of the definition runs as an agent inside it. */
  workspaceTitle: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  prompt: string;
}

/** The dispatcher's only view of Paseo. Implemented by the paseo CLI; faked in tests. */
export interface PaseoGateway {
  list(): Promise<Map<string, AgentInfo>>;
  status(agentId: string): Promise<{ status: string; pendingPermissions: number } | undefined>;
  lastError(agentId: string): Promise<string>;
  logsTail(agentId: string, entries: number): Promise<string>;
  /** Input tokens of the agent's last turn; a proxy for how large its session context has grown. */
  lastInputTokens(agentId: string): Promise<number | undefined>;
  spawn(input: SpawnInput): Promise<string>;
  send(agentId: string, prompt: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  /** Soft-delete the agent's session (its transcript stays in Paseo history). */
  archive(agentId: string): Promise<void>;
  /** Active workspaces; archived ones no longer appear. */
  listWorkspaces(): Promise<PaseoWorkspaceInfo[]>;
  /** Registered projects; each maps a directory to the workspaces under it. */
  listProjects(): Promise<PaseoProjectInfo[]>;
  /** Archive a workspace and everything it owns; the transcript stays in history. */
  archiveWorkspace(workspaceId: string): Promise<void>;
  /** Delete a project and its workspaces. */
  deleteProject(projectId: string): Promise<void>;
}

/** Paseo mode needed for unattended work; grok exposes no modes. */
export const UNATTENDED_MODE: Record<string, string | undefined> = { codex: 'full-access', claude: 'bypassPermissions', devin: 'bypass', 'factory-droid': 'auto-high' };

export function createPaseoCli(bin = process.env.SCK_PASEO_BIN ?? '/Applications/Paseo.app/Contents/Resources/bin/paseo'): PaseoGateway {
  const run = async (args: string[], timeoutMs = 60_000): Promise<string> => {
    const child = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`paseo ${args[0]} failed (exit ${code}): ${err.trim().slice(0, 300)}`);
      return out.trim();
    } finally {
      clearTimeout(timer);
    }
  };
  const json = async <T>(args: string[]): Promise<T> => JSON.parse(await run([...args, '--json'])) as T;
  const workspaces = new Map<string, Promise<string>>();
  const ensureWorkspace = (title: string, cwd: string): Promise<string> => {
    const key = `${title}\0${cwd}`;
    const known = workspaces.get(key);
    if (known) return known;
    const found = (async () => {
      const rows = await json<Array<{ workspaceId: string; name: string; cwd: string }>>(['workspace', 'ls']);
      const existing = rows.find(w => w.name === title && w.cwd === cwd);
      if (existing) return existing.workspaceId;
      const created = await json<{ workspaceId?: string; id?: string }>(['workspace', 'create', '--isolation', 'local', '--path', cwd, '--title', title]);
      const id = created.workspaceId ?? created.id;
      if (!id) throw new Error('paseo workspace create did not return a workspace ID');
      return id;
    })();
    workspaces.set(key, found);
    found.catch(() => workspaces.delete(key));
    return found;
  };
  return {
    async list() {
      const rows = await json<Array<{ id: string; status: string }>>(['ls', '-g']);
      return new Map(rows.map(r => [r.id, { id: r.id, status: r.status }]));
    },
    async status(agentId) {
      try {
        const row = await json<{ Status: string; Archived?: boolean; PendingPermissions?: unknown[] }>(['inspect', agentId]);
        // An archived session still reports its last status; it can no longer take work.
        return { status: row.Archived ? 'archived' : row.Status, pendingPermissions: row.PendingPermissions?.length ?? 0 };
      } catch {
        return undefined;
      }
    },
    async lastError(agentId) {
      const text = await run(['logs', agentId, '--tail', '8', '--no-color']).catch(() => '');
      const errors = text.split('\n').filter(line => line.startsWith('[System Error]'));
      return errors.at(-1)?.replace('[System Error]', '').trim() ?? '';
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
    async archiveWorkspace(workspaceId) {
      await run(['workspace', 'archive', workspaceId]);
    },
    async deleteProject(projectId) {
      await run(['project', 'delete', projectId]);
    },
    async spawn(input) {
      const workspace = await ensureWorkspace(input.workspaceTitle, input.cwd);
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
    async stop(agentId) {
      await run(['stop', agentId]);
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
const goneSceneError = (error: unknown) =>
  /not.?found|no such|already|archived/i.test(error instanceof Error ? error.message : String(error));

/**
 * Release the Paseo side of a task scene: archive every workspace whose cwd points at the
 * tree, then delete each project rooted at the tree that no longer hosts a live workspace.
 * Both steps are idempotent — a missing object counts as done. Every object is attempted so
 * one failure does not mask the others; the collected failures throw so the caller can keep
 * the scene and retry at the next event point.
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
    if (employees) {
      for (const inst of await employees.insts()) {
        if (!inst.cwd || !withinTree(canonicalPath(inst.cwd), target)) continue;
        employeesRetired++;
        await employees.retire(inst.id, '场景回收：会话随任务现场销毁', 'archive').catch(() => undefined);
        employees.detach?.(inst);
        if (inst.paseoAgentId) await paseo.archive(inst.paseoAgentId).catch(() => undefined);
      }
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
