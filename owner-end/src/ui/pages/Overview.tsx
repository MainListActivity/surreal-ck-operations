import { useCallback, useEffect, useState } from 'preact/hooks';
import type { Requirement } from '../../../../src/iteration/requirements.ts';
import { readBoard, runCommand, outcomeText } from '../api.ts';
import { Badge, EmptyState, ErrorState, Loading, PageHeader, ProgressBar, Section, roleText, timeText } from '../common.tsx';
import { nextStep, priorityText, stageOf, stateOf, taskProgress, type Tone } from '../iteration.ts';
import { buildBoardView, clockText, hrefOf, taskIdOf, TASK_STATE_ZH, type BoardViewModel } from '../model.ts';
import type { Product } from './Requirements.tsx';

interface TaskRow { id?: unknown; title?: string; state?: string; executor_role?: string; reviewer_role?: string }
interface Exec { execution: { stage: string; note?: string; released_sha?: string } | null; tasks: Array<{ state?: string }> }

interface Item { key: string; href: string; title: string; reason: string; tone: Tone; badge: string; sub?: string; progress?: number }

interface Data {
  requirements: Requirement[];
  tasks: TaskRow[];
  products: Product[];
  exec: Record<string, Exec>;
  board?: BoardViewModel;
  messages: { total: number; held: number };
  boardError?: string;
  at: number;
}

