/**
 * 派工消息的纯渲染：模板、占位替换、工作目录行与反向渲染。不读数据库，也不读宿主状态。
 * 派工投递与老板看板共用这里的函数，员工收到的文本与看板上显示的文本逐字相等。
 */
export type MessageStep = 'execute' | 'review' | 'rework' | 'nudge' | 'notice';

/** The concrete values a stored body renders with. A preview and the real send use the same context, so they match. */
export interface RenderContext {
  sckBin: string;
  commDir: string;
  findingsFile?: string;
  taskId: string;
  acId?: string;
}

/** The deploy-leg machine criterion id every code dispatch may name when the task carries no readable criteria. */
export const DEFAULT_MACHINE_CRITERION = 'AC-BASE-DEPLOY-1';

/** 任务卡上决定派工正文的字段。任务字段是事实来源：没被老板改过的草稿随这些字段重算。 */
export interface PromptTask {
  title?: string;
  /** 做什么。 */
  requirement?: string;
  /** 可以用什么：老板在任务卡上写的工具、账号、资料、参考实现。 */
  resources?: string;
  /** 如何验证。 */
  acceptance?: string;
  /** 这一步必须守的流程约束（如“不要合并 PR”），紧跟在“做什么”后面；需求再长也留在消息里。 */
  note?: string;
}

/** 超过这个长度的需求或验收不内联进消息，改为指向 task.md：长文档放文件里，消息只说要点。 */
export const INLINE_LIMIT = 6000;

const fits = (text?: string): boolean => !!text?.trim() && text.trim().length <= INLINE_LIMIT;
const titled = (task: PromptTask) => task.title?.trim() ? `《${task.title.trim()}》` : '这项任务';

/** 每条线都有的两样：线的笔记与公司工作能力目录。 */
const COMMON_RESOURCES = `notes.md 是这条线积累的经验，先读。需要账号、登录态或远程执行工具时，用 sck call company_cmd_catalog 查可用的工作能力。`;
/** 收尾约定：执行端靠首行结论给任务收尾（runner/lifecycle.ts 的 workResult），完工分析上线前必须留在消息里。 */
const CLOSE_EXECUTE = `做完后在最终答复里写清完成情况、验证结果和产物位置，然后结束本轮；缺前置条件做不下去时，首行写“工作结果：受阻”并说明缺什么。`;
const CLOSE_REVIEW = `最终答复首行写“复核结论：通过”或“复核结论：退回”，随后逐条给出证据，然后结束本轮；无法复核时首行写“工作结果：受阻”并说明缺什么。`;
const REVIEW_FIRST = `先查第 1 条（老板视角的结果），不成立就说明原因并退回；成立后再逐条复验其余标准。`;

const resourcesSection = (task: PromptTask): string =>
  ['可以用：', task.resources?.trim(), COMMON_RESOURCES].filter(Boolean).join('\n');

function executeMessage(task: PromptTask, code: boolean): string {
  const what = fits(task.requirement) ? task.requirement!.trim() : `完成${titled(task)}，完整需求在 task.md。`;
  const verify = ['验证：',
    fits(task.acceptance) ? task.acceptance!.trim() : task.acceptance?.trim() ? '按 task.md 的验收标准逐条自验。' : '自己验证结果成立，并说明是怎么验证的。',
    code ? '在最终提交上逐条自验。' : undefined, CLOSE_EXECUTE].filter(Boolean).join('\n');
  return [what, task.note?.trim() ? `注意：${task.note.trim()}` : undefined, resourcesSection(task), verify].filter(Boolean).join('\n\n');
}

function reviewMessage(task: PromptTask, code: boolean): string {
  const what = [`独立复验${titled(task)}的交付，提交的成果在 task.md 的“待复核成果”一节。`,
    fits(task.requirement) ? `原需求：\n${task.requirement!.trim()}` : '原需求见 task.md。'].join('\n\n');
  const verify = ['验证：', fits(task.acceptance) ? task.acceptance!.trim() : '按 task.md 的验收标准逐条复验。',
    REVIEW_FIRST, code ? '代码任务在最终合入提交上核对。' : undefined, CLOSE_REVIEW].filter(Boolean).join('\n');
  return [what, task.note?.trim() ? `注意：${task.note.trim()}` : undefined, resourcesSection(task), verify].filter(Boolean).join('\n\n');
}

/**
 * 派工正文：做什么、可以用什么、如何验证三段，内容取自任务卡。存进表里的就是完整正文，老板看到、改到的与员工收到的是同一段话。
 * 返工在前面加一句指向退回意见；催办在前面加一句说明上一轮没有结果。
 */
