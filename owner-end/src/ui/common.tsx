import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { runCommand, outcomeText, type Outcome } from './api.ts';
import type { Tone } from './iteration.ts';

export interface Notice {
  tone: 'ok' | 'warn' | 'err' | 'info';
  text: string;
}

/**
 * 写操作的统一入口：同一时间只允许一个写操作（busy 期间按钮禁用），失败时把服务端 message 写进提示条，
 * 成功后执行 after（通常是刷新数据）。
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busyRef = useRef(false);

  const run = useCallback(async <T,>(
    command: string,
    input: Record<string, unknown>,
    okText: string,
    after?: (result: T) => void | Promise<void>,
  ): Promise<Outcome<T> | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    try {
      const out = await runCommand<T>(command, input);
      if (out.kind === 'ok') {
        setNotice({ tone: 'ok', text: outcomeText(out, okText) });
        if (after) await after(out.result);
      } else if (out.kind === 'pending') {
        // 执行端尚未完成：只提示，不回调 after；看板自动刷新或手动刷新后再看结果。
        setNotice({ tone: 'warn', text: outcomeText(out, okText) });
      } else {
        setNotice({ tone: 'err', text: outcomeText(out, okText) });
      }
      return out;
    } catch {
      setNotice({ tone: 'err', text: '操作失败，请刷新核对后再重试' });
      return undefined;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, notice, setNotice, run };
}

const NOTICE_ICON: Record<Notice['tone'], string> = { ok: '✓', warn: '!', err: '×', info: 'i' };

/** 操作结果提示。成功与提示用 status，失败用 alert，屏幕阅读器会读出。 */
export function NoticeLine({ notice, onClose }: { notice: Notice | null; onClose?(): void }) {
  if (!notice) return null;
  return (
    <div class={`notice ${notice.tone}`} role={notice.tone === 'err' ? 'alert' : 'status'}>
      <span class="notice-icon" aria-hidden="true">{NOTICE_ICON[notice.tone]}</span>
      <span class="notice-text">{notice.text}</span>
      {onClose ? <button type="button" class="ghost icon" aria-label="关闭提示" onClick={onClose}>×</button> : null}
    </div>
  );
}

