import { resolve } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from '../config';
import { SurrealCompanyCore } from '../core';
import { CompanyDatabase } from '../database';
import { readPrivateCredential } from './credential-file';
import { createGhCliGateway, createGithubProjector } from './github-projector';
import { runProjectionWorker } from './projector-worker';
import { createMcpHttpService } from './server';

const rawPort = process.env.SCK_MCP_PORT;
if (!rawPort || !/^[0-9]+$/.test(rawPort)) throw new Error('SCK_MCP_PORT is required');
const port = Number(rawPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid SCK_MCP_PORT');

const db = new CompanyDatabase(loadDatabaseConfig());
await db.connect();
let service: ReturnType<typeof createMcpHttpService> | undefined;
const shutdown = new AbortController();
try {
  // A wedged bootstrap must not leave a silent idle process; fail and let launchd retry.
  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.bootstrap(),
      new Promise<never>((_, reject) => {
        bootTimer = setTimeout(() => reject(new Error('bootstrap timed out after 90s')), 90_000);
      }),
    ]);
  } finally {
    clearTimeout(bootTimer);
  }
  const core = new SurrealCompanyCore(db);
  service = createMcpHttpService({
    core, port,
    ready: async () => {
      const probe = db.db.select(new RecordId('company_meta', 'installation'));
      const timeout = new Promise<false>(resolve => setTimeout(() => resolve(false), 8_000));
      return Boolean(await Promise.race([probe, timeout]));
    },
    heal: () => db.ensureConnected(),
  });
  console.log(`MCP listening on 127.0.0.1:${service.port}`);

  const credentialFile = process.env.SCK_PROJECTOR_CREDENTIAL_FILE;
  const repository = process.env.SCK_GITHUB_REPOSITORY;
  if (Boolean(credentialFile) !== Boolean(repository)) {
    throw new Error('projection requires both SCK_PROJECTOR_CREDENTIAL_FILE and SCK_GITHUB_REPOSITORY');
  }
  if (credentialFile && repository) {
    const credential = await readPrivateCredential(credentialFile);
    const projector = createGithubProjector({
      core, credential, github: createGhCliGateway(repository),
      statePath: resolve(process.env.SCK_PROJECTION_STATE_FILE ?? '.runtime/gh-projection.json'),
      heal: () => db.ensureConnected(),
    });
    const worker = runProjectionWorker({
      // Projection queries run between long gh calls, outside the healed /mcp path;
      // probe-and-reconnect at the top of every pass so a scoped-out conn self-recovers.
      projector: { runOnce: async () => { await db.ensureConnected(); return projector.runOnce(); } },
      signal: shutdown.signal,
      onResult: ({ projected }) => { if (projected) console.log(`Projected ${projected} outbox events`); },
      onError: (error) => console.error(`GitHub projection failed: ${(error as Error)?.message ?? String(error)}; retry scheduled`),
    });
    process.once('SIGINT', () => shutdown.abort());
    process.once('SIGTERM', () => shutdown.abort());
    await worker;
  } else {
    await new Promise<void>(done => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  }
} finally {
  shutdown.abort();
  await service?.close();
  await db.close();
}
