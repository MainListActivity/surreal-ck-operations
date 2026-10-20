import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaseoCli } from '../src/dispatcher/paseo.ts';

// SYS-DISP AC02 (R5): the adapter the tick reads Paseo through, checked against the shapes the local CLI really returns.
// `paseo ls -g --json` is an array of rows with a lowercase `status`; `paseo inspect <id> --json` is an object with capitalized
// `Status` and `Archived`. A fake CLI serves exactly those shapes (identifiers replaced, no session content). An idle session
// must read as idle through both paths, so the roster and the dispatcher cannot disagree about it.
const dir = mkdtempSync(join(tmpdir(), 'sck-paseo-contract-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const iso = '2026-10-20T01:00:00Z';
const lsRow = (id: string, status: string) => ({ id, shortId: id.slice(-5), name: id, provider: 'claude', thinking: 'medium', status, cwd: '/fixture/repo', created: iso });
const inspectRow = (id: string, status: string, archived: boolean) => ({
  Id: id, Name: id, Provider: 'claude', Model: 'fixture', Thinking: 'medium', Status: status, Archived: archived,
  ArchivedAt: archived ? iso : null, Mode: '', Cwd: '/fixture/repo', CreatedAt: iso, UpdatedAt: iso, LastUsage: null,
  Capabilities: {}, AvailableModes: [], PendingPermissions: [], Worktree: null, ParentAgentId: null,
});

writeFileSync(join(dir, 'ls.json'), JSON.stringify([lsRow('agent-idle-1', 'idle'), lsRow('agent-run-1', 'running'), lsRow('agent-closed-1', 'closed')]));
for (const body of [inspectRow('agent-idle-1', 'idle', false), inspectRow('agent-run-1', 'running', false), inspectRow('agent-archived-1', 'idle', true)]) {
  writeFileSync(join(dir, `inspect-${body.Id}.json`), JSON.stringify(body));
}
const bin = join(dir, 'paseo');
writeFileSync(bin, `#!/bin/sh
case "$1" in
  ls) cat "${dir}/ls.json" ;;
  inspect)
    if [ -f "${dir}/inspect-$2.json" ]; then cat "${dir}/inspect-$2.json"; else echo "agent not found" >&2; exit 1; fi ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`);
chmodSync(bin, 0o755);
const paseo = createPaseoCli(bin);

test('the list the tick reads keeps the real statuses: idle stays idle, running stays running, closed is not idle', async () => {
  const rows = await paseo.list();
  expect(rows.get('agent-idle-1')?.status).toBe('idle');
  expect(rows.get('agent-run-1')?.status).toBe('running');
  expect(rows.get('agent-closed-1')?.status).toBe('closed');
  // Archived sessions leave the list, so the tick falls back to the per-agent read for them.
  expect(rows.has('agent-archived-1')).toBe(false);
});

test('the per-agent fallback reads the real inspect shape and agrees with the list for the same idle session', async () => {
  expect(await paseo.status('agent-idle-1')).toEqual({ status: 'idle', pendingPermissions: 0 });
  expect((await paseo.list()).get('agent-idle-1')?.status).toBe('idle');
  expect(await paseo.status('agent-run-1')).toEqual({ status: 'running', pendingPermissions: 0 });
});

test('an archived session reports archived through the fallback, whatever its last status says', async () => {
  expect((await paseo.status('agent-archived-1'))?.status).toBe('archived');
});

test('an agent the CLI does not know reads as undefined, never as idle', async () => {
  expect(await paseo.status('agent-unknown-1')).toBeUndefined();
});