export function OverviewPage() {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reqOut, taskOut, prodOut, boardOut] = await Promise.all([
        runCommand<{ requirements: Requirement[] }>('requirement.list', {}),
        runCommand<{ tasks?: TaskRow[] }>('task.list'),
        runCommand<{ products: Product[] }>('product.iteration.list'),
        readBoard(),
      ]);
      if (reqOut.kind !== 'ok') { setError(outcomeText(reqOut, '')); return; }
      const requirements = reqOut.result.requirements;
      const exec: Record<string, Exec> = {};
      // 只为推进中的需求读取执行记录：进度与发布阶段。
      await Promise.all(requirements.filter(r => ['implementing', 'release_pending', 'released'].includes(r.state)).slice(0, 20).map(async r => {
        const out = await runCommand<Exec>('requirement.execution', { id: r.id }).catch(() => undefined);
        if (out?.kind === 'ok') exec[r.id] = out.result;
      }));
      const board = boardOut.kind === 'ok' ? boardOut.result : undefined;
      const messages = board?.messages ?? [];
      setData({
        requirements,
        tasks: taskOut.kind === 'ok' ? taskOut.result.tasks ?? [] : [],
        products: prodOut.kind === 'ok' ? prodOut.result.products : [],
        exec,
        board: board ? buildBoardView(board) : undefined,
        messages: { total: messages.length, held: messages.filter(m => m.hold).length },
        boardError: boardOut.kind === 'ok' ? undefined : outcomeText(boardOut, ''),
        at: Date.now(),
      });
      setError('');
    } catch {
      setError('总览读取失败，请检查网络后重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const header = (
    <PageHeader
      title="总览"
      description="需要你决定的事项排在最前。点击任一项进入对应需求或任务。"
      actions={<button type="button" class="ghost" disabled={loading} onClick={() => void load()}>{loading ? '正在刷新…' : '刷新'}</button>}
      meta={data ? <span>更新于 {clockText(data.at)} · 每 30 秒自动刷新</span> : undefined}
    />
  );

  if (error && !data) return <div class="page">{header}<ErrorState message={error} onRetry={() => void load()} /></div>;
  if (!data) return <div class="page">{header}<Loading label="正在汇总需求、任务和员工动态…" rows={6} /></div>;

  const productName = (id: string) => data.products.find(p => p.id === id)?.name ?? id;
  const reqItem = (r: Requirement, reason?: string, tone?: Tone): Item => {
    const stage = data.exec[r.id]?.execution?.stage;
    const next = nextStep(r, stage);
    const st = stateOf(r.state);
    const p = data.exec[r.id] ? taskProgress(data.exec[r.id]!.tasks) : undefined;
    return {
      key: `r-${r.id}`, href: hrefOf('requirements', r.id), title: r.title, reason: reason ?? next.text, tone: tone ?? next.tone,
      badge: stageOf(stage)?.label && r.state !== 'released' ? stageOf(stage)!.label : st.label,
      sub: `${productName(r.project)} · ${priorityText(r.priority)}`,
      progress: p && p.total && r.state === 'implementing' ? p.percent : undefined,
    };
  };
  const taskItem = (t: TaskRow, reason: string, tone: Tone): Item => ({
    key: `t-${taskIdOf(t)}`, href: hrefOf('tasks', taskIdOf(t)), title: t.title || taskIdOf(t), reason, tone,
    badge: TASK_STATE_ZH[t.state ?? ''] ?? t.state ?? '', sub: `执行任务 · ${roleText(t.executor_role)}`,
  });

  const reqs = data.requirements;
  const decide = reqs.filter(r => nextStep(r, data.exec[r.id]?.execution?.stage).owner && !(r.state === 'queued' && r.planning_error) && r.state !== 'paused')
    .sort((a, b) => a.priority - b.priority).map(r => reqItem(r));
  const blockedReqs = reqs.filter(r => (r.state === 'queued' && r.planning_error) || r.execution_error || data.exec[r.id]?.execution?.stage === 'blocked' || data.exec[r.id]?.execution?.stage === 'awaiting_evidence')
    .map(r => reqItem(r, r.planning_error ?? r.execution_error ?? data.exec[r.id]?.execution?.note ?? '执行受阻', 'blocked'));
  const blockedTasks = data.tasks.filter(t => t.state === 'blocked').map(t => taskItem(t, '任务受阻，等待处理', 'blocked'));
  const queueBlocked = (data.board?.queue ?? []).filter(q => q.blocked).map(q => ({ key: `q-${q.key}`, href: hrefOf('tasks', q.taskId), title: q.title, reason: q.reason, tone: 'blocked' as Tone, badge: '排队受阻', sub: '派工队列' }));
  const blocked = dedupe([...blockedReqs, ...blockedTasks, ...queueBlocked]);
  const paused = reqs.filter(r => r.state === 'paused').map(r => reqItem(r, '已暂停，恢复后继续推进', 'neutral'));
  const active = reqs.filter(r => (r.state === 'implementing' || r.state === 'queued') && !r.planning_error && !r.execution_error && data.exec[r.id]?.execution?.stage !== 'blocked').map(r => reqItem(r));
  const released = reqs.filter(r => r.state === 'released').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 6)
    .map(r => reqItem(r, data.exec[r.id]?.execution?.released_sha ? `已上线 · 提交 ${data.exec[r.id]!.execution!.released_sha}` : `已上线 · ${timeText(r.updated_at)}`, 'done'));
  const doneTasks = data.tasks.filter(t => t.state === 'done').slice(0, 5).map(t => taskItem(t, '执行与复核已完成', 'done'));

  const tiles = [
    { label: '待你决策', value: decide.length, tone: 'decide' as Tone, href: '#overview-decide' },
    { label: '受阻', value: blocked.length, tone: 'blocked' as Tone, href: '#overview-blocked' },
    { label: '推进中', value: active.length, tone: 'progress' as Tone, href: hrefOf('requirements', undefined, { s: 'active' }) },
    { label: '已上线', value: reqs.filter(r => r.state === 'released').length, tone: 'done' as Tone, href: hrefOf('requirements', undefined, { s: 'released' }) },
  ];

  return (
    <div class="page overview-page">
      {header}
      {error ? <div class="notice warn" role="status"><span class="notice-text">部分数据刷新失败：{error}</span></div> : null}
      <div class="tiles">
        {tiles.map(t => (
          <a key={t.label} class={`tile tone-${t.tone}`} href={t.href} onClick={e => {
            if (t.href.startsWith('#overview-')) { e.preventDefault(); document.getElementById(t.href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          }}>
            <span class="tile-value">{t.value}</span>
            <span class="tile-label">{t.label}</span>
          </a>
        ))}
      </div>

      <div class="overview-grid">
        <div class="overview-main">
          <Section id="overview-decide" title="待你决策" hint="确认开工、确认发布、补齐验收标准或发布流程。">
            <ItemList items={decide} empty="没有等你决策的事项。" />
          </Section>
          <Section id="overview-blocked" title="受阻" hint="规划失败、任务受阻或缺少发布证据。">
            <ItemList items={blocked} empty="没有受阻的事项。" />
            {paused.length ? <><h3 class="sub-head">已暂停（{paused.length}）</h3><ItemList items={paused} empty="" /></> : null}
          </Section>
          <Section title="推进中" hint="已确认的需求，由 Agent 规划与执行。" actions={<a class="more-link" href={hrefOf('requirements', undefined, { s: 'active' })}>全部</a>}>
            <ItemList items={active} empty="当前没有推进中的需求。" />
          </Section>
          <Section title="最近交付" hint="已上线的需求与已完成的执行任务。任务完成不代表已上线。">
            {released.length ? <><h3 class="sub-head">已上线的需求</h3><ItemList items={released} empty="" /></> : null}
            {doneTasks.length ? <><h3 class="sub-head">已完成的执行任务</h3><ItemList items={doneTasks} empty="" /></> : null}
            {!released.length && !doneTasks.length ? <EmptyState title="还没有交付">需求上线或任务完成后会出现在这里。</EmptyState> : null}
          </Section>
        </div>

        <aside class="overview-side">
          <Section title="员工现在" actions={<a class="more-link" href="#messages">派工消息</a>}>
            {data.boardError ? <p class="notice warn"><span class="notice-text">员工动态读取失败：{data.boardError}</span></p> : null}
            {data.board ? (
              <>
                <p class="status-line">
                  <span class={`dot tone-${data.board.runner.tone === 'success' ? 'done' : data.board.runner.tone === 'danger' ? 'blocked' : 'neutral'}`} aria-hidden="true" />
                  {data.board.runner.stateText}{data.board.runner.detail ? ` · ${data.board.runner.detail}` : ''}
                </p>
                {data.board.employees.length ? (
                  <ul class="people">
                    {data.board.employees.map(e => (
                      <li key={e.id}>
                        <span class="avatar" aria-hidden="true">{e.name.slice(0, 1)}</span>
                        <span class="people-main">
                          <strong>{e.name}</strong><small>{roleText(e.role)}</small>
                          <span class={`people-task${e.now.title ? '' : ' idle'}`}>{e.now.title ? `${e.now.statusText}：${e.now.title}` : e.now.statusText}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : <p class="hint">还没有在岗员工。</p>}
                {data.messages.total ? (
                  <a class="inline-alert" href="#messages">
                    <span>{data.messages.total} 条待发消息{data.messages.held ? `，其中 ${data.messages.held} 条已扣住` : ''}</span>
                    <span aria-hidden="true">查看</span>
                  </a>
                ) : null}
              </>
            ) : null}
          </Section>
          <Section title="最近活动">
            {data.board?.recent.length ? (
              <ol class="timeline">
                {data.board.recent.slice(0, 8).map(r => (
                  <li key={r.key}><time>{r.time}</time><span>{r.actor} · {r.label}{r.taskTitle ? <span class="hint"> · {r.taskTitle}</span> : null}</span></li>
                ))}
              </ol>
            ) : <p class="hint">还没有动态。</p>}
          </Section>
        </aside>
      </div>
    </div>
  );
}

function dedupe(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter(i => (seen.has(i.href) ? false : (seen.add(i.href), true)));
}

function ItemList({ items, empty }: { items: Item[]; empty: string }) {
  if (!items.length) return empty ? <p class="empty">{empty}</p> : null;
  return (
    <ul class="item-list">
      {items.map(i => (
        <li key={i.key}>
          <a href={i.href} class={`item tone-${i.tone}`}>
            <span class="item-main">
              <span class="item-title">{i.title}</span>
              <span class="item-reason">{i.reason}</span>
              {i.progress !== undefined ? <ProgressBar value={i.progress} label={`${i.title} 完成比例`} /> : null}
            </span>
            <span class="item-meta">
              <Badge tone={i.tone}>{i.badge}</Badge>
              {i.sub ? <small>{i.sub}</small> : null}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
