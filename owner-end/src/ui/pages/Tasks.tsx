import { useLiveRefresh } from '../realtime.ts';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { outcomeText, runCommand } from '../api.ts';
import {
  Badge, Dialog, EmptyState, ErrorState, Field, FilterTabs, Loading, NoticeLine, PageHeader, Pre, RoleSelect, Section, roleText, timeText, useAction,
} from '../common.tsx';
import { taskTone } from '../iteration.ts';
import { TASK_STATE_ZH, hrefOf, taskIdOf, validateReassign, validateTaskForm, type Route, type TaskFormValues } from '../model.ts';

interface TaskRow {
  id?: unknown;
  title?: string;
  state?: string;
  executor_role?: string;
  reviewer_role?: string;
  type?: string;
  parent?: unknown;
  runtime_execution?: { state: string; attempts?: number; error?: string };
  [key: string]: unknown;
}

interface AuditRow { action?: string; actor?: unknown; at?: unknown; evidence?: string }
interface TaskDetail { task: TaskRow; audit?: AuditRow[]; messages?: unknown[] }

const EMPTY_FORM: TaskFormValues = { title: '', requirement: '', acceptanceText: '', executorRole: '', reviewerRole: '', type: '' };

const GROUPS: ReadonlyArray<{ id: string; label: string; states?: string[] }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中', states: ['doing', 'review'] },
  { id: 'waiting', label: '待领取', states: ['ready', 'planned'] },
  { id: 'blocked', label: '受阻', states: ['blocked'] },
  { id: 'done', label: '已完成', states: ['done'] },
  { id: 'void', label: '已作废', states: ['void'] },
];
const inGroup = (state: string | undefined, group: string) => {
  const g = GROUPS.find(x => x.id === group);
  return !g?.states || g.states.includes(state ?? '');
};

const ACTION_ZH: Record<string, string> = {
  create: '创建', claim: '领取', checkpoint: '更新进度', submit: '提交交付', review: '复核', approve: '通过', accept: '验收通过', reject: '退回', reassign: '改派', void: '作废', release: '释放',
};

export function TasksPage({ route }: { route: Route }) {
  return route.id ? <TaskDetailPage key={route.id} taskId={route.id} /> : <TaskList route={route} />;
}

