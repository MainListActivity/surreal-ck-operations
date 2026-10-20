import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { CompanyDatabase } from '../src/database.ts';
import { SurrealCompanyCore } from '../src/core.ts';
import { LocalEnrollmentAdmin } from '../src/enrollment.ts';
import { OwnerDesk } from '../src/owner.ts';
import { Workforce, type EmployeeDef, type EmployeeInst } from '../src/workforce.ts';
import { Dispatcher, quotaBlockedProviders, roleCapacity, type DispatchSnapshot } from '../src/dispatcher/dispatcher.ts';
import { dispatchBlockedRows, goalBlockerRows } from '../src/dispatcher/dispatch-list.ts';
import { rosterAnswer } from '../src/dispatcher/roster-answer.ts';
import { pulseAnswer } from '../src/dispatcher/pulse-answer.ts';
import { readGoalRootFacts } from '../src/dispatcher/goal-roots.ts';
import type { PaseoGateway } from '../src/dispatcher/paseo.ts';
import { deriveContributors, contributionTimeline, openLeaseOf, proposeImplementer, type ContributionEvent } from '../src/contributors.ts';
import { SidecarPool, type SidecarDeps } from '../plugin/server/sidecar.ts';
import { readJsonFile } from '../src/comm.ts';
import type { ClaimResult, LeaseProof, ProviderQuota } from '../src/contracts.ts';

// SYS-DISP B5 (review f3bd7d, v44 return): the three-author avoidance, seats full and quota at zero, replayed through the real core,
// the real dispatcher and the company fork. Paseo sessions are fakes (the channel launch mirrors the dispatcher's own spawn path);
// quota rows are the plugin's input, supplied by the test. Nothing here mocks the core, the dispatcher or the audit history.
// The 04195c93 replay is read-only: the saved audit history goes through the product functions and nothing is written.

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;

const EVIDENCE = process.env.SCK_B5_EVIDENCE_DIR ?? '/Users/y/Library/Application Support/SurrealCKCompany/evidence/f2f16a69-9472-47c1-8cf1-3df7c653defc';
// Replay output goes to a temp dir unless SCK_B5_OUT_DIR says otherwise: a plain run never overwrites the saved review evidence.
const OUT = process.env.SCK_B5_OUT_DIR ?? join(tmpdir(), 'sck-b5-replay');
const HISTORY_04195C93 = join(EVIDENCE, 'ac01', 'page1.json');
const ROOT_PASSWORD = 'isolated-b5-test-only';

const FIXTURE_ENG = 'fixture-eng';
const FIXTURE_QA_GROK = 'fixture-qa-grok';

interface Fork {
  dir: string;
  db: CompanyDatabase;
  core: SurrealCompanyCore;
  owner: OwnerDesk;
  wf: Workforce;
  gm: string;
  pool: SidecarPool;
  agentRows: Map<string, { id: string; status: string }>;
  envs: Map<string, Record<string, string>>;
  quotaRows: ProviderQuota[];
  minted: Map<string, string>;
  launch: (def: EmployeeDef) => Promise<EmployeeInst & { credential: string; paseoAgentId: string }>;
  dispatcher: () => Dispatcher;
  close: () => Promise<void>;
}

