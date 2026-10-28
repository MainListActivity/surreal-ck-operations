import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

/** Positive identities survive reloads; a cache miss still asks the authoritative employee registry. */
export function employeeSessionLookup(lookup: (agentId: string) => Promise<boolean>, file?: string) {
  const employees = new Set<string>();
  if (file) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') employees.add(id);
    } catch { /* A missing/corrupt cache is not an authoritative negative; query the registry below. */ }
  }
  const remember = (agentId: string) => {
    if (employees.has(agentId)) return;
    employees.add(agentId);
    if (file) {
      mkdirSync(dirname(file), {recursive:true, mode:0o700});
      writeFileSync(file+'.tmp', JSON.stringify([...employees]), {mode:0o600});
      renameSync(file+'.tmp', file);
    }
  };
  const identify = async (agentId: string): Promise<boolean> => {
    if (employees.has(agentId)) return true;
    const employee = await lookup(agentId); // Unavailable is not the same as an authoritative negative.
    if (employee) remember(agentId);
    return employee;
  };
  return Object.assign(identify, {remember});
}
