import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from './config.ts';
import { CompanyDatabase } from './database.ts';
import type { Role } from './contracts.ts';
import { OwnerDesk, type OwnerCommandKind } from './owner.ts';
import { Workforce } from './workforce.ts';

const usage = `老板入口（也可直接在 SurrealDB 写 owner_command 表，或在 Paseo 里对经理说）
  pnpm run company goal [--tier quick|standard|program] [--project <项目>] [--pipeline software|video|story] "<目标>"
                                             提出新目标；不指定 tier 时由 Jev/经理分级
  pnpm run company direction "<公司方向>"    记录公司运作方向，所有员工可见
  pnpm run company inbox                     查看待你决定的关口、员工提问和系统提醒
  pnpm run company approve <任务ID> [意见]   批准关口
  pnpm run company reject <任务ID> <意见>    驳回关口（退回执行者按意见修改）
  pnpm run company reply <任务ID> <回答>     回答员工提问并恢复任务
  pnpm run company reassign <任务ID> [--executor <岗位>] [--reviewer <岗位|owner>] <原因>
                                             改派还没开工（blocked/ready、无租约、未提交）的任务；校验岗位契约，留审计
  pnpm run company revoke <任务ID> [原因]    终止在途执行：撤掉当前持有人的租约回到 ready，任务保留等下一位员工（要整个任务作废用 void）
  pnpm run company void <任务ID> <原因>      作废任务（依赖它的任务会解锁；终验关口作废不会关闭目标）
  pnpm run company unlock <任务ID>           补跑已完成/作废任务的依赖解锁（任务依赖都完成了却还是 blocked 时用）
  pnpm run company cancel-goal <目标ID> <原因>  取消目标：作废其全部未完成任务并关闭目标
  pnpm run company pause | resume            暂停/恢复派工
  pnpm run company status                    公司运行概况`;

