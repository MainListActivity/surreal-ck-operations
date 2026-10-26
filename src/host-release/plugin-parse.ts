/**
 * Parse `paseo plugin ls sck-company --json` without the apply.sh stdin/heredoc trap (F0).
 * Pure: takes a JSON string, returns the binding fields. Used by apply.sh (via -c) and unit tests.
 */

export interface PaseoPluginBinding {
  source: string;
  directory: string;
  status: string;
  enabled: boolean;
  sourceKnown: true;
}

export function parsePaseoPluginJson(raw: string): PaseoPluginBinding {
  const rows = JSON.parse(raw) as Array<{
    path?: string;
    status?: string;
    enabled?: boolean;
    installation?: { identity?: { path?: string } };
  }>;
  if (!Array.isArray(rows)) throw new Error('paseo plugin ls JSON must be an array');
  const row = rows[0] ?? {};
  const source = (row.installation?.identity?.path) || '';
  const directory = row.path || '';
  return {
    source,
    directory,
    status: row.status || '',
    enabled: Boolean(row.enabled),
    sourceKnown: true,
  };
}
