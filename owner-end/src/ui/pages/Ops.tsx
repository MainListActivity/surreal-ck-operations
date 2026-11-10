import { useCallback, useEffect, useState } from 'preact/hooks';
import { COMMAND_CATALOG } from '../../command-catalog.ts';
import { outcomeText, runCommand } from '../api.ts';
import { Empty, NoticeLine, PageHeader, Panel, Pre, timeText, useAction } from '../common.tsx';
import { catalogGroups, catalogTags, parseJsonObject } from '../model.ts';

interface JobRow {
  id: string;
  command: string;
  state: string;
  actorKind?: string;
  actor?: string;
  createdAt?: unknown;
  finishedAt?: unknown;
  error?: unknown;
}

interface AuditRow {
  at?: unknown;
  actorKind?: string;
  actor?: string;
  task?: string;
  command?: string;
  outcome?: string;
  reason?: string;
  summary?: string;
}

interface IdpStatus {
  configured?: Record<string, boolean>;
  tenantId?: string;
}

interface ClientSecret {
  clientId: string;
  clientSecret: string;
  note: string;
}

const OPS_SECTIONS = [['ops-commands', '命令目录'], ['ops-jobs', '执行端作业'], ['ops-audit', '审计'], ['ops-read', '只读查询'], ['ops-idp', '身份服务'], ['ops-cf', 'Cloudflare'], ['ops-write', '直接写库']] as const;

const CLIENT_ROLES = ['gateway', 'viewer', 'automation', 'runner', 'migrator', 'agentClaims'] as const;

export function OpsPage() {
  return (
    <div class="page">
      <PageHeader title="运维" description="面向排障与维护的低频工具：命令目录、执行端作业、审计、只读查询、身份服务与 Cloudflare。直接写库默认折叠，执行前二次确认。" />
      <nav class="jump-bar" aria-label="页内导航">
        {OPS_SECTIONS.map(([id, label]) => (
          <a key={id} href="#ops" onClick={e => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }}>{label}</a>
        ))}
      </nav>
      <CommandPanel />
      <JobsPanel />
      <AuditPanel />
      <ReadSqlPanel />
      <IdpPanel />
      <CfApiPanel />
      <DbWritePanel />
    </div>
  );
}

// ---- 命令面板：网关全部命令的用途与参数，只展示不执行 ----

