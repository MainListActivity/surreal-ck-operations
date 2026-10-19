import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ClaimResult, HistoryEntry, ProjectView, TaskView, WorktreeAssignment } from '../src/contracts.ts';
import { CompanyError } from '../src/core-errors.ts';
import {
  CLAIM_LIST_ECHO_BYTES, PROJECT_ECHO_BYTES, RESPONSE_BUDGET_BYTES, echoClaim, fitCount, guardRelayResponse, jsonBytes, longestFittingPrefix,
  openCursor, sealCursor, utf8Prefix, utf8Segment,
} from '../src/response-budget.ts';
import {
  cursorOf, isPaged, pageSizeOf, parseContextInput, parseHistoryInput, parseTextInput, parseWorktreeInput, queryDigest, TASK_FIELDS, taskIdOf,
} from '../src/query-input.ts';

describe('byte budget (SYS01)', () => {
  test('the budget is 48 KiB of serialized UTF-8 for the whole envelope', () => {
    expect(RESPONSE_BUDGET_BYTES).toBe(48 * 1024);
  });

  test('one check covers every response: exactly 48 KiB passes, one byte more is refused (C2)', () => {
    const base = jsonBytes({ ok: true, data: { blob: '' } });
    const exact = { ok: true, data: { blob: 'a'.repeat(RESPONSE_BUDGET_BYTES - base) } };
    expect(jsonBytes(exact)).toBe(RESPONSE_BUDGET_BYTES);
    expect(guardRelayResponse(exact)).toBe(exact);
    const over = { ok: true, data: { blob: 'a'.repeat(RESPONSE_BUDGET_BYTES - base + 1) } };
    expect(jsonBytes(over)).toBe(RESPONSE_BUDGET_BYTES + 1);
    expect(guardRelayResponse(over)).toMatchObject({ ok: false });
  });

  test('sizes are counted in UTF-8 bytes of the serialized JSON, not in characters', () => {
    expect(jsonBytes('中')).toBe(Buffer.byteLength(JSON.stringify('中'), 'utf8'));
    expect(jsonBytes('🙂')).toBe(Buffer.byteLength(JSON.stringify('🙂'), 'utf8'));
    expect(jsonBytes({ text: '中'.repeat(10) })).toBeGreaterThan(jsonBytes({ text: 'a'.repeat(10) }));
  });

  test('a prefix cut at any byte limit ends on a character boundary and round-trips', () => {
    const text = '中文🙂字符'.repeat(40);
    for (let limit = 0; limit < 80; limit++) {
      const cut = utf8Prefix(text, limit);
      expect(cut.bytes).toBeLessThanOrEqual(limit);
      expect(cut.text).not.toContain('�');
      expect(Buffer.from(cut.text, 'utf8').toString('utf8')).toBe(cut.text);
    }
    expect(utf8Prefix('abc', 10)).toMatchObject({ text: 'abc', bytes: 3, total: 3 });
  });

  test('segments reassemble to the exact original bytes and always make progress', () => {
    const text = '中文🙂字符'.repeat(400);
    const pieces: Buffer[] = [];
    let offset: number | null = 0;
    let steps = 0;
    while (offset !== null) {
      const segment = utf8Segment(text, offset, 97);
      expect(segment.bytes).toBeGreaterThan(0);
      expect(segment.bytes).toBeLessThanOrEqual(97);
      pieces.push(Buffer.from(segment.text, 'utf8'));
      offset = segment.next;
      steps++;
    }
    expect(steps).toBeGreaterThan(1);
    expect(Buffer.concat(pieces).toString('utf8')).toBe(text);
  });

  test('an offset inside a character moves forward to the next boundary', () => {
    const segment = utf8Segment('中文', 1, 100);
    expect(segment.offset).toBe(3);
    expect(segment.text).toBe('文');
    expect(segment.next).toBeNull();
  });

  test('fitCount keeps the largest prefix that fits and nothing that does not', () => {
    const items = Array.from({ length: 200 }, (_, index) => ({ index, text: '中'.repeat(40) }));
    const kept = fitCount(items, rows => rows, 4000);
    expect(kept).toBeGreaterThan(0);
    expect(jsonBytes(items.slice(0, kept))).toBeLessThanOrEqual(4000);
    expect(jsonBytes(items.slice(0, kept + 1))).toBeGreaterThan(4000);
    expect(fitCount(items, rows => rows, 1)).toBe(0);
    expect(fitCount([], rows => rows, 10)).toBe(0);
  });

  test('a text that is over budget on its own keeps the longest prefix that fits, cut between characters and counted as JSON (C3)', () => {
    const text = '中文🙂字符"\n'.repeat(4000);
    const fits = (prefix: string) => jsonBytes({ id: 'x', context: prefix, contextTruncated: true }) <= RESPONSE_BUDGET_BYTES;
    const kept = longestFittingPrefix(text, fits);
    expect(text.startsWith(kept)).toBe(true);
    expect(fits(kept)).toBe(true);
    expect(fits([...text].slice(0, [...kept].length + 1).join(''))).toBe(false);
    expect(Buffer.from(kept, 'utf8').toString('utf8')).toBe(kept);
    expect(longestFittingPrefix('abc', fits)).toBe('abc');
    expect(longestFittingPrefix('中', () => false)).toBe('');
  });

  test('the relay guard turns an over-budget success into a recoverable, JSON-legal error', () => {
    const guarded = guardRelayResponse({ ok: true, data: { blob: '中文🙂'.repeat(20_000) } });
    expect(guarded.ok).toBe(false);
    expect(String((guarded as { error?: string }).error)).toContain('response_too_large');
    expect(guarded).toMatchObject({ ok: false, code: 'response_too_large', retryable: false });
    expect(JSON.parse(JSON.stringify(guarded))).toMatchObject({ ok: false });
    const small = { ok: true, data: { n: 1 } };
    expect(guardRelayResponse(small)).toBe(small);
    const failed = { ok: false, error: 'invalid: pageSize' };
    expect(guardRelayResponse(failed)).toBe(failed);
  });
});