/** A real company fork with the real core, workforce, sidecar pool and dispatcher. Only the Paseo session gateway is a fake. */
async function openFork(name: string): Promise<Fork> {
  const dir = mkdtempSync(join(tmpdir(), `b5-${name}-`));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([join(homedir(), '.surrealdb/surreal'), 'start', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', ROOT_PASSWORD,
    '--log', 'error', `rocksdb:${dir}/database`], { stdout: 'ignore', stderr: 'ignore' });
  const db = new CompanyDatabase({ url: `ws://127.0.0.1:${port}/rpc`, rootUser: 'root', rootPassword: ROOT_PASSWORD,
    namespace: `isolated_b5_${name.replaceAll('-', '_')}`, database: 'control_plane' });
  let ready = false;
  for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
  expect(ready).toBe(true);
  await db.connect(); await db.bootstrap();
  const core = new SurrealCompanyCore(db), enrollment = new LocalEnrollmentAdmin(db), owner = new OwnerDesk(db);
  const gm = await enrollment.enroll('fixture-manager', 'gm', ['execute', 'review', 'manage']);
  // Quota floor 20%: the codex rows below are at 0%, which is quota-blocked. provider_max sets the codex concurrency cap.
  await db.db.upsert(new RecordId('company_meta', 'config')).content({ eval_enabled: false, jev_decisions: false, quota_floor_pct: 20,
    quota_weekly_floor_pct: 0, session_max_wakes: 0, session_max_input_k: 0, provider_max: { codex: 3, grok: 2 } });
  const wf = new Workforce(db, join(dir, 'unused-credential-files'));
  const minted = new Map<string, string>();
  const originalSpawn = wf.spawnInst.bind(wf);
  wf.spawnInst = async d => { const i = await originalSpawn(d); minted.set(i.id, i.credential!); return i; };
  const agentRows = new Map<string, { id: string; status: string }>();
  const envs = new Map<string, Record<string, string>>();
  const quotaRows: ProviderQuota[] = [];
  const ops = { tools: ['ops_info'], call: async () => ({ available: true }), release: () => {} };
  const pool = new SidecarPool({ core, workforce: wf as unknown as SidecarDeps['workforce'], ops, runDir: join(dir, 'comm'), sweepMs: 5 });
  const paseo: PaseoGateway = { list: async () => agentRows, status: async id => agentRows.get(id) ? { status: agentRows.get(id)!.status, pendingPermissions: 0 } : undefined,
    lastError: async () => '', logsTail: async () => 'isolated synthetic transcript', lastInputTokens: async () => 0,
    spawn: async b => { const id = `agent-${b.labels.employee_id}`; agentRows.set(id, { id, status: 'running' }); envs.set(id, b.env); return id; },
    send: async id => { agentRows.get(id)!.status = 'running'; }, stop: async id => { agentRows.get(id)!.status = 'idle'; },
    archive: async id => { agentRows.get(id)!.status = 'archived'; pool.detachAgent(id); },
    listWorkspaces: async () => [], listProjects: async () => [], archiveWorkspace: async () => {}, deleteProject: async () => {} };
  const dispatcher = () => new Dispatcher({ workforce: wf, owner, paseo, sidecar: pool, rand: () => 0,
    quota: async () => quotaRows, env: { opsRepo: dir, sckBin: '/fixture/sck', paseoBin: '/fixture/paseo' } });
  // The launch mirrors the dispatcher's own spawn path: a channel launched in this process, the agent bound to it, then the binding saved.
  const launch = async (def: EmployeeDef) => {
    const inst = await wf.spawnInst(def);
    const env = pool.env(inst);
    const agentId = `agent-${inst.id}`;
    agentRows.set(agentId, { id: agentId, status: 'idle' });
    envs.set(agentId, env);
    pool.bindAgent(inst.id, agentId);
    await wf.bind(inst.id, { agentId, def: def.id, provider: def.provider, model: def.model });
    return { ...inst, credential: inst.credential!, paseoAgentId: agentId };
  };
  return { dir, db, core, owner, wf, gm, pool, agentRows, envs, quotaRows, minted, launch, dispatcher, close: async () => {
    for (const id of agentRows.keys()) pool.detachAgent(id);
    pool.close();
    await db.close(); child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true });
  } };
}

const proofOf = (taskId: string, claim: ClaimResult): LeaseProof =>
  ({ taskId, deliveryId: claim.deliveryId, fence: claim.fence, expectedVersion: claim.task.version });

/**
 * The 04195c93 shape with three authors: A submits; B reviews and returns; the manager hands the code to B, who submits; C reviews
 * and returns; the manager hands the code to C, who submits. Each author has written the task, so none of them may review it.
 */
