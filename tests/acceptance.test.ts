// SYS02 unit tests for the pure acceptance model: validation, defaults and the unified evaluator. No database.
import { describe, expect, test } from 'bun:test';
import {
  acceptanceError, createGithubActionsAdapter, criteriaForLeg, defaultAcceptanceCriteria, evaluateAcceptance, humanSignoffs,
  validateAcceptanceCriteria, type AcceptanceActor, type AcceptanceSubject,
} from '../src/acceptance.ts';
import type { AcceptanceCriterion, AcceptanceEvidenceRecord, AcceptanceGateView } from '../src/contracts.ts';
import { CompanyError } from '../src/core-errors.ts';

const machine = (over: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion =>
  ({ id: 'AC-1', kind: 'machine', required: true, layer: 'ci', evidence: 'ci-run', verify: 'ci', ...over });
const human = (over: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion =>
  ({ id: 'AC-2', kind: 'human', required: true, layer: 'manual', evidence: 'review-signoff', verify: 'independent-review', ...over });
const gate = (over: Partial<AcceptanceGateView> = {}): AcceptanceGateView =>
  ({ version: 1, enabled: true, enabledAt: '2026-10-21T00:00:00.000Z', scope: 'code-deliveries', criteriaVersion: 1, ...over });
const subject = (over: Partial<AcceptanceSubject> = {}): AcceptanceSubject => ({
  id: 't1', kind: 'task', workIntent: { kind: 'code' }, acceptanceHead: 'head-1',
  submittedBy: 'eng', reviewerRole: 'engineering', createdAt: '2026-10-21T00:00:01.000Z', ...over,
});
const actor = (over: Partial<AcceptanceActor> = {}): AcceptanceActor =>
  ({ employeeId: 'rev', role: 'engineering', human: true, ...over });
const row = (over: Partial<AcceptanceEvidenceRecord> = {}): AcceptanceEvidenceRecord => ({
  id: 'e1', taskId: 't1', acId: 'AC-1', kind: 'machine', sha: 'head-1', evidenceType: 'ci-run', source: {},
  verified: true, verifier: 'github-actions', actor: 'eng', at: '2026-10-21T00:00:02.000Z',
  criteriaVersion: 1, taskVersion: 1, digest: 'd1', ...over,
});
const verdictOf = (over: Parameters<typeof evaluateAcceptance>[0]) => evaluateAcceptance(over);

describe('SYS02 acceptance criteria (AC01)', () => {
  test('ids are unique; kind and evidence type cannot be mixed; unknown fields fail closed', () => {
    expect(() => validateAcceptanceCriteria([{ ...machine(), required: 'yes' }])).toThrow(/required/);
    expect(() => validateAcceptanceCriteria([machine(), machine()])).toThrow(/duplicate/);
    expect(() => validateAcceptanceCriteria([{ ...machine(), id: 'nope' }])).toThrow(/id/);
    expect(() => validateAcceptanceCriteria([machine({ evidence: 'review-signoff' })])).toThrow(/machine criteria/);
    expect(() => validateAcceptanceCriteria([human({ evidence: 'ci-run' })])).toThrow(/human criteria/);
    expect(() => validateAcceptanceCriteria([{ ...machine(), layer: 'vibes' } as never])).toThrow(/layer/);
    expect(() => validateAcceptanceCriteria([{ ...machine(), risk: 'magic' } as never])).toThrow(/risk/);
    expect(() => validateAcceptanceCriteria([{ ...machine(), legs: ['nope'] } as never])).toThrow(/legs/);
    expect(() => validateAcceptanceCriteria([])).toThrow(/non-empty/);
    expect(() => validateAcceptanceCriteria(Array.from({ length: 21 }, (_, i) => machine({ id: `AC-${i}` })))).toThrow(/20/);
  });

  test('defaults cover each delivery leg, and a leg filter keeps only criteria that name it or name no leg', () => {
    for (const leg of ['implement', 'release', 'deploy'] as const) {
      const defaults = defaultAcceptanceCriteria(leg);
      expect(defaults.length).toBeGreaterThan(0);
      expect(defaults.every(criterion => criterion.required)).toBe(true);
      expect(defaults.some(criterion => criterion.kind === 'machine')).toBe(true);
    }
    const criteria = [machine({ id: 'AC-1', legs: ['implement'] }), human({ id: 'AC-2', legs: ['deploy'] }), machine({ id: 'AC-3' })];
    expect(criteriaForLeg(criteria, 'implement').map(c => c.id)).toEqual(['AC-1', 'AC-3']);
    expect(criteriaForLeg(criteria, 'deploy').map(c => c.id)).toEqual(['AC-2', 'AC-3']);
  });
});

describe('SYS02 unified evaluator (AC02/AC03/AC05)', () => {
  test('gate off allows old work as legacy; an enabled gate refuses a new code delivery with no criteria', () => {
    expect(verdictOf({ subject: subject({ acceptanceCriteria: undefined }), evidence: [], phase: 'submit', actor: actor(), gate: gate({ enabled: false }) }))
      .toMatchObject({ ok: true, legacy: true });
    expect(verdictOf({ subject: subject({ acceptanceCriteria: undefined }), evidence: [], phase: 'submit', actor: actor(), gate: gate() }))
      .toMatchObject({ ok: false, unmet: [{ acId: '*', reason: 'structured-acceptance-criteria-required' }] });
    expect(verdictOf({ subject: subject({ kind: 'gate', workIntent: undefined, acceptanceCriteria: undefined }), evidence: [], phase: 'owner', actor: actor({ role: 'owner', owner: true }), gate: gate() }))
      .toMatchObject({ ok: true, notApplicable: true });
    expect(verdictOf({ subject: subject({ acceptanceCriteria: undefined, createdAt: '2026-10-20T00:00:00.000Z' }), evidence: [], phase: 'submit', actor: actor(), gate: gate() }))
      .toMatchObject({ ok: true, legacy: true });
  });

  test('a machine AC needs verified evidence of the named type, bound to the current head and environment', () => {
    const criteria = [machine()];
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [row()], phase: 'submit', actor: actor(), gate: gate() }).ok).toBe(true);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [row({ sha: 'old-head' })], phase: 'submit', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-1', reason: 'machine-evidence-missing-or-untrusted' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [row({ verified: false })], phase: 'submit', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-1', reason: 'machine-evidence-missing-or-untrusted' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [row({ evidenceType: 'artifact' })], phase: 'submit', actor: actor(), gate: gate() }).ok).toBe(false);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, acceptanceEnvironment: 'production' }), evidence: [row({ environment: 'staging' })], phase: 'submit', actor: actor(), gate: gate() }).ok).toBe(false);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, acceptanceHead: undefined }), evidence: [row()], phase: 'submit', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-1', reason: 'submission-head-missing' }]);
  });

  test('a human AC is pending at submit and must be signed by the authorized reviewer, never the submitter or a machine', () => {
    const criteria = [human()];
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [], phase: 'submit', actor: actor(), gate: gate() }).ok).toBe(true);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [], phase: 'accept', actor: actor(), gate: gate() }).ok).toBe(true);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [], phase: 'accept', actor: actor({ employeeId: 'eng' }), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-2', reason: 'self-review' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, reviewerRole: 'qa' }), evidence: [], phase: 'accept', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-2', reason: 'reviewer-role-mismatch' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [], phase: 'release', actor: actor({ employeeId: 'jev', role: 'product', human: false }), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-2', reason: 'human-signoff-required' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, reviewerRole: 'owner' }), evidence: [], phase: 'owner', actor: actor({ employeeId: 'owner', role: 'owner', owner: true }), gate: gate() }).ok).toBe(true);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, reviewerRole: 'owner' }), evidence: [], phase: 'owner', actor: actor({ role: 'product' }), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-2', reason: 'owner-signoff-required' }]);
  });

  test('the refusal names every unmet AC and carries the structured list', () => {
    const verdict = verdictOf({
      subject: subject({ acceptanceCriteria: [machine(), human({ id: 'AC-2' })] }), evidence: [],
      phase: 'accept', actor: actor({ employeeId: 'eng' }), gate: gate(),
    });
    const error = acceptanceError(verdict);
    expect(error).toBeInstanceOf(CompanyError);
    expect(error.message).toContain('AC-1:machine-evidence-missing-or-untrusted');
    expect(error.message).toContain('AC-2:self-review');
    expect(error.details).toMatchObject({ unmet: verdict.unmet, phase: 'accept' });
  });
});

