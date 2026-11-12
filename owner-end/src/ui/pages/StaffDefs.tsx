/**
 * 员工定义：每个职能下由哪些 CLI / 模型 / 思考强度的员工干活、最多同时几人在岗、派工权重。
 * 启动命令只能从下拉里选（CLI、模型、思考强度），页面按执行端同一份参数构造（native-args.ts）预览实际命令，不接受自由文本。
 */
import { useState } from 'preact/hooks';
import { launchPreview } from '../../../../src/runner/native-args.ts';
import { parseWorkHours, workHoursText, type WorkHours } from '../../../../src/work-hours.ts';
import { Dialog, Field, NoticeLine, useAction } from '../common.tsx';

/** def.list 返回的一条（见 src/workforce.ts EmployeeDef）。 */
export interface DefRow {
  id: string;
  role: string;
  provider: string;
  model: string;
  thinking?: string;
  tracks?: string[];
  enabled: boolean;
  maxInstances: number;
  priority: number;
  weight: number;
  quotaLimited?: boolean;
  errorStreak: number;
  disabledReason?: string;
  workHours?: WorkHours;
}

const PROVIDERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'claude', label: 'Claude Code（claude）' },
  { value: 'factory-droid', label: 'Factory Droid（droid）' },
  { value: 'codex', label: 'Codex（codex）' },
  { value: 'antigravity', label: 'Antigravity（经 Paseo）' },
];

const CLAUDE_MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
/** 每种 CLI 的常用模型；`auto:<族>` 在派工时按执行端同步的型号表解析成具体型号。 */
const MODELS: Record<string, string[]> = {
  claude: CLAUDE_MODELS,
  'factory-droid': CLAUDE_MODELS,
  codex: ['auto:sol', 'auto:astra', 'auto:luna', 'auto:terra'],
  antigravity: ['gemini-3.8-flash-medium'],
};

const EFFORTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '不指定（CLI 默认）' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

const DEF_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

const DAYS: ReadonlyArray<[number, string]> = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];
/** 半小时一档。 */
const TIMES: string[] = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

const withCurrent = (options: readonly string[], current: string) => current && !options.includes(current) ? [current, ...options] : [...options];

/** 一行可读的启动方式：原生启动给出命令行，经 Paseo 的说明没有命令行。 */
export function launchText(def: Pick<DefRow, 'provider' | 'model' | 'thinking'>): string {
  const preview = launchPreview(def);
  return preview.via === 'native' ? preview.argv.join(' ') : `经 Paseo 启动 ${def.provider}，模型 ${def.model}`;
}