describe('cursors (SYS01)', () => {
  const key = randomBytes(32);
  const body = {
    v: 1 as const, k: 'context' as const, c: 'eng-1', q: 'digest', sid: randomUUID(), seq: 40, exp: Date.now() + 60_000,
  };

  test('a sealed cursor round-trips and verifies', () => {
    const token = sealCursor(body, key);
    expect(token.startsWith('v1.')).toBe(true);
    expect(openCursor(token, key, Date.now())).toEqual(body);
  });

  test('tampering, a foreign key and malformed input are refused as invalid; an expired cursor names a gone listing (C4)', () => {
    const token = sealCursor(body, key);
    const altered = token.slice(0, 4) + (token[4] === 'A' ? 'B' : 'A') + token.slice(5);
    expect(() => openCursor(altered, key, Date.now())).toThrow(/verification/);
    expect(() => openCursor(token, randomBytes(32), Date.now())).toThrow(/verification/);
    expect(() => openCursor('v1.onlyonepart', key, Date.now())).toThrow(/malformed/);
    expect(() => openCursor('v2.a.b', key, Date.now())).toThrow(/malformed/);
    expect(() => openCursor('x'.repeat(5000), key, Date.now())).toThrow(/malformed/);
    expect(() => openCursor(sealCursor({ ...body, seq: -1 }, key), key, Date.now())).toThrow(/malformed/);
    expect(() => openCursor(sealCursor({ ...body, sid: undefined as never }, key), key, Date.now())).toThrow(/malformed/);
    expect(() => openCursor(token, key, body.exp + 1)).toThrow(/expired/);
    const refusals: Array<[() => unknown, CompanyError['code']]> = [
      [() => openCursor(altered, key, Date.now()), 'invalid'],
      [() => openCursor(token, key, body.exp + 1), 'snapshot_gone'],
    ];
    for (const [attempt, code] of refusals) {
      try {
        attempt();
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(CompanyError);
        expect((error as CompanyError).code).toBe(code);
      }
    }
  });
});

