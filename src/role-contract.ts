import { RecordId, type Surreal } from 'surrealdb';
import { CompanyError } from './core-errors.ts';

/** Track name -> executor roles allowed to carry it (undefined/empty = unrestricted), from project.disciplines. */
export type DisciplineContract = Map<string, readonly string[] | undefined>;

/**
 * Role/track contract of a project: a track that lists `roles` may only be carried by those roles,
 * and a role listed by any track is a line role that must always say which track it works on.
 * Roles listed nowhere (owner, product, qa…) stay free to create untracked coordination tasks.
 */
export function assertRoleContract(contract: DisciplineContract | undefined, role: string, discipline?: string): void {
  if (!contract) return;
  if (discipline !== undefined) {
    const allowed = contract.get(discipline);
    if (allowed?.length && !allowed.includes(role)) {
      throw new CompanyError('invalid', `track ${discipline} may only be carried by ${allowed.join('、')}; ${role} cannot take it`);
    }
    return;
  }
  const tracks = [...contract].filter(([, roles]) => roles?.includes(role)).map(([name]) => name);
  if (tracks.length) throw new CompanyError('invalid', `role ${role} is a line role in this project and must set discipline to one of: ${tracks.join('、')}`);
}

/** The contract of the project a task would belong to: the explicit project, else the goal's project. */
export async function loadContract(db: Surreal, goalId?: string, projectId?: string): Promise<DisciplineContract | undefined> {
  type Raw = { disciplines?: Array<{ name?: string; roles?: string[] }> };
  let raw: Raw | undefined;
  if (projectId) [[raw]] = await db.query<[Raw[]]>('SELECT disciplines AS disciplines FROM $project;', { project: new RecordId('project', projectId) });
  else if (goalId) [[raw]] = await db.query<[Raw[]]>('SELECT project.disciplines AS disciplines FROM $goal;', { goal: new RecordId('goal', goalId) });
  const entries = (raw?.disciplines ?? []).filter((d): d is { name: string; roles?: string[] } => typeof d?.name === 'string' && d.name.length > 0);
  return entries.length ? new Map(entries.map(d => [d.name, d.roles])) : undefined;
}
