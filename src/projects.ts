import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { RecordId, type Surreal } from 'surrealdb';
import { ROLES, type ProjectView, type Role } from './contracts.ts';
import { CompanyError } from './core-errors.ts';
import { isPipeline } from './flows.ts';

import { parseBrokerConfig } from './ops/config.ts';
import { projectTextLengths, validateProjectTexts, type ProjectTextLengths } from './input-bounds.ts';

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
  /** Project discipline-track vocabulary (e.g. 编剧/角色设计/分镜) with optional per-track notes. */
  disciplines?: Array<{ name: string; description?: string; roles?: Role[] }>;
  /** Default production line for goals of this project: software (default), video or story. */
  pipeline?: string;
  runbooks?: string[];
  notes?: string;
  /** `broker` is the non-secret ops-broker configuration (see src/ops/config.ts); it is never part of ProjectView. */
  envs: Array<{ name: string; url?: string; healthUrl?: string; verify?: string; broker?: Record<string, unknown> }>;
}

interface ProjectRow {
  id: RecordId; name: string; repo_path: string; default_branch?: string; release: string; rollback?: string;
  red_lines: string[]; disciplines?: Array<{ name: string; description?: string; roles?: Role[] }>; pipeline?: string; runbooks?: string[]; notes?: string;
}
interface EnvRow { id: RecordId; name: string; url?: string; health_url?: string; verify?: string; broker?: unknown }
export interface EnvBrokerRow { name: string; url?: string; healthUrl?: string; broker?: unknown }

const PROJECT_ID = /^[a-z][a-z0-9_-]{0,40}$/;
const secretAad = (project: string, env: string, name: string) => `${project}\0${env}\0${name}`;

/** disciplines vocabulary rule shared by upsert and setDisciplines: unique non-empty names. */
function assertDisciplines(disciplines?: Array<{ name: string; description?: string; roles?: Role[] }>): void {
  const names = (disciplines ?? []).map(d => d?.name);
  if (names.some(n => typeof n !== 'string' || !n.trim()) || new Set(names).size !== names.length) {
    throw new CompanyError('invalid', 'disciplines must be unique non-empty track names');
  }
  for (const d of disciplines ?? []) {
    if (d.roles !== undefined && (!Array.isArray(d.roles) || d.roles.some(r => !ROLES.includes(r)))) {
      throw new CompanyError('invalid', `track ${d.name}: roles must be a list of known roles`);
    }
  }
}

/** Project environments and their sealed credentials. Values never leave this module except via readSealed, which only the ops broker calls. */
export class ProjectStore {
  constructor(private readonly db: Surreal) {}

  async upsert(input: ProjectInput): Promise<ProjectView> {
    if (!PROJECT_ID.test(input.id)) throw new CompanyError('invalid', 'project id must match [a-z][a-z0-9_-]*');
    // Read-only compatibility basis: an unchanged pre-limit over-size field may be preserved, but
    // any field this write changes must satisfy the new limits. Validate before the project row or
    // any environment row is touched.
    const existing = await this.get(input.id);
    validateProjectTexts(input, existing ?? undefined);
    assertDisciplines(input.disciplines);
    if (input.pipeline !== undefined && !isPipeline(input.pipeline)) throw new CompanyError('invalid', 'pipeline must be software, video or story');
    const project = new RecordId('project', input.id);
    await this.db.query(`UPSERT $project CONTENT {
        name: $p.name, repo_path: $p.repoPath, default_branch: $p.defaultBranch ?? 'main', release: $p.release,
        rollback: $p.rollback, red_lines: $p.redLines ?? [], disciplines: $p.disciplines, pipeline: $p.pipeline, runbooks: $p.runbooks ?? [], notes: $p.notes, updated_at: time::now() };`,
    { project, p: input });
    for (const { broker, ...env } of input.envs) {
      await this.db.query(`INSERT INTO project_env { project: $project, name: $e.name, url: $e.url, health_url: $e.healthUrl, verify: $e.verify }
        ON DUPLICATE KEY UPDATE url = $input.url, health_url = $input.health_url, verify = $input.verify;`, { project, e: env });
      // Omitted broker config is left alone so re-running `project set` never wipes it; `project broker` owns it.
      if (broker !== undefined) await this.setBroker(input.id, env.name, broker);
    }
    return (await this.get(input.id))!;
  }

