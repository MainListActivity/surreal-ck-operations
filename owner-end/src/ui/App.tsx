import { RequirementsPage } from './pages/Requirements.tsx';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { beginLogin, CALLBACK_PATH, completeLogin, LOGIN_LABEL, LOGIN_HINT } from './auth.ts';
import { logout, onUnauthorized, readMe, type Me } from './api.ts';
import { pageOf, withDraft, withoutDraft, type Drafts } from './model.ts';
import { BoardPage } from './pages/Board.tsx';
import { NotesPage } from './pages/Notes.tsx';
import { OpsPage } from './pages/Ops.tsx';
import { StaffPage } from './pages/Staff.tsx';
import { TasksPage } from './pages/Tasks.tsx';

type Session =
  | { kind: 'loading' }
  | { kind: 'out'; notice?: string }
  | { kind: 'in'; me: Me }
  | { kind: 'error'; message: string };

const TABS: Array<{ id: ReturnType<typeof pageOf>; label: string }> = [
  { id: 'board', label: '看板' },
  { id: 'requirements', label: '需求池' },
  { id: 'tasks', label: '执行任务' },
  { id: 'notes', label: '笔记' },
  { id: 'staff', label: '员工与权限' },
  { id: 'ops', label: '运维' },
];

/** 登录页：点击后取 /api/config，生成 PKCE 并跳转到 ma_hono 授权页。 */
function LoginPage({ notice }: { notice?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const url = await beginLogin(location.origin);
      location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录配置读取失败，请稍后重试');
      setBusy(false);
    }
  };
  return (
    <main class="login">
      <h1>老板端</h1>
      <p>{LOGIN_HINT}</p>
      {notice ? <p class="notice err" role="alert">{notice}</p> : null}
      {error ? <p class="notice err" role="alert">{error}</p> : null}
      <button type="button" class="primary" disabled={busy} onClick={() => void start()}>
        {busy ? '正在跳转…' : LOGIN_LABEL}
      </button>
    </main>
  );
}

export function App() {
  const [requirementDirty,setRequirementDirty]=useState(false);
  const [session, setSession] = useState<Session>({ kind: 'loading' });
  const [hash, setHash] = useState(() => location.hash);
  /** 未保存的消息原文，按 messageId 保存；切换页面或刷新数据后仍保留。退出登录时清空。 */
  const [drafts, setDrafts] = useState<Drafts>({});
  /** 顶栏「刷新」递增它，让当前页面重新挂载并读取最新数据。 */
  const [pageKey, setPageKey] = useState(0);

  const check = useCallback(async () => {
    setSession({ kind: 'loading' });
    try {
      const found = await readMe();
      setSession(found ? { kind: 'in', me: found.me } : { kind: 'out' });
    } catch (error) {
      setSession({ kind: 'error', message: error instanceof Error ? error.message : '登录状态读取失败' });
    }
  }, []);

  useEffect(() => {
    onUnauthorized(() => {
      setDrafts({});
      setSession({ kind: 'out', notice: '登录已过期，请重新登录' });
    });
    const onHash = () => setHash(location.hash);
    addEventListener('hashchange', onHash);
    void (async () => {
      if (location.pathname === CALLBACK_PATH) {
        const result = await completeLogin(location.search, location.origin);
        // 去掉地址栏的 code 与 state，进入看板。
        history.replaceState(null, '', '/#board');
        setHash('#board');
        if (!result.ok) {
          setSession({ kind: 'out', notice: result.message });
          return;
        }
      }
      await check();
    })();
    return () => removeEventListener('hashchange', onHash);
  }, [check]);

  const setDraft = useCallback((messageId: string, value: string) => setDrafts(d => withDraft(d, messageId, value)), []);
  const dropDraft = useCallback((messageId: string) => setDrafts(d => withoutDraft(d, messageId)), []);

  if (session.kind === 'loading') return <main class="login"><p class="hint">正在确认登录状态…</p></main>;

  if (session.kind === 'error') {
    return (
      <main class="login">
        <h1>老板端</h1>
        <p class="notice err">登录状态读取失败：{session.message}</p>
        <button type="button" onClick={() => void check()}>重试</button>
        <button type="button" onClick={() => void signOut()}>退出登录</button>
      </main>
    );
  }

  if (session.kind === 'out') return <LoginPage notice={session.notice} />;

  const page = pageOf(hash);
  const me = session.me;

  async function signOut() {
    await logout();
    setDrafts({});
    setSession({ kind: 'out' });
  }

  return (
    <div class="shell">
      <header class="topbar">
        <div class="brand">老板端</div>
        <div class="who">当前老板：{me.sub}</div>
        <div class="top-actions">
          <button type="button" disabled={requirementDirty} title={requirementDirty?'请先保存或放弃需求修改':undefined} onClick={() => setPageKey(k => k + 1)}>刷新</button>
          <button type="button" onClick={() => void signOut()}>退出</button>
        </div>
      </header>
      <nav class="tabs" aria-label="页面">
        {TABS.map(tab => (
          <a
            key={tab.id}
            href={`#${tab.id}`}
            class={page === tab.id ? 'tab active' : 'tab'}
            aria-current={page === tab.id ? 'page' : undefined}
          >
            {tab.label}
          </a>
        ))}
      </nav>
      <main class="content">
        {page === 'board' ? (
          <BoardPage key={`board-${pageKey}`} drafts={drafts} onDraft={setDraft} onDraftSaved={dropDraft} />
        ) : null}
        <div hidden={page !== 'requirements'}><RequirementsPage key={`requirements-${pageKey}`} onDirtyChange={setRequirementDirty} /></div>
        {page === 'tasks' ? <TasksPage key={`tasks-${pageKey}`} /> : null}
        {page === 'notes' ? <NotesPage key={`notes-${pageKey}`} /> : null}
        {page === 'staff' ? <StaffPage key={`staff-${pageKey}`} /> : null}
        {page === 'ops' ? <OpsPage key={`ops-${pageKey}`} /> : null}
      </main>
    </div>
  );
}
