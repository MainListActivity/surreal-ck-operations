import { randomUUID } from "node:crypto";
import { loadDatabaseConfig } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/config.ts";
import { CompanyDatabase } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/database.ts";
import { SurrealCompanyCore } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/core.ts";
import { LocalEnrollmentAdmin } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/enrollment.ts";
import { createMcpHttpService } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/mcp/server.ts";
import { connectCompanyClient } from "/Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5/src/mcp/client.ts";
const suffix = randomUUID().slice(0, 8);
const db = new CompanyDatabase({ ...loadDatabaseConfig(), namespace: "sck_agent_company_test", database: "control_plane" });
const check = (condition: unknown, label: string) => { if (!condition) throw Error("FAIL " + label); console.log("PASS", label); };
const value = (result: any, label: string) => { const s = result.structuredContent; if (!s?.ok) throw Error(label + ": " + String(s?.code)); return s.data; };
const error = (result: any, code: string, label: string) => check(result.structuredContent?.ok === false && result.structuredContent?.code === code, label);
const call = (client: any, name: string, args: Record<string, unknown> = {}) => client.client.callTool({ name, arguments: args });
const key = (prefix: string) => prefix + "-" + suffix + "-" + randomUUID().slice(0, 8);
await db.connect();
const connections: any[] = [];
let service: ReturnType<typeof createMcpHttpService> | undefined;
try {
  await db.bootstrap();
  const core = new SurrealCompanyCore(db);
  const admin = new LocalEnrollmentAdmin(db);
  const tokens: Record<string, string> = {};
  const actors: Array<[string, string, string[]]> = [
    ["gm", "gm", ["execute", "review", "manage"]],
    ["q1", "qa", ["execute", "review"]], ["q2", "qa", ["execute", "review"]],
    ["q3", "qa", ["execute", "review"]], ["q4", "qa", ["execute", "review"]],
    ["q5", "qa", ["execute", "review"]], ["q6", "qa", ["execute", "review"]],
    ["eng", "engineering", ["execute", "review"]], ["cs", "cs", ["execute", "review"]]
  ];
  for (const [name, role, caps] of actors) tokens[name] = await admin.enroll("test-qa28-" + name + "-" + suffix, role as any, caps as any);
  service = createMcpHttpService({ core, port: 0 });
  const url = new URL("http://127.0.0.1:" + service.port + "/mcp");
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "qa28", version: "1" } } };
  const request = (token?: string, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers }, body: JSON.stringify(init) });
  check((await request()).status === 401, "B01 missing token 401");
  check((await request("sck_invalid")).status === 401, "B01 wrong token 401");
  check((await request(tokens.q1, { Host: "example.invalid" })).status === 403, "B01 foreign Host 403");
  check((await request(tokens.q1, { Origin: "http://example.invalid" })).status === 403, "B01 foreign Origin 403");
  const clients: Record<string, any> = {};
  for (const name of Object.keys(tokens)) { clients[name] = await connectCompanyClient({ url, credential: tokens[name], clientName: "qa28-" + name }); connections.push(clients[name]); }
  check((await clients.q1.client.listTools()).tools.length === 9, "B01 official SDK lists nine tools");
  const context = value(await call(clients.q1, "get_context"), "context");
  check(context.principal.employeeId === "test-qa28-q1-" + suffix, "B02 identity from credential");
  const fixture = { title: "QA28 A " + suffix, context: "Synthetic isolated MCP acceptance task.", executorRole: "qa", reviewerRole: "engineering", idempotencyKey: key("create") };
  error(await call(clients.q1, "create_task", fixture), "forbidden", "B02 employee cannot create");
  error(await call(clients.cs, "resume_task", { taskId: "fake", text: "Cannot grant manager privileges.", idempotencyKey: key("resume") }), "forbidden", "B02 employee cannot resume");
  const task = value(await call(clients.gm, "create_task", fixture), "create task");
  check(value(await call(clients.gm, "create_task", fixture), "create replay").id === task.id, "B05 create replay");
  error(await call(clients.gm, "create_task", { ...fixture, context: "Changed content." }), "conflict", "B05 create key/payload conflict");
  error(await call(clients.cs, "claim_next", { taskId: task.id }), "forbidden", "B02 wrong role claim");
  const races = await Promise.all([call(clients.q1, "claim_next", { taskId: task.id }), call(clients.q2, "claim_next", { taskId: task.id })]);
  const winning = races.map((r, i) => ({ r, i })).filter(x => x.r.structuredContent?.ok);
  check(winning.length === 1, "B03 concurrent MCP claim one winner");
  const winner = winning[0].i === 0 ? "q1" : "q2";
  const claimed = value(winning[0].r, "winner claim");
  const proof = { taskId: task.id, deliveryId: claimed.deliveryId, fence: claimed.fence, expectedVersion: claimed.task.version };
  check(value(await call(clients[winner], "heartbeat", proof), "heartbeat").task.version === proof.expectedVersion, "B04 MCP heartbeat");
  const checkpoint = value(await call(clients[winner], "checkpoint", { ...proof, text: "Synthetic checkpoint from MCP QA.", idempotencyKey: key("checkpoint") }), "checkpoint");
  error(await call(clients[winner], "submit", { ...proof, text: "Old version should be refused.", idempotencyKey: key("stale") }), "conflict", "B05 stale version rejected");
  const submitArgs = { ...proof, expectedVersion: checkpoint.version, text: "Synthetic MCP submission for QA.", idempotencyKey: key("submit") };
  const submitted = value(await call(clients[winner], "submit", submitArgs), "submit");
  check(submitted.state === "review", "B05 submit reaches review");
  check(value(await call(clients[winner], "submit", submitArgs), "submit replay").version === submitted.version, "B05 submit retry stable");
  error(await call(clients[winner], "submit", { ...submitArgs, text: "Changed synthetic result." }), "conflict", "B05 submit key/payload conflict");
  const review = value(await call(clients.eng, "claim_next", { taskId: task.id }), "review claim");
  const reviewed = value(await call(clients.eng, "review", { taskId: task.id, deliveryId: review.deliveryId, fence: review.fence, expectedVersion: review.task.version, decision: "accept", text: "Independent synthetic review accepted.", idempotencyKey: key("review") }), "review");
  check(reviewed.state === "done", "B06 independent MCP review");
  const selfTask = value(await call(clients.gm, "create_task", { title: "QA28 self " + suffix, context: "Synthetic self-review.", executorRole: "qa", reviewerRole: "qa", idempotencyKey: key("selfcreate") }), "self task");
  const selfClaim = value(await call(clients.q3, "claim_next", { taskId: selfTask.id }), "self claim");
  value(await call(clients.q3, "submit", { taskId: selfTask.id, deliveryId: selfClaim.deliveryId, fence: selfClaim.fence, expectedVersion: selfClaim.task.version, text: "Synthetic self-review delivery from q3.", idempotencyKey: key("selfsubmit") }), "self submit");
  error(await call(clients.q3, "claim_next", { taskId: selfTask.id }), "self_review", "B06 self-review rejected over MCP");
  const changedSession = await connectCompanyClient({ url, credential: tokens.q3, clientName: "qa28-q3-new-session" });
  connections.push(changedSession);
  error(await call(changedSession, "claim_next", { taskId: selfTask.id }), "self_review", "B06 same employee new MCP session self-review rejected");

  const independent = value(await call(clients.q4, "claim_next", { taskId: selfTask.id }), "independent claim");
  value(await call(clients.q4, "review", { taskId: selfTask.id, deliveryId: independent.deliveryId, fence: independent.fence, expectedVersion: independent.task.version, decision: "accept", text: "Other synthetic QA accepts delivery.", idempotencyKey: key("selfaccept") }), "independent accept");
  const revokeTask = value(await call(clients.gm, "create_task", { title: "QA28 revoke " + suffix, context: "Synthetic active lease revocation.", executorRole: "qa", reviewerRole: "engineering", idempotencyKey: key("revokecreate") }), "revoke task");
  const revokeClaim = value(await call(clients.q5, "claim_next", { taskId: revokeTask.id }), "revoke claim");
  await admin.revoke("test-qa28-q5-" + suffix);
  check((await request(tokens.q5)).status === 401, "B07 revoked token next request 401");
  let revokedDenied = false;
  try { await call(clients.q5, "submit", { taskId: revokeTask.id, deliveryId: revokeClaim.deliveryId, fence: revokeClaim.fence, expectedVersion: revokeClaim.task.version, text: "Revoked actor may not submit this task.", idempotencyKey: key("revoked") }); } catch { revokedDenied = true; }
  check(revokedDenied, "B07 revoked established client cannot write");
  const parent = value(await call(clients.gm, "create_task", { title: "QA28 parent " + suffix, context: "Synthetic blocked parent.", executorRole: "qa", reviewerRole: "engineering", idempotencyKey: key("parent") }), "parent");
  const child = value(await call(clients.gm, "create_task", { title: "QA28 child " + suffix, context: "Synthetic dependency.", executorRole: "qa", reviewerRole: "engineering", dependencies: [parent.id], idempotencyKey: key("child") }), "child");
  check(child.state === "blocked", "B08 dependency initially blocked");
  const parentClaim = value(await call(clients.q6, "claim_next", { taskId: parent.id }), "parent claim");
  const blocked = value(await call(clients.q6, "report_blocker", { taskId: parent.id, deliveryId: parentClaim.deliveryId, fence: parentClaim.fence, expectedVersion: parentClaim.task.version, to: "gm", text: "Synthetic blocker requiring manager action.", idempotencyKey: key("block") }), "block");
  check(blocked.state === "blocked", "B08 report_blocker persists");
  check(value(await call(clients.gm, "resume_task", { taskId: parent.id, text: "Synthetic manager resumed blocked work.", idempotencyKey: key("resume") }), "resume").state === "doing", "B08 manager resume");
  const reclaimed = value(await call(clients.q6, "claim_next", { taskId: parent.id }), "reclaim");
  value(await call(clients.q6, "submit", { taskId: parent.id, deliveryId: reclaimed.deliveryId, fence: reclaimed.fence, expectedVersion: reclaimed.task.version, text: "Synthetic parent completed after recovery.", idempotencyKey: key("parentsubmit") }), "parent submit");
  const parentReview = value(await call(clients.eng, "claim_next", { taskId: parent.id }), "parent review");
  value(await call(clients.eng, "review", { taskId: parent.id, deliveryId: parentReview.deliveryId, fence: parentReview.fence, expectedVersion: parentReview.task.version, decision: "accept", text: "Synthetic parent accepted for dependency.", idempotencyKey: key("parentaccept") }), "parent accept");
  const childContext = value(await call(clients.gm, "get_context", { taskId: child.id }), "child context");
  check(childContext.tasks[0].state === "ready", "B08 dependent task unlocked");
  const parallelA = value(await call(clients.gm, "create_task", { title: "QA28 same-role A " + suffix, context: "Independent assignment A.", executorRole: "qa", reviewerRole: "engineering", idempotencyKey: key("sameA") }), "same role A");
  const parallelB = value(await call(clients.gm, "create_task", { title: "QA28 same-role B " + suffix, context: "Independent assignment B.", executorRole: "qa", reviewerRole: "engineering", idempotencyKey: key("sameB") }), "same role B");
  const [ownedA, ownedB] = await Promise.all([
    call(clients.q1, "claim_next", { taskId: parallelA.id }),
    call(clients.q2, "claim_next", { taskId: parallelB.id })
  ]);
  check(value(ownedA, "owned A").task.id === parallelA.id && value(ownedB, "owned B").task.id === parallelB.id && parallelA.id !== parallelB.id, "B03 same-role employees own distinct tasks");
  console.log("RESULT PASS; isolated namespace sck_agent_company_test; run " + suffix);
} finally {
  await Promise.allSettled(connections.map(x => x.close()));
  await service?.close();
  await db.close();
}
