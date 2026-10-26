import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = join(import.meta.dir, '..');
// SYS02 unit tests for the pure acceptance model: validation, defaults and the unified evaluator. No database.
import { describe, expect, test } from 'bun:test';
import {
  acceptanceError, createGithubActionsAdapter, criteriaForLeg, defaultAcceptanceCriteria, evaluateAcceptance, humanSignoffs,
  mergeAcceptanceCriteria, validateAcceptanceCriteria, type AcceptanceActor, type AcceptanceSubject,
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
  criteriaVersion: 1, taskVersion: 1, attempt: 0, digest: 'd1', ...over,
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
    expect(() => validateAcceptanceCriteria([{ ...machine(), environment: 'Production' } as never])).toThrow(/environment/);
    expect(() => validateAcceptanceCriteria([{ ...machine(), environment: 'has space' } as never])).toThrow(/environment/);
    expect(() => validateAcceptanceCriteria([])).toThrow(/non-empty/);
    expect(() => validateAcceptanceCriteria(Array.from({ length: 21 }, (_, i) => machine({ id: `AC-${i}` })))).toThrow(/20/);
  });

  test('the server baseline cannot be removed or downgraded; a caller-set only supplements it', () => {
    const optional = machine({ id: 'AC-OPTIONAL', required: false });
    const merged = mergeAcceptanceCriteria('implement', [optional]);
    expect(merged.map(criterion => criterion.id)).toEqual(['AC-OPTIONAL', 'AC-BASE-IMPL-1', 'AC-BASE-IMPL-2']);
    expect(() => mergeAcceptanceCriteria('implement', [machine({ id: 'AC-BASE-IMPL-1', required: false })])).toThrow(/baseline/);
    expect(() => mergeAcceptanceCriteria('deploy', [human({ id: 'AC-BASE-RELEASE-2' })])).toThrow(/baseline ids/);
    // A human-only or all-optional set still gets the required machine check.
    expect(mergeAcceptanceCriteria('implement', [human()]).map(criterion => criterion.id)).toContain('AC-BASE-IMPL-1');
    // The evaluator merges it too, so a row written before the fix cannot reach review without the machine evidence.
    const verdict = verdictOf({ subject: subject({ acceptanceCriteria: [optional] }), evidence: [], phase: 'submit', actor: actor(), gate: gate() });
    expect(verdict.ok).toBe(false);
    expect(verdict.unmet.some(item => item.acId === 'AC-BASE-IMPL-1')).toBe(true);
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
    const baselineOnly = verdictOf({ subject: subject({ acceptanceCriteria: undefined }), evidence: [], phase: 'submit', actor: actor(), gate: gate() });
    expect(baselineOnly.ok).toBe(false);
    expect(baselineOnly.criteria.map(criterion => criterion.id)).toEqual(['AC-BASE-IMPL-1', 'AC-BASE-IMPL-2']);
    expect(baselineOnly.unmet).toEqual([{ acId: 'AC-BASE-IMPL-1', reason: 'machine-evidence-missing-or-untrusted' }]);
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
    // N1: undefined never wildcards a declared environment, and a generic criterion never accepts environment-labeled evidence.
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, acceptanceEnvironment: 'production' }), evidence: [row({ environment: 'production' })], phase: 'submit', actor: actor(), gate: gate() }).ok).toBe(true);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, acceptanceEnvironment: 'production' }), evidence: [row()], phase: 'submit', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-1', reason: 'machine-evidence-wrong-environment' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [row({ environment: 'production' })], phase: 'submit', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-1', reason: 'machine-evidence-wrong-environment' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: [machine({ environment: 'production' })] }), evidence: [row({ environment: 'production' })], phase: 'submit', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-1', reason: 'environment-mismatch' }]);
    // N2: the attempt and the criteria version are part of the machine match; checkpoint version changes are not.
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, acceptanceAttempt: 2 }), evidence: [row({ attempt: 1 })], phase: 'submit', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-1', reason: 'machine-evidence-wrong-attempt' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, acceptanceAttempt: 2 }), evidence: [row({ attempt: 2 })], phase: 'submit', actor: actor(), gate: gate() }).ok).toBe(true);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: [row({ criteriaVersion: 2 })], phase: 'submit', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-1', reason: 'machine-evidence-stale-criteria-version' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, acceptanceAttempt: 1, taskVersion: 7 }), evidence: [row({ attempt: 1, taskVersion: 1 })], phase: 'submit', actor: actor(), gate: gate() }).ok).toBe(true);
  });

  test('a human AC is pending at submit and must be signed by the authorized reviewer, never the submitter or a machine', () => {
    const criteria = [human()];
    const machineEvidence = [row({ acId: 'AC-BASE-IMPL-1' })];
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: machineEvidence, phase: 'submit', actor: actor(), gate: gate() }).ok).toBe(true);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: machineEvidence, phase: 'accept', actor: actor(), gate: gate() }).ok).toBe(true);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: machineEvidence, phase: 'accept', actor: actor({ employeeId: 'eng' }), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-2', reason: 'self-review' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, reviewerRole: 'qa' }), evidence: machineEvidence, phase: 'accept', actor: actor(), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-2', reason: 'reviewer-role-mismatch' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria }), evidence: machineEvidence, phase: 'release', actor: actor({ employeeId: 'jev', role: 'product', human: false }), gate: gate() }).unmet)
      .toEqual([{ acId: 'AC-2', reason: 'human-signoff-required' }]);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, reviewerRole: 'owner' }), evidence: machineEvidence, phase: 'owner', actor: actor({ employeeId: 'owner', role: 'owner', owner: true }), gate: gate() }).ok).toBe(true);
    expect(verdictOf({ subject: subject({ acceptanceCriteria: criteria, reviewerRole: 'owner' }), evidence: machineEvidence, phase: 'owner', actor: actor({ role: 'product' }), gate: gate() }).unmet)
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
    expect(first[0]).toMatchObject({ acId: 'AC-2', sha: 'head-1', criteriaVersion: 1, attempt: 1 });
    expect(humanSignoffs(verdict, 't1', 'rev', 1)[0]!.digest).toBe(first[0]!.digest);
    expect(humanSignoffs(verdict, 't1', 'rev', 2)[0]!.digest).not.toBe(first[0]!.digest);
    expect(humanSignoffs(verdict, 't1', 'other', 1)[0]!.digest).not.toBe(first[0]!.digest);
    expect(humanSignoffs(verdict, 't2', 'rev', 1)[0]!.digest).not.toBe(first[0]!.digest);
  });
});


