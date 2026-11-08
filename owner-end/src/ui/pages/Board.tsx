import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { readBoard, outcomeText } from '../api.ts';
import { Empty, NoticeLine, Panel, useAction } from '../common.tsx';
import {
  buildBoardView, clockText, draftOf, isDirty, translationView, type BoardViewModel, type Drafts, type EmployeeView, type MessageView,
  type QueueView, type TranslationView,
} from '../model.ts';
import { LANG_OPTIONS, boardSignatures, changedIds, langLabel, langPayload } from '../lang.ts';
import type { BoardTranslation, OwnerBoard } from '../types.ts';

/** 看板每 3 秒自动刷新一次。 */
export const BOARD_REFRESH_MS = 3_000;
/** 变化处高亮保留的时长。 */
export const FLASH_MS = 2_500;

interface BoardState {
  board?: OwnerBoard;
  error?: string;
  loadedAt?: number;
  /** 最近变化的消息编号（高亮用）。 */
  flash: ReadonlySet<string>;
}

export interface BoardPageProps {
  drafts: Drafts;
  onDraft(messageId: string, value: string): void;
  onDraftSaved(messageId: string): void;
}

interface Preview {
  lang: string;
  text: string;
}

interface MessageBlockProps {
  messageId: string;
  title: string;
  meta: string;
  body: string;
  hold: boolean;
  draft: string | undefined;
  dirty: boolean;
  busy: boolean;
  flash: boolean;
  workdirPending?: boolean;
  note?: string;
  extra?: ComponentChildren;
  onDraft(messageId: string, value: string): void;
  onSave(messageId: string, text: string): void;
  onHold(messageId: string, hold: boolean): void;
}

/** 每条消息都共用的字段；保存函数由卡片所在位置决定（员工待发用 edit_rendered，其它用 edit）。 */
type CommonMessageProps = Pick<MessageBlockProps, 'messageId' | 'title' | 'body' | 'hold' | 'draft' | 'dirty' | 'busy' | 'flash' | 'onDraft' | 'onHold'>;

/**
 * 有未保存修改的消息卡片在刷新时不重绘：草稿与忙碌状态都没变时直接跳过渲染，
 * 这样光标与正在输入的文字保持原样；草稿内容保存在父组件里，刷新后仍然保留。
 */
const keepWhileEditing = (prev: MessageBlockProps, next: MessageBlockProps): boolean =>
  next.dirty && prev.draft === next.draft && prev.busy === next.busy;

const MessageBlock = memo(function MessageBlock(p: MessageBlockProps) {
  const editable = p.messageId !== '';
  const text = p.draft ?? p.body;
  return (
    <div class={`message${p.hold ? ' held' : ''}${p.flash ? ' flash' : ''}`}>
      <h4>
        {p.title}
        {p.meta ? <span class="hint"> · {p.meta}</span> : null}
        {p.hold ? <span class="tag warn">已扣住</span> : null}
      </h4>
      <label class="field">
        <span>
          原文{p.note ? `（${p.note}）` : ''}{p.dirty ? '（未保存）' : ''}
        </span>
        <textarea
          rows={4}
          value={text}
          disabled={!editable || p.busy}
          onInput={e => p.onDraft(p.messageId, e.currentTarget.value)}
        />
      </label>
      {p.workdirPending ? <p class="hint">领取任务后会追加工作目录行</p> : null}
      {!editable ? <p class="hint">这条消息缺少编号，只能查看。</p> : null}
      {p.extra}
      <div class="button-row">
        <button type="button" class="primary" disabled={!editable || p.busy || !p.dirty} onClick={() => p.onSave(p.messageId, text)}>
          保存修改
        </button>
        <button type="button" disabled={!editable || p.busy || p.hold} onClick={() => p.onHold(p.messageId, true)}>扣住</button>
        <button type="button" disabled={!editable || p.busy || !p.hold} onClick={() => p.onHold(p.messageId, false)}>放行</button>
      </div>
    </div>
  );
}, keepWhileEditing);

/** 一条消息在看板上的译文原料：原文、扣住、译文语言与译文。 */
interface RawMessage {
  body: string;
  hold: boolean;
  lang?: string;
  translation?: BoardTranslation;
}

interface TranslateBoxProps {
  messageId: string;
  editable: boolean;
  dirty: boolean;
  busy: boolean;
  pick: string;
  status: TranslationView;
  translationText?: string;
  preview?: Preview;
  onPick(messageId: string, lang: string): void;
  onPreview(): void;
  onSave(): void;
}

