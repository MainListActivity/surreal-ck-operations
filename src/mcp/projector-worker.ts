import { setTimeout as delay } from 'node:timers/promises';

export interface ProjectionRunner {
  runOnce(): Promise<{ projected: number }>;
}

/** The process owner supplies the abort signal and controls shutdown. */
export async function runProjectionWorker(input: {
  projector: ProjectionRunner;
  signal: AbortSignal;
  intervalMs?: number;
  onResult?: (result: { projected: number }) => void;
  onError?: (error: unknown) => void;
}): Promise<void> {
  const interval = input.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(interval) || interval < 100) throw new Error('invalid projection interval');
  let failures = 0;
  while (!input.signal.aborted) {
    try {
      const result = await input.projector.runOnce();
      failures = 0;
      input.onResult?.(result);
    } catch (error) {
      failures++;
      input.onError?.(error);
    }
    const waitMs = Math.min(interval * 2 ** Math.min(failures, 6), 60_000);
    try {
      await delay(waitMs, undefined, { signal: input.signal });
    } catch (error) {
      if (!input.signal.aborted) throw error;
    }
  }
}
