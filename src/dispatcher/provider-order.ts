/** Factory runs its native agent first; this orders only candidates already admitted by staffing rules. */
export const FACTORY_PROVIDER = 'factory-droid';
export function factoryFirst<T extends {provider?: string}>(rows: readonly T[]): T[] {
  return [...rows].sort((a,b)=>Number(b.provider===FACTORY_PROVIDER)-Number(a.provider===FACTORY_PROVIDER));
}
