import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDatabaseConfig } from '../src/config';
import type { ClaimResult, TaskView } from '../src/contracts';
import { SurrealCompanyCore } from '../src/core';
import { CompanyDatabase } from '../src/database';
import { LocalEnrollmentAdmin } from '../src/enrollment';
import { connectCompanyClient } from '../src/mcp/client';
import { readPrivateCredential } from '../src/mcp/credential-file';
import { createGhCliGateway, createGithubProjector } from '../src/mcp/github-projector';
import { createMcpHttpService } from '../src/mcp/server';
import { installNodeHost } from '../src/host-node';

installNodeHost();

const credentialDir = process.env.SCK_LIVE_CREDENTIAL_DIR;
const repository = process.env.SCK_GITHUB_REPOSITORY;
if (!credentialDir || !repository) throw new Error('SCK_LIVE_CREDENTIAL_DIR and SCK_GITHUB_REPOSITORY are required');
const credentials = await Promise.all(['gm-01', 'ai-01', 'eng-01'].map(name =>
  readPrivateCredential(join(credentialDir, `${name}.token`))));
const db = new CompanyDatabase(loadDatabaseConfig());
await db.connect();
let service: ReturnType<typeof createMcpHttpService> | undefined;
await mkdir(join(process.cwd(), '.runtime'), { recursive: true, mode: 0o700 });
const temp = await mkdtemp(join(process.cwd(), '.runtime/live-check-'));
try {
  await db.bootstrap();
  const core = new SurrealCompanyCore(db);
  service = createMcpHttpService({ core, port: 0 });
  const url = new URL(`http://127.0.0.1:${service.port}/mcp`);
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-negative', version: '1' },
  } });
  const request = (credential?: string) => fetch(url, { method: 'POST', headers: {
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
    ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
  }, body: initialize });
  assert.equal((await request()).status, 401);
  assert.equal((await request('sck_invalid')).status, 401);
  const enrollment = new LocalEnrollmentAdmin(db);
  const revokedId = `mcp-revoked-${crypto.randomUUID()}`;
  const revokedCredential = await enrollment.enroll(revokedId, 'ai-content', ['execute']);
  assert.equal((await request(revokedCredential)).status, 200);
  await enrollment.revoke(revokedId);
  assert.equal((await request(revokedCredential)).status, 401);
  const clients = await Promise.all(credentials.map((credential, index) =>
    connectCompanyClient({ url, credential, clientName: `live-check-${index}` })));
  try {
    const call = async <T>(index: number, name: string, args: Record<string, unknown>): Promise<T> => {
      const result = await clients[index]!.client.callTool({ name, arguments: args });
      const value = result.structuredContent as { ok: boolean; code?: string; data?: T } | undefined;
      assert(value?.ok === true, `${name} failed: ${value?.code ?? 'no result'}`);
      return value.data as T;
    };
    const gateway = createGhCliGateway(repository);
    const oldBody = (await gateway.getIssue(25)).body;
    const key = crypto.randomUUID();
    const task = await call<TaskView>(0, 'create_task', {
      title: `MCP live integration ${key.slice(0, 8)}`,
      context: 'Synthetic integration task for SDK HTTP, real database, review and durable GitHub projection.',
      executorRole: 'ai-content', reviewerRole: 'engineering', idempotencyKey: key,
    });
    assert.equal(task.state, 'ready');
    const aiContext = await call<{ principal: { employeeId: string }; tasks: TaskView[] }>(1, 'get_context', { taskId: task.id });
    assert.equal(aiContext.principal.employeeId, 'ai-01');
    assert.equal(aiContext.tasks[0]?.id, task.id);
    const claimed = await call<ClaimResult>(1, 'claim_next', { taskId: task.id });
    assert.equal(claimed.task.state, 'doing');
    const proof = { taskId: task.id, deliveryId: claimed.deliveryId, fence: claimed.fence,
      expectedVersion: claimed.task.version };
    const heartbeat = await call<ClaimResult>(1, 'heartbeat', proof);
    assert.equal(heartbeat.task.version, proof.expectedVersion);
    const checkpoint = await call<TaskView>(1, 'checkpoint', { ...proof,
      text: 'Live SDK HTTP and real database checkpoint was persisted.', idempotencyKey: `${key}-checkpoint` });
    const submitArgs = { ...proof, expectedVersion: checkpoint.version,
      text: 'Live adapter integration submitted to engineering for independent review.',
      idempotencyKey: `${key}-submit` };
    const submitted = await call<TaskView>(1, 'submit', submitArgs);
    const replay = await call<TaskView>(1, 'submit', submitArgs);
    assert.equal(replay.version, submitted.version);
    assert.equal(submitted.state, 'review');
    const selfReview = await clients[1]!.client.callTool({ name: 'claim_next', arguments: { taskId: task.id } });
    assert.equal((selfReview.structuredContent as { code?: string } | undefined)?.code, 'self_review');
    const reviewClaim = await call<ClaimResult>(2, 'claim_next', { taskId: task.id });
    assert.equal(reviewClaim.task.state, 'review');
    const accepted = await call<TaskView>(2, 'review', {
      taskId: task.id, deliveryId: reviewClaim.deliveryId, fence: reviewClaim.fence,
      expectedVersion: reviewClaim.task.version, decision: 'accept',
      text: 'Independent engineering review accepted this synthetic live integration task.',
      idempotencyKey: `${key}-review`,
    });
    assert.equal(accepted.state, 'done');
    const events = await core.listOutbox(credentials[0]!);
    const taskEvents = events.filter(event => event.taskId === task.id);
    assert.deepEqual(taskEvents.map(event => event.kind), ['created', 'claimed', 'checkpoint', 'submit', 'claimed', 'accept']);
    const projector = createGithubProjector({ core, credential: credentials[0]!, github: gateway,
      statePath: join(temp, 'projection-a.json') });
    assert.equal((await projector.runOnce()).projected >= taskEvents.length, true);
    assert.equal((await projector.runOnce()).projected, 0);
    const recovery = createGithubProjector({ core, credential: credentials[0]!, github: gateway,
      statePath: join(temp, 'projection-b.json') });
    await recovery.runOnce();
    const marker = `<!-- sck-company-task:${encodeURIComponent(task.id)} -->`;
    const matches = (await gateway.listIssues()).filter(issue => issue.body.includes(marker));
    assert.equal(matches.length, 1);
    const issue = await gateway.getIssue(matches[0]!.number);
    assert.equal(issue.state, 'CLOSED');
    for (const event of taskEvents) {
      const commentMarker = `<!-- sck-company-outbox:${encodeURIComponent(event.id)} -->`;
      assert.equal(issue.comments.filter(comment => comment.body.includes(commentMarker)).length, 1);
    }
    assert.equal((await gateway.getIssue(25)).body, oldBody);
    console.log(JSON.stringify({ taskId: task.id, issue: matches[0]!.number,
      eventCount: taskEvents.length, replayProjected: 0, recoveredWithoutDuplicates: true,
      legacyIssueUntouched: true }));
  } finally {
    await Promise.all(clients.map(client => client.close()));
  }
} finally {
  await service?.close();
  await db.close();
  await rm(temp, { recursive: true, force: true });
}
