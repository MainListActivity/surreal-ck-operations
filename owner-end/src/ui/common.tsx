import type { ComponentChildren } from 'preact';
import { useCallback, useRef, useState } from 'preact/hooks';
import { runCommand, outcomeText, type Outcome } from './api.ts';

export interface Notice {
  tone: 'ok' | 'warn' | 'err';
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
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, notice, setNotice, run };
}

export function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return <p class={`notice ${notice.tone}`} role="status">{notice.text}</p>;
}

export function Panel({ title, hint, actions, children }: {
  title: string;
  hint?: string;
  actions?: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>{title}</h2>
          {hint ? <p class="hint">{hint}</p> : null}
        </div>
        {actions ? <div class="panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Pre({ value }: { value: unknown }) {
  return <pre class="raw">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}

/** 员工岗位（与 src/contracts.ts 的 ROLES 一致）。复核岗另可选 owner。 */
export const ROLE_OPTIONS: readonly string[] = [
  'product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'screenwriter', 'story-author', 'cinematography', 'qa', 'cs',
];

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
      {options.map(role => <option key={role} value={role}>{role}</option>)}
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
