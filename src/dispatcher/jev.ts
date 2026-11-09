/**
 * Thin client for TypeSafe AI's Jev "System One" decision model.
 * One POST carries a state block plus typed questions (choice/score/noul);
 * answers come back with calibrated probabilities and per-answer confidence.
 * The client is injected into the dispatcher so tests can substitute a mock.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface JevQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  /** score: ordered level descriptions (2-10); choice: map of option key -> meaning. */
  criteria?: string[] | Record<string, string | null>;
}

export interface JevAnswer {
  type: 'choice' | 'score' | 'noul';
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
}

export interface JevClient {
  model: string;
  ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult>;
}

export interface JevConfig {
  /** Full endpoint URL; the hosted metered gateway uses a different path but the same payload shape. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export function createJevClient(cfg: JevConfig): JevClient {
  return {
    model: cfg.model,
    async ask(state, questions) {
      const response = await fetch(cfg.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, state, questions }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
      });
      const body = await response.json().catch(() => ({})) as { model?: string; answers?: Record<string, JevAnswer>; error?: { message?: string }; detail?: { error_type?: string } };
      if (!response.ok || !body.answers) {
        const code = typeof body.detail?.error_type === "string" && /^[a-z_]{1,80}$/.test(body.detail.error_type) ? body.detail.error_type : undefined;
        throw new Error(`jev request failed (${response.status}): ${code ?? body.error?.message ?? 'no answers'}`);
      }
      return { model: body.model ?? cfg.model, answers: body.answers };
    },
  };
}

/** Load Jev config from env (falling back to private/service.env); undefined disables the Jev path. */
export function jevFromEnv(env: NodeJS.ProcessEnv = process.env): JevClient | undefined {
  const file = readServiceEnv();
  const get = (name: string) => env[name] || file[name];
  const apiKey = get('JEV_API_KEY') ?? get('TYPESAFE_API_KEY');
  if (!apiKey) return undefined;
  return createJevClient({
    baseUrl: get('JEV_BASE_URL') ?? 'https://api.typesafe.ai/v1/systemone',
    apiKey,
    model: get('JEV_MODEL') ?? 'jev-1.13.0',
  });
}

function readServiceEnv(): Record<string, string> {
  const path = join(
    process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany'),
    'private/service.env');
  const values: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
  } catch { /* no service.env: process.env only */ }
  return values;
}
