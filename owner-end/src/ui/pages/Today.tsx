import type { RuntimeAgentView, RuntimeDelivery } from '../../../../src/runtime-dashboard.ts';
import { ErrorState, Loading, roleText } from '../common.tsx';
import { employeeProgress, onDuty, staffStatus } from '../meeting-rooms.ts';
import { hrefOf } from '../model.ts';
import { expireObservations } from '../runtime-state.ts';
import { useDashboard, useRequirements, useTasks } from '../store.ts';
import { decisionQueue, friendlyTime, pausedCount, projectTone, type DecisionItem } from '../today.ts';

const DELIVERY: Record<RuntimeDelivery['status'], { label: string; tone: string }> = {
  production_verified: { label: '生产已核验', tone: 'done' },
  ci_passed: { label: 'CI 已通过', tone: 'progress' },
  ci_failed: { label: 'CI 未通过', tone: 'blocked' },
  unknown: { label: '结果待确认', tone: 'neutral' },
};

const STAFF_TONE: Record<string, string> = { working: 'progress', blocked: 'blocked', waiting: 'decide', unknown: 'neutral', idle: 'neutral' };

function Status({ tone, children }: { tone: string; children: preact.ComponentChildren }) {
  return <span class={`status tone-${tone}`}>{children}</span>;
}

function Decision({ item, projectName, now }: { item: DecisionItem; projectName?: string; now: number }) {
  return (
    <article class="decision">
      <div class="decision-body">
        <Status tone={item.tone}>{item.label}</Status>
        <a class="decision-title" href={item.href}>{item.title}</a>
        <p class="decision-reason">{item.reason}</p>
        <p class="decision-meta">
          {projectName ? <span>{projectName}</span> : null}
          {item.at ? <span>{friendlyTime(item.at, now)}</span> : null}
        </p>
      </div>
      <a class="button decision-action" href={item.href}>{item.action}</a>
    </article>
  );
}

