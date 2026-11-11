import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { beginLogin, CALLBACK_PATH, completeLogin, LOGIN_LABEL, LOGIN_HINT } from './auth.ts';
import { logout, onUnauthorized, readMe, type Me } from './api.ts';
import { Dialog, NoticeLine, useAction } from './common.tsx';
import { onDuty } from './meeting-rooms.ts';
import { clockText, hrefOf, routeOf, SYSTEM_PAGES, withDraft, withoutDraft, type Drafts, type PageId } from './model.ts';
import { Palette } from './Palette.tsx';
import { BoardPage } from './pages/Board.tsx';
import { ProjectsPage } from './pages/Projects.tsx';
import { TodayPage } from './pages/Today.tsx';
import { resetShared, useDispatch, useLiveDashboard, useRequirements, useTasks } from './store.ts';
import { decisionQueue, projectTone } from './today.ts';
import { NotesPage } from './pages/Notes.tsx';
import { OpsPage } from './pages/Ops.tsx';
import { OverviewPage } from './pages/Overview.tsx';
import { RequirementsPage } from './pages/Requirements.tsx';
import { StaffPage } from './pages/Staff.tsx';
import { TasksPage } from './pages/Tasks.tsx';
import { holdLive, useLiveState } from './realtime.ts';

function LiveIndicator() {
  const state = useLiveState();
  return (
    <span class={`top-status live-indicator live-${state}`} role="status">
      <span class={`dot is-${state === 'live' ? 'done' : state === 'connecting' ? 'idle' : 'blocked'}`} aria-hidden="true" />
      {state === 'live' ? '实时同步' : state === 'connecting' ? '正在连接' : '实时连接中断 · 重连中'}
    </span>
  );
}

/** 执行端（老板的电脑）是否在线：取各主机最近一次心跳。 */
function ExecutorStatus() {
  // 过期按心跳截止时间本地判断：执行端掉线后不再有推送，这里也会转为离线。
  const { data } = useLiveDashboard();
  if (!data) return null;
  const online = data.hosts.filter((h) => h.state === 'online');
  const last = Math.max(0, ...data.hosts.map((h) => h.at ?? 0));
  return (
    <span class="top-status" title={last ? `最近心跳 ${clockText(last)}` : undefined}>
      <span class={`dot is-${online.length ? 'done' : 'blocked'}`} aria-hidden="true" />
      {online.length ? '执行端在线' : last ? `执行端离线 · 最近心跳 ${clockText(last)}` : '执行端未上报'}
    </span>
  );
}

/** 全公司派工开关。暂停前确认；在途执行不受影响。 */
function DispatchToggle() {
  const { data, reload } = useDispatch();
  const [confirm, setConfirm] = useState(false);
  const action = useAction();
  if (!data) return null;
  const toggle = () => void action.run(data.paused ? 'task.resume' : 'task.pause', {}, data.paused ? '已恢复派工' : '已暂停派工。在途执行不受影响。', () => { setConfirm(false); return reload(); });
  return (
    <>
      <span class="top-status">
        <span class={`dot is-${data.paused ? 'blocked' : 'running'}`} aria-hidden="true" />
        {data.paused ? '派工已暂停' : '派工运行中'}
        <button type="button" class="ghost tiny" disabled={action.busy} onClick={() => (data.paused ? toggle() : setConfirm(true))}>{data.paused ? '恢复' : '暂停'}</button>
      </span>
      {action.notice?.tone === 'err' ? <div class="top-notice"><NoticeLine notice={action.notice} onClose={() => action.setNotice(null)} /></div> : null}
      {confirm ? (
        <Dialog title="暂停全公司派工？" onClose={() => setConfirm(false)} footer={(
          <>
            <button type="button" data-autofocus onClick={() => setConfirm(false)}>取消</button>
            <button type="button" class="primary" disabled={action.busy} onClick={toggle}>暂停派工</button>
          </>
        )}>
          <p>暂停后调度器不再派出新任务；员工手上的执行继续做完。需求本身的状态不变。</p>
        </Dialog>
      ) : null}
    </>
  );
}

function TodayCount() {
  const dash = useLiveDashboard();
  const reqs = useRequirements();
  const tasks = useTasks();
  const n = decisionQueue({ requirements: reqs.data, tasks: tasks.data, dashboard: dash.data }).length;
  return n ? <span class="nav-count" aria-label={`${n} 件事等你决定`}>{n}</span> : null;
}

function ProjectLinks({ current }: { current?: string }) {
  const { data } = useLiveDashboard();
  const projects = data?.projects ?? [];
  if (!projects.length) return null;
  return (
    <div class="nav-sub">
      {projects.map((p) => {
        const working = data!.agents.filter((a) => onDuty(a) && a.project?.id === p.id).length;
        return (
          <a key={p.id} href={hrefOf('projects', p.id)} class={current === p.id ? 'nav-sub-link active' : 'nav-sub-link'} aria-current={current === p.id ? 'page' : undefined}>
            <span class={`dot is-${projectTone(p.blocked, working)}`} aria-hidden="true" />
            <span class="nav-sub-name">{p.name}</span>
          </a>
        );
      })}
    </div>
  );
}

const Icon = {
  today: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5l8-7 8 7" /><path d="M6 10v9.5h12V10" /></svg>,
  projects: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 9.5h17" /></svg>,
  live: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="11" rx="2" /><path d="M8.5 19.5h7M12 15.5v4" /></svg>,
  system: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6" /></svg>,
  search: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>,
};

