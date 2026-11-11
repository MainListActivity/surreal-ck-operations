import type { Requirement } from '../../../../src/iteration/requirements.ts';
import type { RuntimeAgentView } from '../../../../src/runtime-dashboard.ts';
import type { RuntimeProjectView } from '../../../../src/runtime-projects.ts';
import { EmptyState, ErrorState, Loading, roleText } from '../common.tsx';
import { REQUIREMENT_GROUPS, inGroup, nextStep, priorityText } from '../iteration.ts';
import { employeeProgress, messagePreview, roomAgents, staffStatus } from '../meeting-rooms.ts';
import { hrefOf, type Route } from '../model.ts';
import { useLiveDashboard, useRequirements } from '../store.ts';
import { projectTone } from '../today.ts';

const STAFF_TONE: Record<string, string> = { working: 'progress', blocked: 'blocked', waiting: 'decide', unknown: 'neutral', idle: 'neutral' };
const ROLE_ORDER = ['product', 'engineering', 'qa'];

/** 流水线四列：老板最关心的「待你确认」在最左。 */
const LANES: ReadonlyArray<{ id: string; label: string; tone: string; limit?: number }> = [
  { id: 'confirm', label: '待你确认', tone: 'decide' },
  { id: 'active', label: '实施中', tone: 'progress' },
  { id: 'release', label: '上线核验', tone: 'progress' },
  { id: 'released', label: '已上线', tone: 'done', limit: 4 },
];

export function ProjectsPage({ route }: { route: Route }) {
  return route.id ? <ProjectDetail key={route.id} id={route.id} /> : <ProjectList />;
}

function ProjectList() {
  const dash = useLiveDashboard();
  const reqs = useRequirements();
  if (!dash.data) {
    return <div class="page"><h1>项目</h1>{dash.error ? <ErrorState message={dash.error} onRetry={() => void dash.reload()} /> : <Loading />}</div>;
  }
  const data = dash.data;
  const projects = data.projects ?? [];
  return (
    <div class="page">
      <header class="today-head"><h1>项目</h1><p class="lede">{projects.length} 个项目</p></header>
      {projects.length ? (
        <div class="project-grid">
          {projects.map((p) => {
            const people = roomAgents(data, p.id);
            const waiting = (reqs.data ?? []).filter((r) => r.project === p.id && inGroup(r.state, 'confirm')).length;
            return (
              <a key={p.id} class="project-card" href={hrefOf('projects', p.id)}>
                <span class="project-card-top">
                  <span class={`dot is-${projectTone(p.blocked, people.length)}`} aria-hidden="true" />
                  <strong>{p.name}</strong>
                </span>
                <span class="project-card-facts">
                  <span>{people.length ? `${people.length} 位在工作` : '没有人在工作'}</span>
                  {waiting ? <span>{waiting} 条待你确认</span> : null}
                  {p.blocked ? <span class="text-blocked">{p.blocked} 项受阻</span> : null}
                </span>
                {p.progress.percent !== undefined ? (
                  <>
                    <span class="line-meter"><i style={{ width: `${p.progress.percent}%` }} /></span>
                    <span class="hint">验收 {p.progress.percent}% · {p.progress.done}/{p.progress.total}</span>
                  </>
                ) : <span class="hint">还没有确认的验收清单</span>}
              </a>
            );
          })}
        </div>
      ) : <EmptyState title="还没有项目">在需求池新建需求并确认后，会在这里出现。</EmptyState>}
    </div>
  );
}

function Stage({ agent }: { agent: RuntimeAgentView }) {
  const status = staffStatus(agent);
  const progress = employeeProgress(agent);
  return (
    <div class={`stage${status.kind === 'working' ? ' is-active' : ''}`}>
      <div class="stage-head">
        <span class={`status tone-${STAFF_TONE[status.kind] ?? 'neutral'}`}>{roleText(agent.role)}</span>
        <span class="hint">{status.text}</span>
      </div>
      {agent.taskTitle ? <a class="stage-task" href={agent.taskId ? hrefOf('tasks', agent.taskId) : undefined}>{agent.taskTitle}</a> : <span class="hint">没有当前任务</span>}
      {agent.blockedReason ? <p class="worker-note">{agent.blockedReason}</p> : null}
      {progress.percent !== undefined ? <span class="line-meter"><i style={{ width: `${progress.percent}%` }} /></span> : null}
      <span class="hint">
        {progress.done !== undefined ? `清单 ${progress.done}/${progress.total}` : progress.detail}
        {agent.destination ? ` · 下一站：${agent.destination.label}` : ''}
      </span>
    </div>
  );
}

function RequirementCard({ r }: { r: Requirement & { stage?: string } }) {
  const step = nextStep(r, r.stage);
  return (
    <a class={`req-card${step.owner ? ' needs-you' : ''}`} href={hrefOf('requirements', r.id)}>
      <span class="req-card-title">{r.title}</span>
      <span class="req-card-meta">
        <span class={`priority p${r.priority}`}>{priorityText(r.priority).split(' ')[0]}</span>
        <span>修订 {r.revision}</span>
      </span>
      <span class={`status tone-${step.tone}`}>{step.text}</span>
    </a>
  );
}

