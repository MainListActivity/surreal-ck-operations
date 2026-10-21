#!/usr/bin/env bun
// SYS02 C3 producer-side running-channel probe. It is executed by the producer CI job and reads the target job's
// annotation while the target job is in progress. The record names both runs and jobs; the server adapter re-reads the
// target run/job windows and the annotation hash, so a local server or a fixture-provided RUN_ID cannot pass.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
};
const workflowName = value('workflow') ?? 'Acceptance target';
const jobName = value('job') ?? 'target';
const out = value('out');
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const producerRunId = process.env.GITHUB_RUN_ID;
if (!repo || !sha || !producerRunId) throw new Error('GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_RUN_ID are required');
const env = { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '' };
const gh = (path: string): any => {
  const child = Bun.spawnSync(['gh', 'api', path], { stdout: 'pipe', stderr: 'pipe', env });
  if (child.exitCode !== 0) throw new Error(`gh api ${path} failed: ${child.stderr.toString().slice(0, 400)}`);
  return JSON.parse(child.stdout.toString());
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (let round = 0; round < 120; round++) {
  const runs = gh(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`).workflow_runs ?? [];
  const targetRun = runs.find((run: any) => run.name === workflowName && String(run.id) !== producerRunId);
  if (targetRun) {
    const jobs = gh(`repos/${repo}/actions/runs/${targetRun.id}/jobs`).jobs ?? [];
    const targetJob = jobs.find((job: any) => job.name === jobName);
    if (targetJob && targetJob.status === 'in_progress') {
      const checkRun = /\/check-runs\/(\d+)/.exec(targetJob.check_run_url ?? '')?.[1] ?? String(targetJob.id);
      let annotations: Array<{ title?: string; message?: string }> = [];
      try {
        annotations = gh(`repos/${repo}/check-runs/${checkRun}/annotations`).annotations ?? [];
      } catch { annotations = []; }
      const marker = annotations.find(item => /acceptance-barrier/.test(item.title ?? '') || /target-ready/.test(item.message ?? ''));
      if (marker) {
        const readAt = new Date().toISOString();
        const annotationHash = hash(JSON.stringify({ title: marker.title ?? '', message: marker.message ?? '' }));
        const record = {
          probe: 'acceptance', runId: producerRunId, jobId: process.env.GITHUB_JOB, readAt, inProgress: true,
          observationHash: annotationHash, probeVersion: 'acceptance-probe/2', producerRunId,
          targetRunId: String(targetRun.id), targetJobId: String(targetJob.id), targetWorkflow: workflowName,
          targetStatus: 'in_progress', kind: 'running-channel', annotationHash,
          target: `${repo}/${workflowName}/${jobName}`, result: 'ok',
        };
        if (out) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
        console.log(JSON.stringify(record));
        process.exit(0);
      }
    }
  }
  await sleep(1000);
}
throw new Error('the target annotation was not readable while the target job was in progress');
