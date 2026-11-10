import { useLiveRefresh } from '../realtime.ts';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { FeedbackView } from '../../../../src/iteration/inspection.ts';
import { runCommand, outcomeText } from '../api.ts';
import { Badge, EmptyState, ErrorState, FilterTabs, Loading, NoticeLine, type Notice } from '../common.tsx';
import { FEEDBACK_CATEGORY, FEEDBACK_STATE, feedbackStateOf } from '../iteration.ts';
import { hrefOf } from '../model.ts';

const PAGE = 50;

/** 单条反馈：保留用户原文；整理理由、关联需求与失败原因放在原文下方。 */
export function FeedbackItem({ row, busy, onRetry, compact }: { row: FeedbackView; busy: boolean; onRetry?(id: string): void; compact?: boolean }) {
  const st = feedbackStateOf(row.state);
  const [open, setOpen] = useState(false);
  const long = row.body.text.length > 180;
  return (
    <li class={`feedback-item${compact ? ' compact' : ''}`}>
      <div class="feedback-head">
        <Badge tone={st.tone}>{st.label}</Badge>
        <span class="tag">{FEEDBACK_CATEGORY[row.category ?? ''] ?? row.category ?? '未分类'}</span>
        {row.requirement ? <a class="feedback-link" href={hrefOf('requirements', row.requirement)}>查看关联需求</a> : null}
      </div>
      <blockquote class={`feedback-text${long && !open ? ' clamp' : ''}`}>{row.body.text}</blockquote>
      {long ? <button type="button" class="link" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? '收起原文' : '展开全文'}</button> : null}
      <p class="meta-line">页面：{row.body.page || '未提供'} · 版本：{row.body.version || '未提供'}</p>
      {row.reason ? <p class="feedback-reason"><span class="label">Agent 整理理由</span>{row.reason}</p> : null}
      {row.last_error ? <p class="feedback-error" role="alert"><span class="label">失败原因</span>{row.last_error}</p> : null}
      {row.body.contact ? <details class="contact"><summary>用户自愿留下的联系方式</summary><p>{row.body.contact}</p></details> : null}
      {onRetry && ['failed', 'dismissed'].includes(row.state) ? (
        <div class="button-row"><button type="button" disabled={busy} onClick={() => onRetry(row.id)}>重新整理</button></div>
      ) : null}
    </li>
  );
}

const STATE_TABS = [{ id: 'all', label: '全部' }, ...Object.entries(FEEDBACK_STATE).map(([id, v]) => ({ id, label: v.label }))];

/** 产品的反馈收件箱：用户反馈 → Agent 整理 → 关联需求。重新整理只对失败或已忽略的反馈开放。 */
export function FeedbackInbox({ project }: { project: string }) {
  const [rows, setRows] = useState<FeedbackView[]>();
  const listScope = useRef('');
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    let active = true;
    const scope = `${project}:${offset}`;
    if (listScope.current !== scope) { setRows(undefined); listScope.current = scope; }
    setError('');
    void runCommand<{ feedback: FeedbackView[] }>('feedback.list', { project, offset }).then(out => {
      if (!active) return;
      if (out.kind === 'ok') setRows(out.result.feedback);
      else setError(outcomeText(out, ''));
    }).catch(() => active && setError('反馈读取失败'));
    return () => { active = false; };
  }, [project, offset, refresh]);

  useLiveRefresh(['product_feedback'], () => setRefresh(r => r + 1), !busy);
  const retry = (id: string) => {
    setBusy(true);
    void runCommand('feedback.retry', { id }).then(out => {
      if (out.kind === 'ok') { setNotice({ tone: 'ok', text: '已重新放入整理队列' }); setRefresh(r => r + 1); }
      else setNotice({ tone: 'err', text: outcomeText(out, '') });
    }).catch(() => setNotice({ tone: 'err', text: '重试失败，请稍后再试' })).finally(() => setBusy(false));
  };

  const counts: Record<string, number> = { all: rows?.length ?? 0 };
  for (const r of rows ?? []) counts[r.state] = (counts[r.state] ?? 0) + 1;
  const shown = (rows ?? []).filter(r => filter === 'all' || r.state === filter);
  const snippet = `<script src="${location.origin}/feedback-widget.js" defer></script>\n<sck-feedback product="${project}" endpoint="${location.origin}"></sck-feedback>`;

  return (
    <div class="feedback-inbox">
      <div class="toolbar">
        <FilterTabs label="按反馈状态筛选" value={filter} onChange={setFilter} items={STATE_TABS.map(t => ({ ...t, count: counts[t.id] ?? 0 }))} />
        <button type="button" class="ghost" disabled={busy} onClick={() => setRefresh(r => r + 1)}>刷新反馈</button>
      </div>
      <NoticeLine notice={notice} onClose={() => setNotice(null)} />
      {error ? <ErrorState message={error} onRetry={() => setRefresh(r => r + 1)} /> : null}
      {!rows && !error ? <Loading label="正在读取反馈…" /> : null}
      {rows && !shown.length ? (
        <EmptyState title={rows.length ? '这个筛选下没有反馈' : '这个产品还没有收到反馈'}>
          {rows.length ? '换一个状态看看。' : '在产品页面嵌入反馈入口后，用户提交的原文会出现在这里，由 Agent 整理成需求。'}
        </EmptyState>
      ) : null}
      {shown.length ? <ul class="feedback-list">{shown.map(row => <FeedbackItem key={row.id} row={row} busy={busy} onRetry={retry} />)}</ul> : null}
      {rows && (offset > 0 || rows.length >= PAGE) ? (
        <div class="pager">
          <button type="button" disabled={busy || !offset} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</button>
          <span>第 {offset / PAGE + 1} 页</span>
          <button type="button" disabled={busy || rows.length < PAGE} onClick={() => setOffset(offset + PAGE)}>下一页</button>
        </div>
      ) : null}
      <details class="embed">
        <summary>在产品中嵌入反馈入口</summary>
        <p class="hint">把下面的代码放到产品页面；来源站点需要先在「产品设置」的允许列表中登记。</p>
        <pre class="raw">{snippet}</pre>
      </details>
    </div>
  );
}