function ProjectDetail({ id }: { id: string }) {
  const dash = useLiveDashboard();
  const reqs = useRequirements();
  if (!dash.data) {
    return <div class="page"><h1>项目</h1>{dash.error ? <ErrorState message={dash.error} onRetry={() => void dash.reload()} /> : <Loading />}</div>;
  }
  const data = dash.data;
  const project: RuntimeProjectView | undefined = data.projects?.find((p) => p.id === id);
  const name = project?.name ?? id;
  const people = roomAgents(data, id).sort((a, b) =>
    (ROLE_ORDER.indexOf(a.role) + 99) % 99 - (ROLE_ORDER.indexOf(b.role) + 99) % 99);
  const mine = (reqs.data ?? []).filter((r) => r.project === id);
  const quiet = mine.filter((r) => inGroup(r.state, 'paused') || inGroup(r.state, 'closed')).length;
  const messages = project?.pendingMessages ?? [];
  const waiting = mine.filter((r) => inGroup(r.state, 'confirm')).length;

  return (
    <div class="page project-page">
      <header class="page-header">
        <nav class="crumbs" aria-label="位置"><span><a href={hrefOf('projects')}>项目</a><span class="crumb-sep">/</span></span></nav>
        <div class="page-header-row">
          <div class="page-header-text">
            <h1>{name}</h1>
            <p class="page-meta">
              <span>{people.length ? `${people.length} 位员工在工作` : '没有员工在工作'}</span>
              {waiting ? <span>{waiting} 条待你确认</span> : null}
              {project?.blocked ? <span class="text-blocked">{project.blocked} 项受阻</span> : null}
              {project?.queued ? <span>{project.queued} 项排队</span> : null}
              <span>{project?.progress.percent !== undefined ? `验收 ${project.progress.percent}% · ${project.progress.done}/${project.progress.total}` : '还没有确认的验收清单'}</span>
            </p>
          </div>
          <div class="page-actions">
            <a class="button" href={hrefOf('overview', undefined, { project: id })}>现场大屏</a>
            <a class="button" href={hrefOf('requirements', undefined, { p: id, settings: '1' })}>项目设置</a>
            <a class="button primary" href={hrefOf('requirements', 'new', { p: id })}>新建需求</a>
          </div>
        </div>
      </header>

      <section class="block" aria-labelledby="site-h">
        <div class="block-head"><h2 id="site-h">工作现场</h2><span class="hint">交接与证据在任务里查看</span></div>
        {people.length ? (
          <div class="relay">{people.map((a) => <Stage key={a.id} agent={a} />)}</div>
        ) : (
          <p class="empty">
            {project?.blocked ? '项目存在阻塞，当前没有执行中的员工。' : project?.queued ? '任务等待派工，当前没有执行中的员工。' : '当前没有员工在这个项目里工作。'}
          </p>
        )}
      </section>

      <section class="block" aria-labelledby="pipe-h">
        <div class="block-head">
          <h2 id="pipe-h">需求</h2>
          <a class="block-link" href={hrefOf('requirements', undefined, { p: id })}>需求池{quiet ? ` · 另有 ${quiet} 条暂停或关闭` : ''}</a>
        </div>
        {reqs.error && !reqs.data ? <ErrorState message={reqs.error} onRetry={() => void reqs.reload()} /> : !reqs.data ? <Loading rows={2} /> : (
          <div class="pipeline">
            {LANES.map((lane) => {
              const group = REQUIREMENT_GROUPS.find((g) => g.id === lane.id)!;
              const rows = mine.filter((r) => inGroup(r.state, group.id));
              const shown = lane.limit ? rows.slice(0, lane.limit) : rows;
              return (
                <div key={lane.id} class="lane">
                  <div class="lane-head"><span class={`status tone-${lane.tone}`}>{lane.label}</span><span class="hint">{rows.length}</span></div>
                  {shown.map((r) => <RequirementCard key={r.id} r={r} />)}
                  {!rows.length ? <p class="lane-empty">无</p> : null}
                  {rows.length > shown.length ? <a class="lane-more" href={hrefOf('requirements', undefined, { p: id, s: lane.id })}>还有 {rows.length - shown.length} 条</a> : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {messages.length ? (
        <section class="block" aria-labelledby="msg-h">
          <div class="block-head"><h2 id="msg-h">待发消息</h2><span class="hint">接收人由调度决定</span></div>
          {messages.map((m) => (
            <a key={m.messageId} class="line-row" href={hrefOf('messages')}>
              <span class={`status tone-${m.hold ? 'decide' : 'neutral'}`}>{m.hold ? '已扣住' : m.stage === 'later' ? '后续步骤' : '下一条'}</span>
              <span class="line-title">{m.title}</span>
              <span class="line-meta">{messagePreview(m).slice(0, 40)}</span>
            </a>
          ))}
        </section>
      ) : null}
    </div>
  );
}
