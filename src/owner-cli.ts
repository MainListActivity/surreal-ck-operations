import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from './config.ts';
import { CompanyDatabase } from './database.ts';
import { OwnerDesk, type OwnerCommandKind } from './owner.ts';
import { Workforce } from './workforce.ts';

const usage = `老板入口（也可直接在 SurrealDB 写 owner_command 表，或在 Paseo 里对经理说）
  pnpm run company goal [--tier quick|standard|program] [--project <项目>] "<目标>"
                                             提出新目标；不指定 tier 时由 Jev/经理分级
  pnpm run company direction "<公司方向>"    记录公司运作方向，所有员工可见
  pnpm run company inbox                     查看待你决定的关口、员工提问和系统提醒
  pnpm run company approve <任务ID> [意见]   批准关口
  pnpm run company reject <任务ID> <意见>    驳回关口（退回执行者按意见修改）
  pnpm run company reply <任务ID> <回答>     回答员工提问并恢复任务
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
  const commands: Record<string, (argv: string[]) => { kind: OwnerCommandKind; task?: string; text?: string; tier?: string; project?: string }> = {
    goal: argv => {
      const tier = flag(argv, 'tier');
      const project = flag(argv, 'project');
      return { kind: 'goal', text: argv.join(' '), tier, project };
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
      "CREATE owner_command CONTENT { kind: $kind, task: $task, text: $text, tier: $tier, project: $project, source: 'cli' };", command);
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
