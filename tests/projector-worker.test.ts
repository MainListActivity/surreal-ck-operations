import { expect, test } from 'bun:test';
import { runProjectionWorker } from '../src/mcp/projector-worker';

test('outbox worker retries a failed projection and stops on shutdown', async () => {
  const controller = new AbortController();
  let attempts = 0;
  let failures = 0;
  await runProjectionWorker({
    signal: controller.signal,
    intervalMs: 100,
    projector: {
      async runOnce() {
        attempts++;
        if (attempts === 1) throw new Error('temporary GitHub failure');
        controller.abort();
        return { projected: 1 };
      },
    },
    onError() { failures++; },
  });
  expect(attempts).toBe(2);
  expect(failures).toBe(1);
});
