import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface AgentInfo { id: string; status: string }

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
}

/** Paseo mode needed for unattended work; grok exposes no modes. */
export const UNATTENDED_MODE: Record<string, string | undefined> = { codex: 'full-access', devin: 'bypass', 'factory-droid': 'auto-high' };

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