async function buildThreeAuthorReview(w: Fork) {
  const { core, gm, wf } = w;
  const def = async (id: string) => (await wf.defs()).find(d => d.id === id)!;
  await wf.upsertDef(FIXTURE_ENG, { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 3 });
  await wf.upsertDef(FIXTURE_QA_GROK, { role: 'qa', provider: 'grok', model: 'fixture', maxInstances: 1 });
  const engDef = await def(FIXTURE_ENG);
  // A, B and C are the three seats of one def: maxInstances is 3, so the seat is full.
  const A = await w.launch(engDef), B = await w.launch(engDef), C = await w.launch(engDef);
  const goal = await core.relayGoal(gm, { text: 'B5 three-author review replay', ownerQuote: 'synthetic B5 replay goal', tier: 'quick', idempotencyKey: 'b5-goal-replay' });
  const T1 = await core.createTask(gm, { title: 'B5 three authors review', context: 'Synthetic regression only', executorRole: 'engineering',
    reviewerRole: 'engineering', goalId: goal.id, idempotencyKey: 'b5-create-t1' });
  const refusals: Array<{ label: string; code?: string; message?: string }> = [];
  const refuse = async (label: string, attempt: Promise<unknown>) => {
    try { await attempt; } catch (error) {
      const e = error as { code?: string; message?: string };
      refusals.push({ label, code: e.code, message: e.message });
      return;
    }
    throw new Error(`${label} was not refused`);
  };
  // A implements (fresh task: A becomes the implementer) and submits.
  const claimA = await core.claim(A.credential, T1.id);
  expect(claimA.task).toMatchObject({ state: 'doing', implementer: A.id });
  await core.submit(A.credential, proofOf(T1.id, claimA), { text: 'synthetic A delivery for the B5 replay', idempotencyKey: 'b5-a-submit' });
  // B reviews and returns. A is the bound implementer: C cannot take the returned code while A stays bound.
  const reviewB = await core.claim(B.credential, T1.id);
  await core.returnTask(B.credential, proofOf(T1.id, reviewB), { text: 'synthetic B return to A for rework (B5)', idempotencyKey: 'b5-b-return' });
  expect(await core.getTask(gm, T1.id)).toMatchObject({ state: 'ready', implementer: A.id });
  await refuse('C execute while bound to A', core.claim(C.credential, T1.id));
  // The manager hands the code to B, the reviewer who returned it. B is a current reviewer, so the takeover names C as the
  // replacement reviewer: C is neither an author nor a reviewer yet, so the rule is met. B implements, then blocks to gm.
  await core.implementerTakeover(gm, { taskId: T1.id, toEmployee: B.id, replacementReviewer: C.id,
    expectedVersion: (await core.getTask(gm, T1.id)).version,
    reason: 'synthetic B5: 经理指定 B 续做，A 的席位与额度不可用', idempotencyKey: 'b5-takeover-b' });
  const claimB = await core.claim(B.credential, T1.id);
  expect(claimB.task).toMatchObject({ state: 'doing', implementer: B.id });
  await core.block(B.credential, proofOf(T1.id, claimB), 'gm', { text: 'synthetic B block to gm for the B5 handoff', idempotencyKey: 'b5-b-block' });
  expect(await core.getTask(gm, T1.id)).toMatchObject({ state: 'blocked' });
  // The manager resumes the task: it is ready again with B as the recorded implementer. A is refused execute while B is bound.
  await core.resume(gm, T1.id, { text: 'synthetic manager resume after the B5 block', idempotencyKey: 'b5-resume-1' });
  expect(await core.getTask(gm, T1.id)).toMatchObject({ state: 'ready', implementer: B.id });
  await refuse('A execute while bound to B', core.claim(A.credential, T1.id));
  // C has never reviewed the task, so C takes over with no replacement reviewer; C implements and submits: C is now an author.
  await core.implementerTakeover(gm, { taskId: T1.id, toEmployee: C.id, expectedVersion: (await core.getTask(gm, T1.id)).version,
    reason: 'synthetic B5: 经理指定 C 续做，B 的席位与额度不可用', idempotencyKey: 'b5-takeover-c' });
  const claimC = await core.claim(C.credential, T1.id);
  await core.submit(C.credential, proofOf(T1.id, claimC), { text: 'synthetic C delivery after the takeover (B5)', idempotencyKey: 'b5-c-submit' });
  // Review state: A, B and C each wrote the task. The refusals in the test are the claim and transition entries of the real core.
  return { A, B, C, goal, T1, claimA, refusals, refuse };
}