describe('argument parsing (SYS01)', () => {
  test('page size is an integer from 1 to 100 and defaults to 25', () => {
    expect(pageSizeOf(undefined)).toBe(25);
    expect(pageSizeOf(1)).toBe(1);
    expect(pageSizeOf(100)).toBe(100);
    for (const bad of [0, 101, 1.5, '10', Number.NaN]) expect(() => pageSizeOf(bad)).toThrow(/pageSize/);
  });

  test('cursors are bounded strings', () => {
    expect(cursorOf(undefined)).toBeUndefined();
    expect(cursorOf('v1.a.b')).toBe('v1.a.b');
    expect(() => cursorOf('')).toThrow(/cursor/);
    expect(() => cursorOf('x'.repeat(3000))).toThrow(/cursor/);
    expect(() => cursorOf(7)).toThrow(/cursor/);
  });

  test('context filters are enumerated or validated, and projection is limited to task fields', () => {
    expect(() => parseContextInput({ state: 'bogus' })).toThrow(/state/);
    expect(() => parseContextInput({ role: 'root' })).toThrow(/role/);
    expect(() => parseContextInput({ since: 'yesterday' })).toThrow(/since/);
    expect(() => parseContextInput({ fields: ['password'] })).toThrow(/unknown task field/);
    expect(() => parseContextInput({ fields: [] })).toThrow(/fields/);
    expect(parseContextInput({ fields: ['id', 'id', 'title'] }).fields).toEqual(['id', 'title']);
    expect(TASK_FIELDS).toContain('state');
    expect(TASK_FIELDS).not.toContain('password');
  });

  test('the paged shape applies only when pageSize or cursor is named; any other call is legacy (C1, C2)', () => {
    expect(parseContextInput({}).paged).toBe(false);
    expect(parseContextInput({}).includeCompany).toBe(true);
    expect(parseContextInput({ pageSize: 5 }).paged).toBe(true);
    expect(parseContextInput({ pageSize: 5 }).includeCompany).toBe(false);
    expect(parseContextInput({ pageSize: 5, includeCompany: true }).includeCompany).toBe(true);
    expect(parseContextInput({ cursor: 'v1.a.b' }).paged).toBe(true);
    expect(parseHistoryInput({}).paged).toBe(false);
    expect(parseHistoryInput({ pageSize: 3 }).paged).toBe(true);
  });

  test('history and text arguments are bounded; expectSha256 must be a lowercase SHA-256 digest (C3)', () => {
    expect(parseHistoryInput({}).pageSize).toBe(25);
    expect(() => parseHistoryInput({ pageSize: 0 })).toThrow(/pageSize/);
    expect(() => parseTextInput({ taskId: 't', field: 'bogus' })).toThrow(/field/);
    expect(() => parseTextInput({ taskId: 't', field: 'context', offset: -1 })).toThrow(/offset/);
    expect(() => parseTextInput({ taskId: 't', field: 'context', limit: 999_999 })).toThrow(/limit/);
    expect(() => parseTextInput({ field: 'context' })).toThrow(/taskId/);
    expect(parseTextInput({ taskId: 't', field: 'context' })).toMatchObject({ offset: 0, limit: 16 * 1024 });
    const digest = 'a'.repeat(64);
    expect(parseTextInput({ taskId: 't', field: 'context', expectSha256: digest })).toMatchObject({ expectSha256: digest });
    // A read past offset 0 must pin the digest of the text it started with, so two versions are never mixed (C3).
    expect(() => parseTextInput({ taskId: 't', field: 'context', offset: 4 })).toThrow(/expectSha256/);
    expect(parseTextInput({ taskId: 't', field: 'context', offset: 4, expectSha256: digest })).toMatchObject({ offset: 4 });
    expect(() => parseTextInput({ taskId: 't', field: 'context', expectSha256: 'A'.repeat(64) })).toThrow(/expectSha256/);
    expect(() => parseTextInput({ taskId: 't', field: 'context', expectSha256: 'abc' })).toThrow(/expectSha256/);
  });

  test('query digests ignore key order and change with every filter', () => {
    const a = queryDigest('context', { state: 'ready', goalId: 'g1' });
    expect(queryDigest('context', { goalId: 'g1', state: 'ready' })).toBe(a);
    expect(queryDigest('context', { state: 'ready', goalId: 'g2' })).not.toBe(a);
    expect(queryDigest('history', { state: 'ready', goalId: 'g1' })).not.toBe(a);
  });
});

describe('null arguments (SYS01, defect 2)', () => {
  test('null is absent on every optional read argument, and a null task id is refused as invalid', () => {
    expect(isPaged({ pageSize: null })).toBe(false);
    expect(isPaged({ cursor: null })).toBe(false);
    expect(isPaged({ pageSize: null, cursor: null })).toBe(false);
    expect(isPaged({ pageSize: 25 })).toBe(true);
    expect(parseContextInput({ pageSize: null, cursor: null, taskId: null }).paged).toBe(false);
    const worktrees = parseWorktreeInput({ pageSize: null, cursor: null, taskId: null });
    expect(worktrees.paged).toBe(false);
    expect(worktrees.taskId).toBeUndefined();
    expect(parseHistoryInput({ pageSize: null, cursor: null }).paged).toBe(false);
    expect(parseTextInput({ taskId: 't', field: 'context', offset: null, limit: null })).toMatchObject({ offset: 0, limit: 16 * 1024 });
    expect(() => taskIdOf(null)).toThrow(/taskId/);
    expect(() => taskIdOf('   ')).toThrow(/taskId/);
    expect(taskIdOf('task-1')).toBe('task-1');
  });
});