export function composeMessage(step: MessageStep, task: PromptTask, code = false, phase = 'doing'): string {
  if (step === 'review') return reviewMessage(task, code);
  if (step === 'rework') return `上一轮被退回，先修复 findings/round-NN.md 里的问题。\n\n${executeMessage(task, code)}`;
  if (step === 'execute') return executeMessage(task, code);
  return `上一轮结束时没有给出工作结果，请接着做完。\n\n${phase === 'review' ? reviewMessage(task, code) : executeMessage(task, code)}`;
}

/** A route's own template still has to point the session at its notes; the stored draft is the full text the owner previews. */
export const routeBody = (body?: string): string | undefined =>
  body?.trim() ? (body.includes('notes.md') ? body : `先读 notes.md。${body}`) : undefined;

/**
 * Pure send-time rewriting of the stored short body. The owner edits the short form; the employee receives
 * concrete absolute paths and a tool binary that is actually on disk. No database or host state is read here.
 */
export function renderMessage(body: string, opts: RenderContext): string {
  const { sckBin, commDir, findingsFile, taskId, acId } = opts;
  const taskFile = `${commDir.replace(/\/+$/, '')}/task.md`;
  const findings = findingsFile ? `${commDir.replace(/\/+$/, '')}/${findingsFile.replace(/^\/+/, '')}` : undefined;
  return body
    .replaceAll('{taskId}', taskId)
    .replaceAll('{acId}', acId ?? DEFAULT_MACHINE_CRITERION)
    .replaceAll('sck call', `'${sckBin}' call`)
    .replaceAll(/(?<![\w./-])task\.md/g, () => taskFile)
    .replaceAll(/(?<![\w./-])notes\.md/g, () => `${commDir.replace(/\/+$/, '')}/notes.md`)
    .replaceAll(/findings\/round-(?:\d+|NN)\.md/g, findings ?? 'findings/round-NN.md');
}

/** Head of the workdir line a dispatch appends after the rendered body. The line is absent when the claim names no worktree. */
const WORKDIR_HEAD = '工作目录：';

/** What the employee receives: the rendered body, then the workdir line when the dispatch names one. */
export function dispatchText(body: string, workdir?: string): string {
  return workdir ? `${body}\n${WORKDIR_HEAD}${workdir}` : body;
}

/**
 * The rendered body without the workdir line a dispatch appends. The owner edits the text the employee will read; the workdir line
 * is the claim's to name, so an edit takes it off before the body is reversed, and the dispatch appends it again.
 */
export function bodyOfDispatch(text: string): string {
  const at = text.lastIndexOf(`\n${WORKDIR_HEAD}`);
  return at >= 0 && !text.slice(at + 1).includes('\n') ? text.slice(0, at) : text;
}

/** The step a task's next dispatch sends: review while the task is in review, rework after any return, otherwise execute. */
export function stepOfTask(state: string | undefined, returned: boolean): MessageStep {
  return state === 'review' ? 'review' : returned ? 'rework' : 'execute';
}

/** The first required machine criterion of a task's acceptance list; the default leg id when none is readable. */
export function machineCriterionOf(criteria: unknown): string {
  if (Array.isArray(criteria)) {
    for (const item of criteria) {
      if (item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'machine' &&
        (item as { required?: unknown }).required === true && typeof (item as { id?: unknown }).id === 'string') {
        return (item as { id: string }).id;
      }
    }
  }
  return DEFAULT_MACHINE_CRITERION;
}

/** Code steps name the task's machine criterion; plain steps carry no {acId} placeholder. */
export function acIdOf(step: MessageStep, criteria: unknown): string | undefined {
  return step === 'execute' || step === 'rework' ? machineCriterionOf(criteria) : undefined;
}

/**
 * The stored body that renders back to exactly `rendered` under `ctx`, or undefined when no such body exists. The owner edits
 * the text the employee will receive. The edit is kept only when rendering the stored body reproduces the edited text, so a path or
 * a command typed by hand can never reach the employee differently from what the board showed.
 */
export function unrenderMessage(rendered: string, ctx: RenderContext): string | undefined {
  const commDir = ctx.commDir.replace(/\/+$/, '');
  const swap = (source: string, from: string, to: string) => from ? source.split(from).join(to) : source;
  let body = rendered;
  if (ctx.findingsFile) body = swap(body, `${commDir}/${ctx.findingsFile.replace(/^\/+/, '')}`, 'findings/round-NN.md');
  body = swap(body, `'${ctx.sckBin}' call`, 'sck call');
  body = swap(body, `${commDir}/notes.md`, 'notes.md');
  body = swap(body, `${commDir}/task.md`, 'task.md');
  body = swap(body, ctx.taskId, '{taskId}');
  body = swap(body, ctx.acId ?? DEFAULT_MACHINE_CRITERION, '{acId}');
  return renderMessage(body, ctx) === rendered ? body : undefined;
}
