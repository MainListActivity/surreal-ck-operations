import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { FeedbackView } from '../../../../src/iteration/inspection.ts';
import type { ProductPolicy, Requirement } from '../../../../src/iteration/requirements.ts';
import { runCommand, outcomeText } from '../api.ts';
import {
  Badge, Callout, Dialog, EmptyState, ErrorState, Field, Loading, NoticeLine, PageHeader, ProgressBar, Section, UnsavedBar, timeText, type Notice,
} from '../common.tsx';
import {
  EMPTY_DRAFT, FLOW_STEPS, LIMITS, PRIORITY_TEXT, acceptanceItems, approveBlockers, draftFrom, flowIndex, isApprovable, isEditable, isPausable,
  milestones, priorityText, releaseBlockers, sameDraft, stageOf, stateOf, taskProgress, taskTone, validateRequirement, type RequirementDraft, type Tone,
} from '../iteration.ts';
import { TASK_STATE_ZH, hrefOf, taskIdOf } from '../model.ts';
import { FeedbackItem } from './Feedback.tsx';
import { EMPTY_POLICY, PolicyDialog, type Product } from './Requirements.tsx';

interface ExecTask { id?: unknown; title?: string; state?: string; acceptance_head?: string }
interface Details {
  execution: { stage: string; note?: string; released_sha?: string } | null;
  plan: { steps: Array<{ title: string; context: string; acceptance: string }> } | null;
  tasks: ExecTask[];
}
type Req = Requirement & { paused_from?: string };
type DialogKind = 'approve' | 'release' | 'reject' | 'pause' | 'discard' | 'settings';

/** 自动刷新间隔：规划、实施与发布阶段，执行记录由后台推进。 */
const POLL_MS = 5_000;

