import { CompanyError } from './core-errors.ts';

/** Track name -> executor roles allowed to carry it (undefined/empty = unrestricted), from project.disciplines. */
export type DisciplineContract = Map<string, readonly string[] | undefined>;

/**
 * Role/track contract of a project: a track that lists `roles` may only be carried by those roles,
 * and a role listed by any track is a line role that must always say which track it works on.
 * Roles listed nowhere (gm, product, qa…) stay free to create untracked coordination tasks.
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
