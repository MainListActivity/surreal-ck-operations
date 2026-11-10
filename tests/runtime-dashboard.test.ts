import { expect, test } from 'bun:test';
import { buildRuntimeDashboard, type DashboardRows } from '../src/runtime-dashboard.ts';
import { cpuPercent } from '../src/runner/telemetry.ts';

const now = 1_800_000_000_000;
function fixture(): DashboardRows {
  return {
    board: {
      at: now,
      runner: { state: 'online' },
      messages: [],
      recent: [],
      unassigned: [],
      employees: [
        {
          id: 'dev',
          name: '开发',
          role: 'engineering',
          model: 'configured',
          now: {
            state: 'leased',
            taskId: 'work',
            title: '上传功能',
            phase: 'execute',
            leaseActive: true,
            leaseStartedAt: now - 5000,
          },
          next: [],
          outbox: [],
        },
        { id: 'qa', name: '测试', role: 'qa', now: { state: 'idle' }, next: [], outbox: [] },
      ],
    },
    employees: [
      {
        id: 'dev',
        runner_id: 'native:a',
        runtime_state: 'running',
        runtime_at: now,
        runtime_model: 'observed',
      },
      { id: 'qa', runner_id: 'plugin:a', runtime_state: 'idle', runtime_at: now },
    ],
    beats: [
      { runner: 'native:a', host: 'mac', at: now },
      { runner: 'plugin:a', host: 'mac', at: now },
    ],
    telemetry: [
      { runner: 'native:a', node: 'physical-a', at: now },
      { runner: 'plugin:a', node: 'physical-a', at: now },
    ],
    tasks: [
      { id: 'work', state: 'doing', title: '上传功能', reviewer_role: 'qa' },
      { id: 'next', parent: 'work', state: 'planned' },
    ],
    sent: [],
    current: [],
    audits: [],
  };
}

test('按物理节点归组，模型来自观测；租约、候选和链上后续不能冒充运行进度', () => {
  const input = fixture();
  const data = buildRuntimeDashboard(input, now);
  expect(data.hosts).toHaveLength(1);
  expect(data.hosts[0]?.runnerIds).toHaveLength(2);
  const agent = data.agents.find((a) => a.id === 'dev')!;
  expect(agent).toMatchObject({
    state: 'running',
    model: 'observed',
    modelSource: 'observed',
    destination: { role: 'qa', agentId: 'qa', source: 'planned' },
  });
  expect(agent.progress).toBeUndefined();
  expect(agent.next).toBeUndefined();
  input.employees[0]!.runtime_at = now - 91_000;
  expect(buildRuntimeDashboard(input, now).agents.find((a) => a.id === 'dev')).toMatchObject({
    state: 'unknown',
    model: 'configured',
    modelSource: 'configured',
  });
});

test('心跳过期与归属缺失如实显示；未上报设备不能伪归当前主机', () => {
  const input = fixture();
  input.beats.forEach((b) => (b.at = now - 91_000));
  delete input.employees[1]!.runner_id;
  const data = buildRuntimeDashboard(input, now);
  expect(data.hosts.find((h) => h.id === 'physical-a')?.state).toBe('offline');
  expect(data.agents.every((a) => a.state === 'unknown')).toBe(true);
  expect(data.agents.find((a) => a.id === 'qa')?.hostId).toBe('unassigned');
  expect(data.summary.hosts).toBe(1);
});

test('进度来自需求的实际任务清单，作废项排除，缺失项不能伪报 100%', () => {
  const input = fixture();
  input.tasks.push({ id: 'accepted', state: 'done' }, { id: 'voided', state: 'void' });
  input.executions = [{ tasks: ['work', 'accepted', 'voided'] }];
  expect(buildRuntimeDashboard(input, now).agents[0]?.progress).toEqual({
    done: 1,
    total: 2,
    label: '所属需求已验收任务',
  });
  input.executions[0]!.tasks.push('missing');
  expect(buildRuntimeDashboard(input, now).agents[0]?.progress).toBeUndefined();
});