export function RequirementDetail({ id, products, onDirtyChange }: { id: string; products: Product[]; onDirtyChange(dirty: boolean): void }) {
  const [r, setR] = useState<Req>();
  const [loadError, setLoadError] = useState('');
  const [policy, setPolicy] = useState<ProductPolicy>();
  const [policyLoaded, setPolicyLoaded] = useState(false);
  const [details, setDetails] = useState<Details | null>();
  const [detailsError, setDetailsError] = useState('');
  const [feedback, setFeedback] = useState<FeedbackView[]>();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [draft, setDraft] = useState<RequirementDraft>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<Partial<Record<keyof RequirementDraft, string>>>({});
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number>();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadDetails = useCallback(async () => {
    const out = await runCommand<Details>('requirement.execution', { id }).catch(() => undefined);
    if (!alive.current) return;
    if (out?.kind === 'ok') { setDetails(out.result); setDetailsError(''); }
    else setDetailsError(out ? outcomeText(out, '') : '执行进度读取失败');
  }, [id]);

  const loadPolicy = useCallback(async (project: string) => {
    const out = await runCommand<{ policy: ProductPolicy | null }>('product.iteration.get', { project }).catch(() => undefined);
    if (!alive.current) return;
    if (out?.kind === 'ok') { setPolicy(out.result.policy ?? undefined); setPolicyLoaded(true); }
  }, []);

  const refresh = useCallback(async (full = false) => {
    const out = await runCommand<{ requirement: Req }>('requirement.get', { id }).catch(() => undefined);
    if (!alive.current) return undefined;
    if (out?.kind !== 'ok') { if (!full) setLoadError(out ? outcomeText(out, '') : '需求读取失败'); return undefined; }
    const next = out.result.requirement;
    setR(next);
    setLoadError('');
    setRefreshedAt(Date.now());
    await loadDetails();
    if (full) {
      void loadPolicy(next.project);
      void runCommand<{ feedback: FeedbackView[] }>('feedback.list', { project: next.project, requirement: next.id })
        .then(f => alive.current && setFeedback(f.kind === 'ok' ? f.result.feedback : []))
        .catch(() => alive.current && setFeedback([]));
    }
    return next;
  }, [id, loadDetails, loadPolicy]);

  useEffect(() => { void refresh(true).then(next => { if (!next && alive.current) setLoadError(prev => prev || '需求读取失败'); }); }, [refresh]);

  const dirty = mode === 'edit' && !!r && !sameDraft(draft, draftFrom(r));
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  // 规划、实施、发布阶段自动刷新；编辑或对话框打开时暂停，避免打断操作。
  useEffect(() => {
    if (!r || mode !== 'view' || dialog || !isPausable(r.state)) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [r?.state, mode, dialog, refresh]);

  const act = async (command: string, input: Record<string, unknown>, okText: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      const out = await runCommand<{ requirement?: Req }>(command, input);
      if (out.kind !== 'ok') {
        setNotice({ tone: out.kind === 'pending' ? 'warn' : 'err', text: outcomeText(out, okText) });
        return false;
      }
      setNotice({ tone: 'ok', text: okText });
      if (out.result.requirement) setR(out.result.requirement);
      await refresh();
      return true;
    } catch {
      setNotice({ tone: 'err', text: '操作失败，请刷新核对后再重试' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loadError && !r) {
    return (
      <div class="page">
        <PageHeader title="需求详情" crumbs={[{ label: '需求', href: '#requirements' }]} />
        <ErrorState title="没有读取到这条需求" message={loadError} onRetry={() => { setLoadError(''); void refresh(true); }} />
      </div>
    );
  }
  if (!r) {
    return <div class="page"><PageHeader title="需求详情" crumbs={[{ label: '需求', href: '#requirements' }]} /><Loading label="正在读取需求…" rows={6} /></div>;
  }

  const product = products.find(p => p.id === r.project);
  const st = stateOf(r.state);
  const tasks = details?.tasks ?? [];
  const stage = details?.execution?.stage;
  const progress = taskProgress(tasks);
  const editable = isEditable(r.state);
  const blockers = approveBlockers(r, policy, dirty, policyLoaded);
  const startEdit = () => { setDraft(draftFrom(r)); setProblems({}); setMode('edit'); setNotice(null); };
  const save = () => {
    const found = validateRequirement(draft);
    setProblems(found);
    if (Object.keys(found).length) return;
    void act('requirement.edit', { id: r.id, revision: r.revision, project: r.project, ...draft, title: draft.title.trim(), problem: draft.problem.trim(), acceptance: draft.acceptance.trim() },
      `已保存为修订 ${r.revision + 1}。还没有开工，确认后才会交给 Agent。`).then(ok => { if (ok) { onDirtyChange(false); setMode('view'); } });
  };
  const control = (action: string, okText: string) => void act('requirement.control', { id: r.id, revision: r.revision, action }, okText).then(() => setDialog(null));
  const listHref = hrefOf('requirements', undefined, { p: r.project });

  const decision = decisionFor(r, stage, details?.execution?.note, progress, blockers, mode, {
    approve: () => setDialog('approve'),
    edit: startEdit,
    reject: () => setDialog('reject'),
    pause: () => setDialog('pause'),
    resume: () => control('resume', '已恢复推进，后续步骤将继续执行。'),
    retry: () => control('retry', '已重新排队规划。'),
    release: () => setDialog('release'),
    settings: () => setDialog('settings'),
  }, busy, policy);

  return (
    <div class="page detail-page">
      <PageHeader
        crumbs={[{ label: '需求', href: '#requirements' }, { label: product?.name ?? r.project, href: listHref }]}
        title={mode === 'edit' ? `编辑：${r.title}` : r.title}
        meta={(
          <>
            <Badge tone={st.tone}>{st.label}</Badge>
            <span class={`priority p${r.priority}`}>{priorityText(r.priority)}</span>
            <span>修订 {r.revision}</span>
            {r.approved_revision != null ? <span>已确认修订 {r.approved_revision}</span> : null}
            <span>更新于 {timeText(r.updated_at)}</span>
          </>
        )}
        actions={mode === 'view' ? (
          <>
            {editable ? <button type="button" disabled={busy} onClick={startEdit}>编辑需求</button> : null}
            <button type="button" class="ghost" disabled={busy} onClick={() => void refresh(true)}>刷新</button>
          </>
        ) : undefined}
      />

      <Flow state={r.state} pausedFrom={r.paused_from} />

      <NoticeLine notice={notice} onClose={() => setNotice(null)} />

      {decision ? <Callout tone={decision.tone} title={decision.title} actions={decision.actions}>{decision.body}</Callout> : null}

      <div class="detail-grid">
        <div class="detail-main">
          {mode === 'edit' ? (
            <Section title={`编辑修订 ${r.revision}`} hint="保存后生成新的修订，状态回到「待确认」。确认开工前可以反复修改。">
              <RequirementForm draft={draft} onChange={setDraft} problems={problems} busy={busy} />
              <div class="form-actions sticky">
                {dirty ? <UnsavedBar>有未保存的修改</UnsavedBar> : <span class="hint">还没有修改</span>}
                <div class="button-row">
                  <button type="button" disabled={busy} onClick={() => { if (dirty) setDialog('discard'); else setMode('view'); }}>{dirty ? '放弃修改' : '返回'}</button>
                  <button type="button" class="primary" disabled={busy || !dirty} onClick={save}>{busy ? '正在保存…' : '保存修订'}</button>
                </div>
              </div>
            </Section>
          ) : (
            <>
              {!editable && r.state !== 'merged' ? (
                <p class="lock-note"><span class="lock-mark" aria-hidden="true" />修订 {r.approved_revision ?? r.revision} 已确认并锁定，执行以确认时的内容为准。如需调整范围，请新建需求。</p>
              ) : null}
              <Section title="要解决的问题">
                <p class="prose">{r.problem}</p>
              </Section>
              <Section title="验收标准" hint="交付按这些条目逐条验收；建议每行写一条可检查的结果。">
                <AcceptanceList text={r.acceptance} onEdit={editable ? startEdit : undefined} />
              </Section>
              <ExecutionSection r={r} details={details} error={detailsError} onRefresh={() => void loadDetails()} />
            </>
          )}
        </div>

        <aside class="detail-side" aria-label="需求概要">
          <Section title="进度里程碑" hint="三件事分别确认，互不代替。">
            <ol class="milestones">
              {milestones(r, tasks, details?.execution?.released_sha).map(m => (
                <li key={m.key} class={m.done ? 'done' : ''}>
                  <span class="ms-mark" aria-hidden="true">{m.done ? '✓' : ''}</span>
                  <span><strong>{m.label}</strong><small>{m.detail}</small></span>
                  <span class="visually-hidden">{m.done ? '已完成' : '未完成'}</span>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="发布方式" actions={<button type="button" class="link" onClick={() => setDialog('settings')}>产品设置</button>}>
            {!policyLoaded ? <p class="hint">正在读取…</p> : !policy ? <p class="hint">产品尚未配置，使用默认设置。</p> : (
              <dl class="facts">
                <dt>迭代流程</dt><dd>{policy.enabled ? '已启用' : <span class="text-blocked">未启用</span>}</dd>
                <dt>上线方式</dt><dd>{policy.autoRelease ? '验收通过后自动发布' : '每次上线由你确认'}</dd>
                <dt>发布流程</dt><dd>{policy.releaseInstructions ? '已配置' : <span class="text-decide">未配置</span>}</dd>
                <dt>验证与回退</dt><dd>{policy.verifyInstructions && policy.rollbackInstructions ? '已配置' : <span class="text-decide">未配置</span>}</dd>
              </dl>
            )}
          </Section>

          <Section title={`来源反馈${feedback ? `（${feedback.length}）` : ''}`}>
            {feedback === undefined ? <p class="hint">正在读取…</p> : feedback.length === 0 ? <p class="hint">没有关联的用户反馈，可能由老板或 Agent 直接创建。</p> : (
              <ul class="feedback-list">{feedback.map(f => <FeedbackItem key={f.id} row={f} busy={busy} compact />)}</ul>
            )}
            <a class="more-link" href={hrefOf('requirements', undefined, { p: r.project, view: 'feedback' })}>查看该产品全部反馈</a>
          </Section>

          <Section title="记录">
            <dl class="facts">
              <dt>产品</dt><dd>{product?.name ?? r.project}</dd>
              <dt>创建</dt><dd>{timeText(r.created_at)}</dd>
              <dt>当前修订</dt><dd>{r.revision}</dd>
              {r.root_task ? <><dt>规划任务</dt><dd><a href={hrefOf('tasks', r.root_task)}>{r.root_task}</a></dd></> : null}
              <dt>编号</dt><dd><code>{r.id}</code></dd>
            </dl>
            {refreshedAt && isPausable(r.state) ? <p class="hint">每 5 秒自动刷新进度 · 上次 {timeText(refreshedAt).slice(11)}</p> : null}
          </Section>
        </aside>
      </div>

      {dialog === 'approve' ? (
        <Dialog
          title={`确认开工：修订 ${r.revision}`}
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button type="button" disabled={busy} onClick={() => setDialog(null)}>再看看</button>
              <button type="button" class="primary" data-autofocus disabled={busy || blockers.length > 0}
                onClick={() => void act('requirement.approve', { id: r.id, revision: r.revision, expectedPolicy: policy }, `已确认修订 ${r.revision} 并开始实施。Agent 正在拆解任务。`).then(ok => { if (ok) setDialog(null); })}>
                {busy ? '正在确认…' : '确认开工'}
              </button>
            </>
          )}
        >
          <p>确认后会发生：</p>
          <ol class="steps-list">
            <li>修订 {r.revision} 锁定，不能再编辑；执行以此为准。</li>
            <li>Agent 按下面的验收标准拆解任务并开始执行。</li>
            <li>{policy?.autoRelease ? '交付验收通过后，按产品策略自动发布。' : '交付验收后会停在「待发布」，等你确认才上线。'}</li>
          </ol>
          <div class="confirm-summary">
            <p class="label">需求</p>
            <p><strong>{r.title}</strong> · {priorityText(r.priority)}</p>
            <p class="label">验收标准（{acceptanceItems(r.acceptance).length} 条）</p>
            <ol class="checklist small">{acceptanceItems(r.acceptance).map((a, i) => <li key={i}>{a}</li>)}</ol>
          </div>
          {blockers.length ? <ul class="blockers">{blockers.map(b => <li key={b}>{b}</li>)}</ul> : null}
        </Dialog>
      ) : null}

      {dialog === 'release' ? (
        <Dialog
          title={`确认发布：修订 ${r.approved_revision ?? r.revision}`}
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button type="button" disabled={busy} onClick={() => setDialog(null)}>暂不发布</button>
              <button type="button" class="primary" data-autofocus disabled={busy || releaseBlockers(policy).length > 0}
                onClick={() => void act('requirement.release', { id: r.id, revision: r.revision, expectedPolicy: policy }, '已授权按当前产品策略发布。上线完成并验证后，需求会变为「已上线」。').then(ok => { if (ok) setDialog(null); })}>
                {busy ? '正在提交…' : '授权发布'}
              </button>
            </>
          )}
        >
          <p>交付已通过验收。授权后，Agent 会按以下流程部署并在线验证；这次授权会写入审计。</p>
          <dl class="facts stacked">
            <dt>发布流程</dt><dd class="prose">{policy?.releaseInstructions || <span class="text-decide">未配置</span>}</dd>
            <dt>上线验证</dt><dd class="prose">{policy?.verifyInstructions || <span class="text-decide">未配置</span>}</dd>
            <dt>回退流程</dt><dd class="prose">{policy?.rollbackInstructions || <span class="text-decide">未配置</span>}</dd>
          </dl>
          {releaseBlockers(policy).length ? (
            <Callout tone="decide" title="发布前需要补齐产品设置" actions={<button type="button" onClick={() => setDialog('settings')}>打开产品设置</button>}>
              <ul class="blockers plain">{releaseBlockers(policy).map(b => <li key={b}>{b}</li>)}</ul>
            </Callout>
          ) : null}
        </Dialog>
      ) : null}

      {dialog === 'reject' ? (
        <Dialog title="拒绝这条需求？" tone="danger" onClose={() => setDialog(null)} footer={(
          <>
            <button type="button" data-autofocus disabled={busy} onClick={() => setDialog(null)}>取消</button>
            <button type="button" class="danger" disabled={busy} onClick={() => control('reject', '已拒绝。需求不会开工，之后仍可修改并重新确认。')}>拒绝需求</button>
          </>
        )}>
          <p>拒绝后不会开工。来源反馈保留；以后可以编辑这条需求，它会回到「待确认」。</p>
        </Dialog>
      ) : null}

      {dialog === 'pause' ? (
        <Dialog title="暂停后续推进？" onClose={() => setDialog(null)} footer={(
          <>
            <button type="button" data-autofocus disabled={busy} onClick={() => setDialog(null)}>取消</button>
            <button type="button" class="primary" disabled={busy} onClick={() => control('pause', '已暂停。已派出的任务会做完当前步骤，后续步骤不再推进。')}>暂停推进</button>
          </>
        )}>
          <ul class="steps-list">
            <li>已派出的任务按现有租约继续，做完当前步骤为止。</li>
            <li>后续步骤不再派工，直到你恢复。</li>
            <li>已经发起的部署无法通过暂停撤销。</li>
          </ul>
        </Dialog>
      ) : null}

      {dialog === 'discard' ? (
        <Dialog title="放弃未保存的修改？" onClose={() => setDialog(null)} footer={(
          <>
            <button type="button" data-autofocus onClick={() => setDialog(null)}>继续编辑</button>
            <button type="button" class="danger" onClick={() => { setDialog(null); onDirtyChange(false); setMode('view'); setDraft(draftFrom(r)); }}>放弃修改</button>
          </>
        )}>
          <p>本次编辑的内容不会保存，需求保持修订 {r.revision}。</p>
        </Dialog>
      ) : null}

      {dialog === 'settings' ? (
        <PolicyDialog
          productName={product?.name ?? r.project}
          initial={policy ?? EMPTY_POLICY}
          loaded={policyLoaded}
          onDirtyChange={d => onDirtyChange(d || dirty)}
          onClose={() => { onDirtyChange(dirty); setDialog(null); }}
          save={async value => {
            const out = await runCommand('product.iteration.configure', { project: r.project, ...value });
            if (out.kind !== 'ok') return outcomeText(out, '');
            setPolicy(value);
            setNotice({ tone: 'ok', text: '产品设置已保存。' });
            return undefined;
          }}
        />
      ) : null}
    </div>
  );
}

interface DecisionActions {
  approve(): void; edit(): void; reject(): void; pause(): void; resume(): void; retry(): void; release(): void; settings(): void;
}

/** 决策栏：告诉老板现在需要做什么、为什么，以及能做什么。 */
function decisionFor(r: Req, stage: string | undefined, note: string | undefined, progress: ReturnType<typeof taskProgress>, blockers: string[], mode: 'view' | 'edit',
  a: DecisionActions, busy: boolean, policy?: ProductPolicy): { tone: Tone; title: string; body?: ComponentChildren; actions?: ComponentChildren } | undefined {
  if (mode === 'edit') return undefined;
  const pause = <button type="button" disabled={busy} onClick={a.pause}>暂停推进</button>;
  switch (r.state) {
    case 'draft':
    case 'pending': {
      const real = blockers.filter(b => !b.startsWith('有未保存'));
      return {
        tone: 'decide',
        title: '等你确认开工',
        body: (
          <>
            <p>确认后修订 {r.revision} 锁定，Agent 按验收标准拆解任务。{policy?.autoRelease ? '验收通过后按策略自动发布。' : '上线前还会再请你确认。'}</p>
            {real.length ? <ul class="blockers">{real.map(b => <li key={b}>{b}</li>)}</ul> : null}
          </>
        ),
        actions: (
          <>
            <button type="button" disabled={busy} onClick={a.reject}>拒绝</button>
            <button type="button" disabled={busy} onClick={a.edit}>编辑</button>
            <button type="button" class="primary" disabled={busy || real.length > 0} onClick={a.approve}>确认开工…</button>
          </>
        ),
      };
    }
    case 'rejected':
      return { tone: 'neutral', title: '已拒绝，不会开工', body: <p>可以编辑后重新提交，保存后回到「待确认」。</p>, actions: <button type="button" disabled={busy} onClick={a.edit}>编辑并重新提交</button> };
    case 'queued':
      return r.planning_error
        ? { tone: 'blocked', title: 'Agent 规划失败', body: <p>{r.planning_error}</p>, actions: <>{pause}<button type="button" class="primary" disabled={busy} onClick={a.retry}>重试规划</button></> }
        : { tone: 'progress', title: '已确认，Agent 正在拆解任务', body: <p>拆解完成后会自动建立执行任务，这里会显示每项任务的进度。</p>, actions: pause };
    case 'implementing':
      if (r.execution_error || stage === 'blocked') {
        return { tone: 'blocked', title: '执行受阻', body: <p>{r.execution_error ?? note ?? '有任务受阻或已作废，请查看下方任务。'}</p>, actions: pause };
      }
      return { tone: 'progress', title: `Agent 执行中 · 已完成 ${progress.done} / ${progress.total || '—'} 项`, body: note ? <p>{note}</p> : undefined, actions: pause };
    case 'release_pending':
      if (stage === 'release_not_configured') {
        return { tone: 'decide', title: '交付已验收，但发布流程未配置', body: <p>请在产品设置中填写发布、上线验证与回退流程，然后确认发布。</p>, actions: <>{pause}<button type="button" class="primary" disabled={busy} onClick={a.settings}>配置发布流程</button></> };
      }
      if (stage === 'awaiting_evidence') return { tone: 'blocked', title: '等待部署证据', body: <p>{note ?? '发布任务需要同一提交的生产部署证据和独立 QA 签署。'}</p>, actions: pause };
      if (stage === 'deploying' || stage === 'verifying') return { tone: 'progress', title: stageOf(stage)!.label, body: <p>{note ?? '已授权发布，Agent 正在部署与验证。'}</p>, actions: pause };
      return {
        tone: 'decide',
        title: '交付已验收，等你确认发布',
        body: <p>任务已完成并通过验收，但产品还没有上线。授权后按产品发布策略部署。</p>,
        actions: <>{pause}<button type="button" class="primary" disabled={busy} onClick={a.release}>确认发布…</button></>,
      };
    case 'released':
      return { tone: 'done', title: '已上线', body: <p>{note ?? '部署证据、独立复核与上线回归均已完成。'}</p> };
    case 'paused':
      return { tone: 'neutral', title: '已暂停推进', body: <p>已派出的任务做完当前步骤后停止；恢复后从{stateOf(r.paused_from ?? 'queued').label}继续。</p>, actions: <button type="button" class="primary" disabled={busy} onClick={a.resume}>恢复推进</button> };
    case 'merged':
      return { tone: 'neutral', title: '已归并到其他需求', body: <p>这条需求的内容由另一条需求承接，不再单独推进。</p> };
    default:
      return undefined;
  }
}

function Flow({ state, pausedFrom }: { state: string; pausedFrom?: string }) {
  const idx = flowIndex(state, pausedFrom);
  const off = state === 'rejected' || state === 'merged';
  return (
    <ol class={`flow${off ? ' off' : ''}${state === 'paused' ? ' paused' : ''}`} aria-label="需求流程">
      {FLOW_STEPS.map((step, i) => (
        <li key={step} class={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>
          <span class="flow-dot" aria-hidden="true">{i < idx ? '✓' : i + 1}</span>
          <span class="flow-label">{step}{i === idx && state === 'paused' ? '（已暂停）' : ''}</span>
        </li>
      ))}
    </ol>
  );
}

function AcceptanceList({ text, onEdit }: { text: string; onEdit?(): void }) {
  const items = acceptanceItems(text);
  if (!items.length) {
    return (
      <EmptyState title="还没有验收标准" action={onEdit ? <button type="button" onClick={onEdit}>补充验收标准</button> : undefined}>
        没有验收标准不能确认开工。写清楚交付后要能检查到的结果。
      </EmptyState>
    );
  }
  return <ol class="checklist">{items.map((item, i) => <li key={i}>{item}</li>)}</ol>;
}

function ExecutionSection({ r, details, error, onRefresh }: { r: Req; details: Details | null | undefined; error: string; onRefresh(): void }) {
  const tasks = details?.tasks ?? [];
  const progress = taskProgress(tasks);
  const stage = stageOf(details?.execution?.stage);
  const approved = !['draft', 'pending', 'rejected'].includes(r.state);
  return (
    <Section title="执行进度" hint="Agent 拆解的计划与执行任务。任务完成不等于产品上线。" actions={<button type="button" class="ghost" onClick={onRefresh}>刷新进度</button>}>
      {error ? <ErrorState message={error} onRetry={onRefresh} /> : null}
      {!error && details === undefined ? <Loading label="正在读取执行进度…" rows={2} /> : null}
      {!error && details !== undefined && !details?.execution && !details?.plan && !tasks.length ? (
        <EmptyState title={approved ? '还没有建立执行任务' : '确认开工后开始执行'}>
          {approved ? 'Agent 正在拆解计划，完成后这里会列出每项任务和负责岗位。' : '确认后，这里会显示 Agent 拆解的计划，以及每项任务的状态和结果。'}
        </EmptyState>
      ) : null}
      {details && (details.execution || details.plan || tasks.length) ? (
        <div class="execution">
          {details.execution ? (
            <div class="exec-head">
              {stage ? <Badge tone={stage.tone}>{stage.label}</Badge> : null}
              {details.execution.note ? <span>{details.execution.note}</span> : null}
              {details.execution.released_sha ? <span class="hint">发布提交 <code>{details.execution.released_sha}</code></span> : null}
            </div>
          ) : null}
          {tasks.length ? (
            <div class="exec-progress">
              <ProgressBar value={progress.percent} label="任务完成比例" />
              <span>{progress.done} / {progress.total} 项任务完成{progress.active ? ` · ${progress.active} 项进行中` : ''}{progress.blocked ? ` · ${progress.blocked} 项受阻` : ''}</span>
            </div>
          ) : null}
          {tasks.length ? (
            <div class="table-wrap">
              <table class="data-table compact">
                <thead><tr><th scope="col">执行任务</th><th scope="col">状态</th><th scope="col"><span class="visually-hidden">操作</span></th></tr></thead>
                <tbody>
                  {tasks.map((t, i) => {
                    const tid = taskIdOf(t);
                    return (
                      <tr key={tid || i}>
                        <td class="cell-title"><span>{t.title || tid}</span>{t.acceptance_head ? <span class="cell-sub">{t.acceptance_head}</span> : null}</td>
                        <td data-label="状态"><Badge tone={taskTone(t.state)}>{TASK_STATE_ZH[t.state ?? ''] ?? t.state ?? '未知'}</Badge></td>
                        <td class="cell-action">{tid ? <a href={hrefOf('tasks', tid)}>查看</a> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {details.plan?.steps.length ? (
            <details class="plan" open={!tasks.length}>
              <summary>Agent 拆解的计划（{details.plan.steps.length} 步）</summary>
              <ol class="plan-steps">
                {details.plan.steps.map((s, i) => (
                  <li key={i}>
                    <strong>{s.title}</strong>
                    {s.context ? <p>{s.context}</p> : null}
                    {s.acceptance ? <p class="hint">验收：{s.acceptance}</p> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

/** 需求表单：标题、问题、验收标准、优先级。字数限制与服务端一致。 */
export function RequirementForm({ draft, onChange, problems, busy }: {
  draft: RequirementDraft;
  onChange(d: RequirementDraft): void;
  problems: Partial<Record<keyof RequirementDraft, string>>;
  busy: boolean;
}) {
  return (
    <div class="form req-form">
      <Field label="标题" required count={draft.title.length} max={LIMITS.title} error={problems.title} hint="用一句话说明要改善什么。">
        <input value={draft.title} maxLength={LIMITS.title} disabled={busy} onInput={e => onChange({ ...draft, title: e.currentTarget.value })} />
      </Field>
      <Field label="要解决的问题" required count={draft.problem.length} max={LIMITS.problem} error={problems.problem} hint="谁在什么场景遇到了什么问题，影响是什么。">
        <textarea rows={7} maxLength={LIMITS.problem} disabled={busy} value={draft.problem} onInput={e => onChange({ ...draft, problem: e.currentTarget.value })} />
      </Field>
      <Field label="验收标准" count={draft.acceptance.length} max={LIMITS.acceptance} error={problems.acceptance} hint="每行一条可检查的结果。没有验收标准不能确认开工。">
        <textarea rows={6} maxLength={LIMITS.acceptance} disabled={busy} value={draft.acceptance} onInput={e => onChange({ ...draft, acceptance: e.currentTarget.value })} />
      </Field>
      <fieldset class="field priority-field" disabled={busy}>
        <legend class="field-label">优先级</legend>
        <div class="seg-group">
          {[0, 1, 2, 3].map(p => (
            <label key={p} class={`seg-option${draft.priority === p ? ' checked' : ''}`}>
              <input type="radio" name="priority" value={p} checked={draft.priority === p} onChange={() => onChange({ ...draft, priority: p })} />
              <span>{PRIORITY_TEXT[p]}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** 新建需求：创建后状态为「待确认」，不会开工。 */
export function RequirementCreate({ products, project: initialProject, onDirtyChange }: { products: Product[]; project?: string; onDirtyChange(dirty: boolean): void }) {
  const [project, setProject] = useState(initialProject ?? '');
  const [draft, setDraft] = useState<RequirementDraft>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<Partial<Record<keyof RequirementDraft, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!project && products.length === 1) setProject(products[0]!.id); }, [products, project]);
  const dirty = !sameDraft(draft, EMPTY_DRAFT);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const backHref = hrefOf('requirements', undefined, { p: project || undefined });
  const submit = async () => {
    const found = validateRequirement(draft);
    setProblems(found);
    if (!project) { setError('请选择产品'); return; }
    if (Object.keys(found).length) return;
    setBusy(true);
    setError('');
    try {
      const out = await runCommand<{ requirement: Requirement }>('requirement.create', { project, ...draft, title: draft.title.trim(), problem: draft.problem.trim(), acceptance: draft.acceptance.trim() });
      if (out.kind !== 'ok') { setError(outcomeText(out, '')); return; }
      onDirtyChange(false);
      location.hash = hrefOf('requirements', out.result.requirement.id);
    } catch {
      setError('保存失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="page detail-page">
      <PageHeader crumbs={[{ label: '需求', href: backHref }]} title="新建需求" description="保存后状态为「待确认」，不会开工。你可以继续编辑，确认开工后才交给 Agent。" />
      <div class="detail-grid single">
        <div class="detail-main">
          <Section>
            {error ? <div class="notice err" role="alert"><span class="notice-text">{error}</span></div> : null}
            <div class="form">
              <Field label="产品" required error={!project && error === '请选择产品' ? '请选择产品' : undefined}>
                <select value={project} disabled={busy} onChange={e => setProject(e.currentTarget.value)}>
                  <option value="">请选择产品</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            </div>
            <RequirementForm draft={draft} onChange={setDraft} problems={problems} busy={busy} />
            <div class="form-actions sticky">
              {dirty ? <UnsavedBar>有未保存的内容</UnsavedBar> : <span class="hint">填写标题和问题后即可保存</span>}
              <div class="button-row">
                <a class="button" href={backHref}>取消</a>
                <button type="button" class="primary" disabled={busy || !dirty} onClick={() => void submit()}>{busy ? '正在保存…' : '保存为待确认'}</button>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
