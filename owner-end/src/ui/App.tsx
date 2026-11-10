import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { beginLogin, CALLBACK_PATH, completeLogin, LOGIN_LABEL, LOGIN_HINT } from './auth.ts';
import { logout, onUnauthorized, readMe, type Me } from './api.ts';
import { Dialog } from './common.tsx';
import { routeOf, withDraft, withoutDraft, type Drafts, type PageId } from './model.ts';
import { BoardPage } from './pages/Board.tsx';
import { NotesPage } from './pages/Notes.tsx';
import { OpsPage } from './pages/Ops.tsx';
import { OverviewPage } from './pages/Overview.tsx';
import { RequirementsPage } from './pages/Requirements.tsx';
import { StaffPage } from './pages/Staff.tsx';
import { TasksPage } from './pages/Tasks.tsx';
import { useLiveState } from './realtime.ts';

function LiveIndicator() {
  const state = useLiveState();
  return <p class={`live-indicator live-${state}`} role="status">{state === 'live' ? '● LIVE 实时连接' : state === 'connecting' ? '◌ 正在连接实时数据' : '● 实时连接中断 · 正在重连'}</p>;
}

type Session =
  | { kind: 'loading' }
  | { kind: 'out'; notice?: string }
  | { kind: 'in'; me: Me }
  | { kind: 'error'; message: string };

interface NavItem { id: PageId; label: string; hint: string }

/** 主导航：老板每天用的三项。管理：低频功能。旧入口的对应关系见 docs/owner-workbench.md。 */
const PRIMARY: NavItem[] = [
  { id: 'overview', label: '总览', hint: '主机、Agent、当前任务与实时交接' },
  { id: 'requirements', label: '需求', hint: '反馈、需求确认、进度与发布' },
  { id: 'tasks', label: '执行任务', hint: '需求拆出的任务与执行结果' },
];
const SECONDARY: NavItem[] = [
  { id: 'messages', label: '派工消息', hint: '员工动态、排队与待发消息' },
  { id: 'notes', label: '笔记', hint: '派工时附带的线笔记' },
  { id: 'staff', label: '员工与权限', hint: '员工策略与命令保护' },
  { id: 'ops', label: '运维', hint: '命令目录、作业、审计与身份' },
];

const Mark = () => (
  <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="6" />
    <path d="M7 12.5l3.2 3.2L17 8.8" />
  </svg>
);

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
      <div class="login-card">
        <div class="login-brand"><Mark /><span>老板端</span></div>
        <h1>管理 AI 员工与产品迭代</h1>
        <p class="login-lead">反馈整理成需求，由你确认开工；执行进度、受阻事项和交付结果集中在一处查看。</p>
        <ul class="login-points">
          <li>需要你决策的事项排在最前</li>
          <li>确认后的需求修订锁定，执行以确认快照为准</li>
          <li>确认开工后，独立复核通过即可合并 PR，由 GitHub 自动部署并验收线上效果</li>
        </ul>
        {notice ? <div class="notice err" role="alert"><span class="notice-text">{notice}</span></div> : null}
        {error ? <div class="notice err" role="alert"><span class="notice-text">{error}</span></div> : null}
        <button type="button" class="primary large" disabled={busy} onClick={() => void start()}>
          {busy ? '正在跳转…' : LOGIN_LABEL}
        </button>
        <p class="login-hint">{LOGIN_HINT}</p>
      </div>
    </main>
  );
}

function CenterState({ children }: { children: preact.ComponentChildren }) {
  return <main class="login"><div class="login-card center">{children}</div></main>;
}