describe('SYS02 GitHub Actions adapter (AC02/AC04)', () => {
  const annotation = { context: 'acceptance-barrier', description: 'target-ready' };
  const annotationHash = createHash('sha256').update(JSON.stringify(annotation)).digest('hex');
  const record = {
    probe: 'acceptance', runId: '42', jobId: 'probe', readAt: '2026-10-21T00:00:30.000Z', inProgress: true,
    observationHash: annotationHash, target: 'o/r/Acceptance target/target', kind: 'running-channel', result: 'ok',
    probeVersion: 'acceptance-probe/2', producerRunId: '42', targetRunId: '99', targetJobId: '77',
    targetWorkflow: 'Acceptance target', targetStatus: 'in_progress', channel: 'commit-status', statusCreatedAt: '2026-10-21T00:00:20.000Z', annotationHash,
  };
  const runLog: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    runLog.push(args);
    if (args[0] === 'run' && args[1] === 'view') {
      return JSON.stringify({ headSha: 'head-1', status: 'completed', conclusion: 'success', workflowName: 'Acceptance probe',
        createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:01:00.000Z' });
    }
    if (args[0] === 'api' && String(args[1]).includes('/actions/artifacts/7')) {
      return JSON.stringify({ id: 7, name: 'acceptance-running', expired: false, workflow_run: { id: 42, head_sha: 'head-1' } });
    }
    if (args[0] === 'api' && String(args[1]).includes('/actions/runs/99')) {
      return JSON.stringify({ head_sha: 'head-1', run_started_at: '2026-10-21T00:00:05.000Z', updated_at: '2026-10-21T00:00:50.000Z', name: 'Acceptance target', path: '.github/workflows/acceptance-target.yml' });
    }
    if (args[0] === 'api' && String(args[1]).includes('/actions/jobs/77')) {
      return JSON.stringify({ run_id: 99, head_sha: 'head-1', started_at: '2026-10-21T00:00:10.000Z', completed_at: '2026-10-21T00:00:40.000Z', check_run_url: 'https://api.github.com/repos/o/r/check-runs/77' });
    }
    if (args[0] === 'api' && String(args[1]).includes('/commits/head-1/statuses')) {
      return JSON.stringify([{ context: 'acceptance-barrier', description: 'target-ready', state: 'pending', created_at: '2026-10-21T00:00:20.000Z' }]);
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const readArtifact = async () => ({ name: 'acceptance-probe.json', content: JSON.stringify(record) });
  const base = { provider: 'github-actions' as const, runUrl: 'https://github.com/o/r/actions/runs/42', artifactId: '7', sha: 'head-1', verify: 'probe:running-channel' };
  const probe = { runId: '42', jobId: 'probe', readAt: record.readAt, inProgress: true, observationHash: annotationHash,
    probeVersion: 'acceptance-probe/2', producerRunId: '42', targetRunId: '99', targetJobId: '77', kind: 'running-channel', channel: 'commit-status', statusCreatedAt: '2026-10-21T00:00:20.000Z', annotationHash };

  test('a probe is verified from its artifact and the target run/job window, not from the caller record', async () => {
    const adapter = createGithubActionsAdapter(run, readArtifact);
    expect(await adapter.verify({ ...base, probe })).toMatchObject({ ok: true });
    expect((await adapter.verify({ ...base, artifactId: undefined, probe })).ok).toBe(false);
    expect((await adapter.verify({ ...base, probe: { ...probe, observationHash: 'b'.repeat(64) } })).ok).toBe(false);
    expect((await adapter.verify({ ...base, artifactId: '8', probe })).ok).toBe(false);
    const late = { ...record, readAt: '2026-10-21T00:02:00.000Z' };
    const lateAdapter = createGithubActionsAdapter(run, async () => ({ name: 'late.json', content: JSON.stringify(late) }));
    expect((await lateAdapter.verify({ ...base, probe: { ...probe, readAt: late.readAt } })).ok).toBe(false);
    const otherRun = async (args: string[]) => args[0] === 'api' && String(args[1]).includes('/actions/artifacts/8')
      ? JSON.stringify({ id: 8, name: 'acceptance-running', expired: false, workflow_run: { id: 43, head_sha: 'head-1' } })
      : run(args);
    expect((await createGithubActionsAdapter(otherRun, readArtifact).verify({ ...base, artifactId: '8', probe })).ok).toBe(false);
    expect((await adapter.verify({ ...base, verify: 'probe:node-packed', probe })).ok).toBe(false);
    expect(runLog.some(args => args[0] === 'run' && args[1] === 'view')).toBe(true);

    // R2: untrusted probe version, a target workflow mismatch and a missing commit-status channel are all refused.
    const versionMismatch = { ...record, probeVersion: 'acceptance-probe/1' };
    const versionAdapter = createGithubActionsAdapter(run, async () => ({ name: 'acceptance-probe.json', content: JSON.stringify(versionMismatch) }));
    expect((await versionAdapter.verify({ ...base, probe: { ...probe, probeVersion: 'acceptance-probe/1' } })).ok).toBe(false);
    const otherWorkflow = { ...record, targetWorkflow: 'Other target' };
    const otherWorkflowAdapter = createGithubActionsAdapter(run, async () => ({ name: 'acceptance-probe.json', content: JSON.stringify(otherWorkflow) }));
    expect((await otherWorkflowAdapter.verify({ ...base, probe })).ok).toBe(false);
    const noChannel = { ...record, channel: undefined };
    const noChannelAdapter = createGithubActionsAdapter(run, async () => ({ name: 'acceptance-probe.json', content: JSON.stringify(noChannel) }));
    expect((await noChannelAdapter.verify({ ...base, probe })).ok).toBe(false);
  });

  test('a Node packed probe is verified from its artifact and the Node/bundle fields', async () => {
    const node = { ...record, kind: 'node-packed', nodeVersion: 'v22.14.0', bundleHash: 'c'.repeat(64), targetRunId: undefined, targetJobId: undefined, targetStatus: undefined, annotationHash: undefined };
    const adapter = createGithubActionsAdapter(run, async () => ({ name: 'acceptance-probe.json', content: JSON.stringify(node) }));
    const nodeBase = { ...base, verify: 'probe:node-packed', risk: 'packaging' };
    const nodeProbe = { ...probe, kind: 'node-packed', targetRunId: undefined, targetJobId: undefined, annotationHash: undefined };
    expect(await adapter.verify({ ...nodeBase, probe: nodeProbe })).toMatchObject({ ok: true });
    expect((await adapter.verify({ ...nodeBase, risk: 'runtime', probe: nodeProbe })).ok).toBe(true);
    const noVersion = { ...node, nodeVersion: undefined };
    const noVersionAdapter = createGithubActionsAdapter(run, async () => ({ name: 'acceptance-probe.json', content: JSON.stringify(noVersion) }));
    expect((await noVersionAdapter.verify({ ...nodeBase, probe: nodeProbe })).ok).toBe(false);
  });

  test('N1: an environment-bound probe is only accepted with a deployment record for this run and head', async () => {
    // N1-R: the deployment must be produced by THIS run and its success state must be read. The run link is the fact
    // that cannot be borrowed: a same-head, same-environment, in-window deployment of another run is refused.
    const withDeployments = (list: unknown[], statuses: unknown[] = []) => async (args: string[]) => {
      if (args[0] === 'api' && String(args[1]).includes('/deployments?')) return JSON.stringify(list);
      if (args[0] === 'api' && String(args[1]).includes('/deployments/') && String(args[1]).includes('/statuses')) return JSON.stringify(statuses);
      return run(args);
    };
    // The deployment workflow is a trusted one and the run is its own; the status names the run's job.
    const deployRun = async (args: string[]): Promise<string> => {
      if (args[0] === 'run' && args[1] === 'view') {
        return JSON.stringify({ headSha: 'head-1', status: 'completed', conclusion: 'success', workflowName: 'Deploy production',
          createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:01:00.000Z' });
      }
      return run(args);
    };
    // A5: the deploy job the success status names is read back from the repository and must be this run's job.
    const withDeploymentsOn = (list: unknown[], statuses: unknown[] = [], deployJob: Record<string, unknown> = { run_id: 42, head_sha: 'head-1' }) => async (args: string[]) => {
      if (args[0] === 'api' && String(args[1]).includes('/deployments?')) return JSON.stringify(list);
      if (args[0] === 'api' && String(args[1]).includes('/deployments/') && String(args[1]).includes('/statuses')) return JSON.stringify(statuses);
      if (args[0] === 'api' && String(args[1]).includes('/actions/jobs/4242')) return JSON.stringify(deployJob);
      return deployRun(args);
    };
    const envRecord = { ...record, environment: 'production' };
    const reader = async () => ({ name: 'acceptance-probe.json', content: JSON.stringify(envRecord) });
    const envProbe = { ...probe, environment: 'production' };
    const envBase = { ...base, probe: envProbe, environment: 'production' };
    const deployment = { id: 900, environment: 'production', sha: 'head-1', created_at: '2026-10-21T00:00:20.000Z' };
    const success = { state: 'success', environment: 'production', created_at: '2026-10-21T00:00:40.000Z',
      log_url: 'https://github.com/o/r/actions/runs/42/job/4242' };
    // A generic CI run (the probe workflow) may not certify an environment at all.
    expect((await createGithubActionsAdapter(withDeployments([deployment], [success]), reader).verify(envBase)).ok).toBe(false);
    // The trusted deployment workflow, with a deployment and a success status of this run, is accepted.
    expect(await createGithubActionsAdapter(withDeploymentsOn([deployment], [success]), reader).verify(envBase)).toMatchObject({ ok: true, environment: 'production' });
    expect((await createGithubActionsAdapter(withDeploymentsOn([], [success]), reader).verify(envBase)).ok).toBe(false);
    expect((await createGithubActionsAdapter(withDeploymentsOn([{ ...deployment, environment: 'staging' }], [success]), reader).verify(envBase)).ok).toBe(false);
    expect((await createGithubActionsAdapter(withDeploymentsOn([{ ...deployment, created_at: '2026-10-21T00:02:00.000Z' }], [success]), reader).verify(envBase)).ok).toBe(false);
    expect((await createGithubActionsAdapter(withDeploymentsOn([{ ...deployment, sha: 'other-head' }], [success]), reader).verify(envBase)).ok).toBe(false);
    // N1-R: a deployment of another run is refused even though the head, environment and window all match.
    const borrowed = { ...success, log_url: 'https://github.com/o/r/actions/runs/999/job/4242' };
    expect((await createGithubActionsAdapter(withDeploymentsOn([deployment], [borrowed]), reader).verify(envBase)).ok).toBe(false);
    // A5: a deploy job that belongs to another run, or one that cannot be read back, is refused.
    expect((await createGithubActionsAdapter(withDeploymentsOn([deployment], [success], { run_id: 999, head_sha: 'head-1' }), reader).verify(envBase)).ok).toBe(false);
    expect((await createGithubActionsAdapter(withDeploymentsOn([deployment], [success], { run_id: 42, head_sha: 'other-head' }), reader).verify(envBase)).ok).toBe(false);
    const jobUnreadable = async (args: string[]) => {
      if (args[0] === 'api' && String(args[1]).includes('/actions/jobs/4242')) throw new Error('HTTP 500');
      return withDeploymentsOn([deployment], [success])(args);
    };
    expect((await createGithubActionsAdapter(jobUnreadable, reader).verify(envBase)).ok).toBe(false);
    // A deployment with no success state is refused.
    expect((await createGithubActionsAdapter(withDeploymentsOn([deployment], [{ ...success, state: 'failure' }]), reader).verify(envBase)).ok).toBe(false);
    // A generic criterion refuses an environment-labeled probe, and a differing probe label is refused.
    expect((await createGithubActionsAdapter(withDeploymentsOn([deployment], [success]), reader).verify({ ...base, probe: envProbe })).ok).toBe(false);
    expect((await createGithubActionsAdapter(withDeploymentsOn([deployment], [success]), reader).verify({ ...envBase, probe: { ...envProbe, environment: 'staging' } })).ok).toBe(false);
    // A plain ci-run with the same deployment is accepted; without it, refused.
    const ciBase = { provider: 'github-actions' as const, runUrl: 'https://github.com/o/r/actions/runs/42', sha: 'head-1', environment: 'production' };
    expect(await createGithubActionsAdapter(withDeploymentsOn([deployment], [success])).verify(ciBase)).toMatchObject({ ok: true, environment: 'production' });
    expect((await createGithubActionsAdapter(withDeploymentsOn([])).verify(ciBase)).ok).toBe(false);
  });

  test('R2: the Node packed probe writes no record when the Node execution fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sck-node-fail-'));
    try {
      const bin = join(dir, 'bin'); mkdirSync(bin);
      const stub = join(bin, 'node');
      writeFileSync(stub, '#!/bin/sh\ncase "$1" in --version) echo v22.14.0 ;; *) echo node-failed >&2; exit 1 ;; esac\n');
      chmodSync(stub, 0o755);
      const out = join(dir, 'acceptance-probe.json');
      const child = Bun.spawnSync([process.execPath, join(ROOT, 'scripts', 'acceptance-node-probe.ts'), '--out', out], {
        cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, GITHUB_RUN_ID: '1', PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(child.exitCode).not.toBe(0);
      expect(existsSync(out)).toBe(false);
      expect(child.stderr.toString()).toContain('node failed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('managed-local-test acceptance adapter', () => {
  const ownerEvidence = `来源：owner:paseo-plugin\n决定：reply\n无法取得就在本地运行单元测试，通过就可以`;
  const ownerReply = {
    action: 'owner_reply',
    actor: 'owner:paseo-plugin',
    evidence: ownerEvidence,
    at: '2026-10-26T05:37:49.111436Z',
  };
  const hostSecret = 'SCK_AGENT_CWD=/ops\nSCK_BUN=/bun\n';
  const unsignedRecord = {
    gate: 'managed-local-test',
    suite: 'sys04-runtime-diagnostics',
    sha: 'b1d5bc3ffed0629ec95184856d0651eb66189327',
    bun: '1.3.11',
    bunPath: '/bun',
    platform: 'darwin',
    result: 'pass',
    exitCode: 0,
    startedAt: '2026-10-26T05:50:00Z',
    finishedAt: '2026-10-26T05:50:30Z',
    command: 'bun test tests/plugin-runtime-diagnostics.test.ts tests/sidecar-runtime-diagnostics.test.ts && bun scripts/test-worktrees.ts tests/plugin-runtime-role-gate.fork.test.ts',
    target: '/release/b1d5bc3ffed0629ec95184856d0651eb66189327',
    repoIdentity: '/ops/.git',
    dirty: false,
    log: '/gates/managed-local-test/b1d5bc3ffed0629ec95184856d0651eb66189327.log',
    logHash: 'a'.repeat(64),
    hostMode: 'dry-run' as const,
  };
  const authorizedTask = '612f1946-ccab-42b6-b426-c3b032eb6a11';
  const ownerTask = '25ec8d1a-6bbf-4bee-abaf-74998adeb5af';

  const managedRecord = async () => {
    const { signManagedLocalTestAttestation } = await import('../src/acceptance.ts');
    const attestation = signManagedLocalTestAttestation(unsignedRecord, hostSecret);
    return { ...unsignedRecord, hostMode: 'managed' as const, hostAttestation: attestation };
  };

  const baseOf = async () => {
    const goodRecord = await managedRecord();
    return {
      goodRecord,
      base: {
        sha: goodRecord.sha,
        suite: goodRecord.suite,
        ownerReplyAuditId: 'wuj9vmp3vg9pqyu33p2v',
        ownerReplyTaskId: ownerTask,
        requestingTaskId: authorizedTask,
        readRecord: async () => goodRecord,
        readOwnerReply: async () => ownerReply,
        readLogHash: () => 'a'.repeat(64),
        readHostSecret: () => hostSecret,
      },
    };
  };

  test('a host-attested pass record with a real owner_reply is accepted', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base, goodRecord } = await baseOf();
    const result = await verifyManagedLocalTest(base);
    expect(result).toMatchObject({ ok: true, sha: goodRecord.sha });
    if (result.ok) {
      expect(result.source.provider).toBe('managed-local-test');
      expect(result.source.exitCode).toBe(0);
      expect(result.source.ownerReplyAuditId).toBe('wuj9vmp3vg9pqyu33p2v');
      expect(result.source.hostMode).toBe('managed');
    }
  });

  test('a dry-run (engineer self-run) record cannot substitute CI', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base } = await baseOf();
    const result = await verifyManagedLocalTest({
      ...base, readRecord: async () => unsignedRecord, readHostSecret: () => hostSecret,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('dry-run');
  });

  test('a forged hostAttestation is refused', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base, goodRecord } = await baseOf();
    expect((await verifyManagedLocalTest({
      ...base,
      readRecord: async () => ({ ...goodRecord, hostAttestation: 'f'.repeat(64) }),
    })).ok).toBe(false);
    expect((await verifyManagedLocalTest({
      ...base, readHostSecret: () => null,
    })).ok).toBe(false);
  });

  test('a failed or dirty record is refused', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base, goodRecord } = await baseOf();
    expect((await verifyManagedLocalTest({
      ...base, readRecord: async () => ({ ...goodRecord, result: 'fail', exitCode: 1 }),
    })).ok).toBe(false);
    expect((await verifyManagedLocalTest({
      ...base, readRecord: async () => ({ ...goodRecord, dirty: true }),
    })).ok).toBe(false);
  });

  test('a hand-edited log (logHash mismatch) is refused', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base } = await baseOf();
    expect((await verifyManagedLocalTest({
      ...base, readLogHash: () => 'b'.repeat(64),
    })).ok).toBe(false);
  });

  test('a missing gate record is refused', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base } = await baseOf();
    expect((await verifyManagedLocalTest({
      ...base, readRecord: async () => null,
    })).ok).toBe(false);
  });

  test('an unauthorized requesting task is refused', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base } = await baseOf();
    const result = await verifyManagedLocalTest({
      ...base, requestingTaskId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not in the owner-authorized');
  });

  test('a forged or paraphrased owner_reply is refused', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base } = await baseOf();
    expect((await verifyManagedLocalTest({
      ...base, readOwnerReply: async () => ({ ...ownerReply, evidence: '本地测试通过就可以（我同意）' }),
    })).ok).toBe(false);
    expect((await verifyManagedLocalTest({
      ...base, readOwnerReply: async () => ({ ...ownerReply, action: 'owner_approve' }),
    })).ok).toBe(false);
    expect((await verifyManagedLocalTest({
      ...base, readOwnerReply: async () => ({ ...ownerReply, actor: 'engineering-claude-x' }),
    })).ok).toBe(false);
    expect((await verifyManagedLocalTest({
      ...base, readOwnerReply: async () => null,
    })).ok).toBe(false);
  });

  test('an unknown suite is refused', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base } = await baseOf();
    expect((await verifyManagedLocalTest({ ...base, suite: 'anything-goes' })).ok).toBe(false);
  });

  test('a wrong-sha gate record is refused', async () => {
    const { verifyManagedLocalTest } = await import('../src/acceptance.ts');
    const { base, goodRecord } = await baseOf();
    expect((await verifyManagedLocalTest({
      ...base, readRecord: async () => ({ ...goodRecord, sha: 'c'.repeat(40) }),
    })).ok).toBe(false);
  });

  test('the composite adapter routes by provider and keeps github-actions working', async () => {
    const { createAcceptanceSourceAdapter } = await import('../src/acceptance.ts');
    const goodRecord = await managedRecord();
    const adapter = createAcceptanceSourceAdapter({
      github: {
        verify: async () => ({ ok: true, sha: 'head-1', at: '2026-10-26T00:00:00Z', source: { provider: 'github-actions' } }),
      },
      readRecord: async () => goodRecord,
      readOwnerReply: async () => ownerReply,
      readLogHash: () => 'a'.repeat(64),
      readHostSecret: () => hostSecret,
    });
    expect(await adapter.verify({
      provider: 'github-actions', runUrl: 'https://github.com/o/r/actions/runs/1', sha: 'head-1',
    })).toMatchObject({ ok: true, source: { provider: 'github-actions' } });
    expect(await adapter.verify({
      provider: 'managed-local-test', sha: goodRecord.sha, suite: goodRecord.suite,
      ownerReplyAuditId: 'wuj9vmp3vg9pqyu33p2v', ownerReplyTaskId: ownerTask, requestingTaskId: authorizedTask,
    })).toMatchObject({ ok: true, source: { provider: 'managed-local-test' } });
  });

  test('PR-gate soft CI failure is substituted only for authorized tasks with host-attested sys02 suite', async () => {
    const {
      evaluateManagedLocalPrGateSubstitute, MANAGED_LOCAL_TEST_SUBMIT_SUITE, signManagedLocalTestAttestation,
    } = await import('../src/acceptance.ts');
    const submitRecord = {
      ...unsignedRecord,
      suite: MANAGED_LOCAL_TEST_SUBMIT_SUITE,
      command: 'bun test tests/acceptance.test.ts tests/pr-gate.test.ts',
      hostMode: 'managed' as const,
      hostAttestation: '',
    };
    submitRecord.hostAttestation = signManagedLocalTestAttestation(submitRecord, hostSecret);
    const ciReason = 'PR https://github.com/o/r/pull/7 的 CI 未通过（quality、channel）：修复并确认通过后再提交。';
    const ok = await evaluateManagedLocalPrGateSubstitute({
      taskId: authorizedTask,
      head: submitRecord.sha,
      ciFailed: ['quality', 'channel'],
      reason: ciReason,
      readRecord: async () => submitRecord,
      readOwnerReply: async () => ownerReply,
      readLogHash: () => 'a'.repeat(64),
      readHostSecret: () => hostSecret,
    });
    expect(ok).toMatchObject({ ok: true, head: submitRecord.sha });

    // Ordinary task: soft CI stays a refuse.
    const deniedTask = await evaluateManagedLocalPrGateSubstitute({
      taskId: '00000000-0000-0000-0000-000000000000',
      head: submitRecord.sha,
      ciFailed: ['quality'],
      reason: ciReason,
      readRecord: async () => submitRecord,
      readOwnerReply: async () => ownerReply,
      readLogHash: () => 'a'.repeat(64),
      readHostSecret: () => hostSecret,
    });
    expect(deniedTask.ok).toBe(false);

    // Dry-run cannot substitute even for an authorized task.
    const dry = await evaluateManagedLocalPrGateSubstitute({
      taskId: authorizedTask,
      head: submitRecord.sha,
      ciFailed: ['quality'],
      reason: ciReason,
      readRecord: async () => ({ ...submitRecord, hostMode: 'dry-run', hostAttestation: undefined }),
      readOwnerReply: async () => ownerReply,
      readLogHash: () => 'a'.repeat(64),
      readHostSecret: () => hostSecret,
    });
    expect(dry.ok).toBe(false);
    if (!dry.ok) expect(dry.reason).toContain('受管本地替代未通过');

    // Wrong head / wrong suite / local fail refuse.
    expect((await evaluateManagedLocalPrGateSubstitute({
      taskId: authorizedTask, head: 'd'.repeat(40), ciFailed: ['quality'], reason: ciReason,
      readRecord: async () => submitRecord, readOwnerReply: async () => ownerReply,
      readLogHash: () => 'a'.repeat(64), readHostSecret: () => hostSecret,
    })).ok).toBe(false);
    expect((await evaluateManagedLocalPrGateSubstitute({
      taskId: authorizedTask, head: submitRecord.sha, ciFailed: ['quality'], reason: ciReason,
      readRecord: async () => ({ ...submitRecord, result: 'fail', exitCode: 1 }),
      readOwnerReply: async () => ownerReply, readLogHash: () => 'a'.repeat(64), readHostSecret: () => hostSecret,
    })).ok).toBe(false);
  });
});
