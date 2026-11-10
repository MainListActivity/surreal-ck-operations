import { useCallback, useEffect, useState } from 'preact/hooks';
import { outcomeText, runCommand } from '../api.ts';
import { Empty, NoticeLine, Panel, Pre, RoleSelect, timeText, useAction } from '../common.tsx';
import { TASK_STATE_ZH, taskIdOf, validateReassign, validateTaskForm, type TaskFormValues } from '../model.ts';

interface TaskRow {
  id?: unknown;
  title?: string;
  state?: string;
  executor_role?: string;
  reviewer_role?: string;
  type?: string;
  [key: string]: unknown;
}

interface AuditRow {
  action?: string;
  actor?: unknown;
  at?: unknown;
  evidence?: string;
}

interface TaskDetail {
  task: TaskRow;
  audit?: AuditRow[];
  messages?: unknown[];
}

const EMPTY_FORM: TaskFormValues = { title: '', requirement: '', acceptanceText: '', executorRole: '', reviewerRole: '', type: '' };

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskRow[] | undefined>();
  const [listError, setListError] = useState<string>();
  const [paused, setPaused] = useState<boolean>();
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<TaskDetail>();
  const [detailError, setDetailError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [subtaskOf, setSubtaskOf] = useState<string>();
  const dispatch = useAction();

  const loadList = useCallback(async () => {
    const out = await runCommand<{ tasks?: TaskRow[] }>('task.list');
    if (out.kind === 'ok') {
      setTasks(out.result.tasks ?? []);
      setListError(undefined);
    } else {
      setListError(outcomeText(out, ''));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    const out = await runCommand<{ paused?: boolean }>('status');
    if (out.kind === 'ok') setPaused(out.result.paused === true);
  }, []);

  const openDetail = useCallback(async (taskId: string) => {
    setSelected(taskId);
    setSubtaskOf(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    const out = await runCommand<TaskDetail>('task.detail', { taskId });
    if (out.kind === 'ok') setDetail(out.result);
    else setDetailError(outcomeText(out, ''));
  }, []);

  useEffect(() => {
    void loadList();
    void loadStatus();
  }, [loadList, loadStatus]);

  const afterWrite = async () => {
    await loadList();
    if (selected) await openDetail(selected);
  };

  const selectedRow = tasks?.find(t => taskIdOf(t) === selected);

  return (
    <div class="page">
      <Panel title="派工" hint="暂停后调度器不再派出新的任务，已在途的执行不受影响。">
        <div class="status-bar">
          <span class={`badge ${paused ? 'danger' : 'success'}`}>{paused === undefined ? '派工状态未知' : paused ? '已暂停' : '运行中'}</span>
          {paused === undefined ? null : (
            <button
              type="button"
              disabled={dispatch.busy}
              onClick={() => void dispatch.run(paused ? 'task.resume' : 'task.pause', {}, paused ? '已恢复派工' : '已暂停派工', () => loadStatus())}
            >
              {paused ? '恢复派工' : '暂停派工'}
            </button>
          )}
        </div>
        <NoticeLine notice={dispatch.notice} />
      </Panel>

      <Panel
        title="执行任务"
        hint="这里直接创建执行任务；尚未决定开工的问题请先放入需求池。"
        actions={<button type="button" class="primary" onClick={() => setCreating(c => !c)}>{creating ? '收起' : '新建任务'}</button>}
      >
        {creating ? <TaskForm onDone={() => { setCreating(false); void loadList(); }} onCancel={() => setCreating(false)} /> : null}
        {listError ? <p class="notice err">任务列表读取失败：{listError}</p> : null}
        {tasks === undefined && !listError ? <p class="hint">正在读取任务…</p> : null}
        {tasks && tasks.length === 0 ? <Empty>还没有任务</Empty> : null}
        {tasks && tasks.length > 0 ? (
          <ul class="list">
            {tasks.map(t => {
              const id = taskIdOf(t);
              return (
                <li key={id} class={id === selected ? 'row selected' : 'row'}>
                  <div class="row-main">
                    <strong>{t.title || id}</strong>
                    <span class="tag">{TASK_STATE_ZH[t.state ?? ''] ?? t.state ?? '未知状态'}</span>
                    {t.type ? <span class="tag">{t.type}</span> : null}
                  </div>
                  <div class="hint">执行 {t.executor_role ?? '—'} · 复核 {t.reviewer_role ?? '—'} · {id}</div>
                  <button type="button" onClick={() => void openDetail(id)}>查看</button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Panel>

      {selected ? (
        <Panel title="任务详情" actions={<button type="button" onClick={() => { setSelected(''); setDetail(undefined); }}>关闭</button>}>
          {detailError ? <p class="notice err">{detailError}</p> : null}
          {!detail && !detailError ? <p class="hint">正在读取…</p> : null}
          {detail ? (
            <>
              <h3>{detail.task.title ?? selected}</h3>
              <p>
                <span class="tag">{TASK_STATE_ZH[detail.task.state ?? ''] ?? detail.task.state ?? '未知状态'}</span>{' '}
                执行 {detail.task.executor_role ?? '—'} · 复核 {detail.task.reviewer_role ?? '—'}
              </p>
              <div class="button-row">
                <button type="button" onClick={() => setSubtaskOf(subtaskOf ? undefined : selected)}>
                  {subtaskOf ? '收起子任务' : '加子任务'}
                </button>
              </div>
              {subtaskOf ? (
                <TaskForm parent={subtaskOf} onDone={() => { setSubtaskOf(undefined); void afterWrite(); }} onCancel={() => setSubtaskOf(undefined)} />
              ) : null}
              <ReassignForm taskId={selected} current={selectedRow} onDone={() => void afterWrite()} />
              <VoidForm taskId={selected} onDone={() => void afterWrite()} />
              <h4>审计</h4>
              {detail.audit && detail.audit.length ? (
                <ul class="list compact">
                  {detail.audit.map((a, index) => (
                    <li key={index}>
                      <span class="hint">{timeText(a.at)}</span> {a.action ?? '—'} · {String(a.actor ?? '')}
                      {a.evidence ? <span class="hint"> · {a.evidence}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : <Empty>没有审计记录</Empty>}
              <details>
                <summary>原始数据</summary>
                <Pre value={detail} />
              </details>
            </>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

export function TaskForm({ parent, onDone, onCancel }: {
  parent?: string;
  onDone(): void;
  onCancel?(): void;
}) {
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
      <h4>{parent ? '新建子任务' : '新建任务'}</h4>
      <label class="field">
        <span>标题（必填）</span>
        <input value={form.title} disabled={busy} onInput={e => set('title')(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>需求原文（必填）</span>
        <textarea rows={4} value={form.requirement} disabled={busy} onInput={e => set('requirement')(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>验收标准（必填）</span>
        <textarea rows={3} value={form.acceptanceText} disabled={busy} onInput={e => set('acceptanceText')(e.currentTarget.value)} />
      </label>
      <div class="grid-2">
        <label class="field">
          <span>执行岗（必填）</span>
          <RoleSelect value={form.executorRole} disabled={busy} onChange={set('executorRole')} />
        </label>
        <label class="field">
          <span>复核岗（必填）</span>
          <RoleSelect value={form.reviewerRole} disabled={busy} withOwner onChange={set('reviewerRole')} />
        </label>
      </div>
      <label class="field">
        <span>类型（可空，填了则按该类型的路线）</span>
        <input value={form.type} disabled={busy} onInput={e => set('type')(e.currentTarget.value)} />
      </label>
      {problems.length ? <ul class="errors">{problems.map(p => <li key={p}>{p}</li>)}</ul> : null}
      <NoticeLine notice={notice} />
      <div class="button-row">
        <button type="submit" class="primary" disabled={busy}>{parent ? '添加子任务' : '提交任务'}</button>
        {onCancel ? <button type="button" disabled={busy} onClick={onCancel}>取消</button> : null}
      </div>
    </form>
  );
}

function ReassignForm({ taskId, current, onDone }: { taskId: string; current?: TaskRow; onDone(): void }) {
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
    }, '已改派', () => {
      setNote('');
      onDone();
    });
  };

  return (
    <div class="form">
      <h4>改派</h4>
      <p class="hint">当前：执行 {current?.executor_role ?? '—'} · 复核 {current?.reviewer_role ?? '—'}。留空的岗位保持不变。</p>
      <div class="grid-2">
        <label class="field">
          <span>新执行岗</span>
          <RoleSelect value={executorRole} allowBlank blankText="保持不变" disabled={busy} onChange={setExecutorRole} />
        </label>
        <label class="field">
          <span>新复核岗</span>
          <RoleSelect value={reviewerRole} allowBlank blankText="保持不变" withOwner disabled={busy} onChange={setReviewerRole} />
        </label>
      </div>
      <label class="field">
        <span>改派原因（必填）</span>
        <textarea rows={2} value={note} disabled={busy} onInput={e => setNote(e.currentTarget.value)} />
      </label>
      {problems.length ? <ul class="errors">{problems.map(p => <li key={p}>{p}</li>)}</ul> : null}
      <NoticeLine notice={notice} />
      <div class="button-row">
        <button type="button" disabled={busy} onClick={submit}>改派</button>
      </div>
    </div>
  );
}

function VoidForm({ taskId, onDone }: { taskId: string; onDone(): void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const { busy, notice, run } = useAction();

  if (!open) {
    return (
      <div class="button-row">
        <button type="button" class="danger" onClick={() => setOpen(true)}>作废任务…</button>
      </div>
    );
  }
  return (
    <div class="form danger-zone">
      <h4>作废任务</h4>
      <p class="hint">作废后任务不再派工，且无法撤回。请写明原因（至少 2 个字）。</p>
      <label class="field">
        <span>作废原因</span>
        <textarea rows={2} value={note} disabled={busy} onInput={e => setNote(e.currentTarget.value)} />
      </label>
      <NoticeLine notice={notice} />
      <div class="button-row">
        <button
          type="button"
          class="danger"
          disabled={busy || note.trim().length < 2}
          onClick={() => void run('task.void', { taskId, note: note.trim() }, '已作废', () => { setOpen(false); setNote(''); onDone(); })}
        >
          确认作废
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>
  );
}