function TaskList({ route }: { route: Route }) {
  const [tasks, setTasks] = useState<TaskRow[]>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  const group = GROUPS.some(g => g.id === route.params.s) ? route.params.s! : 'all';

  useEffect(() => {
    let active = true;
    setError('');
    void runCommand<{ tasks?: TaskRow[] }>('task.list').then(out => {
      if (!active) return;
      if (out.kind === 'ok') setTasks(out.result.tasks ?? []);
      else setError(outcomeText(out, ''));
    }).catch(() => active && setError('任务列表读取失败'));
    return () => { active = false; };
  }, [tick]);

  useLiveRefresh(['task'], () => setTick(t => t + 1), !creating);
  const counts = useMemo(() => Object.fromEntries(GROUPS.map(g => [g.id, (tasks ?? []).filter(t => inGroup(t.state, g.id)).length])), [tasks]);
  const needle = query.trim().toLowerCase();
  const rows = (tasks ?? []).filter(t => inGroup(t.state, group) && (!needle || (t.title ?? '').toLowerCase().includes(needle) || taskIdOf(t).includes(needle)));

  return (
    <div class="page">
      <PageHeader
        title="执行任务"
        description="任务完成表示执行与复核结束，不代表已上线。"
        actions={<button type="button" class="primary" onClick={() => setCreating(true)}>新建任务</button>}
      />
      <div class="toolbar">
        <FilterTabs label="按任务状态筛选" value={group} onChange={id => { location.hash = hrefOf('tasks', undefined, { s: id === 'all' ? undefined : id }); }}
          items={GROUPS.map(g => ({ id: g.id, label: g.label, count: counts[g.id] ?? 0 }))} />
        <label class="search">
          <span class="visually-hidden">搜索任务</span>
          <input type="search" placeholder="搜索任务标题或编号" value={query} onInput={e => setQuery(e.currentTarget.value)} />
        </label>
      </div>
      {error ? <ErrorState message={error} onRetry={() => setTick(t => t + 1)} /> : null}
      {!tasks && !error ? <Loading label="正在读取任务…" rows={5} /> : null}
      {tasks && !rows.length ? (
        <EmptyState title={tasks.length ? '没有符合条件的任务' : '还没有执行任务'}>
          {tasks.length ? '换一个状态或搜索词看看。' : '需求确认开工后，Agent 拆出的任务会出现在这里。'}
        </EmptyState>
      ) : null}
      {rows.length ? (
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th scope="col">任务</th><th scope="col">状态</th><th scope="col">执行岗</th><th scope="col">复核岗</th><th scope="col">类型</th></tr></thead>
            <tbody>
              {rows.map(t => {
                const id = taskIdOf(t);
                return (
                  <tr key={id} class={t.state === 'blocked' ? 'is-blocked' : undefined}>
                    <td class="cell-title"><a class="row-link" href={hrefOf('tasks', id)}>{t.title || id}</a><span class="cell-sub" title={id}><code>#{id.slice(0, 8)}</code></span></td>
                    <td data-label="状态"><Badge tone={taskTone(t.state)}>{TASK_STATE_ZH[t.state ?? ''] ?? t.state ?? '未知'}</Badge></td>
                    <td data-label="执行岗">{roleText(t.executor_role)}</td>
                    <td data-label="复核岗">{roleText(t.reviewer_role)}</td>
                    <td data-label="类型">{t.type ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? (
        <Dialog wide title="新建执行任务" onClose={() => setCreating(false)}>
          <p class="hint">直接派给员工执行。还没决定要不要做的事，请先放进<a href="#requirements">需求</a>，由你确认后再开工。</p>
          <TaskForm onDone={() => { setCreating(false); setTick(t => t + 1); }} onCancel={() => setCreating(false)} />
        </Dialog>
      ) : null}
    </div>
  );
}

function TaskDetailPage({ taskId }: { taskId: string }) {
  const [detail, setDetail] = useState<TaskDetail>();
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [panel, setPanel] = useState<'subtask' | 'reassign' | 'void' | null>(null);
  const [notice, setNotice] = useState<string>('');

  useEffect(() => {
    let active = true;
    setError('');
    void runCommand<TaskDetail>('task.detail', { taskId }).then(out => {
      if (!active) return;
      if (out.kind === 'ok') setDetail(out.result);
      else setError(outcomeText(out, ''));
    }).catch(() => active && setError('任务详情读取失败'));
    return () => { active = false; };
  }, [taskId, tick]);

  useLiveRefresh(['task','audit','outbound_message'], () => setTick(t => t + 1), !panel);
  const crumbs = [{ label: '执行任务', href: '#tasks' }];
  if (error && !detail) return <div class="page"><PageHeader title="任务详情" crumbs={crumbs} /><ErrorState title="没有读取到这个任务" message={error} onRetry={() => setTick(t => t + 1)} /></div>;
  if (!detail) return <div class="page"><PageHeader title="任务详情" crumbs={crumbs} /><Loading label="正在读取任务…" rows={5} /></div>;

  const t = detail.task;
  const text = (key: string) => (typeof t[key] === 'string' && (t[key] as string).trim() ? t[key] as string : undefined);
  const description = text('requirement');
  const acceptance = text('acceptance_text') ?? text('acceptanceText') ?? text('acceptance');
  const parent = t.parent ? taskIdOf({ id: t.parent }) : undefined;
  const done = (message: string) => { setPanel(null); setNotice(message); setTick(x => x + 1); };

  return (
    <div class="page detail-page">
      <PageHeader
        crumbs={crumbs}
        title={t.title || taskId}
        meta={(
          <>
            <Badge tone={taskTone(t.state)}>{TASK_STATE_ZH[t.state ?? ''] ?? t.state ?? '未知'}</Badge>
            <span>执行：{roleText(t.executor_role)}</span>
            <span>复核：{roleText(t.reviewer_role)}</span>
            <code>{taskId}</code>
          </>
        )}
        actions={<button type="button" class="ghost" onClick={() => setTick(x => x + 1)}>刷新</button>}
      />
      {t.runtime_execution ? <p class="hint">执行端：{
        ({ reserved: '已预留，等待启动确认', running: '执行中', collecting: '正在保存结果', pending: '结果已保存，自动处理中',
          settled: '结果已入库', interrupted: '本轮中断，等待恢复', superseded: '执行批次已被接替', attention: '等待处理' } as Record<string, string>)[t.runtime_execution.state]
          ?? t.runtime_execution.state
      }{t.runtime_execution.attempts ? ` · 已重试 ${t.runtime_execution.attempts} 次` : ''}
      {t.runtime_execution.error ? ` · ${t.runtime_execution.error}` : ''}</p> : null}
      {notice ? <NoticeLine notice={{ tone: 'ok', text: notice }} onClose={() => setNotice('')} /> : null}
      {t.state === 'blocked' ? <div class="callout tone-blocked"><div class="callout-body"><p class="callout-title">任务受阻</p><div class="callout-text"><p>查看下方进展记录了解原因；可以改派岗位，或作废后重新拆分。</p></div></div></div> : null}

      <div class="detail-grid">
        <div class="detail-main">
          <Section title="任务说明">{description ? <p class="prose">{description}</p> : <p class="hint">没有填写说明。</p>}</Section>
          <Section title="验收标准">{acceptance ? <p class="prose">{acceptance}</p> : <p class="hint">没有填写验收标准。</p>}</Section>
          <Section title="进展记录" hint="领取、进度、提交与复核，新的在下。">
            {detail.audit?.length ? (
              <ol class="timeline">
                {detail.audit.map((a, i) => (
                  <li key={i}>
                    <time>{timeText(a.at)}</time>
                    <span><strong>{ACTION_ZH[a.action ?? ''] ?? a.action ?? '—'}</strong> · {String(a.actor ?? '')}{a.evidence ? <span class="timeline-note">{a.evidence}</span> : null}</span>
                  </li>
                ))}
              </ol>
            ) : <p class="hint">还没有进展记录。</p>}
          </Section>
          <details class="raw-details">
            <summary>原始数据（排障用）</summary>
            <Pre value={detail} />
          </details>
        </div>
        <aside class="detail-side" aria-label="任务操作">
          <Section title="概要">
            <dl class="facts">
              <dt>状态</dt><dd>{TASK_STATE_ZH[t.state ?? ''] ?? t.state}</dd>
              <dt>执行岗</dt><dd>{roleText(t.executor_role)} <small class="hint">{t.executor_role}</small></dd>
              <dt>复核岗</dt><dd>{roleText(t.reviewer_role)} <small class="hint">{t.reviewer_role}</small></dd>
              {t.type ? <><dt>类型</dt><dd>{t.type}</dd></> : null}
              {parent ? <><dt>父任务</dt><dd><a href={hrefOf('tasks', parent)}>{parent}</a></dd></> : null}
              <dt>派工消息</dt><dd>{detail.messages?.length ? <a href="#messages">{detail.messages.length} 条</a> : '无'}</dd>
            </dl>
          </Section>
          <Section title="操作">
            <div class="action-stack">
              <button type="button" onClick={() => setPanel('subtask')}>加子任务</button>
              <button type="button" onClick={() => setPanel('reassign')}>改派岗位</button>
              <button type="button" class="danger" disabled={t.state === 'void'} onClick={() => setPanel('void')}>作废任务…</button>
            </div>
          </Section>
        </aside>
      </div>

      {panel === 'subtask' ? (
        <Dialog wide title="加子任务" onClose={() => setPanel(null)}>
          <TaskForm parent={taskId} onDone={() => done('已添加子任务')} onCancel={() => setPanel(null)} />
        </Dialog>
      ) : null}
      {panel === 'reassign' ? (
        <Dialog title="改派岗位" onClose={() => setPanel(null)}>
          <ReassignForm taskId={taskId} current={t} onDone={() => done('已改派')} onCancel={() => setPanel(null)} />
        </Dialog>
      ) : null}
      {panel === 'void' ? (
        <Dialog title="作废任务" tone="danger" onClose={() => setPanel(null)}>
          <VoidForm taskId={taskId} onDone={() => done('已作废')} onCancel={() => setPanel(null)} />
        </Dialog>
      ) : null}
    </div>
  );
}

export function TaskForm({ parent, onDone, onCancel }: { parent?: string; onDone(): void; onCancel?(): void }) {
  const [form, setForm] = useState<TaskFormValues>(EMPTY_FORM);
  const [problems, setProblems] = useState<string[]>([]);
  const { busy, notice, run } = useAction();
  const set = (key: keyof TaskFormValues) => (value: string) => setForm(prev => ({ ...prev, [key]: value }));

  const submit = (event: Event) => {
    event.preventDefault();
    const found = validateTaskForm(form);
    setProblems(found);
    if (found.length) return;
    void run('task.create', {
      title: form.title.trim(),
      requirement: form.requirement.trim(),
      acceptanceText: form.acceptanceText.trim(),
      executorRole: form.executorRole,
      reviewerRole: form.reviewerRole,
      ...(form.type.trim() ? { type: form.type.trim() } : {}),
      ...(parent ? { parent } : {}),
    }, parent ? '已添加子任务' : '已创建任务', () => {
      setForm(EMPTY_FORM);
      onDone();
    });
  };

  return (
    <form class="form" onSubmit={submit} noValidate>
      {parent ? <p class="hint">父任务：<code>{parent}</code></p> : null}
      <Field label="标题" required><input value={form.title} disabled={busy} onInput={e => set('title')(e.currentTarget.value)} /></Field>
      <Field label="任务说明" required><textarea rows={4} value={form.requirement} disabled={busy} onInput={e => set('requirement')(e.currentTarget.value)} /></Field>
      <Field label="验收标准" required><textarea rows={3} value={form.acceptanceText} disabled={busy} onInput={e => set('acceptanceText')(e.currentTarget.value)} /></Field>
      <div class="grid-2">
        <Field label="执行岗" required><RoleSelect value={form.executorRole} disabled={busy} onChange={set('executorRole')} /></Field>
        <Field label="复核岗" required hint="执行岗与复核岗不能相同。"><RoleSelect value={form.reviewerRole} disabled={busy} withOwner onChange={set('reviewerRole')} /></Field>
      </div>
      <Field label="类型" hint="可空；填了则按该类型的路线派工。"><input value={form.type} disabled={busy} onInput={e => set('type')(e.currentTarget.value)} /></Field>
      {problems.length ? <ul class="errors" role="alert">{problems.map(p => <li key={p}>{p}</li>)}</ul> : null}
      <NoticeLine notice={notice} />
      <div class="button-row end">
        {onCancel ? <button type="button" disabled={busy} onClick={onCancel}>取消</button> : null}
        <button type="submit" class="primary" disabled={busy}>{parent ? '添加子任务' : '提交任务'}</button>
      </div>
    </form>
  );
}

function ReassignForm({ taskId, current, onDone, onCancel }: { taskId: string; current?: TaskRow; onDone(): void; onCancel(): void }) {
  const [executorRole, setExecutorRole] = useState('');
  const [reviewerRole, setReviewerRole] = useState('');
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const { busy, notice, run } = useAction();

  const submit = () => {
    const found = validateReassign({ executorRole, reviewerRole, note });
    setProblems(found);
    if (found.length) return;
    void run('task.reassign', {
      taskId,
      ...(executorRole ? { executorRole } : {}),
      ...(reviewerRole ? { reviewerRole } : {}),
      note: note.trim(),
    }, '已改派', () => { setNote(''); onDone(); });
  };

  return (
    <div class="form">
      <p class="hint">当前：执行 {roleText(current?.executor_role)} · 复核 {roleText(current?.reviewer_role)}。留空的岗位保持不变。</p>
      <div class="grid-2">
        <Field label="新执行岗"><RoleSelect value={executorRole} allowBlank blankText="保持不变" disabled={busy} onChange={setExecutorRole} /></Field>
        <Field label="新复核岗"><RoleSelect value={reviewerRole} allowBlank blankText="保持不变" withOwner disabled={busy} onChange={setReviewerRole} /></Field>
      </div>
      <Field label="改派原因" required><textarea rows={2} value={note} disabled={busy} onInput={e => setNote(e.currentTarget.value)} /></Field>
      {problems.length ? <ul class="errors" role="alert">{problems.map(p => <li key={p}>{p}</li>)}</ul> : null}
      <NoticeLine notice={notice} />
      <div class="button-row end">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" class="primary" disabled={busy} onClick={submit}>改派</button>
      </div>
    </div>
  );
}

function VoidForm({ taskId, onDone, onCancel }: { taskId: string; onDone(): void; onCancel(): void }) {
  const [note, setNote] = useState('');
  const { busy, notice, run } = useAction();
  return (
    <div class="form">
      <p>作废后任务不再派工，且<strong>无法撤回</strong>。请写明原因（至少 2 个字）。</p>
      <Field label="作废原因" required><textarea rows={2} value={note} disabled={busy} onInput={e => setNote(e.currentTarget.value)} /></Field>
      <NoticeLine notice={notice} />
      <div class="button-row end">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" class="danger" disabled={busy || note.trim().length < 2} onClick={() => void run('task.void', { taskId, note: note.trim() }, '已作废', () => { setNote(''); onDone(); })}>确认作废</button>
      </div>
    </div>
  );
}
