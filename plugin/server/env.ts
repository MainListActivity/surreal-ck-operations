import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const serviceHome = () =>
  process.env.SCK_SERVICE_HOME ?? join(homedir(), "Library/Application Support/SurrealCKCompany");

/** Fill process.env from private/service.env (the launchd services get it via run.sh; we get it here). */
export function loadServiceEnv(): void {
  try {
    for (const line of readFileSync(join(serviceHome(), "private/service.env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  } catch (error) {
    console.warn(`[sck-company] service.env not loaded: ${(error as Error).message}`);
  }
}
