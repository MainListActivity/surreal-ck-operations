// SYS02 AC04: a real CI probe. It runs inside the CI job whose run it attests, reads the target while the job is still
// in progress, and writes a record the server adapter can bind to the run id and time window. A post-job download or a
// hand-written record has no run id/window and is refused by the adapter.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export interface ProbeRecord {
  probe: 'acceptance';
  runId: string;
  jobId?: string;
  readAt: string;
  inProgress: true;
  observationHash: string;
  target: string;
  kind: 'url' | 'module';
  result: 'ok';
}

export interface ProbeInput { kind: 'url' | 'module'; target: string }

/** Read the target now, while the caller's CI job is in progress, and return the attestable record. */
export async function runProbe(input: ProbeInput, env: NodeJS.ProcessEnv = process.env): Promise<ProbeRecord> {
  const runId = env.GITHUB_RUN_ID;
  if (!runId) throw new Error('GITHUB_RUN_ID is required: the probe must run inside the CI job it attests');
  const readAt = new Date().toISOString();
  let observation: string;
  if (input.kind === 'url') {
    const response = await fetch(input.target, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`probe target answered ${response.status}`);
    observation = await response.text();
  } else {
    const module = await import(input.target);
    const value = typeof module.default === 'function' ? await module.default() : (module.default ?? null);
    observation = JSON.stringify({ keys: Object.keys(module).sort(), value });
  }
  return {
    probe: 'acceptance', runId, ...(env.GITHUB_JOB ? { jobId: env.GITHUB_JOB } : {}), readAt, inProgress: true,
    observationHash: createHash('sha256').update(observation).digest('hex'),
    target: input.target, kind: input.kind, result: 'ok',
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? undefined : args[at + 1];
  };
  const url = value('url');
  const modulePath = value('module');
  const out = value('out');
  if ((url === undefined) === (modulePath === undefined)) {
    console.error('usage: acceptance-probe.ts --url <target> | --module <path> [--out <file>]');
    process.exit(2);
  }
  const record = await runProbe(url !== undefined ? { kind: 'url', target: url } : { kind: 'module', target: modulePath! });
  if (out) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
}
