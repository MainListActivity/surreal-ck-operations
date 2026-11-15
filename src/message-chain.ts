/**
 * 消息链预排：按任务链把已经发出的、接下来要发的、以及还没建任务的后续步骤的派工消息排成一条时间线。
 *
 * 只读，不写库。顺序只来自事实：任务链的父子关系（同一个父任务下的多个子任务是并行的，不排先后），和需求流水线已确认的规划。
 * 已建任务的消息就是 outbound_message 里的草稿，老板用 message.edit / message.hold 控制；还没建任务的流水线步骤，
 * 消息按规划提前算出来（与建任务时用的是同一个函数），老板的安排存在 planned_message（message.plan）。
 * 返工与催办只在被退回、一轮没有结果时才生成，这里不预建，页面上用一句话说明。
 */
import { RecordId, type Surreal } from 'surrealdb';
import { iterationMessages, iterationStep, iterationSteps } from './iteration/execution.ts';
import { iterationPlan, type IterationPlan } from './iteration/planning.ts';
import type { Approval } from './iteration/requirements.ts';
import { stepOfTask, type MessageStep } from './outbound-render.ts';

export type ChainRowStatus =
  /** 已发出。 */ | 'sent'
  /** 任务下一次派工就发这条。 */ | 'next'
  /** 被扣住，等老板放行。 */ | 'held'
  /** 同一张任务里靠后的一步（如执行还没提交时的复核消息）。 */ | 'later'
  /** 任务已建，但要等前面的任务完成才开始。 */ | 'waiting'
  /** 流水线后面的步骤：任务还没建，消息是按规划提前算出来的。 */ | 'planned';

export interface ChainRow {
  status: ChainRowStatus;
  /** 这一步在链上的说明：等谁、什么时候发。 */
  when: string;
  taskId?: string;
  title: string;
  step: MessageStep;
  role: string;
  /** 已建草稿的编号：用 message.edit / message.hold 改。 */
  messageId?: string;
  /** 还没建任务的流水线步骤：用 message.plan 改，键是这四项。 */
  plan?: { requirement: string; revision: number; index: number; step: 'execute' | 'review' };
  /** 未发消息的正文；已发出的不带（要看用 message.list）。 */
  body?: string;
  hold: boolean;
  holdReason?: string;
  /** 正文是老板写定的（改过或提前改写过）：不再随任务卡变化。否则发出前会按任务卡和最新进展重算。 */
  fixed: boolean;
  sentTo?: string;
  sentAt?: string;
}

export interface MessageChain {
  /** 链的编号：根任务，或还没建任务的需求（requirement:<编号>）。 */
  id: string;
  title: string;
  requirement?: string;
  rows: ChainRow[];
}

type Row = Record<string, unknown>;
const keyOf = (value: unknown): string => String((value as RecordId | undefined)?.id ?? value ?? '');
const iso = (value: unknown): string | undefined => value instanceof Date ? value.toISOString() : value ? String(value) : undefined;
const STEP_RANK: Record<string, number> = { execute: 0, rework: 1, nudge: 2, review: 3, notice: 4 };
const STEP_TEXT: Record<string, string> = { execute: '执行', rework: '返工', review: '复核', nudge: '催办', notice: '通知' };
export const stepText = (step: string): string => STEP_TEXT[step] ?? step;

