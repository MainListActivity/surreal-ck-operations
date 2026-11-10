import { useLiveRefresh } from '../realtime.ts';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { outcomeText, runCommand } from '../api.ts';
import { Empty, NoticeLine, PageHeader, Panel, roleText, useAction } from '../common.tsx';
import { splitLines } from '../model.ts';

export interface AgentPolicy {
  disabled: boolean;
  allow: string[] | null;
  deny: string[];
  lang: string | null;
}

export interface AgentRow {
  employee: string;
  name: string;
  role: string;
  idpUser?: string;
  policy: AgentPolicy;
}

interface GuardEntry {
  command: string;
  ownerOnly: boolean;
}

interface TargetLock {
  command: string;
  target: string;
}

interface LockedTargets {
  companyTenantId: string | null;
  companyHost: string;
  scripts: string[];
  d1Ids: string[];
}

// 旧版网关响应可能不含以下字段，读取时需兜底。
interface GuardList {
  protected: GuardEntry[];
  hardOwnerOnly: string[];
  ownerApiCommands: string[];
  targetLocks?: TargetLock[];
  lockedTargets?: LockedTargets;
  ownerOnlyForAgents?: string[];
}

export function StaffPage() {
  const [agents, setAgents] = useState<AgentRow[]>();
  const [agentError, setAgentError] = useState<string>();
  const [guard, setGuard] = useState<GuardList>();
  const [guardError, setGuardError] = useState<string>();

  const loadAgents = useCallback(async () => {
    const out = await runCommand<{ agents?: AgentRow[] }>('agent.list');
    if (out.kind === 'ok') {
      setAgents(out.result.agents ?? []);
      setAgentError(undefined);
    } else {
      setAgentError(outcomeText(out, ''));
    }
  }, []);

  const loadGuard = useCallback(async () => {
    const out = await runCommand<GuardList>('guard.list');
    if (out.kind === 'ok') {
      setGuard(out.result);
      setGuardError(undefined);
    } else {
      setGuardError(outcomeText(out, ''));
    }
  }, []);

  useLiveRefresh(['employee','agent_identity','agent_policy'], loadAgents);
  useLiveRefresh(['protected_command'], loadGuard);
  useEffect(() => {
    void loadAgents();
    void loadGuard();
  }, [loadAgents, loadGuard]);

  return (
    <div class="page">
      <PageHeader title="员工与权限" description="员工的命令范围、停用与译文语言，以及哪些命令需要老板确认。低频设置，修改会写入审计。" />
      <nav class="jump-bar" aria-label="页内导航"><a href="#staff" onClick={e => { e.preventDefault(); document.getElementById('staff-agents')?.scrollIntoView({ behavior: 'smooth' }); }}>员工策略</a><a href="#staff" onClick={e => { e.preventDefault(); document.getElementById('staff-guard')?.scrollIntoView({ behavior: 'smooth' }); }}>受保护命令</a><a href="#staff" onClick={e => { e.preventDefault(); document.getElementById('staff-locked')?.scrollIntoView({ behavior: 'smooth' }); }}>固定限制</a></nav>
      <Panel id="staff-agents" title="员工" hint="策略决定员工能调用哪些命令、是否停用、译文语言。语言留空表示不翻译。">
        {agentError ? <p class="notice err">员工列表读取失败：{agentError}</p> : null}
        {agents === undefined && !agentError ? <p class="hint">正在读取员工…</p> : null}
        {agents && agents.length === 0 ? <Empty>还没有员工</Empty> : null}
        {agents && agents.length > 0 ? (
          <div class="grid">
            {agents.map(a => <AgentCard key={a.employee} agent={a} onChanged={() => void loadAgents()} />)}
          </div>
        ) : null}
      </Panel>

      <Panel id="staff-guard" title="受保护命令" hint="受保护的命令需要老板确认后员工才能调用；仅老板的命令只有老板能调用。">
        {guardError ? <p class="notice err">保护列表读取失败：{guardError}</p> : null}
        {guard ? <GuardSection guard={guard} onChanged={() => void loadGuard()} /> : <p class="hint">正在读取…</p>}
      </Panel>

      {guard ? (
        <Panel id="staff-locked" title="只能老板调用的命令" hint="员工通过网关不能调用这些命令。这些命令写死在代码里，本页不能修改。">
          {guard.hardOwnerOnly.length === 0 ? <Empty>没有内置的仅老板命令</Empty> : (
            <ul class="chips">
              {guard.hardOwnerOnly.map(c => <li key={c} class="tag">{c}</li>)}
            </ul>
          )}
          <h4>按目标锁定（写死，不可改）</h4>
          {(guard.targetLocks ?? []).length === 0 ? <Empty>没有按目标的锁定</Empty> : (
            <ul class="list compact">
              {(guard.targetLocks ?? []).map(t => (
                <li key={`${t.command}|${t.target}`} class="row">
                  <div class="row-main">
                    <span class="tag">{t.command}</span>
                    <span>{t.target}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {guard.lockedTargets ? (
            <dl class="facts">
              <dt>公司租户 id</dt>
              <dd>{guard.lockedTargets.companyTenantId ?? '未配置'}</dd>
              <dt>公司域名</dt>
              <dd>{guard.lockedTargets.companyHost}</dd>
              <dt>受保护的 Worker 脚本</dt>
              <dd>{guard.lockedTargets.scripts.length ? guard.lockedTargets.scripts.join('、') : '无'}</dd>
              <dt>受保护的 D1 数据库 id</dt>
              <dd>{guard.lockedTargets.d1Ids.length ? guard.lockedTargets.d1Ids.join('、') : '无'}</dd>
            </dl>
          ) : null}
          <h4>员工拒绝清单（写死，不可改）</h4>
          <p class="hint">员工调用即拒绝并写审计，老板不受限。</p>
          {(guard.ownerOnlyForAgents ?? []).length === 0 ? <Empty>没有员工拒绝项</Empty> : (
            <ul class="chips">
              {(guard.ownerOnlyForAgents ?? []).map(c => <li key={c} class="tag">{c}</li>)}
            </ul>
          )}
          <details>
            <summary>老板接口命令（{guard.ownerApiCommands.length}）</summary>
            <ul class="chips">
              {guard.ownerApiCommands.map(c => <li key={c} class="tag">{c}</li>)}
            </ul>
          </details>
        </Panel>
      ) : null}
    </div>
  );
}

function AgentCard({ agent, onChanged }: { agent: AgentRow; onChanged(): void }) {
  const p = agent.policy;
  const [open, setOpen] = useState(false);
  const [disabled, setDisabled] = useState(p.disabled);
  const [unrestricted, setUnrestricted] = useState(p.allow === null);
  const [allow, setAllow] = useState((p.allow ?? []).join('\n'));
  const [deny, setDeny] = useState(p.deny.join('\n'));
  const [lang, setLang] = useState(p.lang ?? '');
  const { busy, notice, run } = useAction();

  const openEditor = () => {
    setDisabled(p.disabled);
    setUnrestricted(p.allow === null);
    setAllow((p.allow ?? []).join('\n'));
    setDeny(p.deny.join('\n'));
    setLang(p.lang ?? '');
    setOpen(o => !o);
  };

  const save = () => void run('agent.policy.set', {
    agent: agent.employee,
    disabled,
    allow: unrestricted ? null : splitLines(allow),
    deny: splitLines(deny),
    lang: lang.trim() || null,
  }, '已保存策略', () => {
    setOpen(false);
    onChanged();
  });

  const ensureIdentity = () => void run('agent.identity.ensure', { employee: agent.employee }, '已创建身份', () => onChanged());

  return (
    <article class="card">
      <header class="card-head">
        <span class="tag" title={agent.role}>{roleText(agent.role)}</span>
        <span class={p.disabled ? 'badge tone-blocked' : 'badge tone-done'}>{p.disabled ? '已停用' : '启用中'}</span>
      </header>
      <h3>{agent.name}</h3>
      <p class="hint">员工 {agent.employee}</p>
      <dl class="facts">
        <dt>允许清单</dt>
        <dd>{p.allow === null ? '不限制（null）' : p.allow.length ? p.allow.join('、') : '空列表'}</dd>
        <dt>拒绝清单</dt>
        <dd>{p.deny.length ? p.deny.join('、') : '无'}</dd>
        <dt>译文语言</dt>
        <dd>{p.lang ?? '不翻译'}</dd>
        <dt>ma_hono 身份</dt>
        <dd>{agent.idpUser ?? '未创建'}</dd>
      </dl>
      <div class="button-row">
        <button type="button" onClick={openEditor}>{open ? '收起策略' : '编辑策略'}</button>
        {agent.idpUser ? null : (
          <button type="button" disabled={busy} onClick={ensureIdentity}>创建 ma_hono 身份</button>
        )}
      </div>
      {open ? (
        <div class="form">
          <label class="inline"><input type="checkbox" checked={disabled} disabled={busy} onChange={e => setDisabled(e.currentTarget.checked)} /> 停用这位员工</label>
          <label class="inline"><input type="checkbox" checked={unrestricted} disabled={busy} onChange={e => setUnrestricted(e.currentTarget.checked)} /> 允许清单不限制（保存为 null）</label>
          {unrestricted ? null : (
            <label class="field">
              <span>允许清单（每行一个命令；保存为列表）</span>
              <textarea rows={3} value={allow} disabled={busy} onInput={e => setAllow(e.currentTarget.value)} />
            </label>
          )}
          <label class="field">
            <span>拒绝清单（每行一个命令）</span>
            <textarea rows={3} value={deny} disabled={busy} onInput={e => setDeny(e.currentTarget.value)} />
          </label>
          <label class="field">
            <span>译文语言（留空表示不翻译）</span>
            <input value={lang} disabled={busy} onInput={e => setLang(e.currentTarget.value)} />
          </label>
          <NoticeLine notice={notice} />
          <div class="button-row">
            <button type="button" class="primary" disabled={busy} onClick={save}>保存策略</button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
          </div>
        </div>
      ) : (
        <NoticeLine notice={notice} />
      )}
    </article>
  );
}

function GuardSection({ guard, onChanged }: { guard: GuardList; onChanged(): void }) {
  const [command, setCommand] = useState('');
  const [ownerOnly, setOwnerOnly] = useState(false);
  const [problem, setProblem] = useState('');
  const { busy, notice, run } = useAction();

  const protect = (cmd: string, only: boolean, okText: string) => void run('guard.protect', { command: cmd, ownerOnly: only }, okText, () => onChanged());

  return (
    <>
      {guard.protected.length === 0 ? <Empty>还没有受保护的命令</Empty> : (
        <ul class="list compact">
          {guard.protected.map(g => (
            <li key={g.command} class="row">
              <div class="row-main">
                <code>{g.command}</code>
                <span class="tag">{g.ownerOnly ? '仅老板' : '需确认'}</span>
              </div>
              <div class="button-row">
                <button type="button" disabled={busy} onClick={() => protect(g.command, !g.ownerOnly, g.ownerOnly ? '已改为需确认' : '已改为仅老板')}>
                  {g.ownerOnly ? '改为需确认' : '改为仅老板'}
                </button>
                <button type="button" class="danger" disabled={busy} onClick={() => void run('guard.unprotect', { command: g.command }, '已取消保护', () => onChanged())}>
                  取消保护
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div class="form">
        <label class="field">
          <span>命令名</span>
          <input value={command} disabled={busy} onInput={e => setCommand(e.currentTarget.value)} />
        </label>
        <label class="inline"><input type="checkbox" checked={ownerOnly} disabled={busy} onChange={e => setOwnerOnly(e.currentTarget.checked)} /> 仅老板可调用</label>
        {problem ? <p class="notice err">{problem}</p> : null}
        <NoticeLine notice={notice} />
        <div class="button-row">
          <button
            type="button"
            class="primary"
            disabled={busy}
            onClick={() => {
              if (!command.trim()) {
                setProblem('请填写命令名');
                return;
              }
              setProblem('');
              protect(command.trim(), ownerOnly, '已加入保护');
            }}
          >
            加入保护
          </button>
        </div>
      </div>
    </>
  );
}
