import { useCallback, useEffect, useState } from 'preact/hooks';
import { outcomeText, runCommand } from '../api.ts';
import { Empty, NoticeLine, PageHeader, Panel, Pre, timeText, useAction } from '../common.tsx';
import { noteLanes } from '../model.ts';

interface NoteRow {
  id: string;
  lane: string;
  text: string;
  state?: 'proposed' | 'active' | 'removed';
  pinned?: boolean;
  author?: string;
  updatedAt?: string;
}

interface ConsolidationRow {
  id?: unknown;
  consolidationId?: unknown;
  lane?: string;
  at?: unknown;
  createdAt?: unknown;
  undone?: boolean;
  [key: string]: unknown;
}

const NOTE_STATE_ZH: Record<string, string> = { proposed: '待确认', active: '启用中', removed: '已删除' };
const NOTE_MAX_CHARS = 2000;

export function NotesPage() {
  const [lanes, setLanes] = useState<string[]>([]);
  const [lane, setLane] = useState('');
  const [notes, setNotes] = useState<NoteRow[]>();
  const [loadError, setLoadError] = useState<string>();
  const [consolidations, setConsolidations] = useState<ConsolidationRow[]>();
  const [consolidationError, setConsolidationError] = useState<string>();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [removing, setRemoving] = useState('');
  const [addLane, setAddLane] = useState('');
  const [addText, setAddText] = useState('');
  const [addPinned, setAddPinned] = useState(false);
  const [addProposed, setAddProposed] = useState(false);
  const [addProblems, setAddProblems] = useState<string[]>([]);
  const [preview, setPreview] = useState<unknown>();
  const [consolidateArmed, setConsolidateArmed] = useState(false);
  const { busy, notice, run } = useAction();

  const refresh = useCallback(async (filter: string) => {
    const allOut = await runCommand<{ notes?: NoteRow[] }>('note.list');
    if (allOut.kind === 'ok') {
      const all = allOut.result.notes ?? [];
      setLanes(noteLanes(all));
    }
    const shownOut = filter ? await runCommand<{ notes?: NoteRow[] }>('note.list', { lane: filter }) : allOut;
    if (shownOut.kind === 'ok') {
      setNotes(shownOut.result.notes ?? []);
      setLoadError(undefined);
    } else {
      setLoadError(outcomeText(shownOut, ''));
    }
    const consOut = await runCommand<{ consolidations?: ConsolidationRow[] }>('note.consolidations', { limit: 20 });
    if (consOut.kind === 'ok') {
      setConsolidations(consOut.result.consolidations ?? []);
      setConsolidationError(undefined);
    } else {
      setConsolidationError(outcomeText(consOut, ''));
    }
  }, []);

  useEffect(() => {
    void refresh(lane);
  }, [lane, refresh]);

  useEffect(() => {
    if (!addLane && lane) setAddLane(lane);
  }, [lane]);

  const after = () => refresh(lane);
  const laneOptions = lane && !lanes.includes(lane) ? [...lanes, lane] : lanes;

  const submitAdd = () => {
    const problems: string[] = [];
    if (!addLane.trim()) problems.push('请填写线（lane）');
    if (!addText.trim()) problems.push('笔记内容必填');
    if ([...addText.trim()].length > NOTE_MAX_CHARS) problems.push(`一条笔记不超过 ${NOTE_MAX_CHARS} 字`);
    setAddProblems(problems);
    if (problems.length) return;
    void run('note.add', {
      lane: addLane.trim(),
      text: addText.trim(),
      pinned: addPinned,
      proposed: addProposed,
    }, '已添加笔记', () => {
      setAddText('');
      setAddPinned(false);
      setAddProposed(false);
      return after();
    });
  };

  const scopeText = lane || '全部线';

  return (
    <div class="page">
      <PageHeader title="笔记" description="按线（lane）维护的经验笔记，派工时附在 notes.md 里交给员工。待确认的笔记需要你启用后才生效。" />
      <Panel
        title="线的笔记"
        hint="笔记会附在该线每次派工的 notes.md 里。待确认的笔记需要你启用后才生效。"
        actions={(
          <label class="inline">
            <span>线</span>
            <select value={lane} onChange={e => setLane(e.currentTarget.value)}>
              <option value="">全部线</option>
              {laneOptions.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        )}
      >
        <NoticeLine notice={notice} />
        {loadError ? <p class="notice err">笔记读取失败：{loadError}</p> : null}
        {notes === undefined && !loadError ? <p class="hint">正在读取笔记…</p> : null}
        {notes && notes.length === 0 ? <Empty>这条线还没有笔记</Empty> : null}
        {notes && notes.length > 0 ? (
          <ul class="list">
            {notes.map(n => (
              <li key={n.id} class="row">
                {editing?.id === n.id ? (
                  <div class="form">
                    <textarea rows={2} value={editing.text} disabled={busy} onInput={e => setEditing({ id: n.id, text: e.currentTarget.value })} />
                    <div class="button-row">
                      <button
                        type="button"
                        class="primary"
                        disabled={busy || !editing.text.trim()}
                        onClick={() => void run('note.edit', { noteId: n.id, text: editing.text.trim() }, '已保存笔记', () => { setEditing(null); return after(); })}
                      >
                        保存
                      </button>
                      <button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div class="row-main">
                      <span>{n.text}</span>
                      <span class="tag">{NOTE_STATE_ZH[n.state ?? ''] ?? n.state ?? '未知状态'}</span>
                      {n.pinned ? <span class="tag">已置顶</span> : null}
                    </div>
                    <div class="hint">{n.lane} · {n.author ?? ''} · {timeText(n.updatedAt)}</div>
                    <div class="button-row">
                      <button type="button" disabled={busy} onClick={() => setEditing({ id: n.id, text: n.text })}>编辑</button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run('note.pin', { noteId: n.id, pinned: !n.pinned }, n.pinned ? '已取消置顶' : '已置顶', after)}
                      >
                        {n.pinned ? '取消置顶' : '置顶'}
                      </button>
                      {n.state === 'proposed' ? (
                        <button type="button" class="primary" disabled={busy} onClick={() => void run('note.activate', { noteId: n.id }, '已启用', after)}>启用</button>
                      ) : null}
                      {removing === n.id ? (
                        <>
                          <button type="button" class="danger" disabled={busy} onClick={() => void run('note.remove', { noteId: n.id }, '已删除', () => { setRemoving(''); return after(); })}>
                            确认删除
                          </button>
                          <button type="button" disabled={busy} onClick={() => setRemoving('')}>取消</button>
                        </>
                      ) : (
                        <button type="button" class="danger" disabled={busy} onClick={() => setRemoving(n.id)}>删除</button>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel title="新增笔记" hint="一条笔记只能一行。不要写入凭证。">
        <div class="form">
          <label class="field">
            <span>线（必填）</span>
            <input list="lane-options" value={addLane} disabled={busy} onInput={e => setAddLane(e.currentTarget.value)} />
            <datalist id="lane-options">
              {lanes.map(l => <option key={l} value={l} />)}
            </datalist>
          </label>
          <label class="field">
            <span>笔记内容（必填，一行）</span>
            <input value={addText} disabled={busy} onInput={e => setAddText(e.currentTarget.value)} />
          </label>
          <div class="button-row">
            <label class="inline"><input type="checkbox" checked={addPinned} disabled={busy} onChange={e => setAddPinned(e.currentTarget.checked)} /> 置顶</label>
            <label class="inline"><input type="checkbox" checked={addProposed} disabled={busy} onChange={e => setAddProposed(e.currentTarget.checked)} /> 作为待确认</label>
          </div>
          {addProblems.length ? <ul class="errors">{addProblems.map(p => <li key={p}>{p}</li>)}</ul> : null}
          <div class="button-row">
            <button type="button" class="primary" disabled={busy} onClick={submitAdd}>添加笔记</button>
          </div>
        </div>
      </Panel>

      <Panel title="整理笔记" hint={`整理会合并重复与过期的笔记，不改写原文。当前范围：${scopeText}。`}>
        <div class="button-row">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run('note.consolidate', { ...(lane ? { lane } : {}), dryRun: true }, '已生成整理预览', result => { setPreview(result); setConsolidateArmed(false); })}
          >
            预览整理
          </button>
          {consolidateArmed ? (
            <>
              <button
                type="button"
                class="danger"
                disabled={busy}
                onClick={() => void run('note.consolidate', { ...(lane ? { lane } : {}), dryRun: false }, '已整理', () => { setConsolidateArmed(false); setPreview(undefined); return after(); })}
              >
                确认执行整理
              </button>
              <button type="button" disabled={busy} onClick={() => setConsolidateArmed(false)}>取消</button>
            </>
          ) : (
            <button type="button" class="danger" disabled={busy} onClick={() => setConsolidateArmed(true)}>执行整理…</button>
          )}
        </div>
        {preview !== undefined ? (
          <details open>
            <summary>整理预览结果</summary>
            <Pre value={preview} />
          </details>
        ) : null}

        <h4>整理记录</h4>
        {consolidationError ? <p class="notice err">整理记录读取失败：{consolidationError}</p> : null}
        {consolidations && consolidations.length === 0 ? <Empty>还没有整理记录</Empty> : null}
        {consolidations && consolidations.length > 0 ? (
          <ul class="list compact">
            {consolidations.map((c, index) => {
              const cid = String(c.id ?? c.consolidationId ?? '');
              return (
                <li key={cid || index} class="row">
                  <span class="hint">{timeText(c.at ?? c.createdAt)}</span> {c.lane ?? ''} {c.undone ? <span class="tag">已撤销</span> : null}
                  <div class="button-row">
                    <button
                      type="button"
                      disabled={busy || !cid || c.undone === true}
                      onClick={() => void run('note.consolidation.undo', { id: cid }, '已撤销这次整理', after)}
                    >
                      撤销这次整理
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}