const snapshotOfTask = async (w: Fork, taskId: string) => {
  const task = await w.core.getTask(w.gm, taskId);
  const history = await w.core.history(w.gm, taskId);
  return { version: task.version, state: task.state, currentEmployee: task.currentEmployee ?? null,
    implementer: task.implementer ?? null, historyRows: history.length };
};

/** The roster and pulse views of one pass, built the way the plugin builds them: the same snapshot and the same bounded answers. */
async function ownerViews(w: Fork, snapshot: DispatchSnapshot, roots: string[]) {
  // The pulse reads the goal-root facts the way plugin/server/handlers.ts does: a failed read keeps the verdict-only card.
  let facts: Awaited<ReturnType<typeof readGoalRootFacts>> | undefined;
  let factsError: string | undefined;
  try { facts = await readGoalRootFacts(w.db.db, w.wf, roots); } catch (error) { factsError = (error as Error).message; }
  const entryView = (e: DispatchSnapshot['reviewPools'][number]['entries'][number]) =>
    ({ key: e.key, kind: e.kind, eligible: e.eligible, code: e.code, reason: e.reason, provider: e.provider, role: e.role, weight: e.weight, share: e.share });
  const roster = rosterAnswer({ paused: false, opsRepo: w.dir, usage: [], defs: [], instances: [], health: [],
    pools: snapshot.pools.map(p => ({ role: p.role, home: p.home, entries: p.entries.map(entryView) })),
    reviewPools: snapshot.reviewPools.map(p => ({ taskId: p.taskId, title: p.title, role: p.role, home: p.home, status: p.status, entries: p.entries.map(entryView) })),
    dispatchBlocked: dispatchBlockedRows(snapshot.verdicts),
    dispatchAt: snapshot.at ? new Date(snapshot.at).toISOString() : undefined });
  const pulse = pulseAnswer({ at: new Date().toISOString(), dispatchAt: snapshot.at ? new Date(snapshot.at).toISOString() : undefined,
    paused: false, doing: [], ready: [], dispatchBlocked: dispatchBlockedRows(snapshot.verdicts),
    goalBlockers: goalBlockerRows(snapshot.verdicts, facts), stuck: [], waiting: [], recentDone: [], goals: [], resources: [],
    last24h: {}, churn: {} });
  return { roster, pulse, facts, factsError };
}

