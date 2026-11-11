import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { hrefOf, taskIdOf } from './model.ts';
import { useDashboard, useRequirements, useTasks } from './store.ts';

interface Entry { key: string; group: string; label: string; hint?: string; href: string }

const PAGES: Entry[] = [
  { key: 'p:today', group: '页面', label: '今天', href: hrefOf('today') },
  { key: 'p:projects', group: '页面', label: '项目', href: hrefOf('projects') },
  { key: 'p:overview', group: '页面', label: '现场大屏', href: hrefOf('overview') },
  { key: 'p:requirements', group: '页面', label: '需求池', href: hrefOf('requirements') },
  { key: 'p:new', group: '页面', label: '新建需求', href: hrefOf('requirements', 'new') },
  { key: 'p:tasks', group: '页面', label: '执行任务', href: hrefOf('tasks') },
  { key: 'p:messages', group: '系统', label: '派工消息', href: hrefOf('messages') },
  { key: 'p:notes', group: '系统', label: '笔记', href: hrefOf('notes') },
  { key: 'p:staff', group: '系统', label: '员工与权限', href: hrefOf('staff') },
  { key: 'p:ops', group: '系统', label: '运维', href: hrefOf('ops') },
];

/** 匹配：全部关键字都出现在标题或提示里（不区分大小写）。 */
export function matches(entry: Pick<Entry, 'label' | 'hint'>, query: string): boolean {
  const hay = `${entry.label} ${entry.hint ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** ⌘K 跳转：页面、项目、需求、任务，一个输入框找到。只读，不执行命令。 */
export function Palette({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dash = useDashboard();
  const reqs = useRequirements();
  const tasks = useTasks();

  const entries = useMemo(() => {
    const projects: Entry[] = (dash.data?.projects ?? []).map((p) => ({ key: `pr:${p.id}`, group: '项目', label: p.name, href: hrefOf('projects', p.id) }));
    const requirements: Entry[] = (reqs.data ?? []).map((r) => ({ key: `r:${r.id}`, group: '需求', label: r.title, hint: r.id, href: hrefOf('requirements', r.id) }));
    const taskRows: Entry[] = (tasks.data ?? []).map((t) => {
      const id = taskIdOf(t);
      return { key: `t:${id}`, group: '任务', label: t.title || id, hint: id, href: hrefOf('tasks', id) };
    });
    const q = query.trim();
    if (!q) return [...PAGES, ...projects];
    const pick = (list: Entry[], n: number) => list.filter((e) => matches(e, q)).slice(0, n);
    return [...pick(PAGES, 5), ...pick(projects, 5), ...pick(requirements, 8), ...pick(taskRows, 8)];
  }, [query, dash.data, reqs.data, tasks.data]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setCursor(0); }, [query]);

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    location.hash = entry.href;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(entries.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(entries[cursor]); }
  };

  let lastGroup = '';
  return (
    <div class="palette-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="搜索与跳转">
        <input
          ref={input}
          class="palette-input"
          type="search"
          placeholder="搜索需求、任务、项目或页面"
          aria-label="搜索需求、任务、项目或页面"
          aria-controls="palette-results"
          aria-activedescendant={entries[cursor] ? `pal-${cursor}` : undefined}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={onKey}
        />
        <ul id="palette-results" class="palette-results" role="listbox">
          {entries.map((entry, i) => {
            const head = entry.group !== lastGroup ? entry.group : '';
            lastGroup = entry.group;
            return (
              <li key={entry.key} role="presentation">
                {head ? <p class="palette-group">{head}</p> : null}
                <a
                  id={`pal-${i}`}
                  role="option"
                  aria-selected={i === cursor}
                  class={`palette-item${i === cursor ? ' is-active' : ''}`}
                  href={entry.href}
                  onMouseEnter={() => setCursor(i)}
                  onClick={(e) => { e.preventDefault(); go(entry); }}
                >
                  <span>{entry.label}</span>
                  {entry.hint ? <code>{entry.hint.slice(0, 8)}</code> : null}
                </a>
              </li>
            );
          })}
          {!entries.length ? <li class="palette-empty">没有找到“{query}”</li> : null}
        </ul>
        <p class="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 关闭</p>
      </div>
    </div>
  );
}
