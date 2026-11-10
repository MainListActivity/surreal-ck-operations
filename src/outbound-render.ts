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

/** 表里保存短正文；派工时 renderMessage 才补上真实路径、工具绝对路径与任务 ID。 */
const NOTES = `先读 notes.md。`;
/** 工作结果是业务输出；任务生命周期由执行端接管。 */
const END_TURN = `完成后直接给出最终答复：完成情况、验证结果和产物位置，然后结束本轮。执行端自动保存并送审。`;
const COMPANY = `需要账号、登录态、带登录链接或远程执行工具时，用 sck call company_cmd_catalog 查询可用工作能力。`;
const RESULT = `遇到实际前置缺口，最终答复首行写“工作结果：受阻”并说明缺少什么。`;
const EXECUTE_CODE = `${NOTES}实现 task.md 中的需求，在最终提交上按验收标准逐条自验。最终答复用单独一行“提交：<完整40位SHA>”标明被验证的提交。${COMPANY}${RESULT}${END_TURN}`;
const EXECUTE_PLAIN = `${NOTES}完成 task.md 中的需求，按验收标准自验。${COMPANY}${RESULT}${END_TURN}`;
const REVIEW_FIRST = `先查验收标准第 1 条（老板视角的结果）；不成立就说明原因并退回，成立后再逐条复验其余标准。`;
const REVIEW = `${NOTES}按 task.md 的验收标准独立复验。${REVIEW_FIRST}最终答复首行写“复核结论：通过”或“复核结论：退回”，正文给出逐条证据和发现。${COMPANY}${RESULT}结束本轮，执行端自动记录评审结果。`;
const REVIEW_CODE = REVIEW.replace('按 task.md 的验收标准独立复验。', '按 task.md 的验收标准独立复验，代码任务在最终合入提交上核对。');
const REWORK_CODE = `修复 findings/round-NN.md 中的问题后，` + EXECUTE_CODE;
const REWORK_PLAIN = `修复 findings/round-NN.md 中的问题后，` + EXECUTE_PLAIN;
const NUDGE = (phase: string) => phase === 'review' ? REVIEW : EXECUTE_PLAIN;

/** A route's own template still has to point the session at its notes; the stored draft is the full text the owner previews. */
export const routeBody = (body?: string): string | undefined =>
  body?.trim() ? (body.includes('notes.md') ? body : `${NOTES}${body}`) : undefined;

export const templateFor = (step: MessageStep, code = false, phase = 'doing'): string =>
  step === 'execute' ? (code ? EXECUTE_CODE : EXECUTE_PLAIN)
    : step === 'review' ? (code ? REVIEW_CODE : REVIEW)
      : step === 'rework' ? (code ? REWORK_CODE : REWORK_PLAIN)
        : NUDGE(phase);

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
    .replaceAll('task.md', taskFile)
    .replaceAll('notes.md', `${commDir.replace(/\/+$/, '')}/notes.md`)
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