test('当前提示词须匹配当前租约，实际发送内容优先，旧模板有来源且长文本有截断标记', () => {
  const input = fixture();
  input.current = [
    { task: 'work', sent_to: 'dev', sent_at: now, body: 'template', sent_body: '实际发送' },
  ];
  expect(buildRuntimeDashboard(input, now).agents[0]?.currentPrompt).toMatchObject({
    text: '实际发送',
    source: 'sent',
  });
  input.current[0]!.sent_at = now - 100_000;
  expect(buildRuntimeDashboard(input, now).agents[0]?.currentPrompt).toBeUndefined();
  input.current[0]!.sent_at = now;
  delete input.current[0]!.sent_body;
  input.current[0]!.body = '字'.repeat(16001);
  expect(buildRuntimeDashboard(input, now).agents[0]?.currentPrompt).toMatchObject({
    source: 'template',
    truncated: true,
  });
});

test('已送达交付、返工与链上交接有方向；notice 和草稿不能制造交接', () => {
  const input = fixture();
  input.sent = [
    { id: '1', task: 'work', sent_to: 'dev', step: 'execute', sent_at: now - 3000 },
    { id: '2', task: 'work', sent_to: 'qa', step: 'review', sent_at: now - 2000 },
    { id: '3', task: 'work', sent_to: 'dev', step: 'rework', sent_at: now - 1000 },
    { id: '4', task: 'next', sent_to: 'qa', step: 'execute', sent_at: now },
    { id: '5', task: 'work', sent_to: 'qa', step: 'notice', sent_at: now },
  ];
  expect(buildRuntimeDashboard(input, now).transfers.map((t) => [t.from, t.to, t.kind])).toEqual([
    ['dev', 'qa', 'review'],
    ['qa', 'dev', 'rework'],
    ['dev', 'qa', 'handoff'],
  ]);
});

test('CPU 首样本未知，后续按累计时间差计算，时钟重置不输出假指标', () => {
  expect(cpuPercent(undefined, { idle: 50, total: 100 })).toBeUndefined();
  expect(cpuPercent({ idle: 50, total: 100 }, { idle: 70, total: 200 })).toBe(80);
  expect(cpuPercent({ idle: 50, total: 100 }, { idle: 20, total: 200 })).toBeUndefined();
});

test('GitHub CI/CD 不产生 Agent；CI 通过、生产部署证据与历史提交分别展示', () => {
  const input = fixture();
  Object.assign(input.tasks[0]!, { acceptance_head: 'new-sha', acceptance_attempt: 2 });
  input.evidence = [
    {
      id: 'ci',
      task: 'work',
      sha: 'new-sha',
      attempt: 2,
      verified: true,
      verifier: 'github-actions',
      at: now,
      source: { conclusion: 'success', runUrl: 'https://github.com/example/app/actions/runs/1' },
    },
    {
      id: 'deploy',
      task: 'work',
      sha: 'old-sha',
      attempt: 1,
      verified: true,
      verifier: 'github-actions',
      environment: 'production',
      at: now - 100,
      source: {
        conclusion: 'success',
        deployment: { deploymentId: '123', status: 'success' },
        runUrl: 'javascript:alert(1)',
      },
    },
    {
      id: 'unverified',
      task: 'work',
      sha: 'new-sha',
      attempt: 2,
      verified: false,
      verifier: 'github-actions',
      environment: 'production',
      at: now,
      source: { deployment: { deploymentId: 'bad', status: 'success' } },
    },
  ];
  const data = buildRuntimeDashboard(input, now);
  expect(data.agents).toHaveLength(input.board.employees.length);
  expect(data.deliveries).toHaveLength(2);
  expect(data.deliveries[0]).toMatchObject({ status: 'ci_passed', current: true });
  expect(data.deliveries[1]).toMatchObject({ status: 'production_verified', current: false });
  expect(data.deliveries[1]!.runUrl).toBeUndefined();
  input.evidence[1]!.source.conclusion = 'failure';
  expect(buildRuntimeDashboard(input, now).deliveries[1]!.status).toBe('ci_failed');
});
