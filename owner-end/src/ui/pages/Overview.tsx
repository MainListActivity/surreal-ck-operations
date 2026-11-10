import { WorkContextFiles } from "../WorkContext.tsx";
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { RuntimeDashboard, RuntimeAgentView } from '../../../../src/runtime-dashboard.ts';
import { readDashboard, outcomeText } from '../api.ts';
import { useLiveRefresh, useLiveState } from '../realtime.ts';
import { expireObservations, remainingText, useObservationClock } from '../runtime-state.ts';
import { Badge, ErrorState, Loading, ProgressBar, roleText } from '../common.tsx';
import { hrefOf, clockText, durationText } from '../model.ts';

const states = {
  running: ['运行中', 'done'],
  waiting: ['等待输入', 'decide'],
  idle: ['空闲', 'neutral'],
  error: ['运行异常', 'blocked'],
  unknown: ['状态未知', 'neutral'],
} as const;
const platform = (s: string) => ({ darwin: 'macOS', linux: 'Linux', win32: 'Windows' })[s] ?? s;
function Glyph({ kind = 'host' }: { kind?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      aria-hidden="true"
    >
      {kind === 'host' ? (
        <>
          <rect x="3" y="3" width="18" height="7" rx="2" />
          <rect x="3" y="14" width="18" height="7" rx="2" />
          <path d="M6 6h2m3 0h7M6 17h2m3 0h7" />
        </>
      ) : kind === 'product' ? (
        <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" />
      ) : kind === 'qa' ? (
        <>
          <path d="M8 3h8m-6 0v7l-5 9q-1 2 2 2h10q3 0 2-2l-5-9V3M8 15h8" />
        </>
      ) : (
        <>
          <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" />
        </>
      )}
    </svg>
  );
}
function Meter({ label, value }: { label: string; value?: number }) {
  return (
    <div class="runtime-meter">
      <span>
        {label} <b>{value === undefined ? '未上报' : `${Math.round(value)}%`}</b>
      </span>
      <progress max="100" value={value ?? 0} aria-label={label} />
    </div>
  );
}
interface Line {
  id: string;
  d: string;
  x: number;
  y: number;
  label: string;
  active: boolean;
  planned: boolean;
  taskId: string;
}
function Connections({
  data,
  active,
  selected,
}: {
  data: RuntimeDashboard;
  active: Set<string>;
  selected?: string;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  useEffect(() => {
    const root = document.getElementById('runtime-map');
    if (!root) return;
    const calc = () => {
      const box = root.getBoundingClientRect();
      const cards = new Map(
        Array.from(root.querySelectorAll<HTMLElement>('[data-agent]')).map((el) => [
          el.dataset.agent!,
          el.getBoundingClientRect(),
        ]),
      );
      const all: Array<{
        id: string;
        from: string;
        to: string;
        label: string;
        taskId: string;
        planned: boolean;
      }> = data.transfers
        .filter((e) => active.has(e.id) || selected === e.taskId)
        .map((e) => ({ ...e, planned: false }));
      if (selected)
        for (const a of data.agents)
          if (a.taskId === selected && a.destination?.agentId)
            all.push({
              id: `planned-${a.id}`,
              from: a.id,
              to: a.destination.agentId,
              label: '预计下一站',
              taskId: selected,
              planned: true,
            });
      setLines(
        all.flatMap((e) => {
          const a = cards.get(e.from),
            b = cards.get(e.to);
          if (!a || !b) return [];
          const right = b.left > a.left + 20;
          const same = Math.abs(a.left - b.left) < 20;
          const x1 = (same ? a.right - 18 : right ? a.right : a.left) - box.left;
          const x2 = (same ? b.right - 18 : right ? b.left : b.right) - box.left;
          const y1 = a.top + a.height / 2 - box.top,
            y2 = b.top + b.height / 2 - box.top;
          const bend = same ? Math.max(x1, x2) + 20 : (x1 + x2) / 2;
          return [
            {
              id: e.id,
              d: `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`,
              x: (x1 + x2) / 2,
              y: (y1 + y2) / 2,
              label: e.label,
              active: active.has(e.id),
              planned: e.planned,
              taskId: e.taskId,
            },
          ];
        }),
      );
    };
    calc();
    const observer = new ResizeObserver(calc);
    observer.observe(root);
    for (const el of Array.from(root.querySelectorAll('[data-agent]'))) observer.observe(el);
    return () => observer.disconnect();
  }, [data, active, selected]);
  return (
    <svg class="runtime-connections" aria-hidden="true">
      <defs>
        <filter id="flow-glow">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      {lines.map((l) => (
        <g key={l.id} class={`${l.active ? 'flow-active' : ''} ${l.planned ? 'flow-planned' : ''}`}>
          <path class="flow-halo" d={l.d} />
          <path id={`flow-${l.id}`} class="flow-path" d={l.d} />
          {l.active ? (
            <circle r="5" class="flow-dot">
              <animateMotion dur="2s" repeatCount="1" fill="freeze">
                <mpath href={`#flow-${l.id}`} />
              </animateMotion>
            </circle>
          ) : null}
          <g transform={`translate(${l.x - 54},${l.y - 14})`}>
            <rect class="flow-label-bg" width="108" height="28" rx="14" />
            <text x="54" y="19" text-anchor="middle">
              {l.label}
            </text>
          </g>
        </g>
      ))}
    </svg>
  );
}
function AgentCard({
  agent: a,
  hostName,
  focus,
  selected,
}: {
  agent: RuntimeAgentView;
  hostName: string;
  focus(): void;
  selected: boolean;
}) {
  const state = states[a.state];
  return (
    <article
      class={`runtime-agent ${selected ? 'selected' : ''}`}
      data-agent={a.id}
      aria-label={`${a.name}的执行情况`}
    >
      <header class="agent-identity">
        <span class={`agent-symbol role-${a.role}`}>
          <Glyph kind={a.role} />
        </span>
        <span>
          <strong>{a.name} <small>{roleText(a.role)}</small></strong>
          <small>
            {a.model ?? '模型未上报'}
            {a.modelSource === 'configured' ? ' · 配置值' : ''} · {a.runtime === 'native' ? '原生执行' : a.runtime === 'paseo' ? 'Paseo' : '运行器待上报'}
          </small>
        </span>
        <Badge tone={state[1]}>{state[0]}</Badge>
      </header>
      <div class="agent-work">
        <span>{a.taskTitle ? a.phase === 'review' ? '正在复核' : '当前任务' : '当前'}</span>
        {a.taskTitle ?? (a.state === 'idle' ? '等待下一项任务' : '暂无任务信息')}
      </div>
      <dl class="agent-facts">
        <div><dt>所属项目</dt><dd>{a.project?.name ?? (a.taskId ? '项目未关联' : '待分配')}</dd></div>
        <div><dt>执行电脑</dt><dd>{hostName}</dd></div>
        <div><dt>本阶段已用</dt><dd>{a.elapsedSeconds === undefined ? '—' : durationText(a.elapsedSeconds)}</dd></div>
        <div class="agent-eta"><dt>预计还需{a.estimate?.samples ? ` · 历史 ${a.estimate.samples} 次` : ''}</dt><dd>{remainingText(a)}</dd></div>
      </dl>
      {a.taskId || a.activity ? <ActivityFeed agent={a} /> : null}
      {a.progress ? <div class="agent-progress">
        <span>{a.progress.label} {a.progress.done}/{a.progress.total}</span>
        <ProgressBar value={a.progress.total ? (a.progress.done / a.progress.total) * 100 : 0} label={a.progress.label} />
      </div> : null}
      <div class="agent-next"><b>下一条</b> · {a.next?.title ?? '暂无候选任务'}</div>
      {a.destination ? <div class="agent-destination"><b>交给</b> · {roleText(a.destination.role)}（提交后调度）</div> : null}
      <details class="agent-brief">
        <summary>任务资料与派工内容</summary>
        <p class="hint">{a.currentPrompt?.source === 'sent' ? '实际发送内容' : a.currentPrompt ? '历史模板，旧执行端未记录实际正文' : '尚无本轮派工内容'}</p>
        {a.currentPrompt ? <pre class="runtime-prompt-full">{a.currentPrompt.text}{a.currentPrompt.truncated ? '\n（内容已截断）' : ''}</pre> : null}
        <WorkContextFiles value={a.currentPrompt?.context} />
        {a.next ? <><h3>下一条 · 尚未派工</h3><p class="hint">{a.next.reason}</p>
          <pre class="runtime-prompt-full">{a.next.prompt?.text ?? a.next.title}</pre>
          <WorkContextFiles value={a.next.prompt?.context} /></> : null}
        {a.taskId ? <div class="agent-detail-links"><a href={hrefOf('tasks', a.taskId)}>查看任务</a><button class="link" onClick={focus}>高亮任务流转</button></div> : null}
      </details>
    </article>
  );
}
export function OverviewPage() {
  const [snapshot, setData] = useState<RuntimeDashboard>();
  const [focusedTask, setFocusedTask] = useState<string>();
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [active, setActive] = useState(new Set<string>());
  const seen = useRef<Set<string> | undefined>(undefined);
  const loading = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const live = useLiveState();
  const animationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(async () => {
    if (loading.current) {
      pending.current = true;
      return;
    }
    loading.current = true;
    try {
      do {
        pending.current = false;
        const out = await readDashboard();
        if (!mounted.current) return;
        if (out.kind !== 'ok') {
          setError(outcomeText(out, ''));
          return;
        }
        const next = out.result;
        const fresh = seen.current ? next.transfers.filter((e) => !seen.current!.has(e.id)) : [];
        seen.current = new Set([...(seen.current ?? []), ...next.transfers.map((e) => e.id)]);
        if (seen.current.size > 4096) seen.current = new Set([...seen.current].slice(-2048));
        setData(next);
        setError('');
        if (fresh.length) {
          setActive(new Set(fresh.map((e) => e.id)));
          clearTimeout(animationTimer.current);
          animationTimer.current = setTimeout(() => setActive(new Set()), 4500);
        }
      } while (pending.current);
    } catch {
      setError('运行大盘读取失败，已保留最后快照');
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      clearTimeout(animationTimer.current);
    };
  }, [load]);
  useLiveRefresh(
    [
      'agent_activity', 'task', 'project',
      'employee',
      'audit',
      'runner_heartbeat',
      'company_meta',
      'outbound_message',
      'requirement_execution',
      'acceptance_evidence',
    ],
    load,
    !paused,
  );
  const resume = () => {
    setPaused((p) => !p);
    if (paused) void load();
  };
  const full = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector('.runtime-page')?.requestFullscreen();
    } catch {
      setError('浏览器未允许全屏');
    }
  };
  const observedNow = useObservationClock(
    snapshot
      ? [...snapshot.hosts.map((h) => h.at), ...snapshot.agents.map((a) => a.observedAt)]
      : [],
    paused || snapshot?.sample,
  );
  const data = snapshot ? expireObservations(snapshot, observedNow) : undefined;
  if (!data)
    return (
      <div class="page">
        <h1>总览</h1>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : (
          <Loading label="正在连接运行大盘…" />
        )}
      </div>
    );
  const flow = focusedTask
    ? data.transfers.filter((t) => t.taskId === focusedTask)
    : data.transfers.slice(-4);
  const summary = data.summary;
  return (
    <div class="page runtime-page">
      <header class="runtime-header">
        <div>
          <h1>总览</h1>
          <span>AI 团队实时运行大盘</span>
        </div>
        <div class="runtime-controls">
          <Badge tone={paused ? 'decide' : live === 'live' ? 'done' : 'blocked'}>
            {paused
              ? '画面已暂停'
              : live === 'live'
                ? 'LIVE 已连接'
                : live === 'connecting'
                  ? '正在连接'
                  : '连接中断'}
          </Badge>
          <small>最后更新 {clockText(data.at)}</small>
          <button onClick={resume} title="只暂停显示，不暂停 Agent">
            {paused ? '▶ 继续' : 'Ⅱ 暂停画面'}
          </button>
          <button onClick={() => void full()} aria-label="切换全屏">
            ⛶
          </button>
        </div>
      </header>
      {error ? (
        <div class="notice err" role="alert">
          {error}
          <button onClick={() => void load()}>重试</button>
        </div>
      ) : null}
      {live !== 'live' && !paused ? (
        <div class="notice warn">实时连接尚未恢复，以下为最后收到的快照，不代表当前运行状态。</div>
      ) : null}
      <div class="runtime-summary">
        <span>
          <Glyph />
          <b>{summary.hosts}</b> 台主机 <small>（{summary.onlineHosts} 在线）</small>
        </span>
        <span>
          <b>{summary.agents}</b> 个 Agent{' '}
          <small>
            （{summary.runningAgents} 运行 · {summary.idleAgents} 空闲）
          </small>
        </span>
        <span>
          <b>{summary.tasks}</b> 项任务执行中
        </span>
        <span>
          <b>{summary.queued}</b> 项排队中
        </span>
        <span class={summary.blocked ? 'text-blocked' : ''}>
          <b>{summary.blocked}</b> 项受阻
        </span>
      </div>
      <div class="runtime-context">
        {data.warnings.length ? (
          <details class="runtime-warnings">
            <summary>数据说明 · {data.warnings.length} 项</summary>
            {data.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </details>
        ) : null}
        {data.sample ? (
          <div class="runtime-demo-controls">
            <span>运行状态与 CI/CD 结果为【设计案例】</span>
            <button onClick={() => void fetch('/api/demo/transfer', { method: 'POST' })}>
              演示一次交接
            </button>
          </div>
        ) : null}
      </div>
      <div class="runtime-map" id="runtime-map">
        <div class="runtime-hosts">
          {data.hosts.map((h) => (
            <section class="runtime-host" key={h.id}>
              <header class="host-header">
                <span class="host-title">
                  <Glyph />
                  <strong>{h.name}</strong>
                  <small>
                    {h.metrics
                      ? `${platform(h.metrics.platform)} · ${h.metrics.cores}C / ${Math.round(h.metrics.memoryTotal / 2 ** 30)}G`
                      : '设备规格未上报'}
                  </small>
                  <Badge
                    tone={
                      h.state === 'online' ? 'done' : h.state === 'offline' ? 'blocked' : 'neutral'
                    }
                  >
                    {h.state === 'online' ? '在线' : h.state === 'offline' ? '离线' : '未知'}
                  </Badge>
                </span>
                <span class="host-meters">
                  <Meter label="CPU" value={h.metrics?.cpuPercent} />
                  <Meter
                    label="内存"
                    value={
                      h.metrics && h.metrics.memoryTotal
                        ? (h.metrics.memoryUsed / h.metrics.memoryTotal) * 100
                        : undefined
                    }
                  />
                </span>
              </header>
              <div class="host-agents">
                {data.agents
                  .filter((a) => a.hostId === h.id)
                  .map((a) => (
                    <AgentCard
                      key={a.id}
                      agent={a}
                      hostName={h.name}
                      focus={() => setFocusedTask(a.taskId)}
                      selected={!!focusedTask && focusedTask === a.taskId}
                    />
                  ))}
                {!data.agents.some((a) => a.hostId === h.id) ? (
                  <p class="runtime-empty">此主机暂无在岗 Agent</p>
                ) : null}
              </div>
            </section>
          ))}
        </div>
        <Connections data={data} active={active} selected={focusedTask} />
        {!data.hosts.length ? (
          <p class="runtime-empty">尚未收到执行主机心跳。启动执行端后会自动出现在这里。</p>
        ) : null}
      </div>
      <div class="runtime-bottom">
        <section class="panel">
          <header class="panel-head">
            <h2>
              任务流转 <small>{focusedTask ? '已选任务' : '真实交接记录'}</small>
            </h2>
            {focusedTask ? (
              <button class="link" onClick={() => setFocusedTask(undefined)}>
                显示全部
              </button>
            ) : null}
          </header>
          {flow.length ? (
            <ol class="runtime-flow">
              {flow.map((t) => (
                <li key={t.id} class={active.has(t.id) ? 'current' : ''}>
                  <span>{data.agents.find((a) => a.id === t.from)?.name ?? t.from}</span>
                  <strong>→ {t.label} →</strong>
                  <span>{data.agents.find((a) => a.id === t.to)?.name ?? t.to}</span>
                  <a href={hrefOf('tasks', t.taskId)}>{t.title}</a>
                  <small>{clockText(t.at)}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p class="hint">暂无已送达的跨 Agent 交接。候选任务不会被当作交接事件。</p>
          )}
        </section>
        <section class="panel">
          <header class="panel-head">
            <h2>最近事件</h2>
            <small>最近 {data.events.length} 条</small>
          </header>
          <ul class="runtime-events">
            {data.events.map((e) => (
              <li key={e.id}>
                <time>{clockText(e.at)}</time>
                <span>
                  {e.actor} · {e.label}{' '}
                  {e.taskId ? (
                    <a href={hrefOf('tasks', e.taskId)}>{e.taskTitle ?? e.taskId}</a>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {!data.events.length ? <p class="hint">等待新的运行事件</p> : null}
        </section>
      </div>
      <section class="panel runtime-delivery">
        <header class="panel-head">
          <h2>GitHub CI/CD</h2>
          <small>PR 合并后自动构建与部署 · 不占用 Agent 席位</small>
        </header>
        <p class="hint">{data.sample?'以下为本地 CI/CD 设计案例。':'显示系统已核验的流水线结果。'}CI 检查通过与生产部署完成分别展示。</p>
        {data.deliveries.length ? (
          <ul class="runtime-deliveries">
            {data.deliveries.map((d) => (
              <li key={d.id}>
                <a href={hrefOf('tasks', d.taskId)}>{d.title}</a>
                <Badge
                  tone={
                    !d.current
                      ? 'neutral'
                      : d.status === 'ci_failed'
                        ? 'blocked'
                        : d.status === 'unknown'
                          ? 'neutral'
                          : 'done'
                  }
                >
                  {!d.current ? '历史提交 · ' : ''}
                  {
                    {
                      ci_passed: 'CI 检查通过',
                      ci_failed: 'CI 检查未通过',
                      production_verified: '生产部署已核验',
                      unknown: '结果待确认',
                    }[d.status]
                  }
                </Badge>
                <code>{d.sha.slice(0, 12)}</code>
                {d.runUrl ? (
                  <a href={d.runUrl} target="_blank" rel="noopener noreferrer">
                    查看 Actions ↗
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p class="hint">暂无已回传的 GitHub 证据，暂不能判断构建或生产部署结果。</p>
        )}
      </section>
      <p class="runtime-data-note">公开输出每 30 秒上报，新内容自动滚动到末尾；只展示近 24 小时内每轮最近 40 条记录。工具次数不代表完成比例。预计时间参考近 30 天同项目、岗位和阶段的历史耗时，至少 5 次；不含后续复核和上线。</p>
    </div>
  );
}

function ActivityFeed({agent}: {agent: RuntimeAgentView}) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const activity = agent.activity;
  useEffect(() => { follow.current = true; }, [activity?.turn]);
  useEffect(() => { if (follow.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [activity?.turn, activity?.events.at(-1)?.seq]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { if (follow.current) el.scrollTop = el.scrollHeight; });
    observer.observe(el);
    return () => observer.disconnect();
  }, [activity?.turn]);
  if (!activity) return <div class="agent-activity-empty">{agent.runtime === 'paseo' ? 'Paseo 会话尚未接入实时输出' : '等待执行端上报本轮进度'}{agent.action ? ` · ${agent.action}` : ''}</div>;
  return <section class="agent-activity" aria-label={`${agent.name}的近期输出`}>
    <div class="agent-activity-heading">
      <strong>{agent.state === 'unknown' ? '连接中断 · 保留最近输出' : activity.tool ? `正在调用 ${activity.tool}` : activity.state === 'running' ? '本轮执行中' : activity.state === 'completed' ? '本轮已结束 · 等待流程收尾' : activity.state === 'failed' ? '本轮执行失败' : '本轮已停止'}</strong>
      <span>上报 {clockText(activity.observedAt)} · 工具 {activity.toolsCompleted} 次</span>
    </div>
    <div class="agent-activity-feed" ref={ref} tabIndex={0} aria-label="近期公开输出，自动跟随最新内容"
      onWheel={e => { if (e.deltaY < 0) follow.current = false; }} onTouchStart={() => { follow.current = false; }}
      onPointerDown={() => { follow.current = false; }} onKeyDown={e => { if (['ArrowUp','PageUp','Home'].includes(e.key)) follow.current = false; }}
      onScroll={() => { const el = ref.current!; if (el.scrollHeight - el.scrollTop - el.clientHeight < 32) follow.current = true; }}>
      {activity.events.map(e => <div key={`${activity.turn}:${e.seq}`} class={`activity-${e.kind}`}><time>{clockText(e.at)}</time><pre>{e.text}</pre></div>)}
      {!activity.events.length ? <p class="hint">回合已启动，等待公开输出</p> : null}
    </div>
  </section>;
}