/** 页面标题区：面包屑、标题、说明与右侧主操作。 */
export function PageHeader({ title, crumbs, description, actions, meta }: {
  title: ComponentChildren;
  crumbs?: Array<{ label: string; href?: string }>;
  description?: ComponentChildren;
  actions?: ComponentChildren;
  meta?: ComponentChildren;
}) {
  return (
    <header class="page-header">
      {crumbs?.length ? (
        <nav class="crumbs" aria-label="位置">
          {crumbs.map((c, i) => (
            <span key={i}>{c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}<span class="crumb-sep" aria-hidden="true">/</span></span>
          ))}
        </nav>
      ) : null}
      <div class="page-header-row">
        <div class="page-header-text">
          <h1>{title}</h1>
          {meta ? <div class="page-meta">{meta}</div> : null}
          {description ? <p class="page-desc">{description}</p> : null}
        </div>
        {actions ? <div class="page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

/** 区块。旧页面使用的 Panel 与之同义。 */
export function Section({ title, hint, actions, children, id, class: cls }: {
  title?: ComponentChildren;
  hint?: ComponentChildren;
  actions?: ComponentChildren;
  children?: ComponentChildren;
  id?: string;
  class?: string;
}) {
  return (
    <section class={`panel${cls ? ` ${cls}` : ''}`} id={id}>
      {title || actions ? (
        <header class="panel-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {hint ? <p class="hint">{hint}</p> : null}
          </div>
          {actions ? <div class="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Panel(props: { title: string; hint?: string; actions?: ComponentChildren; children?: ComponentChildren; id?: string }) {
  return <Section {...props} />;
}

/** 状态标记：颜色含义固定（见 Tone）。 */
export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ComponentChildren; title?: string }) {
  return <span class={`badge tone-${tone}`} title={title}>{children}</span>;
}

/** 需要注意的说明块：决策栏、受阻说明、锁定提示。 */
export function Callout({ tone = 'neutral', title, children, actions }: {
  tone?: Tone;
  title: ComponentChildren;
  children?: ComponentChildren;
  actions?: ComponentChildren;
}) {
  return (
    <div class={`callout tone-${tone}`}>
      <div class="callout-body">
        <p class="callout-title">{title}</p>
        {children ? <div class="callout-text">{children}</div> : null}
      </div>
      {actions ? <div class="callout-actions">{actions}</div> : null}
    </div>
  );
}

export function Pre({ value }: { value: unknown }) {
  return <pre class="raw">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="state-block empty-state">
      <p class="state-title">{title}</p>
      {children ? <p class="state-text">{children}</p> : null}
      {action ? <div class="state-action">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = '正在读取…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div class="state-block loading" role="status" aria-live="polite">
      <span class="visually-hidden">{label}</span>
      <div class="skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => <span key={i} style={{ width: `${88 - i * 14}%` }} />)}
      </div>
      <p class="state-text" aria-hidden="true">{label}</p>
    </div>
  );
}

export function ErrorState({ title = '读取失败', message, onRetry }: { title?: string; message: string; onRetry?(): void }) {
  return (
    <div class="state-block error-state" role="alert">
      <p class="state-title">{title}</p>
      <p class="state-text">{message}</p>
      {onRetry ? <div class="state-action"><button type="button" onClick={onRetry}>重试</button></div> : null}
    </div>
  );
}

/** 筛选分段：每项带数量，使用 aria-pressed 表示当前选择。 */
export function FilterTabs({ items, value, onChange, label }: {
  items: ReadonlyArray<{ id: string; label: string; count?: number }>;
  value: string;
  onChange(id: string): void;
  label: string;
}) {
  return (
    <div class="filter-tabs" role="group" aria-label={label}>
      {items.map(item => (
        <button key={item.id} type="button" class="filter-tab" aria-pressed={item.id === value} onClick={() => onChange(item.id)}>
          <span>{item.label}</span>
          {item.count !== undefined ? <span class="count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 表单字段：标签、说明、字数与错误。 */
export function Field({ label, hint, error, count, max, children, required }: {
  label: string;
  hint?: ComponentChildren;
  error?: string;
  count?: number;
  max?: number;
  required?: boolean;
  children: ComponentChildren;
}) {
  return (
    <label class={`field${error ? ' has-error' : ''}`}>
      <span class="field-label">
        <span>{label}{required ? <span class="req" aria-hidden="true"> *</span> : null}</span>
        {max !== undefined && count !== undefined ? <span class={`counter${count > max ? ' over' : ''}`}>{count} / {max}</span> : null}
      </span>
      {children}
      {hint ? <span class="field-hint">{hint}</span> : null}
      {error ? <span class="field-error" role="alert">{error}</span> : null}
    </label>
  );
}

let dialogSeq = 0;

/**
 * 模态对话框：打开时聚焦首个可操作控件，Tab 在框内循环，Esc 关闭，关闭后焦点回到打开前的元素。
 */
export function Dialog({ title, children, footer, onClose, wide, tone }: {
  title: ComponentChildren;
  children?: ComponentChildren;
  footer?: ComponentChildren;
  onClose(): void;
  wide?: boolean;
  tone?: 'danger';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [titleId] = useState(() => `dialog-title-${++dialogSeq}`);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])') ?? []);
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const head = list[0]!, tail = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === head) { e.preventDefault(); tail.focus(); }
      else if (!e.shiftKey && document.activeElement === tail) { e.preventDefault(); head.focus(); }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('has-dialog');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-dialog');
      previous?.focus?.();
    };
  }, []);
  return (
    <div class="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} class={`dialog${wide ? ' wide' : ''}${tone ? ` ${tone}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header class="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" class="ghost icon" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div class="dialog-body">{children}</div>
        {footer ? <footer class="dialog-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** 未保存修改提示条。 */
export function UnsavedBar({ children }: { children?: ComponentChildren }) {
  return (
    <div class="unsaved-bar" role="status">
      <span class="dot" aria-hidden="true" />
      <span>{children ?? '有未保存的修改'}</span>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={label}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}

/** 员工岗位（与 src/contracts.ts 的 ROLES 一致）。复核岗另可选 owner。 */
export const ROLE_OPTIONS: readonly string[] = [
  'product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'screenwriter', 'story-author', 'cinematography', 'qa', 'cs',
];

export const ROLE_ZH: Record<string, string> = {
  product: '产品', engineering: '工程', 'ai-content': 'AI 内容', 'concept-design': '概念设计', 'asset-production': '素材制作',
  screenwriter: '编剧', 'story-author': '故事作者', cinematography: '摄影', qa: '质量验收', cs: '客服', owner: '老板',
  research: '研究', operations: '运营', gm: '总经理',
};
export const roleText = (role: string | undefined): string => role ? ROLE_ZH[role] ?? role : '未指定';

export function RoleSelect({ value, onChange, allowBlank, blankText, withOwner, id, disabled }: {
  value: string;
  onChange(value: string): void;
  allowBlank?: boolean;
  blankText?: string;
  withOwner?: boolean;
  id?: string;
  disabled?: boolean;
}) {
  const options = withOwner ? [...ROLE_OPTIONS, 'owner'] : [...ROLE_OPTIONS];
  return (
    <select id={id} value={value} disabled={disabled} onChange={e => onChange(e.currentTarget.value)}>
      {allowBlank ? <option value="">{blankText ?? '不指定'}</option> : null}
      {!allowBlank && !value ? <option value="">请选择</option> : null}
      {options.map(role => <option key={role} value={role}>{roleText(role)} · {role}</option>)}
    </select>
  );
}

/** 显示时间：ms 转本地 yyyy-mm-dd HH:MM；无法解析时原样返回。 */
export function timeText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