/** 译文区：选语言、预览（不落库）、保存语言并翻译（message 落库）。 */
function TranslateBox(p: TranslateBoxProps) {
  return (
    <div class="translate-box">
      <p class="meta">
        译文：{p.status.label}
        {p.pick ? ` · ${langLabel(p.pick)}` : ''}
      </p>
      {p.status.kind === 'ready' && p.translationText ? <p class="translation">{p.translationText}</p> : null}
      {p.status.blocksSend && p.pick ? <p class="warn-text">发送前需要译文</p> : null}
      <label class="field inline">
        <span>译文语言</span>
        <select
          value={p.pick}
          disabled={p.busy || !p.editable}
          onChange={e => p.onPick(p.messageId, e.currentTarget.value)}
        >
          {LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {p.dirty ? <p class="hint">有未保存修改：先保存原文，再翻译</p> : null}
      <div class="button-row">
        <button type="button" disabled={p.busy || !p.editable || !p.pick} onClick={p.onPreview}>预览译文</button>
        <button type="button" class="primary" disabled={p.busy || !p.editable || p.dirty} onClick={p.onSave}>保存语言并翻译</button>
      </div>
      {p.preview ? (
        <div class="preview">
          <p class="hint">预览（未保存）· {langLabel(p.preview.lang)}</p>
          <p class="translation">{p.preview.text}</p>
        </div>
      ) : null}
    </div>
  );
}

export function BoardPage({ drafts, onDraft, onDraftSaved }: BoardPageProps) {
  const [state, setState] = useState<BoardState>({ flash: new Set() });
  const [picks, setPicks] = useState<Readonly<Record<string, string>>>({});
  const [previews, setPreviews] = useState<Readonly<Record<string, Preview>>>({});
  const loading = useRef(false);
  const sigs = useRef<Map<string, string> | undefined>(undefined);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const { busy, notice, run } = useAction();

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const out = await readBoard();
      if (out.kind !== 'ok') {
        setState(prev => ({ ...prev, error: outcomeText(out, '') }));
        return;
      }
      const next = boardSignatures(out.result);
      const changed = changedIds(sigs.current, next);
      sigs.current = next;
      setState(prev => ({
        board: out.result,
        loadedAt: Date.now(),
        flash: changed.length ? new Set([...prev.flash, ...changed]) : prev.flash,
      }));
      if (changed.length) {
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          setState(prev => {
            const flash = new Set(prev.flash);
            for (const id of changed) flash.delete(id);
            return { ...prev, flash };
          });
        }, FLASH_MS);
        timers.current.add(timer);
      }
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), BOARD_REFRESH_MS);
    const pending = timers.current;
    return () => {
      clearInterval(timer);
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, [load]);

  /** 员工待发消息：按员工渲染后的原文保存（message.edit_rendered）。 */
  const saveRendered = (employeeId: string, messageId: string, text: string) =>
    void run('message.edit_rendered', { messageId, employeeId, rendered: text }, '已保存，派工时按这段原文发出', () => {
      onDraftSaved(messageId);
      return load();
    });

  /** 未分配与其它未发消息：存储原文（message.edit）。 */
  const saveBody = (messageId: string, text: string) =>
    void run('message.edit', { messageId, body: text }, '已保存', () => {
      onDraftSaved(messageId);
      return load();
    });

  const setHold = (messageId: string, on: boolean) =>
    void run(on ? 'message.hold' : 'message.release', { messageId }, on ? '已扣住，等待放行' : '已放行', () => load());

  const board = state.board;
  const view: BoardViewModel | undefined = board ? buildBoardView(board) : undefined;

  /** 按编号找原料（员工卡片、排队项与 messages 三处合并，先到先用）。 */
  const raw = new Map<string, RawMessage>();
  if (board) {
    const put = (row: { messageId?: string; body: string; hold?: boolean; lang?: string; translation?: BoardTranslation }) => {
      if (!row.messageId || raw.has(row.messageId)) return;
      raw.set(row.messageId, { body: row.body, hold: row.hold === true, lang: row.lang, translation: row.translation });
    };
    for (const e of board.employees ?? []) for (const o of e.outbox ?? []) put(o);
    for (const u of board.unassigned ?? []) if (u.message) put(u.message);
    for (const m of board.messages ?? []) put(m);
  }

  /** 选择框默认值：已有译文的语言，否则消息自己的语言，否则不翻译。 */
  const pickOf = (messageId: string): string => {
    if (Object.prototype.hasOwnProperty.call(picks, messageId)) return picks[messageId] ?? '';
    const r = raw.get(messageId);
    return r?.translation?.lang ?? r?.lang ?? '';
  };

  const setPick = (messageId: string, lang: string) => setPicks(p => ({ ...p, [messageId]: lang }));

  /** 预览译文：只返回译文，不落库。 */
  const preview = (messageId: string, text: string, lang: string) =>
    void run<{ lang: string; text: string }>('translate.preview', { text, lang }, '已生成译文预览', result => {
      setPreviews(p => ({ ...p, [messageId]: { lang: result.lang, text: result.text } }));
    });

  /** 保存译文语言：translate.message 落库；空串表示清除语言（lang: null）。 */
  const saveLang = (messageId: string, pick: string) =>
    void run('translate.message', { messageId, lang: langPayload(pick) }, pick ? '已保存语言并翻译' : '已清除译文语言，回到原文投递', () => {
      setPreviews(p => {
        const next = { ...p };
        delete next[messageId];
        return next;
      });
      return load();
    });

  /** 一条消息的译文区：状态由原料给出，草稿未保存时禁用保存。 */
  const translateFor = (messageId: string, editable: boolean, dirty: boolean, body: string, status?: TranslationView): ComponentChildren => {
    const r = raw.get(messageId);
    const tv: TranslationView = status ?? translationView(r?.translation);
    const draft = draftOf(drafts, messageId);
    return (
      <TranslateBox
        messageId={messageId}
        editable={editable}
        dirty={dirty}
        busy={busy}
        pick={pickOf(messageId)}
        status={tv}
        translationText={tv.kind === 'ready' ? tv.text : undefined}
        preview={previews[messageId]}
        onPick={setPick}
        onPreview={() => preview(messageId, draft ?? body, pickOf(messageId))}
        onSave={() => saveLang(messageId, pickOf(messageId))}
      />
    );
  };

  /** 三类消息共用的字段；保存函数由各自位置决定。 */
  const common = (m: MessageView): CommonMessageProps => ({
    messageId: m.messageId,
    title: m.title,
    body: m.body,
    hold: m.hold,
    draft: draftOf(drafts, m.messageId),
    dirty: isDirty(drafts, m.messageId, m.body),
    busy,
    flash: state.flash.has(m.messageId),
    onDraft,
    onHold: setHold,
  });

  return (
    <div class="page board-page">
      <div class="status-bar">
        {view
          ? <span class={`badge ${view.runner.tone}`}>{view.runner.stateText}</span>
          : <span class="badge">执行端未知</span>}
        {view && view.runner.detail ? <span class="hint">{view.runner.detail}</span> : null}
        {view ? <span class="hint">{view.scheduler}</span> : null}
        <span class="hint">上次刷新 {state.loadedAt ? clockText(state.loadedAt) : '—'}（每 3 秒自动刷新）</span>
        <button type="button" onClick={() => void load()}>刷新</button>
      </div>
      {state.error ? <p class="notice err">看板读取失败：{state.error}</p> : null}
      <NoticeLine notice={notice} />
      {!board && !state.error ? <p class="hint">正在读取看板…</p> : null}

      {view ? (
        <>
          <Panel title="公司在动" hint="全公司最近的操作，新的在上。">
            {view.recent.length === 0 ? <Empty>还没有动态</Empty> : (
              <ul class="activity">
                {view.recent.map(r => (
                  <li key={r.key}>
                    <span class="hint">{r.time}</span> {r.actor} · {r.label}
                    {r.taskTitle ? <> · {r.taskTitle}</> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <h2 class="section-title">员工</h2>
          <div class="grid">
            {view.employees.map(e => (
              <EmployeeCard
                key={e.id}
                e={e}
                busy={busy}
                drafts={drafts}
                common={common}
                translateFor={translateFor}
                onSaveRendered={saveRendered}
                onSend={messageId => void run('message.send', { messageId }, '已发送，等待派工', () => load())}
              />
            ))}
            {view.employees.length === 0 ? <Empty>还没有在岗员工</Empty> : null}
          </div>

          <Panel title="排队中（未分配）" hint="调度器按这里的顺序派给员工。">
            {view.queue.length === 0 ? <Empty>没有排队中的任务</Empty> : (
              <div class="stack">
                {view.queue.map(q => (
                  <QueueCard key={q.key} q={q} drafts={drafts} common={common} translateFor={translateFor} onSaveBody={saveBody} />
                ))}
              </div>
            )}
          </Panel>

          <Panel title="其它未发消息" hint="不在任何员工卡片或排队项中的待发消息。">
            {view.others.length === 0 ? <Empty>没有其它未发消息</Empty> : (
              <div class="stack">
                {view.others.map((m, index) => (
                  <MessageBlock
                    key={m.messageId || `other-${index}`}
                    {...common(m)}
                    onSave={saveBody}
                    meta={m.stepText}
                    note="消息原文"
                    extra={m.messageId ? translateFor(m.messageId, true, isDirty(drafts, m.messageId, m.body), m.body) : undefined}
                  />
                ))}
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}

interface EmployeeCardProps {
  e: EmployeeView;
  busy: boolean;
  drafts: Drafts;
  common(m: MessageView): CommonMessageProps;
  translateFor(messageId: string, editable: boolean, dirty: boolean, body: string, status?: TranslationView): ComponentChildren;
  onSaveRendered(employeeId: string, messageId: string, text: string): void;
  onSend(messageId: string): void;
}

function EmployeeCard({ e, busy, drafts, common, translateFor, onSaveRendered, onSend }: EmployeeCardProps) {
  const n = e.now;
  return (
    <article class="card staff-card">
      <header class="card-head">
        <span class="tag">{e.role}</span>
        <span class={`badge ${n.status === 'idle' ? '' : 'violet'}`}>{n.statusText}</span>
      </header>
      <h3>{e.name}</h3>
      {e.subtitle ? <p class="hint">{e.subtitle}</p> : null}

      <section>
        <h4>正在做</h4>
        {n.title
          ? <p><strong>{n.title}</strong>{n.phaseText ? ` · ${n.phaseText}` : ''}</p>
          : <p class="hint">{n.noTaskText}</p>}
        {n.facts.length ? <p class="hint">{n.facts.join(' · ')}</p> : null}
        {n.progressText ? <p class="hint">{n.progressText}</p> : null}
      </section>

      <section>
        <h4>接下来</h4>
        {e.next.length === 0 ? <p class="hint">队列里暂无可接的任务</p> : (
          <ol class="next-list">
            {e.next.slice(0, 5).map(row => (
              <li key={row.key}>
                <span class="tag">第 {row.position} 位</span> {row.title}（{row.phaseText}）
                <span class={row.eligible ? 'ok-text' : 'hint'}>{row.eligible ? ' · 可接' : ' · 暂不可接'}</span>
                <span class="hint"> · {row.reason}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h4>待发消息</h4>
        {e.outbox.length === 0 ? <p class="hint">没有待发消息</p> : e.outbox.map((o, index) => {
          const dirty = isDirty(drafts, o.messageId, o.body);
          const editable = o.messageId !== '';
          const blocksSend = o.translation.blocksSend;
          const extra = (
            <>
              {translateFor(o.messageId, editable, dirty, o.body, o.translation)}
              <div class="button-row">
                <button type="button" disabled={busy || !editable || dirty || blocksSend} onClick={() => onSend(o.messageId)}>发送</button>
              </div>
            </>
          );
          return (
            <MessageBlock
              key={o.messageId || `outbox-${index}`}
              {...common(o)}
              onSave={(messageId, text) => onSaveRendered(e.id, messageId, text)}
              meta={o.stepText}
              workdirPending={o.workdirPending}
              extra={extra}
              note="发给员工，可改"
            />
          );
        })}
      </section>
    </article>
  );
}

function QueueCard({ q, drafts, common, translateFor, onSaveBody }: {
  q: QueueView;
  drafts: Drafts;
  common(m: MessageView): CommonMessageProps;
  translateFor(messageId: string, editable: boolean, dirty: boolean, body: string, status?: TranslationView): ComponentChildren;
  onSaveBody(messageId: string, text: string): void;
}) {
  return (
    <article class="card">
      <header class="card-head">
        <span class="tag">第 {q.position} 位</span>
        <span class="tag">{q.phaseText}</span>
        {q.blocked ? <span class="tag warn">被挡住</span> : null}
        <span class={q.eligible ? 'ok-text' : 'hint'}>{q.eligible ? '可接' : '暂不可接'}</span>
      </header>
      <h3>{q.title}</h3>
      <p class="hint">{q.reason}</p>
      {q.message ? (
        <MessageBlock
          key={q.message.messageId || q.key}
          {...common(q.message)}
          onSave={onSaveBody}
          meta={q.message.stepText}
          note="存储原文，未渲染：派给员工后按其路径渲染"
          extra={q.message.messageId
            ? translateFor(q.message.messageId, true, isDirty(drafts, q.message.messageId, q.message.body), q.message.body)
            : undefined}
        />
      ) : <p class="hint">还没有消息，派给员工后生成。</p>}
    </article>
  );
}
