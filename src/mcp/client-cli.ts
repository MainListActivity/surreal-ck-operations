import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, reqDir, resDir, writeFileAtomic, type CommResponse } from '../comm.ts';
import { connectCompanyClient } from './client';
import { readPrivateCredential } from './credential-file';

const [command, name, json] = Bun.argv.slice(2);
if (!['list', 'call'].includes(command ?? '')) throw new Error('usage: bun src/mcp/client-cli.ts list | call <tool> [json-arguments]');
if (command === 'call' && !name) throw new Error('tool name is required');

// Comm mode: the plugin sidecar owns the credential; the agent relays requests
// through its private comm directory and never sees any auth material.
const comm = process.env.SCK_COMM_DIR;
if (comm) {
  if (!process.env.SCK_COMM_KEY) {
    process.stderr.write('SCK_COMM_KEY is not set — comm requests cannot be authenticated; check the dispatch environment\n');
    process.exit(1);
  }
  const key = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  writeFileAtomic(join(reqDir(comm), `${key}.json`), JSON.stringify({
    key: process.env.SCK_COMM_KEY ?? '', tool: command === 'list' ? '__list__' : name!,
    args: json ? JSON.parse(json) : {},
  }));
  const resFile = join(resDir(comm), `${key}.json`);
  // Media generation runs upstream for minutes (music up to 300s); wait past the studio's own timeout.
  const waitMs = name === 'media_music' || name === 'media_voice_design' ? 330_000 : name?.startsWith('media_') ? 150_000 : 120_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const res = readJsonFile<CommResponse>(resFile);
    if (res) {
      try { unlinkSync(resFile); } catch { /* consumed race */ }
      if (!res.ok) { process.stderr.write(`${res.error ?? 'comm request failed'}\n`); process.exit(1); }
      process.stdout.write(`${JSON.stringify(res.data ?? null)}\n`);
      process.exit(0);
    }
    if (Date.now() > deadline) { process.stderr.write('comm request timed out\n'); process.exit(1); }
    await Bun.sleep(200);
  }
}

const url = process.env.SCK_MCP_URL;
const credential = process.env.SCK_EMPLOYEE_CREDENTIAL_FILE
  ? await readPrivateCredential(process.env.SCK_EMPLOYEE_CREDENTIAL_FILE)
  : process.env.SCK_EMPLOYEE_CREDENTIAL ?? '';

if (!url) throw new Error('SCK_MCP_URL is required');
if (!credential) throw new Error('SCK_EMPLOYEE_CREDENTIAL_FILE or SCK_EMPLOYEE_CREDENTIAL is required');

const connection = await connectCompanyClient({
  url: new URL(url), credential, clientName: 'sck-employee-cli',
  gateToken: process.env.SCK_MCP_TOKEN || undefined,
});
try {
  const result = command === 'list'
    ? await connection.client.listTools()
    : await connection.client.callTool({ name: name!, arguments: json ? JSON.parse(json) : {} });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await connection.close();
}
