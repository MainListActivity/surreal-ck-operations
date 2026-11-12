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

test('正常阻塞清空租约后按最后阻塞审计保留员工、项目和原因，不依赖最近事件窗口', () => {
  const input=fixture();
  input.board.employees[0]!.now={state:'idle'};
  Object.assign(input.employees[0]!, {runtime_state:'idle',session_task:'work',last_task:'task:work'});
  Object.assign(input.tasks[0]!, {state:'blocked',project_ref:'project:app',project_name:'产品'});
  input.audits=Array.from({length:40},(_,i)=>({task:`other-${i}`,action:'checkpoint',at:now-i}));
  input.blockedAudits=[{task:'task:work',actor:'employee:dev',at:now-40*86400000,evidence:'等待仓库权限；token=private-secret'}];
  const result=buildRuntimeDashboard(input,now);
  expect(result.agents.find(a=>a.id==='dev')).toMatchObject({taskId:'work',taskState:'blocked',project:{id:'app',name:'产品'}});
  expect(result.agents.find(a=>a.id==='dev')?.blockedReason).toContain('等待仓库权限');
  expect(result.agents.find(a=>a.id==='dev')?.blockedReason).not.toContain('private-secret');
  expect(result.projects?.find(p=>p.id==='app')?.blocked).toBe(1);
});

test('受阻说明已译成老板语言时，原因显示译文，员工写的原文另附', () => {
  const input=fixture();
  input.board.employees[0]!.now={state:'idle'};
  Object.assign(input.employees[0]!, {runtime_state:'idle',session_task:'work'});
  Object.assign(input.tasks[0]!, {state:'blocked'});
  input.blockedAudits=[{task:'work',actor:'dev',at:now-10,evidence:'等待 API 密钥',evidence_original:'Waiting for the API key'}];
  const dev=buildRuntimeDashboard(input,now).agents.find(a=>a.id==='dev');
  expect(dev).toMatchObject({blockedReason:'等待 API 密钥',blockedReasonOriginal:'Waiting for the API key'});
  input.blockedAudits=[{task:'work',actor:'dev',at:now-10,evidence:'等待仓库权限'}];
  expect('blockedReasonOriginal' in buildRuntimeDashboard(input,now).agents.find(a=>a.id==='dev')!).toBe(false);
});

test('同一任务旧执行员工和复核员工都在册时，只把最近报告阻塞的人标成受阻', () => {
  const input=fixture();
  for(const e of input.board.employees)e.now={state:'idle'};
  for(const e of input.employees)Object.assign(e,{runtime_state:'idle',session_task:'work'});
  Object.assign(input.tasks[0]!,{state:'blocked'});
  input.blockedAudits=[{task:'work',actor:'dev',at:now-20,evidence:'旧阻塞'},{task:'work',actor:'qa',at:now-10,evidence:'复核阻塞'}];
  const result=buildRuntimeDashboard(input,now);
  expect(result.agents.find(a=>a.id==='dev')?.taskId).toBeUndefined();
  expect(result.agents.find(a=>a.id==='qa')).toMatchObject({taskId:'work',blockedReason:'复核阻塞'});
});

test('待发只展示最新可消费草稿，后续复核不误归当前执行员工', () => {
  const input=fixture();
  input.tasks.push({id:'done',state:'done'});
  input.board.messages=[
    {messageId:'old',taskId:'next',title:'下一单',step:'execute',state:'draft',hold:false,body:'旧正文',editable:true},
    {messageId:'new',taskId:'next',title:'下一单',step:'execute',state:'draft',hold:false,body:'新正文',editable:true},
    {messageId:'review',taskId:'work',title:'复核',step:'review',state:'draft',hold:false,body:'QA正文',editable:true,employeeId:'dev'},
    {messageId:'done',taskId:'done',title:'已结',step:'review',state:'draft',hold:false,body:'不再派发',editable:true},
    {messageId:'notice',taskId:'work',title:'通知',step:'notice',state:'draft',hold:false,body:'遗留通知',editable:true,employeeId:'dev'},
  ];
  input.board.employees[0]!.outbox=[{...input.board.messages[1]!,step:'execute',workdirPending:false,lang:'zh'}];
  const data=buildRuntimeDashboard(input,now);
  expect(data.projects?.flatMap(p=>p.pendingMessages.map(m=>m.messageId))).toEqual(['new','review']);
  expect(data.agents.find(a=>a.id==='dev')?.pendingMessages?.map(m=>m.messageId)).toEqual(['new']);
  expect(data.projects?.flatMap(p=>p.pendingMessages).find(m=>m.messageId==='review')?.stage).toBe('later');
});