describe('claim echo (SYS01, return of 04195c93)', () => {
  const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
  // 300 characters of CJK, 892 bytes: the longest path the intent validation accepts (validateIntent, dispatcher worktree registry).
  const cjkPath = (index: number): string => `${String(index).padStart(3, '0')}-${'甲'.repeat(296)}`;
  const worktreeOf = (paths?: string[]): WorktreeAssignment => ({
    id: 'wt-claim', repo: '/repos/proj', worktreePath: '/wt/claim', mode: 'exclusive', discipline: '代码',
    intent: paths ? { kind: 'assets', paths } : { kind: 'code' },
  } as unknown as WorktreeAssignment);
  const project = (extra: Partial<ProjectView> = {}): ProjectView => ({
    id: 'proj', name: '项目', repoPath: '/repos/proj', defaultBranch: 'main', release: 'merge, then CI deploys',
    redLines: ['no secrets in evidence'], runbooks: [], envs: [], ...extra,
  });
  const entry = (index: number): HistoryEntry => ({
    auditId: `audit-${index}`, action: 'checkpoint', actor: 'eng-01', version: index, at: '2026-10-19T18:00:00.000Z',
    evidence: '证'.repeat(680), evidenceTruncated: true,
  });
  const claimWith = (context: string, claim: Partial<ClaimResult> = {}, task: Partial<TaskView> = {}): ClaimResult => ({
    task: {
      id: 'task-claim', title: '认领回显', context, state: 'doing', executorRole: 'engineering', reviewerRole: 'qa', kind: 'task',
      dependencies: [], version: 4, fence: 3, currentEmployee: 'eng-01', deliveryId: 'delivery-claim', leaseExpiresAt: '2026-10-19T19:00:00.000Z',
      ...task,
    },
    deliveryId: 'delivery-claim', fence: 3, leaseExpiresAt: '2026-10-19T19:00:00.000Z', history: [], historyComplete: true,
    ...claim,
  });
  const envelope = (data: unknown): number => jsonBytes({ ok: true, data });

  test('a claim within the budget is echoed whole: lease, history, project and worktree come back as they are', () => {
    const worktree = worktreeOf();
    const echo = echoClaim(claimWith('短正文', { worktree, project: project(), history: [entry(1)] }, { worktree }));
    expect(echo).toMatchObject({
      deliveryId: 'delivery-claim', fence: 3, leaseExpiresAt: '2026-10-19T19:00:00.000Z', historyComplete: true,
      history: [entry(1)], project: project(), worktree,
    });
    expect(echo.projectTruncated).toBeUndefined();
    expect(echo.task).toMatchObject({ id: 'task-claim', context: '短正文', contextTruncated: false, contextBytes: utf8('短正文') });
    expect(echo.task.worktree).toBeUndefined();
    expect(envelope(echo)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  });

  test('a claim over the budget keeps its lease and cuts the context; the cut is flagged and the whole text has the digest', () => {
    // 19,000 Chinese characters are 57,000 bytes: the claim is over the budget on its own.
    const context = '甲'.repeat(19_000);
    const echo = echoClaim(claimWith(context, { history: Array.from({ length: 6 }, (_, i) => entry(i)), project: project() }));
    expect(envelope(echo)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(echo).toMatchObject({ deliveryId: 'delivery-claim', fence: 3, leaseExpiresAt: '2026-10-19T19:00:00.000Z', historyComplete: true });
    expect(echo.history).toHaveLength(6);
    expect(echo.task).toMatchObject({ contextTruncated: true, contextBytes: utf8(context), contextSha256: sha256(context) });
    expect(context.startsWith(echo.task.context)).toBe(true);
    expect(echo.task.contextNextOffset).toBe(utf8(echo.task.context));
    expect(Buffer.from(context, 'utf8').subarray(echo.task.contextNextOffset!).toString('utf8')).toBe(context.slice(echo.task.context.length));
  });

  test('a project over PROJECT_ECHO_BYTES is echoed by identity with its size and digest; an identity over the cap is not echoed', () => {
    const large = project({ notes: '注'.repeat(5_000), runbooks: Array.from({ length: 40 }, (_, i) => `runbook-${i}-${'r'.repeat(200)}`) });
    expect(jsonBytes(large)).toBeGreaterThan(PROJECT_ECHO_BYTES);
    const echo = echoClaim(claimWith('短正文', { project: large }));
    expect(echo.project).toEqual({ id: 'proj', name: '项目', repoPath: '/repos/proj', defaultBranch: 'main', release: 'merge, then CI deploys' });
    expect(echo).toMatchObject({ projectTruncated: true, projectBytes: jsonBytes(large), projectSha256: sha256(JSON.stringify(large)) });
    const huge = echoClaim(claimWith('短正文', { project: project({ release: 'r'.repeat(PROJECT_ECHO_BYTES + 1) }) }));
    expect(huge.project).toBeUndefined();
    expect(huge).toMatchObject({ projectTruncated: true, deliveryId: 'delivery-claim' });
    expect(envelope(huge)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  });

  test('a list over CLAIM_LIST_ECHO_BYTES is cut to its longest prefix, counted and digested; a short list is whole', () => {
    const dependencies = Array.from({ length: 1_000 }, (_, i) => `task-${String(i).padStart(4, '0')}-${'d'.repeat(40)}`);
    const paths = Array.from({ length: 50 }, (_, i) => cjkPath(i));
    const worktree = worktreeOf(paths);
    const echo = echoClaim(claimWith('短正文', { worktree }, { dependencies, workIntent: { kind: 'assets', paths }, worktree }));
    expect(envelope(echo)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(echo.task.dependencies.length).toBeGreaterThan(0);
    expect(echo.task.dependencies).toEqual(dependencies.slice(0, echo.task.dependencies.length));
    expect(jsonBytes(echo.task.dependencies)).toBeLessThanOrEqual(CLAIM_LIST_ECHO_BYTES);
    expect(echo.task.workIntent?.paths).toEqual(paths.slice(0, echo.task.workIntent?.paths?.length));
    expect(echo.worktree?.intent.paths).toEqual(paths.slice(0, echo.worktree?.intent.paths?.length));
    expect(echo.listsTruncated).toEqual({
      dependencies: { count: 1_000, sha256: sha256(JSON.stringify(dependencies)) },
      workIntentPaths: { count: 50, sha256: sha256(JSON.stringify(paths)) },
      worktreePaths: { count: 50, sha256: sha256(JSON.stringify(paths)) },
    });
    const short = echoClaim(claimWith('短正文', {}, { dependencies: ['task-a'], workIntent: { kind: 'assets', paths: ['assets/a'] } }));
    expect(short.listsTruncated).toBeUndefined();
    expect(short.task).toMatchObject({ dependencies: ['task-a'], workIntent: { kind: 'assets', paths: ['assets/a'] } });
  });

  test('legal maxima together still answer within the budget: title, lists, project, a full handover window, six predecessors, a 20,000-character context', () => {
    const dependencies = Array.from({ length: 200 }, (_, i) => `task-${String(i).padStart(4, '0')}-${'d'.repeat(120)}`);
    const paths = Array.from({ length: 50 }, (_, i) => cjkPath(i));
    const worktree = worktreeOf(paths);
    const context = '甲'.repeat(20_000);
    const predecessors = Array.from({ length: 6 }, (_, i) => ({
      employee: `eng-${i}-${'e'.repeat(60)}`, agentId: 'a'.repeat(64), provider: 'claude', role: 'engineering', retired: false,
    }));
    const echo = echoClaim(claimWith(context, {
      worktree, predecessors, history: Array.from({ length: 8 }, (_, i) => entry(i)),
      project: project({ release: '甲'.repeat(2_600), runbooks: Array.from({ length: 20 }, () => '甲'.repeat(60)) }),
    }, { title: '甲'.repeat(200), dependencies, workIntent: { kind: 'assets', paths }, worktree }));
    expect(envelope(echo)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(echo).toMatchObject({ deliveryId: 'delivery-claim', fence: 3, leaseExpiresAt: '2026-10-19T19:00:00.000Z' });
    expect(echo.task).toMatchObject({ title: '甲'.repeat(200), contextTruncated: true, contextBytes: utf8(context), contextSha256: sha256(context) });
    expect(Object.keys(echo.listsTruncated ?? {}).sort()).toEqual(['dependencies', 'workIntentPaths', 'worktreePaths']);
  });

  test('history over the room left by the other fields is left out (historyComplete turns false); the lease and the task stay whole', () => {
    // Core keeps the handover window at 16 KiB, so this is beyond any real claim: the echo still answers, as a safety net.
    const echo = echoClaim(claimWith('短正文', { history: Array.from({ length: 30 }, (_, i) => entry(i)) }));
    expect(envelope(echo)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(echo).toMatchObject({ deliveryId: 'delivery-claim', fence: 3, historyComplete: false, history: [] });
    expect(echo.task).toMatchObject({ context: '短正文', contextTruncated: false });
  });
});
