#!/usr/bin/env bun
// SYS-DISP first-switch preflight (843d4e75 R2). A gm runs this on the live task service; engineering never does.
//
//   bun scripts/maintenance-preflight.ts                 # capability only (the window is reported, not acted on)
//   bun scripts/maintenance-preflight.ts --window --deployment '<json>' --extras '<json>'
//
// Reads only what a gm can already read:
//   sck call get_admin_summary '{}'                       full-company counts + integrity, one transaction
//   sck call get_context '{"pageSize":100,"fields":[…]}'  fixed-snapshot task pages until page.hasMore is false
// It never pauses dispatch, installs, reloads or writes; a non-zero exit means "do not open the window".
import { evaluatePreflight, PREFLIGHT_FIELDS, type AdminSummaryView, type DeploymentLease, type PageView, type WindowExtras } from '../src/maintenance-preflight.ts';

const SCK = process.env.SCK_BIN ?? '/Users/y/Library/Application Support/SurrealCKCompany/bin/sck';
const MAX_PAGES = 500;

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const parseJson = <T>(label: string, value: string | undefined): T | undefined => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value) as T; } catch (error) { throw new Error(`${label} is not valid JSON: ${(error as Error).message}`); }
};

async function sck(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const child = Bun.spawn([SCK, 'call', tool, JSON.stringify(args)], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`${tool} failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 400)}`);
  try { return JSON.parse(stdout) as Record<string, unknown>; } catch { throw new Error(`${tool} returned non-JSON output`); }
}

const summary = await sck('get_admin_summary', {}) as unknown as AdminSummaryView;
const pageSize = Number(argValue('--page-size') ?? 100);
const pages: PageView[] = [];
let cursor: string | undefined;
for (let index = 0; index < MAX_PAGES; index++) {
  const answer = await sck('get_context', { pageSize, fields: [...PREFLIGHT_FIELDS], ...(cursor === undefined ? {} : { cursor }) });
  const rows = Array.isArray(answer.tasks) ? answer.tasks as PageView['rows'] : undefined;
  const page = answer.page as { hasMore?: unknown; nextCursor?: unknown; total?: unknown; snapshotAt?: unknown } | undefined;
  if (!rows || !page || typeof page.hasMore !== 'boolean') throw new Error('get_context did not return the paged task shape');
  pages.push({
    rows, hasMore: page.hasMore,
    total: typeof page.total === 'number' ? page.total : undefined,
    snapshotAt: typeof page.snapshotAt === 'string' ? page.snapshotAt : undefined,
  });
  if (!page.hasMore) break;
  if (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0) throw new Error('page.hasMore is true but no nextCursor was issued');
  cursor = page.nextCursor;
}

const deployment = parseJson<DeploymentLease>('--deployment', argValue('--deployment'));
const extras = parseJson<WindowExtras>('--extras', argValue('--extras')) ?? { triageGoals: null, pendingEvals: null, gmAttention: null };
const now = argValue('--now') === undefined ? Date.now() : Date.parse(argValue('--now')!);
const nearExpirySeconds = argValue('--near-expiry') === undefined ? undefined : Number(argValue('--near-expiry'));
const verdict = evaluatePreflight({ summary, pages, extras, deployment, now, nearExpirySeconds });
const wantWindow = process.argv.includes('--window');
console.log(JSON.stringify({ mode: wantWindow ? 'window' : 'capability', verdict, pages: pages.length, rows: pages.reduce((sum, page) => sum + page.rows.length, 0) }, null, 2));
process.exit(verdict.capability.complete && (!wantWindow || verdict.window.allowed) ? 0 : 1);
