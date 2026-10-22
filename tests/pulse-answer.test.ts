import { expect, test } from 'bun:test';
import { PULSE_LIST_CAPS, pulseAnswer, type PulseParts } from '../src/dispatcher/pulse-answer.ts';

const parts = (workflowWaits: unknown[]): PulseParts => ({
  at: '2026-10-22T00:00:00.000Z', paused: false, doing: [], ready: [], dispatchBlocked: [], goalBlockers: [], workflowWaits,
  workflowWaitSummary: { source: 'workflow-graph', available: true, checkedAt: '2026-10-22T00:00:00.000Z', totalRoots: workflowWaits.length, truncated: false },
  stuck: [], waiting: [], recentDone: [], goals: [], resources: [], last24h: {}, churn: {},
});

const waitRoot = (index: number, title = `wait-${index}`) => ({ goalId: 'goal-1', taskId: `task-${index}`, title,
  workflowState: 'blocked', kind: 'dependency', basis: 'task.dependencies', waitingForRole: 'engineering',
  nextTrigger: 'dependency completes', goalRootCount: 1, impact: 1, dependencyPath: [{ taskId: `task-${index}`, title }] });

test('owner pulse bounds workflow wait roots by count and reports omitted roots', () => {
  const answer = pulseAnswer(parts(Array.from({ length: 25 }, (_, index) => `root-${index}`)));
  expect(answer.workflowWaits).toHaveLength(PULSE_LIST_CAPS.workflowWaits.items);
  expect(answer.bounds.workflowWaits).toEqual({ total: 25, shown: 20, truncated: true });
});

test('owner pulse bounds workflow wait roots by serialized bytes without silent cuts', () => {
  const answer = pulseAnswer(parts(Array.from({ length: 25 }, (_, index) => waitRoot(index, '长等待根标题'.repeat(30)))));
  expect(answer.workflowWaits.length).toBeGreaterThan(0);
  expect(answer.workflowWaits.length).toBeLessThan(PULSE_LIST_CAPS.workflowWaits.items);
  expect(Buffer.byteLength(JSON.stringify(answer.workflowWaits), 'utf8')).toBeLessThanOrEqual(PULSE_LIST_CAPS.workflowWaits.bytes);
  expect(answer.bounds.workflowWaits).toMatchObject({ total: 25, shown: answer.workflowWaits.length, truncated: true });
});

test('one contract-max wait row fits the workflow-waits share, so a full list is never silently emptied', () => {
  // The review measured 6669 bytes for a 200-character title plus an 8-step path; the share must hold at least one whole row.
  const maxRow = { ...waitRoot(0, '长标题'.repeat(64)),
    dependencyPath: Array.from({ length: 8 }, (_, step) => ({ taskId: `step-${step}`, title: '长标题'.repeat(64) })) };
  expect(Buffer.byteLength(JSON.stringify(maxRow), 'utf8')).toBeLessThanOrEqual(PULSE_LIST_CAPS.workflowWaits.bytes);
  const answer = pulseAnswer(parts([maxRow, maxRow, maxRow]));
  expect(answer.workflowWaits.length).toBeGreaterThan(0);
  expect(answer.bounds.workflowWaits).toMatchObject({ total: 3, shown: answer.workflowWaits.length, truncated: true });
  expect(Buffer.byteLength(JSON.stringify(answer.workflowWaits), 'utf8')).toBeLessThanOrEqual(PULSE_LIST_CAPS.workflowWaits.bytes);
});