type Session =
  | { kind: 'loading' }
  | { kind: 'out'; notice?: string }
  | { kind: 'in'; me: Me }
  | { kind: 'error'; message: string };

const SYSTEM_TABS: Array<{ id: PageId; label: string }> = [
  { id: 'messages', label: '派工消息' },
  { id: 'notes', label: '笔记' },
  { id: 'staff', label: '员工与权限' },
  { id: 'ops', label: '运维' },
];

const Mark = () => (
  <span class="brand-mark" aria-hidden="true">CK</span>
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
  const [palette, setPalette] = useState(false);

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
      resetShared();
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
        history.replaceState(null, '', '/#today');
        hashRef.current = '#today';
        setHash('#today');
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

  // 登录期间只建一次实时连接；切换菜单、刷新当前页都复用它。
  const signedIn = session.kind === 'in';
  useEffect(() => (signedIn ? holdLive() : undefined), [signedIn]);

  const setDraft = useCallback((messageId: string, value: string) => setDrafts(d => withDraft(d, messageId, value)), []);
  const dropDraft = useCallback((messageId: string) => setDrafts(d => withoutDraft(d, messageId)), []);

  // ⌘K / Ctrl+K 打开搜索与跳转。
  useEffect(() => {
    if (session.kind !== 'in') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [session.kind]);

  async function signOut() {
    await logout();
    resetShared();
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
  const inSystem = SYSTEM_PAGES.includes(route.page);
  const nav = (id: PageId, label: string, icon: preact.JSX.Element, active: boolean, extra?: preact.ComponentChildren) => (
    <a href={hrefOf(id)} class={active ? 'nav-link active' : 'nav-link'} aria-current={active ? 'page' : undefined}>
      {icon}<span>{label}</span>{extra}
    </a>
  );

  return (
    <div class="app">
      <a class="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus(); }}>跳到主要内容</a>
      <aside class={`sidebar${navOpen ? ' open' : ''}`}>
        <div class="sidebar-top">
          <a class="brand" href={hrefOf('today')}><Mark /><span class="brand-text"><strong>老板端</strong></span></a>
          <button type="button" class="ghost nav-toggle" aria-expanded={navOpen} aria-controls="primary-nav" onClick={() => setNavOpen(o => !o)}>
            {navOpen ? '收起' : '菜单'}
          </button>
        </div>
        <nav id="primary-nav" class="nav" aria-label="主导航">
          {nav('today', '今天', Icon.today, route.page === 'today', <TodayCount />)}
          {nav('projects', '项目', Icon.projects, route.page === 'projects' && !route.id)}
          <ProjectLinks current={route.page === 'projects' ? route.id : undefined} />
          {nav('overview', '现场大屏', Icon.live, route.page === 'overview')}
        </nav>
        <div class="sidebar-foot">
          {nav('messages', '系统', Icon.system, inSystem)}
          <p class="who" title={me.sub}><span class="avatar" aria-hidden="true">{me.sub.slice(0, 1)}</span><span>{me.sub}</span></p>
          <button type="button" class="ghost signout" onClick={() => { if (dirtyRef.current) setLeaveTo('__signout__'); else void signOut(); }}>退出登录</button>
        </div>
      </aside>
      <div class="main-wrap">
        <header class="topbar">
          <button type="button" class="search-trigger" onClick={() => setPalette(true)} aria-label="搜索需求、任务、项目（⌘K）">
            {Icon.search}<span>搜索需求、任务、项目</span><kbd>⌘K</kbd>
          </button>
          <div class="top-right">
            <LiveIndicator />
            <ExecutorStatus />
            <DispatchToggle />
            <button type="button" class="ghost tiny" disabled={dirty} title={dirty ? '请先保存或放弃修改' : '重新读取当前页面数据'} onClick={() => setPageKey(k => k + 1)}>刷新</button>
          </div>
        </header>
        <main id="main" class="main" tabIndex={-1}>
          {inSystem ? (
            <nav class="system-tabs" aria-label="系统">
              {SYSTEM_TABS.map((t) => (
                <a key={t.id} href={hrefOf(t.id)} class={route.page === t.id ? 'system-tab active' : 'system-tab'} aria-current={route.page === t.id ? 'page' : undefined}>{t.label}</a>
              ))}
            </nav>
          ) : null}
          {route.page === 'today' ? <TodayPage key={`today-${pageKey}`} /> : null}
          {route.page === 'projects' ? <ProjectsPage key={`projects-${pageKey}`} route={route} /> : null}
          {route.page === 'overview' ? <OverviewPage key={`overview-${pageKey}`} /> : null}
          {route.page === 'requirements' ? <RequirementsPage key={`requirements-${pageKey}`} route={route} onDirtyChange={setDirty} /> : null}
          {route.page === 'tasks' ? <TasksPage key={`tasks-${pageKey}`} route={route} /> : null}
          {route.page === 'messages' ? <BoardPage key={`board-${pageKey}`} drafts={drafts} onDraft={setDraft} onDraftSaved={dropDraft} /> : null}
          {route.page === 'notes' ? <NotesPage key={`notes-${pageKey}`} /> : null}
          {route.page === 'staff' ? <StaffPage key={`staff-${pageKey}`} /> : null}
          {route.page === 'ops' ? <OpsPage key={`ops-${pageKey}`} /> : null}
        </main>
      </div>
      {palette ? <Palette onClose={() => setPalette(false)} /> : null}
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