test('租约已过期时即使运行观测还新鲜也不能给出员工结束时间', () => {
  const input=fixture();
  if(input.board.employees[0]!.now.state==='leased')input.board.employees[0]!.now.leaseActive=false;
  expect(buildRuntimeDashboard(input,now).agents.find(a=>a.id==='dev')?.estimate?.status).toBe('unavailable');
});

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

test('大屏直接给出项目和本阶段耗时，未知连接不继续承诺预计时间', () => {
  const input = fixture();
  Object.assign(input.tasks[0]!, {kind: 'task', project_ref: 'project:company', project_name: '公司工作台'});
  input.timingEvents = Array.from({length: 5}, (_, i) => [
    {task: `task:past-${i}`, actor: 'employee:dev', project_ref: 'project:company', role: 'engineering', kind: 'task', phase: 'execute', action: 'claim', at: now - 600000},
    {task: `task:past-${i}`, actor: 'employee:dev', project_ref: 'project:company', role: 'engineering', kind: 'task', phase: 'execute', action: 'submit', at: now - 60000},
  ]).flat();
  expect(buildRuntimeDashboard(input, now).agents.find(a => a.id === 'dev')).toMatchObject({
    project: {id: 'company', name: '公司工作台'}, elapsedSeconds: 5,
    estimate: {status: 'estimated', samples: 5, lowerSeconds: 535, upperSeconds: 535},
  });
  expect(buildRuntimeDashboard(input, now + 100000).agents.find(a => a.id === 'dev')?.estimate?.status).toBe('unavailable');
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

test('退出的旧插件进程不重复计算主机；有在岗员工的离线节点仍可见', () => {
  const input = fixture();
  input.beats.push({ runner: 'plugin:old-pid', host: 'mac', at: now - 3600000 });
  input.beats.push({ runner: 'native:empty', host: 'remote-empty', at: now });
  expect(buildRuntimeDashboard(input, now).summary.hosts).toBe(2);
  input.employees[1]!.runner_id = 'plugin:old-pid';
  const data = buildRuntimeDashboard(input, now);
  expect(data.summary.hosts).toBe(3);
  expect(data.hosts.find(h => h.id === 'plugin:old-pid')?.state).toBe('offline');
  expect(data.agents.find(a => a.id === 'qa')?.state).toBe('unknown');
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
  input.tasks[0]!.project_ref = 'original-project';
  expect(buildRuntimeDashboard(input, now).transfers[0]?.projectId).toBe('original-project');
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

test('本轮进度精确匹配运行回合；历史回合更晚补报也不会覆盖；失联保留输出但状态未知',()=>{
  const f=fixture();f.employees[0]!.paseo_agent_id='native:a:s';
  f.tasks[0]!.runtime_execution={agent:'native:a:s',turn:'current'};
  const activity={agent:'native:a:s',turn:'current',runtime:'native',state:'running',startedAt:now-1000,observedAt:now,lastActivityAt:now,toolsCompleted:2,events:[]};
  f.activities=[{employee:'dev',agent:activity.agent,task:'work',activity:{...activity,turn:'old'}},{employee:'dev',agent:activity.agent,task:'work',activity}];
  expect(buildRuntimeDashboard(f,now).agents.find(a=>a.id==='dev')?.activity?.turn).toBe('current');
  const stale=buildRuntimeDashboard(f,now+100000).agents.find(a=>a.id==='dev');
  expect(stale?.state).toBe('unknown');expect(stale?.activity?.turn).toBe('current');
  f.tasks[0]!.runtime_execution=undefined;
  expect(buildRuntimeDashboard(f,now).agents.find(a=>a.id==='dev')?.activity).toBeUndefined();
});