run('B5 three-author review replay: no review candidate qualifies, the roster and the pulse name one root cause, and the three authors are refused', async () => {
  const w = await openFork('blocked');
  try {
    // Quota at zero on codex; grok stays healthy so the pass is not a global budget stop and the candidates are read.
    w.quotaRows.push({ provider: 'codex', lowestPct: 0, fetchedAt: new Date().toISOString() } as ProviderQuota,
      { provider: 'grok', lowestPct: 100, fetchedAt: new Date().toISOString() } as ProviderQuota);
    const built = await buildThreeAuthorReview(w);
    const { A, B, C, goal, T1, refuse } = built;
    // The three authors' attempts on the review state: claim and transition entries of the real core.
    const before = await snapshotOfTask(w, T1.id);
    await refuse('A review claim', w.core.claim(A.credential, T1.id));
    await refuse('B review claim', w.core.claim(B.credential, T1.id));
    await refuse('C review claim', w.core.claim(C.credential, T1.id));
    await refuse('A accept with a stale proof', w.core.accept(A.credential, { taskId: T1.id, deliveryId: 'stale', fence: 0, expectedVersion: before.version },
      { text: 'stale accept after the review closed (B5)', idempotencyKey: 'b5-a-accept-stale' }));
    await refuse('B return with a stale proof', w.core.returnTask(B.credential, { taskId: T1.id, deliveryId: 'stale', fence: 0, expectedVersion: before.version },
      { text: 'stale return after the review closed (B5)', idempotencyKey: 'b5-b-return-stale' }));
    await refuse('C submit with a stale proof', w.core.submit(C.credential, { taskId: T1.id, deliveryId: 'stale', fence: 0, expectedVersion: before.version },
      { text: 'stale submit after the review closed (B5)', idempotencyKey: 'b5-c-submit-stale' }));
    expect(await snapshotOfTask(w, T1.id)).toEqual(before);
    // A second, fresh execute task under the same goal: the same seats and the same quota reach its execute verdict.
    const T2 = await w.core.createTask(w.gm, { title: 'B5 fresh execute under zero quota', context: 'Synthetic regression only', executorRole: 'engineering',
      reviewerRole: 'engineering', goalId: goal.id, idempotencyKey: 'b5-create-t2' });
    // The real pass: no review candidate, no spawn (the seat is full), no claim (the quota is at zero).
    const d = w.dispatcher();
    const tick = await d.tick();
    expect(tick.woke.filter(x => x.task === T1.id || x.task === T2.id)).toEqual([]);
    expect(tick.skipped).toBeUndefined();
    expect((await w.wf.insts()).filter(i => i.def === FIXTURE_ENG)).toHaveLength(3);
    expect(await snapshotOfTask(w, T1.id)).toEqual(before);
    const snapshot = d.dispatchSnapshot();
    const reviewVerdict = snapshot.verdicts.find(v => v.taskId === T1.id && v.phase === 'review')!;
    expect(reviewVerdict).toMatchObject({ dispatchable: false, eligibleCount: 0, workflowState: 'review', goalId: goal.id });
    expect(reviewVerdict.reasons.map(r => r.code)).toEqual(['author_recusal', 'seat_full']);
    expect(reviewVerdict.reasons.find(r => r.code === 'author_recusal')!.candidates).toEqual([A.id, B.id, C.id].sort());
    expect(reviewVerdict.reasons.find(r => r.code === 'seat_full')!.candidates).toEqual([`spawn:${FIXTURE_ENG}`]);
    expect(reviewVerdict.reasons.find(r => r.code === 'seat_full')!.actions).toEqual([expect.objectContaining({ authority: 'gm', tool: 'def_ensure', executable: true })]);
    // The execute verdict of T2: the codex seats are quota-blocked, and the reviewer of the work is reserved (R1).
    const executeVerdict = snapshot.verdicts.find(v => v.taskId === T2.id && v.phase === 'execute')!;
    expect(executeVerdict).toMatchObject({ dispatchable: false, eligibleCount: 0, workflowState: 'ready' });
    expect(executeVerdict.reasons.map(r => r.code)).toEqual(['quota', 'review_capacity', 'seat_full']);
    // All three codex seats are reuse reviewers with no eligible reviewer, so reviewPlanOf reserves the first legal key (key order);
    // the execute pool keeps the other two seats, which are the quota-blocked candidates.
    const seats = [A.id, B.id, C.id].sort();
    expect(executeVerdict.reasons.find(r => r.code === 'quota')!.candidates).toEqual(seats.slice(1));
    expect(executeVerdict.reasons.find(r => r.code === 'review_capacity')!.candidates).toEqual([seats[0]]);
    expect(executeVerdict.reasons.find(r => r.code === 'quota')!.actions).toEqual([expect.objectContaining({ authority: 'owner', executable: false })]);
    // The review pool of T1 has no candidate at all: every entry is either recused or a seat that cannot be added.
    const pool = snapshot.reviewPools.find(p => p.taskId === T1.id)!;
    expect(pool.status).toBe('blocked');
    expect(pool.entries.filter(e => e.eligible)).toEqual([]);
    expect(pool.entries.map(e => [e.key, e.code]).sort()).toEqual([[A.id, 'author_recusal'], [B.id, 'author_recusal'], [C.id, 'author_recusal'], [`spawn:${FIXTURE_ENG}`, 'seat_full']].sort());
    // The root cause at role level: the engineering role has no usable seat, because the codex quota is at zero.
    const capacity = roleCapacity(await w.wf.defs(), quotaBlockedProviders(w.quotaRows, { quotaFloorPct: 20, quotaWeeklyFloorPct: 0 }, Date.now()),
      await w.wf.providerHealth(), Math.floor(Date.now() / 1000));
    expect(capacity.find(c => c.role === 'engineering')).toMatchObject({ usable: 0 });
    // Roster and pulse: the same two rows, the same codes, owners and actions. The goal root shows the same task.
    const { roster, pulse, facts, factsError } = await ownerViews(w, snapshot, [T1.id, T2.id]);
    const rosterRows = roster.dispatchBlocked as Array<{ taskId: string; phase: string; reasons: Array<{ code: string; owner: string; actions: unknown }> }>;
    const pulseRows = pulse.dispatchBlocked as typeof rosterRows;
    // The goal's own root task ("[目标] ... 实现与上线申请", created with the goal) is blocked too: it is the third row.
    const rootTaskId = snapshot.verdicts.find(v => v.goalId === goal.id && v.taskId !== T1.id && v.taskId !== T2.id)!.taskId;
    expect(rosterRows.map(r => `${r.taskId}:${r.phase}`).sort()).toEqual([`${T1.id}:review`, `${T2.id}:execute`, `${rootTaskId}:execute`].sort());
    expect(pulseRows).toEqual(rosterRows);
    const goalRows = pulse.goalBlockers as Array<{ goalId: string; taskId: string; undispatchable: number; people: { authors: string[] }; reasons: Array<{ code: string; owner: string; actions: unknown }> }>;
    expect(goalRows).toHaveLength(1);
    const root = goalRows[0]!;
    // One goal card for the goal: it counts the three undispatchable tasks of the goal (T1 review, T2 execute and the root).
    expect(root).toMatchObject({ goalId: goal.id, undispatchable: 3 });
    expect([T1.id, T2.id, rootTaskId]).toContain(root.taskId);
    const rootVerdict = snapshot.verdicts.find(v => v.taskId === root.taskId)!;
    expect(root.reasons.map(r => r.code)).toEqual(rootVerdict.reasons.map(r => r.code));
    expect(root.reasons).toEqual(rosterRows.find(r => r.taskId === root.taskId)!.reasons);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'blocked-roster-pulse.json'), JSON.stringify({ at: snapshot.at, refusals: built.refusals,
      verdicts: snapshot.verdicts, reviewPools: pool, roster, pulse, roleCapacity: capacity, authors: { A: A.id, B: B.id, C: C.id },
      goalRootFactsError: factsError ?? null }, null, 2));
    writeFileSync(join(OUT, 'refusals.json'), JSON.stringify({ refusals: built.refusals, stateBefore: before, stateAfter: await snapshotOfTask(w, T1.id) }, null, 2));
    // The goal card names the three authors (SYS-DISP AC03 R2). On this fork the goal-root facts read fails (see factsError), so the
    // card falls back to the verdict-only card and this contract is not met. Reported as a product defect; the test is not softened.
    // The people the card would name come from the same contributors read the goal-root facts use; that read succeeds here.
    const contrib = await w.wf.contributors(T1.id);
    expect({ authors: contrib.authors, implementer: contrib.implementer }).toEqual({ authors: [A.id, B.id, C.id].sort(), implementer: C.id });
    expect(factsError).toBeUndefined();
    expect(facts!.people.get(T1.id)!.authors).toEqual([A.id, B.id, C.id].sort());
    expect(facts!.people.get(T1.id)!.implementer).toBe(C.id);
  } finally {
    await w.close();
  }
}, 120000);

