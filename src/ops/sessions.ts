import { randomBytes } from 'node:crypto';
import { CompanyError } from '../core-errors.ts';

export interface OpsSession {
  id: string;
  employeeId: string;
  project: string;
  env: string;
  alias: string;
  username: string;
  /** Held in broker memory only; never serialised into any response. */
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  workspace?: { slug: string; dbName: string };
  createdAt: number;
}

const MAX_PER_EMPLOYEE = 8;
const MAX_AGE_MS = 6 * 60 * 60_000;

/** Login sessions the broker holds on behalf of employees. The handle is the only thing an employee ever sees. */
export class SessionStore {
  private readonly sessions = new Map<string, OpsSession>();

  constructor(private readonly now: () => number = Date.now) {}

  create(input: Omit<OpsSession, 'id' | 'createdAt'>): OpsSession {
    this.prune();
    const mine = [...this.sessions.values()].filter(s => s.employeeId === input.employeeId).sort((a, b) => a.createdAt - b.createdAt);
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_PER_EMPLOYEE + 1))) this.sessions.delete(old.id);
    const session: OpsSession = { ...input, id: `s_${randomBytes(8).toString('hex')}`, createdAt: this.now() };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Sessions are private to the employee (instance) that opened them and to one project environment. */
  get(handle: unknown, employeeId: string, project: string, env: string): OpsSession {
    const session = typeof handle === 'string' ? this.sessions.get(handle) : undefined;
    if (!session || session.employeeId !== employeeId || session.project !== project || session.env !== env) {
      throw new CompanyError('not_found', 'unknown session; call ops_login first');
    }
    if (this.now() - session.createdAt > MAX_AGE_MS) {
      this.sessions.delete(session.id);
      throw new CompanyError('not_found', 'session expired; call ops_login again');
    }
    return session;
  }

  drop(handle: string): void { this.sessions.delete(handle); }

  dropEmployee(employeeId: string): void {
    for (const session of [...this.sessions.values()]) if (session.employeeId === employeeId) this.sessions.delete(session.id);
  }

  /** Every live token, for scrubbing it out of any text that might echo it. */
  secrets(employeeId: string): string[] {
    return [...this.sessions.values()].filter(s => s.employeeId === employeeId).map(s => s.token);
  }

  private prune(): void {
    const cutoff = this.now() - MAX_AGE_MS;
    for (const session of [...this.sessions.values()]) if (session.createdAt < cutoff) this.sessions.delete(session.id);
  }
}