describe('SYS02 human sign-offs', () => {
  test('the digest is unique per task, criterion, signer and attempt, and the head is the signed sha', () => {
    const verdict = verdictOf({
      subject: subject({ acceptanceCriteria: [human()] }), evidence: [], phase: 'accept', actor: actor(), gate: gate(),
    });
    const first = humanSignoffs(verdict, 't1', 'rev', 1);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ acId: 'AC-2', sha: 'head-1', criteriaVersion: 1 });
    expect(humanSignoffs(verdict, 't1', 'rev', 1)[0]!.digest).toBe(first[0]!.digest);
    expect(humanSignoffs(verdict, 't1', 'rev', 2)[0]!.digest).not.toBe(first[0]!.digest);
    expect(humanSignoffs(verdict, 't1', 'other', 1)[0]!.digest).not.toBe(first[0]!.digest);
    expect(humanSignoffs(verdict, 't2', 'rev', 1)[0]!.digest).not.toBe(first[0]!.digest);
  });
});


describe('SYS02 GitHub Actions adapter (AC02/AC04)', () => {
  const record = {
    probe: 'acceptance', runId: '42', jobId: 'probe', readAt: '2026-10-21T00:00:30.000Z', inProgress: true,
    observationHash: 'a'.repeat(64), target: 'http://probe', kind: 'url', result: 'ok',
  };
  const runLog: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    runLog.push(args);
    if (args[0] === 'run' && args[1] === 'view') {
      return JSON.stringify({ headSha: 'head-1', status: 'completed', conclusion: 'success', workflowName: 'probe',
        createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:01:00.000Z' });
    }
    if (args[0] === 'api' && String(args[1]).includes('/actions/artifacts/7')) {
      return JSON.stringify({ id: 7, name: 'acceptance-probe', expired: false, workflow_run: { id: 42, head_sha: 'head-1' } });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const readArtifact = async () => ({ name: 'acceptance-probe.json', content: JSON.stringify(record) });
  const base = { provider: 'github-actions' as const, runUrl: 'https://github.com/o/r/actions/runs/42', artifactId: '7', sha: 'head-1' };
  const probe = { runId: '42', jobId: 'probe', readAt: record.readAt, inProgress: true, observationHash: record.observationHash };

  test('a probe is verified from its CI artifact, not from the caller record', async () => {
    const adapter = createGithubActionsAdapter(run, readArtifact);
    expect(await adapter.verify({ ...base, probe })).toMatchObject({ ok: true });
    // No artifact: a window-shaped caller record alone is refused.
    expect((await adapter.verify({ ...base, artifactId: undefined, probe })).ok).toBe(false);
    // The caller's attested hash is not the artifact's record.
    expect((await adapter.verify({ ...base, probe: { ...probe, observationHash: 'b'.repeat(64) } })).ok).toBe(false);
    // The artifact cannot be read or is of another run.
    expect((await adapter.verify({ ...base, artifactId: '8', probe })).ok).toBe(false);
    // The artifact record read outside the run window.
    const late = { ...record, readAt: '2026-10-21T00:02:00.000Z' };
    const lateAdapter = createGithubActionsAdapter(run, async () => ({ name: 'late.json', content: JSON.stringify(late) }));
    expect((await lateAdapter.verify({ ...base, probe: { ...probe, readAt: late.readAt } })).ok).toBe(false);
    // The artifact belongs to another run.
    const otherRun = async (args: string[]) => args[0] === 'api'
      ? JSON.stringify({ id: 8, name: 'acceptance-probe', expired: false, workflow_run: { id: 43, head_sha: 'head-1' } })
      : run(args);
    expect((await createGithubActionsAdapter(otherRun, readArtifact).verify({ ...base, probe })).ok).toBe(false);
    expect(runLog.some(args => args[0] === 'run' && args[1] === 'view')).toBe(true);
  });
});