const [action, first, ...rest] = process.argv.slice(2);
if (!action) { console.log(usage); process.exit(0); }
const db = new CompanyDatabase(loadDatabaseConfig());
const desk = new OwnerDesk(db);
try {
  await db.connect();
  await db.bootstrap();
  const flag = (argv: string[], name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? undefined : argv.splice(at, 2)[1];
  };
  const commands: Record<string, (argv: string[]) => { kind: OwnerCommandKind; task?: string; text?: string; tier?: string; project?: string; pipeline?: string }> = {
    goal: argv => {
      const tier = flag(argv, 'tier');
      const project = flag(argv, 'project');
      const pipeline = flag(argv, 'pipeline');
      return { kind: 'goal', text: argv.join(' '), tier, project, pipeline };
    },
    direction: argv => ({ kind: 'direction', text: argv.join(' ') }),
    approve: ([task, ...note]) => ({ kind: 'approve', task, text: note.join(' ') }),
    reject: ([task, ...note]) => ({ kind: 'reject', task, text: note.join(' ') }),
    reply: ([task, ...note]) => ({ kind: 'reply', task, text: note.join(' ') }),
    pause: () => ({ kind: 'pause' }),
    resume: () => ({ kind: 'resume' }),
  };
  if (commands[action]) {
    const command = commands[action]([first ?? '', ...rest].filter(Boolean));
    const [[created]] = await db.db.query<[[{ id: RecordId }]]>(
      "CREATE owner_command CONTENT { kind: $kind, task: $task, text: $text, tier: $tier, project: $project, pipeline: $pipeline, source: 'cli' };", command);
    await desk.applyPending();
    const row = await db.db.select<{ status: string; result?: string }>(created.id);
    console.log(`${row?.status === 'applied' ? '已执行' : row?.status === 'failed' ? '失败' : '已排队'}：${action} ${row?.result ?? ''}`);
    if (row?.status === 'failed') process.exitCode = 1;
  } else if (action === 'inbox') {
    const inbox = await desk.inbox();
    if (!inbox.gates.length && !inbox.questions.length && !inbox.notices.length) console.log('没有待你处理的事项。');
    for (const gate of inbox.gates) {
      console.log(`\n=== 关口 ${gate.task.id} ===\n${gate.task.title}\n\n${gate.submission ?? '（无提交内容）'}`);
      console.log(`\n→ 批准：pnpm run company approve ${gate.task.id} [意见]\n→ 驳回：pnpm run company reject ${gate.task.id} <意见>`);
    }
    for (const q of inbox.questions) {
      console.log(`\n=== 员工提问 ${q.task.id} ===\n${q.task.title}\n\n${q.question ?? ''}\n\n→ 回答：pnpm run company reply ${q.task.id} <回答>`);
    }
    const other = inbox.notices.filter(n => !/^(gate|question):/.test(n.key));
    if (other.length) console.log(`\n=== 系统提醒 ===\n${other.map(n => `- ${n.text}`).join('\n')}`);
  } else if (action === 'reassign') {
    const args = [first ?? '', ...rest].filter(Boolean);
    const executorRole = flag(args, 'executor') as Role | undefined;
    const reviewerRole = flag(args, 'reviewer') as Role | 'owner' | undefined;
    const [taskId, ...note] = args;
    if (!taskId) throw new Error('用法：pnpm run company reassign <任务ID> [--executor <岗位>] [--reviewer <岗位|owner>] <原因>');
    const task = await desk.reassign({ taskId, executorRole, reviewerRole, note: note.join(' '), source: 'owner:cli', key: `cli:${taskId}:${executorRole ?? ''}:${reviewerRole ?? ''}` });
    console.log(`已改派：${task.title}\n执行 ${task.executorRole}｜验收 ${task.reviewerRole}｜状态 ${task.state}`);
  } else if (action === 'revoke') {
    const [taskId, ...note] = [first ?? '', ...rest].filter(Boolean);
    if (!taskId) throw new Error('用法：pnpm run company revoke <任务ID> [原因]');
    const workforce = new Workforce(db, process.env.SCK_CREDENTIAL_DIR ?? '/nonexistent');
    const reason = note.join(' ') || '老板终止在途执行';
    const result = await workforce.revokeTaskLease(taskId, reason,
      '【交接包】老板终止了上一棒的在途执行。先核对任务分支/授权目录中的实际改动与已有 checkpoint，再继续；不要重复已完成且已验证的步骤。',
      'owner:cli');
    if (!result.ok) { console.log('该任务没有在途租约可撤。'); process.exitCode = 1; }
    else console.log(`已撤销 ${result.employee} 的租约，任务回到 ready 等下一位员工。`);
  } else if (action === 'void') {
    const [taskId, ...note] = [first ?? '', ...rest].filter(Boolean);
    if (!taskId) throw new Error('用法：pnpm run company void <任务ID> <原因>');
    const task = await desk.retire({ taskId, note: note.join(' '), source: 'owner:cli', key: `cli-void:${taskId}` });
    console.log(`已作废：${task.title}（${task.state}）`);
  } else if (action === 'unlock') {
    if (!first) throw new Error('用法：pnpm run company unlock <任务ID>');
    const unlocked = await desk.unlockDependents({ taskId: first, source: 'owner:cli' });
    console.log(unlocked.length ? `已解锁：${unlocked.join('、')}` : '没有需要解锁的任务。');
  } else if (action === 'cancel-goal') {
    const [goalId, ...note] = [first ?? '', ...rest].filter(Boolean);
    if (!goalId) throw new Error('用法：pnpm run company cancel-goal <目标ID> <原因>');
    const result = await desk.cancelGoal({ goalId, note: note.join(' '), source: 'owner:cli', key: `cli-cancel:${goalId}` });
    console.log(`已作废 ${result.retired} 个任务；${result.remaining ? `仍有 ${result.remaining} 个未能作废，目标保持原状` : '目标已关闭（cancelled）'}`);
  } else if (action === 'status') {
    const workforce = new Workforce(db, '/nonexistent');
    const [brief, tasks, insts, health, config, defs] = await Promise.all([
      desk.brief(), workforce.tasks(), workforce.insts(), workforce.providerHealth(), workforce.config(), workforce.defs()]);
    const count = (state: string) => tasks.filter(t => t.state === state).length;
    console.log(`派工：${config.paused ? '已暂停' : '运行中'}（最多同时 ${config.maxRunning} 位员工）`);
    console.log(`任务：待办 ${count('ready')} · 进行中 ${count('doing')} · 待验收 ${count('review')} · 阻塞 ${count('blocked')}`);
    console.log(`在办目标：${brief.goals.map(g => `${g.title}（${g.id}，${g.state === 'triage' ? '待分级' : g.tier ?? '旧流程'}）`).join('、') || '无'}`);
    if (brief.projects.length) console.log(`项目环境：${brief.projects.map(p => `${p.id}（${p.envs.map(e => e.name).join('/')}）`).join('、')}`);
    console.log(`在职员工：${insts.map(i => `${i.id}@${i.provider ?? '?'}`).join('、') || '无'}`);
    console.log(`订阅：${[...health.values()].map(h => `${h.provider}=${h.state}${h.until ? `(至 ${new Date(h.until * 1000).toLocaleString('zh-CN')})` : ''}`).join('、') || '全部正常'}`);
    const scored = defs.filter(d => d.scored > 0);
    if (scored.length) {
      console.log(`绩效均分：${scored.map(d => `${d.id}=${d.avgScore?.toFixed(1)}分/${d.scored}次`).join('、')}`);
    }
    if (brief.directions.length) console.log(`公司方向：\n${brief.directions.map(d => `- ${d.text}`).join('\n')}`);
  } else {
    console.log(usage);
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