function CommandPanel() {
  const [query, setQuery] = useState('');
  const groups = catalogGroups(COMMAND_CATALOG, query);
  return (
    <Panel id="ops-commands" title="命令面板" hint="网关的全部命令与参数。这里只展示，不执行。员工经 company_cmd 调用的也是这些命令，高危命令应先确认保护清单。">
      <label class="field">
        <span>搜索（命令名、用途或分组）</span>
        <input value={query} onInput={e => setQuery(e.currentTarget.value)} />
      </label>
      {groups.length === 0 ? <Empty>没有匹配的命令</Empty> : null}
      {groups.map(view => (
        <details key={view.group} open={query.trim() !== ''}>
          <summary>{view.group}（{view.commands.length}）</summary>
          <ul class="list compact">
            {view.commands.map(spec => (
              <li key={spec.command} class="row">
                <div class="row-main">
                  <code>{spec.command}</code>
                  <span>{spec.title}</span>
                  {catalogTags(spec).map(tag => <span key={tag} class={tag === '高危' ? 'tag danger' : 'tag'}>{tag}</span>)}
                </div>
                <div class="hint">参数：{spec.params}</div>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </Panel>
  );
}

// ---- 执行端任务队列 ----

function JobsPanel() {
  const [filter, setFilter] = useState('');
  const [jobs, setJobs] = useState<JobRow[]>();
  const [error, setError] = useState<string>();
  const [job, setJob] = useState<JobRow>();
  const [jobError, setJobError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (state: string) => {
    setLoading(true);
    const out = await runCommand<{ jobs?: JobRow[] }>('ops.job.list', { ...(state.trim() ? { state: state.trim() } : {}), limit: 50 });
    setLoading(false);
    if (out.kind === 'ok') {
      setJobs(out.result.jobs ?? []);
      setError(undefined);
    } else {
      setError(outcomeText(out, ''));
    }
  }, []);

  const open = async (id: string) => {
    setJobError(undefined);
    const out = await runCommand<{ job?: JobRow }>('ops.job.get', { id });
    if (out.kind === 'ok' && out.result.job) setJob(out.result.job);
    else setJobError(out.kind === 'ok' ? '没有找到这个任务' : outcomeText(out, ''));
  };

  useEffect(() => {
    void load('');
  }, [load]);

  return (
    <Panel id="ops-jobs" title="执行端任务队列" hint="执行端提交的老板命令在这里排队与完成情况。">
      <div class="button-row">
        <label class="inline">
          <span>状态过滤（留空为全部）</span>
          <input value={filter} onInput={e => setFilter(e.currentTarget.value)} />
        </label>
        <button type="button" disabled={loading} onClick={() => void load(filter)}>查询</button>
      </div>
      {error ? <p class="notice err">读取失败：{error}</p> : null}
      {jobs && jobs.length === 0 ? <Empty>没有匹配的任务</Empty> : null}
      {jobs && jobs.length > 0 ? (
        <ul class="list compact">
          {jobs.map(j => (
            <li key={j.id} class="row">
              <div class="row-main">
                <code>{j.command}</code>
                <span class={`badge tone-${j.state === 'done' ? 'done' : j.state === 'error' ? 'blocked' : j.state === 'running' ? 'progress' : 'neutral'}`}>{j.state}</span>
                <span class="hint">{j.actorKind ?? ''} {j.actor ?? ''} · {timeText(j.createdAt)}</span>
              </div>
              {j.error ? <div class="notice err">{String(j.error)}</div> : null}
              <div class="button-row">
                <button type="button" onClick={() => void open(j.id)}>查看</button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {jobError ? <p class="notice err">{jobError}</p> : null}
      {job ? (
        <details open>
          <summary>任务 {job.id}（{job.state}）</summary>
          <Pre value={job} />
        </details>
      ) : null}
    </Panel>
  );
}

// ---- 审计 ----

function AuditPanel() {
  const [rows, setRows] = useState<AuditRow[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const out = await runCommand<{ audit?: AuditRow[] }>('audit.list', { limit: 50 });
    setLoading(false);
    if (out.kind === 'ok') {
      setRows(out.result.audit ?? []);
      setError(undefined);
    } else {
      setError(outcomeText(out, ''));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel id="ops-audit" title="审计" hint="最近的操作记录，摘要由服务端生成。" actions={<button type="button" disabled={loading} onClick={() => void load()}>刷新</button>}>
      {error ? <p class="notice err">审计读取失败：{error}</p> : null}
      {rows && rows.length === 0 ? <Empty>还没有审计记录</Empty> : null}
      {rows && rows.length > 0 ? (
        <ul class="list compact">
          {rows.map((r, index) => (
            <li key={index} class="row">
              <div class="row-main">
                <span class="hint">{timeText(r.at)}</span>
                <span>{r.actorKind ?? ''} {r.actor ?? ''}</span>
                <code>{r.command ?? ''}</code>
                <span class={r.outcome === 'ok' || r.outcome === 'success' ? 'badge tone-done' : 'badge tone-blocked'}>{r.outcome ?? ''}</span>
              </div>
              {r.summary ? <div>{r.summary}</div> : null}
              {r.reason ? <div class="hint">原因：{r.reason}</div> : null}
              {r.task ? <div class="hint">任务：{r.task}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

// ---- 只读 SQL ----

function ReadSqlPanel() {
  const [sql, setSql] = useState('');
  const [vars, setVars] = useState('');
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<unknown>();
  const { busy, notice, run } = useAction();

  const execute = () => {
    const parsed = parseJsonObject(vars);
    if (!parsed.ok) {
      setProblem(parsed.error);
      return;
    }
    if (!sql.trim()) {
      setProblem('请填写 SQL');
      return;
    }
    setProblem('');
    void run('db.read', { sql, ...(parsed.value ? { vars: parsed.value } : {}) }, '查询完成', r => setResult(r));
  };

  return (
    <Panel id="ops-read" title="只读查询" hint="只允许读取。结果原样显示，请不要粘贴敏感数据。">
      <div class="form">
        <label class="field">
          <span>SQL</span>
          <textarea rows={4} value={sql} disabled={busy} onInput={e => setSql(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>参数（JSON 对象，可空）</span>
          <textarea rows={2} value={vars} disabled={busy} onInput={e => setVars(e.currentTarget.value)} />
        </label>
        {problem ? <p class="notice err">{problem}</p> : null}
        <NoticeLine notice={notice} />
        <div class="button-row">
          <button type="button" class="primary" disabled={busy} onClick={execute}>执行查询</button>
        </div>
      </div>
      {result !== undefined ? <Pre value={result} /> : null}
    </Panel>
  );
}

// ---- idp 与一次性密钥 ----

function IdpPanel() {
  const [status, setStatus] = useState<IdpStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [role, setRole] = useState<(typeof CLIENT_ROLES)[number]>('gateway');
  const [clientName, setClientName] = useState('');
  const [resetId, setResetId] = useState('');
  const [secret, setSecret] = useState<ClientSecret>();
  const { busy, notice, run } = useAction();

  const loadStatus = useCallback(async () => {
    const out = await runCommand<IdpStatus>('idp.status');
    if (out.kind === 'ok') {
      setStatus(out.result);
      setStatusError(undefined);
    } else {
      setStatusError(outcomeText(out, ''));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  /**
   * 一次性密钥只放在组件状态里：关闭或刷新页面即消失，不写入任何浏览器存储。
   * 没有返回密钥（客户端已存在）时清掉旧显示，避免把上一个密钥留在屏幕上。
   */
  const showSecret = (clientId: string, clientSecretValue: string | undefined) => {
    setSecret(clientSecretValue ? {
      clientId,
      clientSecret: clientSecretValue,
      note: '只显示一次，请立即保存到 wrangler secret。关闭或刷新页面后不再显示，页面不会保存它。',
    } : undefined);
  };

  return (
    <Panel id="ops-idp" title="身份服务（idp）" hint="ma_hono 租户与各类客户端的状态。" actions={<button type="button" onClick={() => void loadStatus()}>刷新</button>}>
      {statusError ? <p class="notice err">读取失败：{statusError}</p> : null}
      {status ? (
        <dl class="facts">
          <dt>租户</dt>
          <dd>{status.tenantId ?? '未设置'}</dd>
          {Object.entries(status.configured ?? {}).map(([key, ok]) => (
            <div key={key} class="fact-row">
              <dt>{key}</dt>
              <dd class={ok ? 'ok-text' : 'warn-text'}>{ok ? '已配置' : '未配置'}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div class="form">
        <h4>客户端密钥</h4>
        <div class="grid-2">
          <label class="field">
            <span>客户端角色</span>
            <select value={role} disabled={busy} onChange={e => setRole(e.currentTarget.value as (typeof CLIENT_ROLES)[number])}>
              {CLIENT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label class="field">
            <span>客户端名称（可空）</span>
            <input value={clientName} disabled={busy} onInput={e => setClientName(e.currentTarget.value)} />
          </label>
        </div>
        <div class="button-row">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run('idp.client.ensure', { role, ...(clientName.trim() ? { clientName: clientName.trim() } : {}) }, '已取得客户端', (r: { clientId: string; clientSecret?: string; created?: boolean }) => {
              showSecret(r.clientId, r.clientSecret);
              void loadStatus();
            })}
          >
            创建或取得客户端
          </button>
        </div>
        <label class="field">
          <span>客户端 ID（重置密钥用）</span>
          <input value={resetId} disabled={busy} onInput={e => setResetId(e.currentTarget.value)} />
        </label>
        <div class="button-row">
          <button
            type="button"
            class="danger"
            disabled={busy || !resetId.trim()}
            onClick={() => void run('idp.client.reset', { clientId: resetId.trim() }, '已重置密钥', (r: { clientId: string; clientSecret?: string }) => {
              showSecret(r.clientId, r.clientSecret);
              void loadStatus();
            })}
          >
            重置密钥
          </button>
        </div>
        <NoticeLine notice={notice} />
        {secret ? (
          <div class="secret-box" role="alert">
            <p><strong>客户端 {secret.clientId}</strong></p>
            <p class="warn-text">{secret.note}</p>
            <code class="secret">{secret.clientSecret}</code>
            <div class="button-row">
              <button type="button" onClick={() => setSecret(undefined)}>我已保存，清除显示</button>
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

// ---- cf.api 只读 ----

function CfApiPanel() {
  const [path, setPath] = useState('/');
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<unknown>();
  const { busy, notice, run } = useAction();

  const execute = () => {
    if (!path.startsWith('/')) {
      setProblem('路径要以 / 开头');
      return;
    }
    setProblem('');
    void run('cf.api', { method: 'GET', path }, '已读取', r => setResult(r));
  };

  return (
    <Panel id="ops-cf" title="Cloudflare 只读接口" hint="只发起 GET 请求。">
      <div class="form">
        <label class="field">
          <span>路径（以 / 开头）</span>
          <input value={path} disabled={busy} onInput={e => setPath(e.currentTarget.value)} />
        </label>
        {problem ? <p class="notice err">{problem}</p> : null}
        <NoticeLine notice={notice} />
        <div class="button-row">
          <button type="button" class="primary" disabled={busy} onClick={execute}>GET 读取</button>
        </div>
      </div>
      {result !== undefined ? <Pre value={result} /> : null}
    </Panel>
  );
}

// ---- db.write：默认折叠，执行前显示 SQL 并二次确认 ----

function DbWritePanel() {
  const [sql, setSql] = useState('');
  const [vars, setVars] = useState('');
  const [pending, setPending] = useState<{ sql: string; vars?: Record<string, unknown> }>();
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<unknown>();
  const { busy, notice, run } = useAction();

  const prepare = () => {
    const parsed = parseJsonObject(vars);
    if (!parsed.ok) {
      setProblem(parsed.error);
      return;
    }
    if (!sql.trim()) {
      setProblem('请填写 SQL');
      return;
    }
    setProblem('');
    setPending({ sql, vars: parsed.value });
  };

  const confirm = () => {
    if (!pending) return;
    void run('db.write', { sql: pending.sql, ...(pending.vars ? { vars: pending.vars } : {}) }, '写入已执行', r => {
      setResult(r);
      setPending(undefined);
    });
  };

  return (
    <details id="ops-write" class="danger-zone bottom">
      <summary>高危：直接写数据库（db.write）</summary>
      <div class="form">
        <p class="warn-text">这里的 SQL 会直接修改生产数据，没有撤销。执行前会再次显示 SQL 并要求确认。</p>
        <label class="field">
          <span>SQL</span>
          <textarea rows={4} value={sql} disabled={busy} onInput={e => setSql(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>参数（JSON 对象，可空）</span>
          <textarea rows={2} value={vars} disabled={busy} onInput={e => setVars(e.currentTarget.value)} />
        </label>
        {problem ? <p class="notice err">{problem}</p> : null}
        {pending ? (
          <div class="confirm-box">
            <p><strong>即将执行以下 SQL：</strong></p>
            <Pre value={pending.sql} />
            {pending.vars ? <Pre value={pending.vars} /> : null}
            <div class="button-row">
              <button type="button" class="danger" disabled={busy} onClick={confirm}>确认执行写入</button>
              <button type="button" disabled={busy} onClick={() => setPending(undefined)}>取消</button>
            </div>
          </div>
        ) : (
          <div class="button-row">
            <button type="button" class="danger" disabled={busy} onClick={prepare}>准备执行…</button>
          </div>
        )}
        <NoticeLine notice={notice} />
        {result !== undefined ? <Pre value={result} /> : null}
      </div>
    </details>
  );
}