run('B5 fourth reviewer D: a qualified idle non-author is dispatched to the review and the real core accepts its claim', async () => {
  const w = await openFork('fourth');
  try {
    // Quota at zero on codex while the three authors are placed; grok stays healthy.
    w.quotaRows.push({ provider: 'codex', lowestPct: 0, fetchedAt: new Date().toISOString() } as ProviderQuota,
      { provider: 'grok', lowestPct: 100, fetchedAt: new Date().toISOString() } as ProviderQuota);
    const { A, B, C, T1 } = await buildThreeAuthorReview(w);
    // The seat opens and the codex quota recovers: the controlled fourth person D is the only qualified reviewer.
    await w.wf.upsertDef(FIXTURE_ENG, { role: 'engineering', provider: 'codex', model: 'fixture', maxInstances: 4 });
    w.quotaRows[0] = { provider: 'codex', lowestPct: 100, fetchedAt: new Date().toISOString() } as ProviderQuota;
    const d = w.dispatcher();
    const tick = await d.tick();
    const woke = tick.woke.find(x => x.task === T1.id);
    expect(woke).toBeDefined();
    const D = (await w.wf.insts()).find(i => i.def === FIXTURE_ENG && ![A.id, B.id, C.id].includes(i.id))!;
    expect(woke).toMatchObject({ employee: D.id, spawned: true });
    // D is neither an author nor the implementer of the task.
    const facts = await w.wf.contributors(T1.id);
    expect(facts.excluded).not.toContain(D.id);
    // The real core accepted D's review claim: D holds the review lease, the task is in review, and the audit row is D's review claim.
    const task = await w.core.getTask(w.gm, T1.id);
    expect(task).toMatchObject({ state: 'review', currentEmployee: D.id });
    const history = await w.core.history(w.gm, T1.id);
    expect(history.filter(h => h.action === 'claim' && h.actor === D.id)).toHaveLength(1);
    // D's claim file exists: the sidecar relayed the claim for D through the real core.
    const claimFile = readJsonFile<ClaimResult>(join(w.envs.get(D.paseoAgentId!)!.SCK_COMM_DIR!, 'claim.json'));
    expect(claimFile?.task.id).toBe(T1.id);
    writeFileSync(join(OUT, 'fourth-reviewer.json'), JSON.stringify({ woke, reviewer: D.id, excluded: facts.excluded, task: { state: task.state, currentEmployee: task.currentEmployee, version: task.version } }, null, 2));
  } finally {
    await w.close();
  }
}, 120000);