export async function readMessageChains(db: Surreal): Promise<MessageChain[]> {
  const [taskRows] = await db.query<[Row[]]>(
    'SELECT id, title, state, parent, tag, executor_role, reviewer_role, current_employee, created_at FROM task ORDER BY created_at DESC LIMIT 300;');
  const tasks = new Map((taskRows ?? []).map(row => [keyOf(row.id), row] as const));
  const open = (row: Row | undefined) => !!row && row.state !== 'done' && row.state !== 'void';
  // 链：沿 parent 往上找到根；父任务不在读取范围内的，以它自己为根。
  const rootOf = (id: string): string => { let at = id; for (let n = 0; n < 50; n++) { const parent = keyOf(tasks.get(at)?.parent); if (!parent || !tasks.has(parent)) break; at = parent; } return at; };
  const members = new Map<string, string[]>();
  for (const id of [...tasks.keys()].reverse()) { const root = rootOf(id); members.set(root, [...(members.get(root) ?? []), id]); }

  // 流水线里的需求：已规划、还在进行的。它的任务按 requirement_execution.tasks 的顺序一张接一张。
  const [requirements] = await db.query<[Row[]]>(
    "SELECT id, approved_revision, state, root_task FROM product_requirement WHERE planned = true AND state IN ['queued', 'implementing', 'release_pending', 'paused'];").catch(() => [[] as Row[]]);
  const pipelines: Array<{ requirement: string; revision: number; approval: Approval; plan: IterationPlan; tasks: string[]; paused: boolean }> = [];
  for (const row of requirements ?? []) {
    const requirement = keyOf(row.id), revision = Number(row.approved_revision);
    if (!Number.isInteger(revision)) continue;
    try {
      const [[approval], [plan], [run]] = await db.query<[Array<{ snapshot: string }>, Array<{ body: string }>, Array<{ tasks?: string[] }>]>(
        'SELECT snapshot FROM $approval; SELECT body FROM $plan; SELECT tasks FROM $run;', {
          approval: new RecordId('requirement_approval', `${requirement}:${revision}`), plan: new RecordId('requirement_plan', `${requirement}:${revision}`),
          run: new RecordId('requirement_execution', `${requirement}:${revision}`) });
      if (!approval || !plan) continue;
      pipelines.push({ requirement, revision, approval: JSON.parse(approval.snapshot) as Approval, plan: iterationPlan(JSON.parse(plan.body)),
        tasks: run?.tasks ?? [], paused: row.state === 'paused' });
    } catch { /* 读不出规划的需求不预排，已建任务照常按任务链显示。 */ }
  }
  const pipelineOfRoot = new Map(pipelines.filter(p => p.tasks[0]).map(p => [rootOf(p.tasks[0]!), p] as const));

  const chainRoots = [...members.entries()].filter(([root, ids]) => ids.some(id => open(tasks.get(id))) || (pipelineOfRoot.has(root) && pipelineOfRoot.get(root)!.tasks.length < iterationSteps(pipelineOfRoot.get(root)!.plan)));
  const taskIds = chainRoots.flatMap(([, ids]) => ids).map(id => tasks.get(id)!.id);
  const [messages, returns, planned] = await Promise.all([
    taskIds.length ? db.query<[Row[]]>(
      `SELECT id, task, step, role, state, hold, hold_reason, body_edited, sent_to, sent_at, created_at, (IF state = 'sent' THEN NONE ELSE body END) AS body
        FROM outbound_message WHERE task IN $ids ORDER BY created_at;`, { ids: taskIds }).then(r => r[0] ?? []) : Promise.resolve([] as Row[]),
    taskIds.length ? db.query<[Row[]]>("SELECT task FROM audit WHERE task IN $ids AND action IN ['return', 'owner_reject'];", { ids: taskIds }).then(r => r[0] ?? []) : Promise.resolve([] as Row[]),
    pipelines.length ? db.query<[Row[]]>('SELECT requirement, revision, index, step, body, hold FROM planned_message WHERE requirement IN $ids;', { ids: pipelines.map(p => p.requirement) })
      .then(r => r[0] ?? []).catch(() => [] as Row[]) : Promise.resolve([] as Row[]),
  ]);
  const returned = new Set(returns.map(row => keyOf(row.task)));
  const messagesOf = new Map<string, Row[]>();
  for (const row of messages) messagesOf.set(keyOf(row.task), [...(messagesOf.get(keyOf(row.task)) ?? []), row]);
  const plannedOf = new Map(planned.map(row => [`${row.requirement}:${row.revision}:${row.index}:${row.step}`, row] as const));

  /** 一张已建任务的消息：先是发出过的（按时间），再是没发的（每一步只取最新一条草稿）。 */
  const rowsOfTask = (id: string): ChainRow[] => {
    const task = tasks.get(id)!, all = messagesOf.get(id) ?? [];
    const title = String(task.title ?? ''), next = stepOfTask(String(task.state), returned.has(id));
    const parent = tasks.get(keyOf(task.parent));
    const sent = all.filter(row => row.state === 'sent').sort((a, b) => String(iso(a.sent_at)).localeCompare(String(iso(b.sent_at))))
      .map((row): ChainRow => ({ status: 'sent', when: '已发出', taskId: id, title, step: String(row.step) as MessageStep, role: String(row.role ?? ''),
        messageId: keyOf(row.id), hold: false, fixed: true, ...(row.sent_to ? { sentTo: String(row.sent_to) } : {}), ...(iso(row.sent_at) ? { sentAt: iso(row.sent_at) } : {}) }));
    if (!open(task)) return sent;
    const latest = new Map<string, Row>();
    for (const row of all) if (row.state !== 'sent') latest.set(String(row.step), row);
    const unsent = [...latest.values()].sort((a, b) => (STEP_RANK[String(a.step)] ?? 9) - (STEP_RANK[String(b.step)] ?? 9)).map((row): ChainRow => {
      const step = String(row.step) as MessageStep, held = row.hold === true || row.state === 'held';
      const status: ChainRowStatus = task.state === 'planned' ? 'waiting' : held ? 'held' : step === next || step === 'nudge' ? 'next' : 'later';
      const when = task.state === 'planned' ? `等《${String(parent?.title ?? '前一张任务')}》完成后发`
        : task.state === 'blocked' ? '任务受阻，恢复后发'
          : held ? (typeof row.hold_reason === 'string' ? `系统扣住：${row.hold_reason}` : '已扣住，等你放行')
            : step === 'nudge' ? '催办：等派出' : step === next ? (task.current_employee ? '下一次派工时发' : '下一条，等派工')
              : step === 'review' ? '执行岗提交后发' : '靠后的一步';
      return { status, when, taskId: id, title, step, role: String(row.role ?? ''), messageId: keyOf(row.id), body: String(row.body ?? ''),
        hold: held, ...(typeof row.hold_reason === 'string' && held ? { holdReason: row.hold_reason } : {}), fixed: row.body_edited === true };
    });
    return [...sent, ...unsent];
  };

  /** 流水线里还没建任务的步骤：消息按规划提前算，套上老板提前做的安排。 */
  const plannedRows = (p: (typeof pipelines)[number]): ChainRow[] => {
    const rows: ChainRow[] = [];
    for (let index = p.tasks.length; index < iterationSteps(p.plan); index++) {
      const { input } = iterationStep(p.approval, p.plan, index);
      const bodies = iterationMessages(input);
      for (const step of ['execute', 'review'] as const) {
        const plan = plannedOf.get(`${p.requirement}:${p.revision}:${index}:${step}`);
        const body = typeof plan?.body === 'string' && plan.body.trim() ? plan.body : undefined;
        rows.push({ status: 'planned', when: p.paused ? '需求已暂停' : index === 0 ? '流水线下一轮建任务后发' : step === 'review' ? '这一步提交后发' : '上一步通过复核后建任务并发出',
          title: input.title, step, role: step === 'execute' ? input.executorRole : input.reviewerRole,
          plan: { requirement: p.requirement, revision: p.revision, index, step }, body: body ?? bodies[step], hold: plan?.hold === true, fixed: body !== undefined });
      }
    }
    return rows;
  };

  const chains: MessageChain[] = chainRoots.map(([root, ids]) => {
    const pipeline = pipelineOfRoot.get(root);
    // 流水线的任务按建出的顺序；其它链按父子关系深度优先（兄弟按创建时间）。
    const order = pipeline ? [...pipeline.tasks.filter(id => tasks.has(id)), ...ids.filter(id => !pipeline.tasks.includes(id))] : (() => {
      const out: string[] = [];
      const walk = (id: string) => { if (out.includes(id)) return; out.push(id); ids.filter(kid => keyOf(tasks.get(kid)?.parent) === id).forEach(walk); };
      walk(root); ids.forEach(walk);
      return out;
    })();
    return { id: root, title: pipeline ? pipeline.approval.content.title : String(tasks.get(root)?.title ?? ''),
      ...(pipeline ? { requirement: pipeline.requirement } : {}), rows: [...order.flatMap(rowsOfTask), ...(pipeline ? plannedRows(pipeline) : [])] };
  });
  // 已规划但一张任务都还没建的需求。
  for (const p of pipelines) {
    if (p.tasks.length) continue;
    chains.push({ id: `requirement:${p.requirement}`, title: p.approval.content.title, requirement: p.requirement, rows: plannedRows(p) });
  }
  // 有下一条要发的排前面，其余按标题。
  const weight = (chain: MessageChain) => chain.rows.some(row => row.status === 'held') ? 0 : chain.rows.some(row => row.status === 'next') ? 1 : 2;
  return chains.sort((a, b) => weight(a) - weight(b) || a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

/**
 * 老板提前安排流水线某一步的消息：改写正文（body 传 null 即恢复按规划生成）、建出后先扣住。
 * 只对还没建任务的步骤有效：已经建出任务的，直接改那条消息。
 */
export async function planMessage(db: Surreal, input: { requirement: string; revision: number; index: number; step: 'execute' | 'review'; body?: string | null; hold?: boolean }, actor: string):
  Promise<{ requirement: string; revision: number; index: number; step: string; body?: string; hold: boolean }> {
  const { CompanyError } = await import('./core-errors.ts');
  const { requirement, revision, index, step } = input;
  const [[row], [plan], [run]] = await db.query<[Array<{ approved_revision?: number }>, Array<{ body: string }>, Array<{ tasks?: string[] }>]>(
    'SELECT approved_revision FROM $requirement; SELECT body FROM $plan; SELECT tasks FROM $run;', {
      requirement: new RecordId('product_requirement', requirement), plan: new RecordId('requirement_plan', `${requirement}:${revision}`),
      run: new RecordId('requirement_execution', `${requirement}:${revision}`) });
  if (!row || row.approved_revision !== revision || !plan) throw new CompanyError('not_found', '没有这条需求的已确认规划');
  if (!Number.isInteger(index) || index < 0 || index >= iterationSteps(iterationPlan(JSON.parse(plan.body)))) throw new CompanyError('invalid', '规划里没有这一步');
  if (index < (run?.tasks?.length ?? 0)) throw new CompanyError('conflict', '这一步的任务已经建出，请直接改那条消息');
  const id = new RecordId('planned_message', `${requirement}:${revision}:${index}:${step}`);
  const [saved] = await db.query<[Array<{ body?: string; hold?: boolean }>]>(
    `UPSERT $id SET requirement = $requirement, revision = $revision, index = $index, step = $step, actor = $actor, updated_at = time::now()
      ${input.body !== undefined ? ', body = $body' : ''}${input.hold !== undefined ? ', hold = $hold' : ''} RETURN AFTER;`,
    { id, requirement, revision, index, step, actor, body: input.body?.trim() ? input.body : undefined, hold: input.hold === true });
  return { requirement, revision, index, step, ...(saved?.[0]?.body ? { body: saved[0].body } : {}), hold: saved?.[0]?.hold === true };
}
