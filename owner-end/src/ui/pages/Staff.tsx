import { useLiveRefresh } from '../realtime.ts';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { outcomeText, runCommand } from '../api.ts';
import { Empty, NoticeLine, PageHeader, Panel, roleText, useAction } from '../common.tsx';
import { LANG_OPTIONS, langLabel } from '../lang.ts';
import { CommandPicker, CommandSelect } from '../CommandPicker.tsx';
import { DefList, ProviderPreference, type DefRow } from './StaffDefs.tsx';

export interface RolePolicy {
  disabled: boolean;
  allow: string[] | null;
  deny: string[];
  lang: string | null;
}

/** 一个职能：它的员工定义、当前在岗的实例与职能策略。策略对该职能的所有员工（含以后新开的实例）生效。 */
export interface RoleRow {
  role: string;
  defs: Array<{ id: string; enabled: boolean; model?: string }>;
  onDuty: Array<{ employee: string; def: string }>;
  policy: RolePolicy;
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
  const [roles, setRoles] = useState<RoleRow[]>();
  const [roleError, setRoleError] = useState<string>();
  const [defs, setDefs] = useState<DefRow[]>([]);
  const [guard, setGuard] = useState<GuardList>();
  const [guardError, setGuardError] = useState<string>();

  const loadRoles = useCallback(async () => {
    const [out, defOut] = await Promise.all([
      runCommand<{ roles?: RoleRow[] }>('agent.list'),
      runCommand<{ defs?: DefRow[] }>('def.list'),
    ]);
    if (out.kind === 'ok') {
      setRoles(out.result.roles ?? []);
      setRoleError(undefined);
    } else {
      setRoleError(outcomeText(out, ''));
    }
    if (defOut.kind === 'ok') setDefs(defOut.result.defs ?? []);
    else setRoleError(`员工定义读取失败：${outcomeText(defOut, '')}`);
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

  useLiveRefresh(['employee', 'agent_policy'], loadRoles);
  useLiveRefresh(['protected_command'], loadGuard);
  useEffect(() => {
    void loadRoles();
    void loadGuard();
  }, [loadRoles, loadGuard]);

  return (
    <div class="page">
      <PageHeader title="员工与权限" description="按职能设置命令范围与译文语言，对该职能的所有员工生效；修改会写入审计。" />
      <nav class="jump-bar" aria-label="页内导航"><a href="#staff" onClick={e => { e.preventDefault(); document.getElementById('staff-agents')?.scrollIntoView({ behavior: 'smooth' }); }}>职能策略</a><a href="#staff" onClick={e => { e.preventDefault(); document.getElementById('staff-guard')?.scrollIntoView({ behavior: 'smooth' }); }}>受保护命令</a><a href="#staff" onClick={e => { e.preventDefault(); document.getElementById('staff-locked')?.scrollIntoView({ behavior: 'smooth' }); }}>固定限制</a></nav>
      <OwnerLangPanel />

      <Panel id="staff-agents" title="职能" hint="每轮会话都会新开员工实例，所以策略按职能保存：停用、允许/拒绝清单与译文语言对这个职能的所有员工生效。员工定义决定这个职能由哪些 CLI 与模型来干活。">
        {roleError ? <p class="notice err">职能列表读取失败：{roleError}</p> : null}
        <ProviderPreference defs={defs} />
        {roles === undefined && !roleError ? <p class="hint">正在读取职能…</p> : null}
        {roles && roles.length === 0 ? <Empty>还没有员工定义</Empty> : null}
        {roles && roles.length > 0 ? (
          <div class="grid">
            {roles.map(r => <RoleCard key={r.role} row={r} defs={defs.filter(d => d.role === r.role)} allDefs={defs} onChanged={() => void loadRoles()} />)}
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

function RoleCard({ row, defs, allDefs, onChanged }: { row: RoleRow; defs: DefRow[]; allDefs: DefRow[]; onChanged(): void }) {
  const p = row.policy;
  const [open, setOpen] = useState(false);
  const [disabled, setDisabled] = useState(p.disabled);
  const [unrestricted, setUnrestricted] = useState(p.allow === null);
  const [allow, setAllow] = useState<string[]>(p.allow ?? []);
  const [deny, setDeny] = useState<string[]>(p.deny);
  const [lang, setLang] = useState(p.lang ?? '');
  const { busy, notice, run } = useAction();

  const openEditor = () => {
    setDisabled(p.disabled);
    setUnrestricted(p.allow === null);
    setAllow(p.allow ?? []);
    setDeny(p.deny);
    setLang(p.lang ?? '');
    setOpen(o => !o);
  };

  const save = () => void run('agent.policy.set', {
    role: row.role,
    disabled,
    allow: unrestricted ? null : allow,
    deny,
    lang: lang || null,
  }, '已保存策略', () => {
    setOpen(false);
    onChanged();
  });

  const enabledDefs = defs.filter(d => d.enabled);
  const langOptions = lang && !LANG_OPTIONS.some(o => o.value === lang) ? [{ value: lang, label: lang }, ...LANG_OPTIONS] : LANG_OPTIONS;
  return (
    <article class="card">
      <header class="card-head">
        <h3 title={row.role}>{roleText(row.role)}</h3>
        <span class={p.disabled ? 'badge tone-blocked' : 'badge tone-done'}>{p.disabled ? '已停用' : '启用中'}</span>
      </header>
      <p class="hint">
        <span class={row.onDuty.length ? 'dot is-running' : 'dot'} /> {row.onDuty.length ? `${row.onDuty.length} 人在岗` : '空闲'}
        {' · '}{enabledDefs.length} 个员工定义启用{defs.length > enabledDefs.length ? `（另有 ${defs.length - enabledDefs.length} 个已停用）` : ''}
      </p>
      <dl class="facts">
        {row.onDuty.length ? (<><dt>在岗实例</dt><dd>{row.onDuty.map(m => m.employee).join('、')}</dd></>) : null}
        <dt>允许清单</dt>
        <dd>{p.allow === null ? '不限制' : p.allow.length ? p.allow.join('、') : '空（什么都不能调用）'}</dd>
        <dt>拒绝清单</dt>
        <dd>{p.deny.length ? p.deny.join('、') : '无'}</dd>
        <dt>译文语言</dt>
        <dd>{langLabel(p.lang)}</dd>
      </dl>
      <div class="button-row">
        <button type="button" onClick={openEditor}>{open ? '收起策略' : '编辑策略'}</button>
      </div>
      {open ? (
        <div class="form">
          <label class="inline"><input type="checkbox" checked={disabled} disabled={busy} onChange={e => setDisabled(e.currentTarget.checked)} /> 停用这个职能的所有员工</label>
          <label class="inline"><input type="checkbox" checked={unrestricted} disabled={busy} onChange={e => setUnrestricted(e.currentTarget.checked)} /> 允许清单不限制（可以调用除拒绝清单外的全部命令）</label>
          {unrestricted ? null : (
            <div class="field">
              <span class="field-label"><span>允许清单</span></span>
              <CommandPicker label="添加允许的命令" value={allow} disabled={busy} onChange={setAllow} />
              <span class="field-hint">{allow.length ? '只能调用清单里的命令。' : '清单为空：这个职能什么命令都不能调用。'}</span>
            </div>
          )}
          <div class="field">
            <span class="field-label"><span>拒绝清单</span></span>
            <CommandPicker label="添加拒绝的命令" value={deny} disabled={busy} onChange={setDeny} />
          </div>
          <label class="field">
            <span class="field-label"><span>译文语言</span></span>
            <select value={lang} disabled={busy} onChange={e => setLang(e.currentTarget.value)}>
              {langOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <span class="field-hint">派给这个职能的消息先译成这种语言再发；他们的提交、退回与受阻说明译回你的常用语言。与你的常用语言相同则不翻译。</span>
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
      <DefList role={row.role} defs={defs} allDefs={allDefs} onChanged={onChanged} />
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
          <span>命令</span>
          <CommandSelect label="要保护的命令" value={command} disabled={busy} onChange={setCommand} exclude={guard.protected.map(g => g.command)} />
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
                setProblem('请选择命令');
                return;
              }
              setProblem('');
              protect(command.trim(), ownerOnly, '已加入保护');
              setCommand('');
            }}
          >
            加入保护
          </button>
        </div>
      </div>
    </>
  );
}

const OWNER_LANG_OPTIONS = [{ value: 'zh', label: '中文 zh' }, ...LANG_OPTIONS.filter(o => o.value)];

/** 老板常用语言：员工的提交、退回、受阻说明译成这种语言；职能语言与之相同的消息不翻译。 */
function OwnerLangPanel() {
  const [saved, setSaved] = useState<string>();
  const [lang, setLang] = useState('zh');
  const { busy, notice, run } = useAction();
  useEffect(() => {
    void runCommand<{ lang: string }>('owner.settings.get').then(out => {
      if (out.kind === 'ok') { setSaved(out.result.lang); setLang(out.result.lang); }
    });
  }, []);
  const options = OWNER_LANG_OPTIONS.some(o => o.value === lang) ? OWNER_LANG_OPTIONS : [{ value: lang, label: lang }, ...OWNER_LANG_OPTIONS];
  return (
    <Panel id="staff-owner-lang" title="你的常用语言" hint="设了译文语言的职能：派给他们的消息从这种语言译过去，他们的提交、退回与受阻说明译回这种语言（原文随时可看）。">
      <div class="inline-field">
        <select aria-label="老板常用语言" value={lang} disabled={busy || saved === undefined} onChange={e => setLang(e.currentTarget.value)}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="button" class="primary" disabled={busy || saved === undefined || lang === saved}
          onClick={() => void run('owner.settings.set', { lang }, '已保存常用语言', () => setSaved(lang))}>保存</button>
      </div>
      <NoticeLine notice={notice} />
    </Panel>
  );
}