run('B5 read-only replay of 04195c93: the saved audit history through the product derivation gives authors {3da797, f4978d, b954f0}, reviewer e3d236 and manager_decision', () => {
  expect(existsSync(HISTORY_04195C93)).toBe(true);
  const raw = readFileSync(HISTORY_04195C93);
  const source = JSON.parse(raw.toString('utf8')) as { history: Array<{ action: string; actor: string; version: number; at: string }> };
  const taskId = '04195c93-c792-4012-9f45-7a1fe17950fc';
  const events: ContributionEvent[] = source.history.map(row => ({ action: row.action, actor: row.actor, at: row.at, version: row.version }));
  // The task as the audit states it: the last row is a claim by f4978d in the execute phase, so that holder's open lease is execute.
  const state = 'doing';
  const holder = 'engineering-factory-droid-f4978d';
  const open = openLeaseOf(holder, state);
  const facts = deriveContributors(events, undefined, open);
  const proposal = proposeImplementer(taskId, facts, undefined);
  const timeline = contributionTimeline(events, open);
  expect(facts.authors).toEqual(['engineering-claude-3da797', 'engineering-factory-droid-b954f0', 'engineering-factory-droid-f4978d']);
  expect(new Set(facts.authors)).toEqual(new Set(['engineering-claude-3da797', 'engineering-factory-droid-f4978d', 'engineering-factory-droid-b954f0']));
  expect(facts.reviewers).toEqual(['engineering-claude-e3d236']);
  expect(facts.ambiguous).toBe(true);
  expect(facts.implementer).toBeUndefined();
  expect(facts.excluded).toEqual(facts.authors);
  expect(proposal.status).toBe('manager_decision');
  expect(timeline).toHaveLength(events.length);
  const sha = createHash('sha256').update(raw).digest('hex');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'replay-04195c93.json'), JSON.stringify({
    replay: 'read-only: saved audit history through contributors.ts (the functions contributor_dryrun reads); nothing written',
    taskId, input: { path: HISTORY_04195C93, sha256: sha, rows: events.length, lastVersion: source.history.at(-1)?.version },
    lease: open, authors: facts.authors, reviewers: facts.reviewers, excluded: facts.excluded, implementer: facts.implementer ?? null,
    ambiguous: facts.ambiguous, unknown: facts.unknown, status: proposal.status, note: proposal.note,
    timeline: timeline.map((row, i) => ({ n: i, ...row })),
  }, null, 2));
});