  /** Rewrites only the disciplines vocabulary (unique non-empty names); other project fields stay untouched. */
  async setDisciplines(projectId: string, disciplines: Array<{ name: string; description?: string; roles?: Role[] }>): Promise<ProjectView> {
    if (!PROJECT_ID.test(projectId)) throw new CompanyError('invalid', 'project id must match [a-z][a-z0-9_-]*');
    assertDisciplines(disciplines);
    const project = new RecordId('project', projectId);
    if (!(await this.db.select<ProjectRow>(project))) throw new CompanyError('not_found', 'project not found');
    await this.db.query('UPDATE $project SET disciplines = $d, updated_at = time::now();', { project, d: disciplines });
    return (await this.get(projectId))!;
  }

  /** Stores the non-secret ops broker settings of one environment after checking they parse. */
  async setBroker(project: string, envName: string, broker: unknown): Promise<void> {
    parseBrokerConfig(broker);
    await this.db.query('UPDATE $env SET broker = $broker;', { env: await this.envId(project, envName), broker });
  }

  async list(): Promise<ProjectView[]> {
    const [rows] = await this.db.query<[ProjectRow[]]>('SELECT * FROM project ORDER BY id;');
    return Promise.all(rows.map(row => this.view(row)));
  }

  /** Distinct non-empty registered project repo_path values (raw stored form). */
  async allRepoPaths(): Promise<string[]> {
    const [rows] = await this.db.query<[Array<{ repo_path?: string }>]>(
      'SELECT repo_path FROM project WHERE repo_path != NONE ORDER BY repo_path;');
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows ?? []) {
      const p = typeof r.repo_path === 'string' ? r.repo_path.trim() : '';
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    }
    return out;
  }

  async get(projectId: string): Promise<ProjectView | undefined> {
    const row = await this.db.select<ProjectRow>(new RecordId('project', projectId));
    return row ? this.view(row) : undefined;
  }

  /** Read-only length diagnostic: field names, counts and UTF-8 bytes; never the text or credentials. */
  async textLengths(projectId: string): Promise<ProjectTextLengths | undefined> {
    if (!PROJECT_ID.test(projectId)) throw new CompanyError('invalid', 'project id must match [a-z][a-z0-9_-]*');
    const row = await this.db.select<ProjectRow>(new RecordId('project', projectId));
    if (!row) return undefined;
    return projectTextLengths({
      release: row.release, rollback: row.rollback, notes: row.notes, runbooks: row.runbooks ?? [],
    });
  }

  /** Dry-run `project check`: run the same pure validation as upsert, without any write. */
  async checkInput(input: ProjectInput): Promise<{ ok: true; lengths: ProjectTextLengths }> {
    if (!PROJECT_ID.test(input.id)) throw new CompanyError('invalid', 'project id must match [a-z][a-z0-9_-]*');
    const existing = await this.get(input.id);
    validateProjectTexts(input, existing ?? undefined);
    return { ok: true, lengths: projectTextLengths(input) };
  }

  private async view(row: ProjectRow): Promise<ProjectView> {
    const [envs, secrets] = await this.db.query<[EnvRow[], Array<{ env: string; name: string; roles: string[] }>]>(
      `SELECT * FROM project_env WHERE project = $project ORDER BY name;
       SELECT env.name AS env, name, roles FROM env_secret WHERE env.project = $project ORDER BY name;`, { project: row.id });
    return {
      id: String(row.id.id), name: row.name, repoPath: row.repo_path, defaultBranch: row.default_branch ?? 'main',
      release: row.release, rollback: row.rollback, redLines: row.red_lines ?? [],
      disciplines: row.disciplines?.map(d => ({ name: d.name, description: d.description, roles: d.roles })),
      pipeline: row.pipeline,
      runbooks: row.runbooks ?? [], notes: row.notes,
      envs: envs.map(e => ({
        name: e.name, url: e.url, healthUrl: e.health_url, verify: e.verify,
        secrets: secrets.filter(s => s.env === e.name).map(s => ({ name: s.name, roles: s.roles as Role[] })),
      })),
    };
  }

  /**
   * Seals a credential. Employees never read env_secret rows: only trusted control-plane code
   * (the ops broker) opens them. `roles` is kept as an inventory label for legacy rows.
   */
  async setSecret(input: { project: string; env: string; name: string; value: string; roles?: Role[]; purpose?: string }, key: Buffer): Promise<void> {
    if (!input.value) throw new CompanyError('invalid', 'secret value is empty');
    const env = await this.envId(input.project, input.env);
    const sealed = sealSecret(key, input.value, secretAad(input.project, input.env, input.name));
    await this.db.query(`INSERT INTO env_secret { env: $env, name: $name, roles: $roles, purpose: $purpose,
        ciphertext: $s.ciphertext, iv: $s.iv, tag: $s.tag, updated_at: time::now() }
      ON DUPLICATE KEY UPDATE roles = $input.roles, purpose = $input.purpose, ciphertext = $input.ciphertext,
        iv = $input.iv, tag = $input.tag, updated_at = time::now();`,
    { env, name: input.name, roles: input.roles ?? [], purpose: input.purpose, s: sealed });
  }

  /** Concurrent issuer initialization never overwrites an existing sealed key. Trusted broker only. */
  async ensureSealed(project: string, envName: string, name: string, create: () => string, key: Buffer): Promise<string> {
    const existing = await this.readSealed(project, envName, name, key);
    if (existing) return existing;
    const env = await this.envId(project, envName);
    const sealed = sealSecret(key, create(), secretAad(project, envName, name));
    await this.db.query(`INSERT INTO env_secret { env: $env, name: $name, roles: [], purpose: "internal AI proof signing", ciphertext: $s.ciphertext, iv: $s.iv, tag: $s.tag, updated_at: time::now() }
      ON DUPLICATE KEY UPDATE name = $input.name;`, { env, name, s: sealed });
    const value = await this.readSealed(project, envName, name, key);
    if (!value) throw new CompanyError('temporarily_unavailable', 'issuer key unavailable');
    return value;
  }

  /** Compare-and-swap rotation; approval and old key identity are checked by the trusted issuer. */
  async rotateSealed(project: string, envName: string, name: string, expected: string, replacement: string, key: Buffer): Promise<void> {
    const env = await this.envId(project, envName);
    const [rows] = await this.db.query<[Array<{ ciphertext: string; iv: string; tag: string }>]>(
      'SELECT ciphertext, iv, tag FROM env_secret WHERE env = $env AND name = $name LIMIT 1;', { env, name });
    const prior = rows[0];
    if (!prior || openSecret(key, prior, secretAad(project, envName, name)) !== expected) throw new CompanyError('conflict', 'issuer key changed');
    const next = sealSecret(key, replacement, secretAad(project, envName, name));
    const [changed] = await this.db.query<[unknown[]]>(
      'UPDATE env_secret SET ciphertext = $s.ciphertext, iv = $s.iv, tag = $s.tag, updated_at = time::now() WHERE env = $env AND name = $name AND ciphertext = $old.ciphertext AND tag = $old.tag RETURN AFTER;', { env, name, old: prior, s: next });
    if (changed.length !== 1) throw new CompanyError('conflict', 'issuer key changed');
  }

  /** Decrypts one secret; undefined when it was never sealed. Trusted callers only. */
  async readSealed(project: string, envName: string, name: string, key: Buffer): Promise<string | undefined> {
    const env = await this.envId(project, envName);
    const [rows] = await this.db.query<[Array<{ ciphertext: string; iv: string; tag: string }>]>(
      'SELECT ciphertext, iv, tag FROM env_secret WHERE env = $env AND name = $name LIMIT 1;', { env, name });
    const row = rows[0];
    return row ? openSecret(key, row, secretAad(project, envName, name)) : undefined;
  }

  /** Raw environment rows including the broker config; for trusted control-plane code only. */
  async brokerEnvs(project: string): Promise<EnvBrokerRow[]> {
    const [rows] = await this.db.query<[EnvRow[]]>(
      'SELECT * FROM project_env WHERE project = $project ORDER BY name;', { project: new RecordId('project', project) });
    return rows.map(row => ({ name: row.name, url: row.url, healthUrl: row.health_url, broker: row.broker }));
  }

  /** Names of sealed credentials in one environment (no values). */
  async sealedNames(project: string, envName: string): Promise<string[]> {
    const env = await this.envId(project, envName);
    const [rows] = await this.db.query<[Array<{ name: string }>]>('SELECT name FROM env_secret WHERE env = $env ORDER BY name;', { env });
    return rows.map(row => row.name);
  }

  private async envId(project: string, env: string): Promise<RecordId> {
    const [rows] = await this.db.query<[Array<{ id: RecordId }>]>(
      'SELECT id FROM project_env WHERE project = $project AND name = $name LIMIT 1;', { project: new RecordId('project', project), name: env });
    if (!rows[0]) throw new CompanyError('not_found', `environment ${project}/${env} not found`);
    return rows[0].id;
  }
}
