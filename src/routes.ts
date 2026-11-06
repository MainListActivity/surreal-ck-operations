import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';
import { ROLES, type ReviewerRole, type Role } from './contracts.ts';

/** One row of the `route` table: the type's executor/reviewer roles, message templates and optional next type. */
export interface RouteRow {
  type: string;
  label: string;
  executor_role: Role;
  reviewer_role: ReviewerRole;
  code: boolean;
  execute_body?: string;
  review_body?: string;
  next?: string;
  hold: boolean;
  enabled: boolean;
}

export const CHAIN_LIMIT = 10;

const ROLE_SET = new Set<string>([...ROLES, 'owner']);

const invalid = (message: string): CompanyError => new CompanyError('invalid', message);

function rowOf(id: RecordId, row: Record<string, unknown>): RouteRow {
  return {
    type: String(id.id), label: String(row.label ?? ''),
    executor_role: String(row.executor_role) as Role, reviewer_role: String(row.reviewer_role) as ReviewerRole,
    code: row.code === true, execute_body: row.execute_body as string | undefined, review_body: row.review_body as string | undefined,
    next: row.next == null ? undefined : String(row.next), hold: row.hold === true, enabled: row.enabled !== false,
  };
}

export async function getRoute(db: Surreal, type: string): Promise<RouteRow | undefined> {
  const row = await db.select<Record<string, unknown>>(new RecordId('route', type));
  return row ? rowOf(new RecordId('route', type), row) : undefined;
}

export async function listRoutes(db: Surreal): Promise<RouteRow[]> {
  const [rows] = await db.query<[Array<{ id: RecordId } & Record<string, unknown>>]>('SELECT * FROM route ORDER BY id;');
  return (rows ?? []).map(row => rowOf(row.id, row));
}

/**
 * Validates a route save: the two roles differ and are known; `next`, when given, points at an enabled route whose
 * type is not this one; following `next` from the saved row never returns to it (cycle) and never runs past CHAIN_LIMIT.
 */
export async function validateRoute(db: Surreal, input: RouteRow): Promise<void> {
  if (!input.type || input.type.length > 40 || !/^[a-z][a-z0-9-]*$/.test(input.type)) throw invalid(`route type ${input.type} 非法`);
  if (!input.label) throw invalid('route label 不能为空');
  if (input.executor_role === input.reviewer_role) throw invalid(`route ${input.type}：执行与复核不能同岗`);
  if (!ROLE_SET.has(input.executor_role)) throw invalid(`route ${input.type}：未知执行岗 ${input.executor_role}`);
  if (!ROLE_SET.has(input.reviewer_role)) throw invalid(`route ${input.type}：未知复核岗 ${input.reviewer_role}`);
  if (input.next !== undefined) {
    const target = await getRoute(db, input.next);
    if (!target || !target.enabled) throw invalid(`route ${input.type}：next ${input.next} 未启用或不存在`);
    // Cycle check: follow the chain from next, as if the new edge already existed.
    let cursor: string | undefined = input.next;
    const seen = new Set<string>([input.type]);
    for (let depth = 0; cursor !== undefined; depth++) {
      if (depth >= CHAIN_LIMIT) throw invalid(`route ${input.type}：next 链超过 ${CHAIN_LIMIT} 步`);
      if (seen.has(cursor)) throw invalid(`route ${input.type}：next 链回到 ${cursor}，成环`);
      seen.add(cursor);
      cursor = (await getRoute(db, cursor))?.next;
    }
  }
}

export async function saveRoute(db: Surreal, input: RouteRow, by: string): Promise<RouteRow> {
  await validateRoute(db, input);
  await db.query('UPSERT ONLY $r CONTENT { label: $label, executor_role: $ex, reviewer_role: $rev, code: $code, execute_body: $eb, review_body: $rb, next: $next, hold: $hold, enabled: true, updated_at: time::now(), updated_by: $by };',
    { r: new RecordId('route', input.type), label: input.label, ex: input.executor_role, rev: input.reviewer_role,
      code: input.code, eb: input.execute_body, rb: input.review_body, next: input.next,
      hold: input.hold === true, by });
  return (await getRoute(db, input.type))!;
}

/** Disables a route; tasks already created keep their recorded roles, new creates of the type are refused. */
export async function disableRoute(db: Surreal, type: string, by: string): Promise<void> {
  const row = await db.select(new RecordId('route', type));
  if (!row) throw new CompanyError('not_found', `route ${type} 不存在`);
  const dependents = (await listRoutes(db)).filter(r => r.enabled && r.next === type);
  if (dependents.length) throw invalid(`route ${type} 仍被 ${dependents.map(d => d.type).join('、')} 的 next 引用`);
  await db.query('UPDATE $r SET enabled = false, updated_at = time::now(), updated_by = $by;', { r: new RecordId('route', type), by });
}
