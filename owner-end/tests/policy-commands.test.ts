import { describe, expect, test } from 'bun:test';
import { RecordId } from 'surrealdb';
import { policyCommand } from '../src/policy-commands.ts';

const LOCKS = { companyTenantId: '', scripts: [], d1Ids: [] };

/** 只认语句形状的假库：员工定义、职能策略、在岗员工；写入语句记入 writes。 */
function fakeDb(opts: { defs?: unknown[]; policies?: unknown[]; staff?: unknown[] } = {}) {
  const writes: Array<{ sql: string; vars: Record<string, unknown> }> = [];
  const db = {
    writes,
    query: async (sql: string, vars: Record<string, unknown> = {}) => {
      if (sql.startsWith('SELECT VALUE id FROM employee_def WHERE role')) {
        return [(opts.defs ?? []).filter((row) => (row as { role: string }).role === vars.role).map((row) => (row as { id: unknown }).id)];
      }
      if (sql.startsWith('SELECT VALUE id FROM agent_policy WHERE agent')) {
        return [(opts.policies ?? []).filter((row) => (row as { agent: string }).agent === vars.role).map((row) => (row as { agent: unknown }).agent)];
      }
      if (sql.includes('FROM employee_def')) return [opts.defs ?? []];
      if (sql.includes('FROM agent_policy')) return [opts.policies ?? []];
      if (sql.includes('FROM employee WHERE')) return [opts.staff ?? []];
      if (sql.startsWith('UPSERT')) {
        writes.push({ sql, vars });
        return [[]];
      }
      if (sql.startsWith('SELECT * FROM $rid')) return [[{ agent: vars.rid, disabled: true, deny: ['task.pause'] }]];
      return [[]];
    },
  };
  return db;
}

const def = (id: string, role: string, enabled = true) => ({ id: new RecordId('employee_def', id), role, enabled, model: 'm' });

describe('agent.list：按职能列出员工策略', () => {
  test('没有在岗员工时职能照样列出；同职能的定义归在一起；没有策略行即默认策略', async () => {
    const db = fakeDb({
      defs: [def('engineering-claude', 'engineering'), def('engineering-fable', 'engineering', false), def('qa-claude', 'qa')],
      policies: [{ agent: 'qa', disabled: false, allow: ['submit'], deny: [], lang: 'en' }],
    });
    const result = await policyCommand(db as never, 'agent.list', {}, 'owner-1', LOCKS) as { roles: Array<Record<string, unknown>> };
    expect(result.roles.map((row) => row.role)).toEqual(['engineering', 'qa']);
    expect(result.roles[0]).toEqual({
      role: 'engineering',
      defs: [{ id: 'engineering-claude', enabled: true, model: 'm' }, { id: 'engineering-fable', enabled: false, model: 'm' }],
      onDuty: [],
      policy: { disabled: false, allow: null, deny: [], lang: null },
    });
    expect(result.roles[1]!.policy).toEqual({ disabled: false, allow: ['submit'], deny: [], lang: 'en' });
  });

  test('在岗实例归到它的职能下', async () => {
    const db = fakeDb({
      defs: [def('engineering-claude', 'engineering')],
      staff: [{ id: new RecordId('employee', 'engineering-claude-6002f3'), role: 'engineering', def: new RecordId('employee_def', 'engineering-claude') }],
    });
    const result = await policyCommand(db as never, 'agent.list', {}, 'owner-1', LOCKS) as { roles: Array<{ onDuty: unknown[] }> };
    expect(result.roles[0]!.onDuty).toEqual([{ employee: 'engineering-claude-6002f3', def: 'engineering-claude' }]);
  });
});

describe('agent.policy.set：按职能写策略', () => {
  test('写到以职能为键的行', async () => {
    const db = fakeDb({ defs: [def('qa-claude', 'qa')] });
    const result = await policyCommand(db as never, 'agent.policy.set', { role: 'qa', disabled: true, deny: ['task.pause'] }, 'owner-1', LOCKS);
    expect(result).toMatchObject({ role: 'qa', policy: { disabled: true, deny: ['task.pause'] } });
    expect(db.writes).toHaveLength(1);
    expect(String(db.writes[0]!.vars.rid)).toBe('agent_policy:qa');
    expect(db.writes[0]!.vars).toMatchObject({ role: 'qa', disabled: true, deny: ['task.pause'], actor: 'owner-1' });
  });

  test('没有员工定义的职能被拒绝，不写库；旧的按员工实例写法同样被拒', async () => {
    const db = fakeDb({ defs: [def('qa-claude', 'qa')] });
    await expect(policyCommand(db as never, 'agent.policy.set', { role: 'qa-claude-4183bc', disabled: true }, 'owner-1', LOCKS))
      .rejects.toThrow('没有职能为 qa-claude-4183bc 的员工定义');
    await expect(policyCommand(db as never, 'agent.policy.set', { agent: 'qa', disabled: true }, 'owner-1', LOCKS)).rejects.toThrow('role invalid');
    expect(db.writes).toHaveLength(0);
  });
});
