/**
 * Putting a live session back on the model its employee definition asks for.
 *
 * A provider can change the model under a running subscription on its own: Factory serves a
 * cheaper model once the standard allowance is spent and switches back when it recovers. The
 * session, its conversation and its seat stay valid throughout, so the answer is to realign the
 * model — never to retire the employee.
 *
 * Paseo's own CLI has no "set model" verb for an existing agent, but its daemon does: the MCP
 * endpoint on loopback accepts `update_agent` with `settings.model` and applies it to the live
 * session immediately. That is the path used here — no SDK, no bundling, no new dependency.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PORT = 6767;
const MCP_PATH = '/mcp/agents';

/** The daemon's HTTP base, derived from the address Paseo publishes for itself. */
export function daemonBase(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = p => readFileSync(p, 'utf8')): string {
  const explicit = (env.PASEO_DAEMON_URL ?? env.SCK_PASEO_DAEMON_URL ?? '').trim();
  if (explicit) return explicit.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
  try {
    const config = JSON.parse(readFile(join(homedir(), '.paseo', 'config.json'))) as { daemon?: { listen?: unknown } };
    const listen = config.daemon?.listen;
    if (typeof listen === 'string' && listen.trim()) return `http://${listen.trim().replace(/\/+$/, '')}`;
  } catch { /* no config: fall through to the default port */ }
  return `http://127.0.0.1:${DEFAULT_PORT}`;
}

interface McpToolResult {
  result?: { content?: Array<{ type?: string; text?: string }>; structuredContent?: { success?: unknown }; isError?: unknown };
  error?: { message?: string };
}

/**
 * Reads the tool result out of the endpoint's answer. The transport is SSE (`event: message`
 * followed by `data: {json}`), but a plain JSON body is accepted too.
 */
export function parseMcpReply(raw: string): { ok: boolean; detail: string } {
  const payload = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') || raw.trim();
  if (!payload) return { ok: false, detail: 'empty reply' };
  let body: McpToolResult;
  try { body = JSON.parse(payload) as McpToolResult; }
  catch { return { ok: false, detail: payload.slice(0, 120) }; }
  if (body.error) return { ok: false, detail: String(body.error.message ?? 'rpc error').slice(0, 160) };
  const result = body.result;
  if (!result) return { ok: false, detail: 'no result' };
  const text = (result.content ?? []).map(part => part.text ?? '').join(' ').trim();
  if (result.isError === true) return { ok: false, detail: text.slice(0, 160) || 'tool error' };
  if (result.structuredContent && result.structuredContent.success === false) return { ok: false, detail: text.slice(0, 160) || 'rejected' };
  return { ok: true, detail: text.slice(0, 160) };
}

export interface SetAgentModelOptions {
  thinkingOptionId?: string;
  base?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Applies `model` to a live agent. Resolves false — never throws — so a caller can keep the
 * session and retry next pass instead of treating an unavailable control plane as a dead employee.
 */
export async function setAgentModel(agentId: string, model: string, options: SetAgentModelOptions = {}): Promise<boolean> {
  if (!agentId || !model) return false;
  const base = options.base ?? daemonBase();
  const doFetch = options.fetchImpl ?? fetch;
  const requestId = `sck-realign-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const reply = await doFetch(`${base}${MCP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: requestId, method: 'tools/call',
        params: { name: 'update_agent', arguments: { agentId, settings: { model, ...(options.thinkingOptionId ? {thinkingOptionId:options.thinkingOptionId} : {}) } } },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!reply.ok) return false;
    return parseMcpReply(await reply.text()).ok;
  } catch {
    return false;
  }
}