function Worker({ agent }: { agent: RuntimeAgentView }) {
  const status = staffStatus(agent);
  const progress = employeeProgress(agent);
  return (
    <div class="worker">
      <div class="worker-top">
        <Status tone={STAFF_TONE[status.kind] ?? 'neutral'}>{roleText(agent.role)}</Status>
        <span class="worker-state">{status.text}{agent.project ? ` · ${agent.project.name}` : ''}</span>
      </div>
      {agent.taskTitle ? <a class="worker-task" href={agent.taskId ? hrefOf('tasks', agent.taskId) : undefined}>{agent.taskTitle}</a> : null}
      {agent.blockedReason ? <p class="worker-note">{agent.blockedReason}</p> : null}
      {progress.percent !== undefined ? (
        <div class="line-meter" role="progressbar" aria-label={progress.label} aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${progress.percent}%` }} />
        </div>
      ) : null}
      <p class="worker-facts">
        {progress.done !== undefined ? <span>清单 {progress.done}/{progress.total}</span> : <span>{progress.detail}</span>}
        {agent.model ? <span>{agent.model}</span> : null}
      </p>
    </div>
  );
}

export function TodayPage() {
  const dash = useDashboard();
  const reqs = useRequirements();
  const tasks = useTasks();
  const snapshot = dash.data;
  if (!snapshot && !reqs.data) {
    const error = dash.error || reqs.error;
    return (
      <div class="page today">
        <h1>今天</h1>
        {error ? <ErrorState message={error} onRetry={() => { void dash.reload(); void reqs.reload(); }} /> : <Loading label="正在读取今天的情况…" />}
      </div>
    );
  }
  const now = snapshot?.at ?? Date.now();
  const data = snapshot ? expireObservations(snapshot, Date.now()) : undefined;
  const names = new Map((data?.projects ?? []).map((p) => [p.id, p.name]));
  const queue = decisionQueue({ requirements: reqs.data, tasks: tasks.data, dashboard: data });
  const working = (data?.agents ?? []).filter(onDuty);
  const idle = (data?.agents ?? []).filter((a) => !onDuty(a) && a.next).slice(0, 2);
  const paused = pausedCount(reqs.data);
  const shipped = (data?.deliveries ?? []).slice(0, 5);
  const projects = [...(data?.projects ?? [])].sort((a, b) =>
    b.blocked - a.blocked || (b.progress.percent ?? -1) - (a.progress.percent ?? -1) || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return (
    <div class="page today">
      <header class="today-head">
        <h1>今天</h1>
        <p class="lede">
          {queue.length ? <><b>{queue.length} 件事</b>等你决定</> : '没有需要你决定的事'}
          {' · '}{working.length ? <><b>{working.length} 位员工</b>在工作</> : '现在没有员工在工作'}
        </p>
      </header>
      {dash.error && data ? <p class="notice warn"><span class="notice-text">运行数据刷新失败，显示的是最后收到的内容。</span></p> : null}

      <div class="today-cols">
        <div class="today-main">
          <section class="block" aria-labelledby="decide-h">
            <div class="block-head">
              <h2 id="decide-h">等你决定</h2>
              <span class="hint">受阻的排在最前</span>
            </div>
            {queue.length ? (
              <div class="decision-list">
                {queue.map((item) => <Decision key={item.key} item={item} projectName={item.projectId ? names.get(item.projectId) ?? item.projectId : undefined} now={now} />)}
              </div>
            ) : (
              <div class="calm">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l3 3 5-6" /></svg>
                <div>
                  <p class="calm-title">今天没有需要你决定的事</p>
                  <p class="hint">有需求等你确认、任务受阻或消息被扣住时，会出现在这里。</p>
                </div>
              </div>
            )}
            {paused ? <p class="block-foot"><a href={hrefOf('requirements', undefined, { s: 'paused' })}>另有 {paused} 条需求已暂停，可随时恢复</a></p> : null}
          </section>

          <section class="block" aria-labelledby="ship-h">
            <div class="block-head">
              <h2 id="ship-h">最近交付</h2>
              <span class="hint">PR 复核通过后合并，由 GitHub 自动部署</span>
            </div>
            {shipped.length ? shipped.map((d) => (
              <a key={d.id} class="line-row" href={hrefOf('tasks', d.taskId)}>
                <Status tone={DELIVERY[d.status].tone}>{DELIVERY[d.status].label}</Status>
                <span class="line-title">{d.title}</span>
                <span class="line-meta">{d.current ? '' : '历史轮次 · '}{friendlyTime(d.at, now)}</span>
              </a>
            )) : <p class="empty">还没有已核验的交付。</p>}
          </section>
        </div>

        <aside class="today-side">
          <section class="block" aria-labelledby="now-h">
            <div class="block-head">
              <h2 id="now-h">公司此刻</h2>
              <a class="block-link" href={hrefOf('overview')}>现场大屏</a>
            </div>
            {working.length ? working.map((a) => <Worker key={a.id} agent={a} />) : <p class="empty">现在没有员工在工作。</p>}
            {idle.map((a) => (
              <div key={a.id} class="worker">
                <div class="worker-top"><Status tone="neutral">{roleText(a.role)}</Status><span class="worker-state">待命</span></div>
                <p class="worker-facts"><span>候选下一条：{a.next!.title}</span></p>
              </div>
            ))}
            {data ? (
              <p class="block-foot">
                {data.summary.onlineHosts ? `${data.summary.onlineHosts} 台电脑在线` : '执行端未在线'}
                {data.summary.queued ? ` · ${data.summary.queued} 项排队` : ''}
              </p>
            ) : null}
          </section>

          <section class="block" aria-labelledby="proj-h">
            <div class="block-head">
              <h2 id="proj-h">项目</h2>
              <span class="hint">已确认范围的验收进度</span>
            </div>
            {projects.length ? projects.map((p) => {
              const tone = projectTone(p.blocked, working.filter((a) => a.project?.id === p.id).length);
              return (
                <a key={p.id} class="project-line" href={hrefOf('projects', p.id)}>
                  <span class="project-line-top">
                    <span class={`dot is-${tone}`} aria-hidden="true" />
                    <span class="project-line-name">{p.name}</span>
                    <span class="project-line-value">
                      {p.progress.percent !== undefined ? `${p.progress.percent}% · ${p.progress.done}/${p.progress.total}` : '未量化'}
                    </span>
                  </span>
                  {p.progress.percent !== undefined ? <span class="line-meter"><i style={{ width: `${p.progress.percent}%` }} /></span> : null}
                </a>
              );
            }) : <p class="empty">还没有项目。</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}