/** 职能卡片里的员工定义列表：状态、启动方式，以及编辑、启用/停用、新增。 */
export function DefList({ role, defs, allDefs, onChanged }: { role: string; defs: DefRow[]; allDefs: DefRow[]; onChanged(): void }) {
  const [editing, setEditing] = useState<DefRow | 'new'>();
  const { busy, notice, run } = useAction();
  return (
    <section class="def-list">
      <h4>员工定义</h4>
      {defs.length === 0 ? <p class="hint">这个职能还没有员工定义，派不出员工。</p> : (
        <ul class="list compact">
          {defs.map(def => (
            <li key={def.id} class="row">
              <div class="row-main">
                <strong>{def.id}</strong>
                <span class={def.enabled ? 'badge tone-done' : 'badge tone-blocked'}>{def.enabled ? '启用' : '停用'}</span>
                <span class="hint">最多 {def.maxInstances} 人 · 权重 {def.weight} · {workHoursText(def.workHours)}</span>
              </div>
              {!def.enabled && def.disabledReason ? <p class="hint">停用原因：{def.disabledReason}</p> : null}
              <code class="launch" title="新开会话时的启动命令">{launchText(def)}</code>
              <div class="button-row">
                <button type="button" disabled={busy} onClick={() => setEditing(def)}>编辑</button>
                {def.enabled
                  ? <button type="button" disabled={busy} onClick={() => void run('def.disable', { id: def.id, reason: '老板停用' }, `已停用 ${def.id}`, onChanged)}>停用</button>
                  : <button type="button" disabled={busy} onClick={() => void run('def.enable', { id: def.id }, `已启用 ${def.id}`, onChanged)}>启用</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <NoticeLine notice={notice} />
      <div class="button-row">
        <button type="button" disabled={busy} onClick={() => setEditing('new')}>新增员工定义</button>
      </div>
      {editing ? (
        <DefEditor role={role} def={editing === 'new' ? undefined : editing} allDefs={allDefs}
          onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); onChanged(); }} />
      ) : null}
    </section>
  );
}

function DefEditor({ role, def, allDefs, onClose, onSaved }: {
  role: string; def?: DefRow; allDefs: DefRow[]; onClose(): void; onSaved(): void;
}) {
  const [id, setId] = useState(def?.id ?? '');
  const [provider, setProvider] = useState(def?.provider ?? 'claude');
  const [model, setModel] = useState(def?.model ?? MODELS.claude![2]!);
  const [thinking, setThinking] = useState(def?.thinking ?? '');
  const [maxInstances, setMaxInstances] = useState(def?.maxInstances ?? 1);
  const [weight, setWeight] = useState(String(def?.weight ?? 10));
  const [priority, setPriority] = useState(String(def?.priority ?? 100));
  const [unlimited, setUnlimited] = useState(def?.quotaLimited === false);
  const [allDay, setAllDay] = useState(!def?.workHours);
  const [days, setDays] = useState<number[]>(def?.workHours?.days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(def?.workHours?.start ?? '09:00');
  const [end, setEnd] = useState(def?.workHours?.end ?? '18:00');
  const [problem, setProblem] = useState('');
  const { busy, notice, run } = useAction();

  // 模型选项：该 CLI 的常用模型，加上其它定义里用过的同 CLI 模型；当前值始终在列。
  const used = allDefs.filter(d => d.provider === provider).map(d => d.model);
  const models = withCurrent([...new Set([...(MODELS[provider] ?? []), ...used])], model);
  const providers = withCurrent(PROVIDERS.map(p => p.value), provider);
  const efforts = withCurrent(EFFORTS.map(e => e.value), thinking);

  const changeProvider = (next: string) => {
    setProvider(next);
    const options = [...(MODELS[next] ?? []), ...allDefs.filter(d => d.provider === next).map(d => d.model)];
    if (!options.includes(model) && options[0]) setModel(options[0]);
  };

  const save = () => {
    const defId = def ? def.id : id.trim();
    if (!def) {
      if (!DEF_ID.test(defId)) return setProblem('编号只能用小写字母、数字和连字符，3 到 41 个字符');
      if (allDefs.some(d => d.id === defId)) return setProblem('这个编号已经有了');
    }
    const w = Number(weight), p = Number(priority);
    if (!Number.isInteger(w) || w < 0 || w > 1000) return setProblem('派工权重是 0 到 1000 的整数');
    if (!Number.isInteger(p)) return setProblem('优先级是整数');
    const workHours = allDay ? null : parseWorkHours({ days, start, end });
    if (workHours === undefined) return setProblem(days.length ? '开始和结束不能是同一时间' : '至少选一天');
    setProblem('');
    void run('def.ensure', {
      id: defId, role, provider, model, thinking: thinking || null,
      maxInstances, weight: w, priority: p, enabled: def?.enabled ?? true, quotaLimited: !unlimited, workHours,
    }, def ? `已保存 ${defId}` : `已新增 ${defId}`, onSaved);
  };

  return (
    <Dialog title={def ? `编辑员工定义 ${def.id}` : '新增员工定义'} onClose={onClose} wide footer={(
      <div class="button-row end">
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" class="primary" disabled={busy} onClick={save}>保存</button>
      </div>
    )}>
      <div class="form">
        {def ? null : (
          <Field label="编号" hint={`建议用「职能-CLI」，如 ${role}-${provider}`} required>
            <input value={id} disabled={busy} data-autofocus placeholder={`${role}-${provider}`} onInput={e => setId(e.currentTarget.value)} />
          </Field>
        )}
        <div class="grid-2">
          <Field label="CLI">
            <select value={provider} disabled={busy} onChange={e => changeProvider(e.currentTarget.value)}>
              {providers.map(v => <option key={v} value={v}>{PROVIDERS.find(p => p.value === v)?.label ?? v}</option>)}
            </select>
          </Field>
          <Field label="模型">
            <select value={model} disabled={busy} onChange={e => setModel(e.currentTarget.value)}>
              {models.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="思考强度">
            <select value={thinking} disabled={busy} onChange={e => setThinking(e.currentTarget.value)}>
              {efforts.map(v => <option key={v} value={v}>{EFFORTS.find(e => e.value === v)?.label ?? v}</option>)}
            </select>
          </Field>
          <Field label="同时在岗上限">
            <select value={String(maxInstances)} disabled={busy} onChange={e => setMaxInstances(Number(e.currentTarget.value))}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n === 0 ? '0（不派工）' : `${n} 人`}</option>)}
            </select>
          </Field>
          <Field label="派工权重" hint="同职能的定义按权重随机挑选；0 表示不主动派。">
            <input type="number" min={0} max={1000} step={1} value={weight} disabled={busy} onInput={e => setWeight(e.currentTarget.value)} />
          </Field>
          <Field label="优先级" hint="数字越小越先派。">
            <input type="number" step={1} value={priority} disabled={busy} onInput={e => setPriority(e.currentTarget.value)} />
          </Field>
        </div>
        <label class="inline"><input type="checkbox" checked={unlimited} disabled={busy} onChange={e => setUnlimited(e.currentTarget.checked)} /> 不受订阅额度限制（额度用完照样派工）</label>
        <div class="field">
          <span class="field-label"><span>工作时间</span></span>
          <label class="inline"><input type="checkbox" checked={allDay} disabled={busy} onChange={e => setAllDay(e.currentTarget.checked)} /> 全天可派工</label>
          {allDay ? null : (
            <div class="work-hours">
              <div class="day-picks" role="group" aria-label="工作日">
                {DAYS.map(([day, label]) => (
                  <label key={day} class={days.includes(day) ? 'day on' : 'day'}>
                    <input type="checkbox" checked={days.includes(day)} disabled={busy}
                      onChange={e => setDays(e.currentTarget.checked ? [...days, day].sort((a, b) => a - b) : days.filter(d => d !== day))} />
                    {label}
                  </label>
                ))}
              </div>
              <div class="time-range">
                <select aria-label="开始时间" value={start} disabled={busy} onChange={e => setStart(e.currentTarget.value)}>
                  {TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <span>至</span>
                <select aria-label="结束时间" value={end} disabled={busy} onChange={e => setEnd(e.currentTarget.value)}>
                  {TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
          )}
          <span class="field-hint">按执行端（你的 Mac）本地时间。时间外不派新活，正在跑的一轮照常跑完；结束早于开始表示跨到次日。</span>
        </div>
        {def?.tracks?.length ? <p class="hint">擅长方向：{def.tracks.join('、')}（保存不会改动）</p> : null}
        <div class="field">
          <span class="field-label"><span>启动命令</span></span>
          <code class="launch">{launchText({ provider, model, thinking })}</code>
          <span class="field-hint">新开会话时执行端经员工沙箱执行这条命令；续接会话时另加续接参数。</span>
        </div>
        {problem ? <p class="notice err">{problem}</p> : null}
        <NoticeLine notice={notice} />
      </div>
    </Dialog>
  );
}