export function App() {
  const [session, setSession] = useState<Session>({ kind: 'loading' });
  const [hash, setHash] = useState(() => location.hash);
  /** 未保存的消息原文，按 messageId 保存；切换页面或刷新数据后仍保留。退出登录时清空。 */
  const [drafts, setDrafts] = useState<Drafts>({});
  /** 刷新递增它，让当前页面重新挂载并读取最新数据。 */
  const [pageKey, setPageKey] = useState(0);
  /** 页面上有未保存修改（需求编辑、产品设置）。离开、刷新前需要确认。 */
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const hashRef = useRef(location.hash);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const setDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirtyState(value);
  }, []);

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
      setDirty(false);
      setSession({ kind: 'out', notice: '登录已过期，请重新登录' });
    });
    const onHash = () => {
      const next = location.hash;
      if (dirtyRef.current && next !== hashRef.current) {
        // 有未保存修改：先回到原地址，再询问是否放弃。
        history.replaceState(null, '', hashRef.current || '#overview');
        setLeaveTo(next);
        return;
      }
      hashRef.current = next;
      setHash(next);
      setNavOpen(false);
      window.scrollTo(0, 0);
    };
    addEventListener('hashchange', onHash);
    const protect = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    addEventListener('beforeunload', protect);
    void (async () => {
      if (location.pathname === CALLBACK_PATH) {
        const result = await completeLogin(location.search, location.origin);
        // 去掉地址栏的 code 与 state，进入总览。
        history.replaceState(null, '', '/#overview');
        hashRef.current = '#overview';
        setHash('#overview');
        if (!result.ok) {
          setSession({ kind: 'out', notice: result.message });
          return;
        }
      }
      await check();
    })();
    return () => {
      removeEventListener('hashchange', onHash);
      removeEventListener('beforeunload', protect);
    };
  }, [check, setDirty]);

  const setDraft = useCallback((messageId: string, value: string) => setDrafts(d => withDraft(d, messageId, value)), []);
  const dropDraft = useCallback((messageId: string) => setDrafts(d => withoutDraft(d, messageId)), []);

  async function signOut() {
    await logout();
    setDrafts({});
    setDirty(false);
    setSession({ kind: 'out' });
  }

  if (session.kind === 'loading') {
    return <CenterState><span class="spinner" aria-hidden="true" /><p role="status">正在确认登录状态…</p></CenterState>;
  }

  if (session.kind === 'error') {
    return (
      <CenterState>
        <div class="login-brand"><Mark /><span>老板端</span></div>
        <div class="notice err" role="alert"><span class="notice-text">登录状态读取失败：{session.message}</span></div>
        <div class="button-row">
          <button type="button" class="primary" onClick={() => void check()}>重试</button>
          <button type="button" onClick={() => void signOut()}>退出登录</button>
        </div>
      </CenterState>
    );
  }

  if (session.kind === 'out') return <LoginPage notice={session.notice} />;

  const route = routeOf(hash);
  const me = session.me;
  const navLink = (item: NavItem) => (
    <a key={item.id} href={`#${item.id}`} class={route.page === item.id ? 'nav-link active' : 'nav-link'} aria-current={route.page === item.id ? 'page' : undefined} title={item.hint}>
      <span>{item.label}</span>
    </a>
  );

  return (
    <div class="app">
      <a class="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus(); }}>跳到主要内容</a>
      <aside class={`sidebar${navOpen ? ' open' : ''}`}>
        <div class="sidebar-top">
          <a class="brand" href="#overview"><Mark /><span class="brand-text"><strong>老板端</strong><small>AI 公司工作台</small></span></a>
          <button type="button" class="ghost nav-toggle" aria-expanded={navOpen} aria-controls="primary-nav" onClick={() => setNavOpen(o => !o)}>
            {navOpen ? '收起' : '菜单'}
          </button>
        </div>
        <nav id="primary-nav" class="nav" aria-label="主导航">
          <div class="nav-group">{PRIMARY.map(navLink)}</div>
          <div class="nav-group">
            <p class="nav-label">管理</p>
            {SECONDARY.map(navLink)}
          </div>
        </nav>
        <div class="sidebar-foot">
          <LiveIndicator />
          <p class="who" title={me.sub}><span class="avatar" aria-hidden="true">{me.sub.slice(0, 1)}</span><span>{me.sub}</span></p>
          <div class="foot-actions">
            <button type="button" class="ghost" disabled={dirty} title={dirty ? '请先保存或放弃修改' : '重新读取当前页面数据'} onClick={() => setPageKey(k => k + 1)}>刷新</button>
            <button type="button" class="ghost" onClick={() => { if (dirtyRef.current) setLeaveTo('__signout__'); else void signOut(); }}>退出</button>
          </div>
        </div>
      </aside>
      <main id="main" class="main" tabIndex={-1}>
        {route.page === 'overview' ? <OverviewPage key={`overview-${pageKey}`} /> : null}
        {route.page === 'requirements' ? <RequirementsPage key={`requirements-${pageKey}`} route={route} onDirtyChange={setDirty} /> : null}
        {route.page === 'tasks' ? <TasksPage key={`tasks-${pageKey}`} route={route} /> : null}
        {route.page === 'messages' ? <BoardPage key={`board-${pageKey}`} drafts={drafts} onDraft={setDraft} onDraftSaved={dropDraft} /> : null}
        {route.page === 'notes' ? <NotesPage key={`notes-${pageKey}`} /> : null}
        {route.page === 'staff' ? <StaffPage key={`staff-${pageKey}`} /> : null}
        {route.page === 'ops' ? <OpsPage key={`ops-${pageKey}`} /> : null}
      </main>
      {leaveTo !== null ? (
        <Dialog
          title="有未保存的修改"
          onClose={() => setLeaveTo(null)}
          footer={(
            <>
              <button type="button" data-autofocus onClick={() => setLeaveTo(null)}>继续编辑</button>
              <button
                type="button"
                class="danger"
                onClick={() => {
                  const target = leaveTo;
                  setLeaveTo(null);
                  setDirty(false);
                  if (target === '__signout__') void signOut();
                  else location.hash = target;
                }}
              >
                放弃修改{leaveTo === '__signout__' ? '并退出' : '并离开'}
              </button>
            </>
          )}
        >
          <p>离开后，当前编辑的内容不会保存。需求在你保存并确认之前不会开工。</p>
        </Dialog>
      ) : null}
    </div>
  );
}
