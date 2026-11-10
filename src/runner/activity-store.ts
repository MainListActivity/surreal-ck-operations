import { createHash } from 'node:crypto';
import type { Surreal } from 'surrealdb';
import type { AgentActivity } from '../agent-activity.ts';

/** Latest 40 public events per turn, retained for 24h. Replayed snapshots overwrite the same row. */
export async function writeAgentActivity(db: Surreal, runner: string, values: AgentActivity[]) {
  const saved: Array<{agent: string; turn: string}> = [];
  for (const value of values) {
    const key = createHash('sha256').update(JSON.stringify([runner, value.agent, value.turn])).digest('hex');
    const result = await db.query(`LET $employee = (SELECT id FROM employee WHERE paseo_agent_id = $agent AND runner_id = $runner LIMIT 1)[0];
      LET $prior = (SELECT task FROM type::record('agent_activity', $key))[0];
      LET $task = (SELECT VALUE id FROM task WHERE runtime_execution.agent = $agent AND runtime_execution.turn = $turn LIMIT 1)[0] ?? $prior.task;
      RETURN IF $employee != NONE AND $task != NONE {
        UPSERT type::record('agent_activity', $key) CONTENT {
          runner: $runner, employee: <string>record::id($employee.id), task: $task,
          agent: $agent, turn: $turn, observed_at: $at, activity: $activity,
          expires_at: time::now() + 1d
        } WHERE observed_at = NONE OR observed_at <= $at;
      };`, {key, runner, agent: value.agent, turn: value.turn, at: value.observedAt, activity: value});
    if (Array.isArray(result.at(-1)) && (result.at(-1) as unknown[]).length) saved.push({agent: value.agent, turn: value.turn});
  }
  return saved;
}
/** Uses the existing heartbeat, with bounded deletes; expiry is enforced on reads even while a node is offline. */
export async function expireAgentActivity(db: Surreal) {
  await db.query(`DELETE (SELECT VALUE id FROM agent_activity WHERE expires_at <= time::now() LIMIT 200);`);
}
