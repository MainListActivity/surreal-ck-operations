import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type {
  RuntimeDashboard,
  RuntimeAgentView,
  RuntimePendingMessage,
} from '../../../../src/runtime-dashboard.ts';
import type { RuntimeProgress } from '../../../../src/runtime-projects.ts';
import type { RuntimeEstimate } from '../../../../src/runtime-timing.ts';
import { WorkContextFiles } from '../WorkContext.tsx';
import { readDashboard, runCommand, outcomeText } from '../api.ts';
import { useLiveRefresh, useLiveState } from '../realtime.ts';
import {
  expireObservations,
  remainingText,
  useObservationClock,
} from '../runtime-state.ts';
import { Badge, ErrorState, Loading, roleText } from '../common.tsx';
import { hrefOf, clockText, durationText, routeOf } from '../model.ts';
import {
  employeeProgress,
  finishText,
  onDuty,
  portraitIndex,
  roomAgents,
  staffStatus,
  useAvatars,
  messagePreview,
} from '../meeting-rooms.ts';

function WorkProgress({ value }: { value: RuntimeProgress }) {
  return (
    <div class="room-progress" title={value.detail}>
      <div>
        <span>{value.label.replace(/^本轮/, '')}</span>
        <b>
          {value.percent === undefined ? '待量化' : `${value.percent}%`}{' '}
          {value.total ? (
            <small>
              ({value.done}/{value.total})
            </small>
          ) : null}
        </b>
      </div>
      <progress
        max={100}
        value={value.percent}
        aria-label={value.label}
        aria-valuetext={value.detail}
      />
      {value.percent === undefined ? <small>{value.detail}</small> : null}
    </div>
  );
}
function TimeProgress({
  estimate,
  at,
  elapsed,
  reason,
  compact = false,
}: {
  estimate?: RuntimeEstimate;
  at: number;
  elapsed?: number;
  reason?: string;
  compact?: boolean;
}) {
  const text = finishText(estimate, at);
  const value =
    text && elapsed !== undefined
      ? Math.min(
          99,
          (elapsed /
            (elapsed +
              (estimate!.lowerSeconds! + estimate!.upperSeconds!) / 2)) *
            100,
        )
      : undefined;
  return (
    <div
      class={`room-time ${text ? 'estimated' : ''} ${compact ? 'time-caption' : ''}`}
    >
      <div>
        <span>预计结束</span>
        <b>
          {text?.replace(/^约 /, '').replace(/ 结束$/, '') ??
            reason ??
            '暂无法估计'}
        </b>
      </div>
      {!compact ? (
        <progress
          max={100}
          value={value}
          aria-label="参考耗时"
          aria-valuetext={text ?? reason ?? '暂无法估计'}
        />
      ) : null}
    </div>
  );
}
function EmployeeFigure({
  agent,
  compact,
  progress,
}: {
  agent: RuntimeAgentView;
  compact: boolean;
  progress: RuntimeProgress;
}) {
  const percent = progress.percent;
  const state = staffStatus(agent);
  const progressText =
    percent === undefined
      ? '待上报'
      : `${state.kind === 'unknown' ? '上次 ' : ''}${percent}%`;
  const description = `${state.text}。${progress.label}：${progressText}${progress.total ? `（${progress.done}/${progress.total}）` : ''}。${progress.detail}`;
  const ring = compact
    ? 'M50 5a45 45 0 1 1 0 90a45 45 0 1 1 0-90'
    : 'M100 37a94 16 0 1 1 0-32a94 16 0 1 1 0 32';
  return (
    <div
      class={`employee-figure ${compact ? 'portrait' : 'character'}`}
      data-agent={agent.id}
    >
      <div
        class="figure-crop"
        role="img"
        aria-label={`${agent.name}的${compact ? '头像' : '形象'}`}
      >
        <span class={`person-sprite person-${portraitIndex(agent)}`} />
      </div>
      <div
        class={`person-halo ${percent === undefined ? 'progress-unknown' : ''}`}
        role="progressbar"
        aria-label={`${agent.name}的${progress.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={description}
        title={description}
      >
        <svg
          viewBox={compact ? '0 0 100 100' : '0 0 200 44'}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path class="halo-track" d={ring} pathLength={100} />
          {percent !== undefined && percent > 0 ? (
            <path
              class="halo-fill"
              d={ring}
              pathLength={100}
              stroke-dasharray={`${percent} 100`}
            />
          ) : null}
        </svg>
        <span class="halo-value" aria-hidden="true">
          {progressText}
        </span>
      </div>
    </div>
  );
}
function EmployeeSeat({
  agent: a,
  host,
  compact,
  focused,
  at,
  edit,
}: {
  agent: RuntimeAgentView;
  host: string;
  compact: boolean;
  focused: boolean;
  at: number;
  edit(m: RuntimePendingMessage): void;
}) {
  const state = staffStatus(a),
    messages = a.pendingMessages ?? [],
    progress = employeeProgress(a);
  const name = (a.name || roleText(a.role)).replace(/^【设计案例】\s*/, '');
  return (
    <article
      class={`employee-seat state-${state.kind}`}
      aria-label={`${a.name}的执行情况`}
    >
      <div class="seat-speech">
        <div
          class="seat-work"
          title={a.blockedReason ?? a.taskTitle ?? a.action}
        >
          {(
            a.blockedReason ??
            a.taskTitle ??
            a.action ??
            '等待执行端确认任务'
          ).replace(/^【设计案例】\s*/, '')}
        </div>
        <ActivityFeed agent={a} />
      </div>
      <EmployeeFigure agent={a} compact={compact} progress={progress} />
      <div class="seat-console">
        <div class="seat-identity">
          <strong>{name}</strong>
          <span class="instance-tag">#{a.id.slice(-6)}</span>
        </div>
        <div class="seat-model">
          <span class="seat-status">{state.text}</span>
          <span>
            {a.model ?? '模型未上报'}
            {a.modelSource === 'configured' ? ' · 配置' : ''}
          </span>
        </div>
        <TimeProgress
          compact
          estimate={state.kind === 'working' ? a.estimate : undefined}
          at={at}
          elapsed={a.elapsedSeconds}
          reason={
            a.taskState === 'blocked'
              ? '受阻，时间待定'
              : a.activity && a.activity.state !== 'running'
                ? '本轮已结束，等待流转'
                : remainingText(a)
          }
        />
        <div class="seat-machine">
          <span>▣ {host}</span>
          <span>
            {a.elapsedSeconds !== undefined
              ? `已用 ${durationText(a.elapsedSeconds)}`
              : ''}
          </span>
        </div>
        <div class="seat-next">
          <span>下一条</span>
          {messages.length ? (
            messages.map((m) => (
              <button
                key={m.messageId}
                onClick={() => edit(m)}
                aria-label={`编辑待发消息：${m.title}`}
                title={`${messagePreview(m)}\n派工正文：${m.preview}`}
              >
                <span>
                  {m.stage === 'later'
                    ? '后续 · '
                    : m.assignment === 'candidate'
                      ? '候选 · '
                      : ''}
                  {m.hold ? '暂缓 · ' : ''}
                  {messagePreview(m)}
                  <small>{m.preview}</small>
                </span>
                <b aria-hidden="true">✎</b>
              </button>
            ))
          ) : (
            <small>暂无确定的待发消息</small>
          )}
        </div>
        {focused ? (
          <details class="seat-context">
            <summary>本轮派工与任务资料</summary>
            <pre class="runtime-prompt-full">
              {a.currentPrompt?.text ?? '尚未记录本轮派工正文'}
            </pre>
            <WorkContextFiles value={a.currentPrompt?.context} />
            {a.taskId ? (
              <a href={hrefOf('tasks', a.taskId)}>任务与验收证据 ↗</a>
            ) : null}
          </details>
        ) : null}
      </div>
    </article>
  );
}

function MessageEditor({
  message,
  latest,
  close,
  reload,
}: {
  message: RuntimePendingMessage;
  latest?: RuntimePendingMessage;
  close(): void;
  reload(): Promise<void>;
}) {
  const [body, setBody] = useState(message.body),
    [expected, setExpected] = useState(message.body),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const busyRef = useRef(false),
    dirty = body !== expected;
  useEffect(() => {
    document
      .querySelector('.room-message-editor')
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [message.messageId]);
  const save = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    try {
      const out = await runCommand('message.edit', {
        messageId: message.messageId,
        body,
        expectedBody: expected,
      });
      if (out.kind === 'ok') {
        setExpected(body.trim());
        setBody(body.trim());
        setNotice('已保存到待发消息，执行端派工时使用这份正文。');
      } else setNotice(outcomeText(out, ''));
      await reload();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <section class="room-message-editor" aria-label="编辑待发消息">
      <header>
        <div>
          <h2>待发消息 · {message.title}</h2>
          <p>
            可修改派工正文；下方展开实际任务内容。任务文件是按已确认需求生成的只读预览。
          </p>
        </div>
        <button onClick={close} disabled={busy}>
          {dirty ? '放弃修改并关闭' : '关闭编辑'}
        </button>
      </header>
      {!latest ? (
        <p class="notice warn">
          消息已派发或已不在当前待发队列；草稿已保留，请核对后再操作。
        </p>
      ) : latest.body !== expected ? (
        <p class="notice warn">
          服务端正文已更新，当前修改已保留。
          <button
            onClick={() => {
              setBody(latest.body);
              setExpected(latest.body);
              setNotice('');
            }}
          >
            使用最新正文重新编辑
          </button>
        </p>
      ) : null}
      <label>
        派工正文
        <textarea
          value={body}
          rows={7}
          maxLength={20000}
          onInput={(e) => setBody(e.currentTarget.value)}
        />
      </label>
      <div class="editor-actions">
        <button
          class="primary"
          onClick={() => void save()}
          disabled={
            busy ||
            !body.trim() ||
            !dirty ||
            !latest ||
            latest.body !== expected
          }
        >
          {busy ? '保存中…' : '保存待发消息'}
        </button>
        <small>
          {message.assignment === 'candidate'
            ? '接收员工仍由派工决定。'
            : '仅修改尚未发送的正文。'}
          编辑期间不会自动暂停派工。
        </small>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      <WorkContextFiles value={latest?.context ?? message.context} />
    </section>
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
      const figures = new Map(
        Array.from(root.querySelectorAll<HTMLElement>('[data-agent]')).map(
          (el) => [el.dataset.agent!, el],
        ),
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
          const from = figures.get(e.from),
            to = figures.get(e.to);
          // An employee may go idle immediately after handing work over. Keep idle people
          // off the floor; the real handoff can enter/leave through the project's doorway.
          const doorway = (from ?? to)
            ?.closest('.project-room')
            ?.querySelector('.room-sign');
          const a = (from ?? doorway)?.getBoundingClientRect(),
            b = (to ?? doorway)?.getBoundingClientRect();
          if (!a || !b) return [];
          const right = b.left > a.left + 20;
          const same = Math.abs(a.left - b.left) < 20;
          const x1 =
            (same ? a.right - 18 : right ? a.right : a.left) - box.left;
          const x2 =
            (same ? b.right - 18 : right ? b.left : b.right) - box.left;
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
    for (const el of Array.from(root.querySelectorAll('[data-agent]')))
      observer.observe(el);
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
        <g
          key={l.id}
          class={`${l.active ? 'flow-active' : ''} ${l.planned ? 'flow-planned' : ''}`}
        >
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
export function OverviewPage() {
  const [snapshot, setData] = useState<RuntimeDashboard>(),
    [error, setError] = useState(''),
    [paused, setPaused] = useState(false);
  const [active, setActive] = useState(new Set<string>()),
    [project, setProject] = useState(
      () => routeOf(location.hash).params.project,
    );
  const [editing, setEditing] = useState<RuntimePendingMessage>();
  const seen = useRef<Set<string> | undefined>(undefined),
    loading = useRef(false),
    pending = useRef(false),
    mounted = useRef(true);
  const live = useLiveState(),
    animationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    );
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
        const next = out.result,
          fresh = seen.current
            ? next.transfers.filter((t) => !seen.current!.has(t.id))
            : [];
        seen.current = new Set([
          ...(seen.current ?? []),
          ...next.transfers.map((t) => t.id),
        ]);
        if (seen.current.size > 4096)
          seen.current = new Set([...seen.current].slice(-2048));
        setData(next);
        setError('');
        if (fresh.length) {
          setActive(new Set(fresh.map((t) => t.id)));
          clearTimeout(animationTimer.current);
          animationTimer.current = setTimeout(() => setActive(new Set()), 4500);
        }
      } while (pending.current);
    } catch {
      setError('读取失败，保留最后收到的画面');
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const changed = () => setProject(routeOf(location.hash).params.project);
    window.addEventListener('hashchange', changed);
    return () => {
      mounted.current = false;
      clearTimeout(animationTimer.current);
      window.removeEventListener('hashchange', changed);
    };
  }, [load]);
  useLiveRefresh(
    [
      'agent_activity',
      'task',
      'project',
      'employee',
      'audit',
      'runner_heartbeat',
      'company_meta',
      'outbound_message',
      'product_requirement',
      'requirement_plan',
      'requirement_execution',
      'acceptance_evidence',
    ],
    load,
    !paused,
  );
  const observedNow = useObservationClock(
    snapshot
      ? [
          ...snapshot.hosts.map((h) => h.at),
          ...snapshot.agents.map((a) => a.observedAt),
        ]
      : [],
    paused || snapshot?.sample,
  );
  const data = snapshot ? expireObservations(snapshot, observedNow) : undefined;
  if (!data)
    return (
      <div class="page">
        <h1>公司总览</h1>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : (
          <Loading label="正在连接公司工作现场…" />
        )}
      </div>
    );
  const rooms = [...(data.projects ?? [])].sort(
    (a, b) =>
      Number(roomAgents(data, b.id).length > 0) -
        Number(roomAgents(data, a.id).length > 0) ||
      b.blocked - a.blocked ||
      a.name.localeCompare(b.name),
  );
  const current = rooms.find((p) => p.id === project);
  const visible = current ? [current] : rooms;
  const duty = current
      ? roomAgents(data, current.id)
      : data.agents.filter(onDuty),
    blocked = duty
      .filter((a) =>
        ['blocked', 'waiting', 'unknown'].includes(staffStatus(a).kind),
      )
      .sort((a, b) => Number(!!b.blockedReason) - Number(!!a.blockedReason));
  const allMessages = [
    ...rooms.flatMap((p) => p.pendingMessages),
    ...data.agents.flatMap((a) => a.pendingMessages ?? []),
  ];
  const full = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector('.runtime-page')?.requestFullscreen();
    } catch {
      setError('浏览器未允许全屏');
    }
  };
  return (
    <div
      class={`page runtime-page company-scene ${current ? 'project-closeup' : ''} ${paused ? 'scene-paused' : ''}`}
    >
      <header class="runtime-header">
        <div>
          <h1>
            {current
              ? current.name.replace(/^【设计案例】\s*/, '')
              : '公司总览'}
          </h1>
          <span>{current ? '项目工作现场' : '所有项目，一眼看见'}</span>
        </div>
        <div class="runtime-controls">
          <Badge
            tone={paused ? 'decide' : live === 'live' ? 'done' : 'blocked'}
          >
            {paused
              ? '画面已暂停'
              : live === 'live'
                ? '● 实时协作'
                : '实时连接待恢复'}
          </Badge>
          <small>更新 {clockText(data.at)}</small>
          <button
            onClick={() => {
              setPaused(!paused);
              if (paused) void load();
            }}
          >
            {paused ? '继续画面' : '暂停画面'}
          </button>
          <button aria-label="切换全屏" onClick={() => void full()}>
            ⛶
          </button>
        </div>
      </header>
      {current ? (
        <a class="room-back" href={hrefOf('overview')}>
          ← 返回公司总览
        </a>
      ) : null}
      <div class="company-counters">
        {current ? (
          <span>
            <b>{duty.length}</b> 位在场
          </span>
        ) : (
          <span>
            <b>{rooms.length}</b> 个项目部
          </span>
        )}
        <span>
          <b>{duty.filter((a) => staffStatus(a).kind === 'working').length}</b>{' '}
          工作中
        </span>
        <span>
          <b>{blocked.length}</b> 受阻 / 等待确认
        </span>
        <span>
          <b>{current ? current.queued : data.summary.queued}</b> 项排队
        </span>
        <span>
          <b>
            {current
              ? new Set(
                  duty
                    .filter((a) =>
                      data.hosts.some(
                        (h) => h.id === a.hostId && h.state === 'online',
                      ),
                    )
                    .map((a) => a.hostId),
                ).size
              : data.summary.onlineHosts}
          </b>{' '}
          台电脑在线
        </span>
      </div>
      {blocked.length ? (
        <div class="scene-attention">
          <b>!</b>
          <span>
            需要关注：
            {blocked[0]!.blockedReason ??
              `${blocked[0]!.name} · ${staffStatus(blocked[0]!).text}`}
          </span>
          {blocked.length > 1 ? (
            <small>共 {blocked.length} 位需关注</small>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div class="notice err" role="alert">
          {error}
          <button onClick={() => void load()}>重试</button>
        </div>
      ) : null}
      {live !== 'live' && !paused ? (
        <div class="notice warn">实时连接尚未恢复，以下为最后快照。</div>
      ) : null}
      {data.sample ? (
        <div class="runtime-demo-controls">
          <span>【设计案例】全部操作仅在本地内存生效</span>
          <div>
            <button
              onClick={() =>
                void fetch('/api/demo/transfer', { method: 'POST' })
              }
            >
              演示交接
            </button>{' '}
            <button
              onClick={() => void fetch('/api/demo/crowd', { method: 'POST' })}
            >
              切换 4 / 8 人
            </button>
          </div>
        </div>
      ) : null}
      {editing ? (
        <MessageEditor
          key={editing.messageId}
          message={editing}
          latest={allMessages.find((m) => m.messageId === editing.messageId)}
          close={() => setEditing(undefined)}
          reload={load}
        />
      ) : null}
      <div class="runtime-map meeting-floor" id="runtime-map">
        <div class="project-rooms">
          {visible.map((p) => {
            const people = roomAgents(data, p.id),
              compact = useAvatars(people.length, !!current);
            const projectEstimate = people.some((a) => a.state === 'unknown')
              ? undefined
              : p.estimate;
            const assigned = new Set(
              people.flatMap((a) =>
                (a.pendingMessages ?? []).map((m) => m.messageId),
              ),
            );
            const waitingMessages = p.pendingMessages.filter(
              (m) => !assigned.has(m.messageId),
            );
            return (
              <section
                key={p.id}
                class={`project-room ${compact ? 'crowded' : ''} ${current ? 'room-focused' : ''} ${people.length ? '' : 'room-empty'}`}
                aria-label={`${p.name}项目部`}
              >
                <header class="room-heading">
                  <div>
                    <span class="room-sign" aria-hidden="true">
                      ◈
                    </span>
                    <h2>
                      {p.name.replace(/^【设计案例】\s*/, '')}
                      <small>
                        {p.name.startsWith('【设计案例】')
                          ? '示例项目部'
                          : '项目部'}
                      </small>
                    </h2>
                  </div>
                  <span class={p.blocked ? 'room-issue' : 'room-active'}>
                    {people.length} 位在场
                    {p.blocked ? ` · ${p.blocked} 项受阻` : ''}
                  </span>
                  {!current ? (
                    <a href={hrefOf('overview', undefined, { project: p.id })}>
                      展开项目 ↗
                    </a>
                  ) : null}
                </header>
                <div
                  class={`room-seats seats-${people.length} ${compact ? 'avatar-seats' : 'figure-seats'}`}
                >
                  {people.map((a) => (
                    <EmployeeSeat
                      key={a.id}
                      agent={a}
                      compact={compact}
                      focused={!!current}
                      at={data.at}
                      host={
                        data.hosts.find((h) => h.id === a.hostId)?.name ??
                        '电脑待上报'
                      }
                      edit={setEditing}
                    />
                  ))}
                </div>
                {!people.length ? (
                  <div class="quiet-room">
                    <span aria-hidden="true">▱</span>
                    <p>
                      {p.blocked
                        ? '项目存在阻塞，当前没有执行中的员工'
                        : p.queued
                          ? '任务等待派工，当前没有执行中的员工'
                          : '当前没有工作中或阻塞的员工'}
                    </p>
                  </div>
                ) : null}
                <div class="room-project-progress">
                  <WorkProgress value={p.progress} />
                  <TimeProgress
                    estimate={projectEstimate}
                    at={data.at}
                    reason={
                      people.some((a) => a.state === 'unknown')
                        ? '连接待确认'
                        : p.estimateReason
                    }
                  />
                </div>
                <footer class="room-footer">
                  <span>
                    {p.queued} 项等待派工 · {p.blocked} 项受阻
                  </span>
                  <small>{p.progress.detail}</small>
                </footer>
                {waitingMessages.length ? (
                  <details class="room-dispatch" open={!!current}>
                    <summary>
                      {waitingMessages.length} 条待发与后续消息 ·
                      接收人由调度决定
                    </summary>
                    <div>
                      {waitingMessages.map((m) => (
                        <button key={m.messageId} onClick={() => setEditing(m)}>
                          <b>{m.title}</b>
                          <span>{messagePreview(m)}</span>
                          {m.context ? (
                            <small class="next-instruction">
                              指令：{m.preview}
                            </small>
                          ) : null}
                          <small>
                            {m.stage === 'later' ? '后续步骤 · ' : ''}
                            {m.hold ? '已暂缓 · ' : ''}点击修改 ↗
                          </small>
                        </button>
                      ))}
                    </div>
                  </details>
                ) : null}
              </section>
            );
          })}
        </div>
        <Connections data={data} active={paused ? new Set() : active} />
      </div>
      {!rooms.length ? (
        <p class="runtime-empty">暂无项目，确认需求后将在这里建立工作现场。</p>
      ) : null}
      <section class="scene-deliveries">
        <strong>GitHub CI/CD</strong>
        <span>PR 独立复核通过后合并，自动上线</span>
        {data.deliveries.slice(0, 3).map((d) => (
          <a key={d.id} href={hrefOf('tasks', d.taskId)}>
            {d.title} ·{' '}
            {d.status === 'production_verified'
              ? '生产已核验'
              : d.status === 'ci_passed'
                ? 'CI 已通过'
                : d.status === 'ci_failed'
                  ? 'CI 未通过'
                  : '结果待确认'}
          </a>
        ))}
      </section>
      <p class="runtime-data-note">
        员工进度来自本轮清单，项目进度来自已确认范围的验收任务；清单完成不代表验收通过。时间为历史耗时参考区间，未上报或存在阻塞时不承诺结束时间。公开进展每
        30 秒上报，由 LIVE 推送更新。
      </p>
    </div>
  );
}
function ActivityFeed({ agent }: { agent: RuntimeAgentView }) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const activity = agent.activity;
  const output = activity?.events.filter((e) => e.kind === 'output') ?? [];
  const visibleEvents = output.length
    ? output
    : (activity?.events.filter((e) => e.kind === 'status') ?? []);
  const showNewest = () => {
    const el = ref.current,
      last = el?.lastElementChild;
    if (el && last && follow.current)
      el.scrollTop +=
        last.getBoundingClientRect().top - el.getBoundingClientRect().top;
  };
  useEffect(() => {
    follow.current = true;
  }, [activity?.turn]);
  useEffect(() => {
    showNewest();
  }, [activity?.turn, activity?.events.at(-1)?.seq]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      showNewest();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [activity?.turn]);
  if (!activity)
    return (
      <div class="agent-activity-empty">
        {agent.runtime === 'paseo'
          ? 'Paseo 会话尚未接入实时输出'
          : '等待执行端上报本轮进度'}
        {agent.action ? ` · ${agent.action}` : ''}
      </div>
    );
  return (
    <section class="agent-activity" aria-label={`${agent.name}的近期输出`}>
      <div class="agent-activity-heading">
        <strong>
          {agent.state === 'unknown'
            ? '状态待确认 · 保留最近输出'
            : activity.tool
              ? `正在调用 ${activity.tool}`
              : activity.state === 'running'
                ? '本轮执行中'
                : activity.state === 'completed'
                  ? '本轮执行已结束'
                  : activity.state === 'failed'
                    ? '本轮执行失败'
                    : '本轮已停止'}
        </strong>
        <span>采样 {clockText(activity.observedAt)}</span>
      </div>
      <div
        class="agent-activity-feed"
        ref={ref}
        tabIndex={0}
        aria-label="近期公开输出，自动跟随最新内容"
        onWheel={(e) => {
          if (e.deltaY < 0) follow.current = false;
        }}
        onTouchStart={() => {
          follow.current = false;
        }}
        onPointerDown={() => {
          follow.current = false;
        }}
        onKeyDown={(e) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(e.key))
            follow.current = false;
        }}
        onScroll={() => {
          const el = ref.current!;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 32)
            follow.current = true;
        }}
      >
        {visibleEvents.map((e) => (
          <div key={`${activity.turn}:${e.seq}`} class={`activity-${e.kind}`}>
            <time>{clockText(e.at)}</time>
            <pre>{e.text}</pre>
          </div>
        ))}
        {!visibleEvents.length ? (
          <p class="hint">回合已启动，等待公开输出</p>
        ) : null}
      </div>
    </section>
  );
}
