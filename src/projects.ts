import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { RecordId, type Surreal } from 'surrealdb';
import type { ProjectView, Role } from './contracts.ts';
import { CompanyError } from './core-errors.ts';

const KEYCHAIN_SERVICE = 'surreal-ck-company';
const KEYCHAIN_ACCOUNT = 'env-secret-key';

/**
 * AES-256-GCM key for env_secret values. Tests and CI pass SCK_SECRET_KEY (base64, 32 bytes);
 * the installed company reads it from the login keychain, creating it on first use.
 */
export function loadSecretKey(create = false): Buffer {
  const fromEnv = process.env.SCK_SECRET_KEY;
  if (fromEnv) return checked(Buffer.from(fromEnv, 'base64'));
  const read = () => execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return checked(Buffer.from(read(), 'base64'));
  } catch (error) {
    if (!create) throw new CompanyError('temporarily_unavailable', 'secret key is not available in the keychain');
    const key = randomBytes(32).toString('base64');
    execFileSync('security', ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', key, '-U'], { stdio: 'ignore' });
    return checked(Buffer.from(read(), 'base64'));
  }
}

function checked(key: Buffer): Buffer {
  if (key.length !== 32) throw new CompanyError('invalid', 'secret key must be 32 bytes');
  return key;
}

export function sealSecret(key: Buffer, value: string, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function openSecret(key: Buffer, sealed: { ciphertext: string; iv: string; tag: string }, aad: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64')).setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export interface ProjectInput {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch?: string;
  release: string;
  rollback?: string;
  redLines?: string[];
  runbooks?: string[];
  notes?: string;
  envs: Array<{ name: string; url?: string; healthUrl?: string; verify?: string }>;
}

interface ProjectRow {
  id: RecordId; name: string; repo_path: string; default_branch?: string; release: string; rollback?: string;
  red_lines: string[]; runbooks?: string[]; notes?: string;
}
interface EnvRow { id: RecordId; name: string; url?: string; health_url?: string; verify?: string }

const PROJECT_ID = /^[a-z][a-z0-9_-]{0,40}$/;
const secretAad = (project: string, env: string, name: string) => `${project}\0${env}\0${name}`;

/** Project environments and their sealed credentials. Values never leave this module except via readSecret. */
export class ProjectStore {
  constructor(private readonly db: Surreal) {}

  async upsert(input: ProjectInput): Promise<ProjectView> {
    if (!PROJECT_ID.test(input.id)) throw new CompanyError('invalid', 'project id must match [a-z][a-z0-9_-]*');
    const project = new RecordId('project', input.id);
    await this.db.query(`UPSERT $project CONTENT {
        name: $p.name, repo_path: $p.repoPath, default_branch: $p.defaultBranch ?? 'main', release: $p.release,
        rollback: $p.rollback, red_lines: $p.redLines ?? [], runbooks: $p.runbooks ?? [], notes: $p.notes, updated_at: time::now() };`,
    { project, p: input });
    for (const env of input.envs) {
      await this.db.query(`INSERT INTO project_env { project: $project, name: $e.name, url: $e.url, health_url: $e.healthUrl, verify: $e.verify }
        ON DUPLICATE KEY UPDATE url = $input.url, health_url = $input.health_url, verify = $input.verify;`, { project, e: env });
    }
    return (await this.get(input.id))!;
  }

  async list(): Promise<ProjectView[]> {
    const [rows] = await this.db.query<[ProjectRow[]]>('SELECT * FROM project ORDER BY id;');
    return Promise.all(rows.map(row => this.view(row)));
  }

  async get(projectId: string): Promise<ProjectView | undefined> {
    const row = await this.db.select<ProjectRow>(new RecordId('project', projectId));
    return row ? this.view(row) : undefined;
  }

  private async view(row: ProjectRow): Promise<ProjectView> {
    const [envs, secrets] = await this.db.query<[EnvRow[], Array<{ env: string; name: string; roles: string[] }>]>(
      `SELECT * FROM project_env WHERE project = $project ORDER BY name;
       SELECT env.name AS env, name, roles FROM env_secret WHERE env.project = $project ORDER BY name;`, { project: row.id });
    return {
      id: String(row.id.id), name: row.name, repoPath: row.repo_path, defaultBranch: row.default_branch ?? 'main',
      release: row.release, rollback: row.rollback, redLines: row.red_lines ?? [], runbooks: row.runbooks ?? [], notes: row.notes,
      envs: envs.map(e => ({
        name: e.name, url: e.url, healthUrl: e.health_url, verify: e.verify,
        secrets: secrets.filter(s => s.env === e.name).map(s => ({ name: s.name, roles: s.roles as Role[] })),
      })),
    };
  }

  async setSecret(input: { project: string; env: string; name: string; value: string; roles: Role[]; purpose?: string }, key: Buffer): Promise<void> {
    if (!input.value) throw new CompanyError('invalid', 'secret value is empty');
    const env = await this.envId(input.project, input.env);
    const sealed = sealSecret(key, input.value, secretAad(input.project, input.env, input.name));
    await this.db.query(`INSERT INTO env_secret { env: $env, name: $name, roles: $roles, purpose: $purpose,
        ciphertext: $s.ciphertext, iv: $s.iv, tag: $s.tag, updated_at: time::now() }
      ON DUPLICATE KEY UPDATE roles = $input.roles, purpose = $input.purpose, ciphertext = $input.ciphertext,
        iv = $input.iv, tag = $input.tag, updated_at = time::now();`,
    { env, name: input.name, roles: input.roles, purpose: input.purpose, s: sealed });
  }

  /** Decrypts one secret. Callers must have authorized the reader for this project and role. */
  async readSecret(project: string, envName: string, name: string, role: Role, key: Buffer): Promise<string> {
    const env = await this.envId(project, envName);
    const [rows] = await this.db.query<[Array<{ roles: string[]; ciphertext: string; iv: string; tag: string }>]>(
      'SELECT roles, ciphertext, iv, tag FROM env_secret WHERE env = $env AND name = $name LIMIT 1;', { env, name });
    const row = rows[0];
    if (!row) throw new CompanyError('not_found', `secret ${project}/${envName}/${name} not found`);
    if (!row.roles.includes(role)) throw new CompanyError('forbidden', `role ${role} may not read ${name}`);
    return openSecret(key, row, secretAad(project, envName, name));
  }

  private async envId(project: string, env: string): Promise<RecordId> {
    const [rows] = await this.db.query<[Array<{ id: RecordId }>]>(
      'SELECT id FROM project_env WHERE project = $project AND name = $name LIMIT 1;', { project: new RecordId('project', project), name: env });
    if (!rows[0]) throw new CompanyError('not_found', `environment ${project}/${env} not found`);
    return rows[0].id;
  }
}
