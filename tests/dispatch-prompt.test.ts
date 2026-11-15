import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskBrief } from '../src/dispatcher/brief.ts';
import { analysisLead, composeMessage, INLINE_LIMIT, RESOURCES_LIMIT, renderMessage, unrenderMessage } from '../src/outbound-render.ts';
import { taskMaterial } from '../src/runner/cloud-lane/lane.ts';
import { workResult } from '../src/runner/lifecycle.ts';

const card = { title: '导出订单', requirement: '给订单列表加一个导出 CSV 的按钮。', resources: '参考 src/export/users.ts 的做法；测试账号在 1Password 的“演示”库。', acceptance: '1. 老板点导出能下载到 CSV。\n2. 列头与页面一致。' };

test('执行消息就是任务卡的三段：做什么、可以用、验证', () => {
  expect(composeMessage('execute', card)).toBe([
    '给订单列表加一个导出 CSV 的按钮。',
    '',
    '可以用：',
    '参考 src/export/users.ts 的做法；测试账号在 1Password 的“演示”库。',
    'notes.md 是这条线积累的经验，先读。需要账号、登录态或远程执行工具时，用 sck call company_cmd_catalog 查可用的工作能力。',
    '',
    '验证：',
    '1. 老板点导出能下载到 CSV。',
    '2. 列头与页面一致。',
    '做完后在最终答复里写清完成情况、验证结果和产物位置，然后结束本轮；缺前置条件做不下去时，首行写“工作结果：受阻”并说明缺什么。',
  ].join('\n'));
});

test('代码任务只多一句：在最终提交上自验并写明提交，执行端认得这一行', () => {
  const body = composeMessage('execute', card, true);
  expect(body).toContain('在最终提交上逐条自验，最终答复用单独一行“提交：<完整40位SHA>”标明被验证的提交。');
  expect(composeMessage('execute', card)).not.toContain('提交：');
  const sha = 'a'.repeat(40);
  expect(workResult(`已完成\n提交：${sha}`, 'doing').evidence.sha).toBe(sha);
});

test('复核、返工、催办都带着任务卡原文，收尾约定仍能被执行端判定', () => {
  const review = composeMessage('review', card, true);
  expect(review).toStartWith('独立复验《导出订单》的交付');
  expect(review).toContain(`原需求：\n${card.requirement}`);
  expect(review).toContain(card.acceptance);
  expect(review).toContain('先查第 1 条（老板视角的结果）');
  expect(composeMessage('rework', card)).toStartWith('上一轮被退回，先修复 findings/round-NN.md 里的问题。\n\n给订单列表');
  expect(composeMessage('nudge', card)).toStartWith('上一轮结束时没有给出工作结果，请接着做完。\n\n给订单列表');
  expect(composeMessage('nudge', card, false, 'review')).toContain('复核结论：通过');
  // 消息里写给员工的结论格式，正是 workResult 认的格式。
  expect(workResult('复核结论：通过\n逐条证据……', 'review').action).toBe('accept');
  expect(workResult('复核结论：退回\n第 1 条不成立', 'review').action).toBe('return');
  expect(workResult('工作结果：受阻\n缺测试账号', 'doing').action).toBe('block');
});

test('没有写资源时只列每条线都有的两样；没有验收时请员工自己说明怎么验证', () => {
  const body = composeMessage('execute', { title: 'x', requirement: '整理周报' });
  expect(body).toContain('可以用：\nnotes.md 是这条线积累的经验');
  expect(body).toContain('自己验证结果成立，并说明是怎么验证的。');
});

test('超长的需求或验收不内联，改为指向 task.md', () => {
  const long = '长'.repeat(INLINE_LIMIT + 1);
  const body = composeMessage('execute', { title: '大需求', requirement: long, acceptance: long });
  expect(body).toStartWith('完成《大需求》，完整需求在 task.md。');
  expect(body).toContain('按 task.md 的验收标准逐条自验。');
  expect(body.length).toBeLessThan(600);
  expect(composeMessage('review', { title: '大需求', requirement: long, acceptance: long })).toContain('原需求见 task.md。');
  // 三段都顶格时仍在补译上限 20000 字之内；资源清单超长同样改为指向 task.md。
  const edge = '长'.repeat(INLINE_LIMIT);
  expect(composeMessage('review', { title: 't', requirement: edge, resources: '资'.repeat(RESOURCES_LIMIT), acceptance: edge, note: '注'.repeat(200) }, true).length).toBeLessThan(20_000);
  expect(composeMessage('execute', { title: 't', requirement: 'x', resources: '资'.repeat(RESOURCES_LIMIT + 1) })).toContain('任务卡列的资源见 task.md 的“可以用”一节。');
});

test('老板文字里的路径、任务号和命令渲染后逐字不变，改完能原样存回', () => {
  const ctx = { sckBin: '/opt/sck/bin/sck', commDir: '/comm/e1', taskId: 'abc-123', acId: 'AC-1' };
  const tricky = { title: 't', requirement: '按 docs/task.md 和 ./notes.md 里的约定改 abc-123 的接口，别动 my-task.md。', resources: '用 sck call media_list 查素材。', acceptance: 'x' };
  const body = composeMessage('rework', tricky, true);
  const shown = renderMessage(body, { ...ctx, findingsFile: 'findings/round-02.md' });
  expect(shown).toContain('按 docs/task.md 和 ./notes.md 里的约定改 abc-123 的接口，别动 my-task.md。');
  expect(shown).toContain("用 '/opt/sck/bin/sck' call media_list 查素材。");
  expect(shown).toContain('/comm/e1/notes.md 是这条线积累的经验');
  expect(shown).toContain('先修复 /comm/e1/findings/round-02.md 里的问题');
  const stored = unrenderMessage(shown, { ...ctx, findingsFile: 'findings/round-02.md' });
  expect(stored).toBeDefined();
  expect(renderMessage(stored!, { ...ctx, findingsFile: 'findings/round-02.md' })).toBe(shown);
  const edited = shown.replace('别动 my-task.md。', '别动 my-task.md，也别动 docs/task.md。');
  const storedEdit = unrenderMessage(edited, { ...ctx, findingsFile: 'findings/round-02.md' });
  expect(renderMessage(storedEdit!, { ...ctx, findingsFile: 'findings/round-02.md' })).toBe(edited);
});

test('task.md 带上“可以用”一节，云端与网页通道也读得到', () => {
  const md = taskBrief({ task: { title: '导出订单', context: '', requirement: card.requirement, resources: card.resources, acceptanceText: card.acceptance, state: 'doing' } as never });
  expect(md).toBe(`# 导出订单\n\n## 需求\n\n${card.requirement}\n\n## 可以用\n\n${card.resources}\n\n## 验收标准\n\n${card.acceptance}\n`);
});

test('退回意见按通信目录里的文件取，不看派工消息怎么写；复核轮不带', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sck-prompt-'));
  try {
    writeFileSync(join(dir, 'task.md'), '# 导出\n\n## 需求\n\n导出 CSV\n');
    expect(taskMaterial(dir, '先修复 findings/round-01.md').findings).toBeUndefined();
    mkdirSync(join(dir, 'findings'));
    writeFileSync(join(dir, 'findings', 'round-01.md'), '第一轮意见\n');
    writeFileSync(join(dir, 'findings', 'round-02.md'), '第二轮意见\n');
    expect(taskMaterial(dir, '老板把消息改成了别的话').findings).toBe('第二轮意见\n');
    expect(taskMaterial(dir).findings).toBe('第二轮意见\n');
    writeFileSync(join(dir, 'task.md'), '# 导出\n\n## 待复核成果\n\nxx\n');
    expect(taskMaterial(dir, '先修复 findings/round-02.md').findings).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('老板对受阻的答复放在消息最前面；太长时指向 answer.md，云端与网页通道内联它', async () => {
  const { answerFile, latestAnswer } = await import('../src/dispatcher/brief.ts');
  const { ANSWER_LIMIT } = await import('../src/outbound-render.ts');
  const { vendorPrompt } = await import('../src/runner/cloud-lane/lane.ts');
  const entry = (action: string, evidence: string) => ({ action, actor: 'x', at: '2026-11-14T00:00:00Z', evidence });
  const history = [entry('submit', '旧结果'), entry('block', '执行端自动收集的工作结果：\n工作结果：受阻\n缺支付沙箱的密钥。'),
    entry('owner_reply', '来源：web\n决定：reply\n密钥在 1Password 的“沙箱”库，条目名 pay-sandbox。'), entry('claim', '')];
  const answer = latestAnswer(history);
  expect(answer).toEqual({ blocker: '缺支付沙箱的密钥。', reply: '密钥在 1Password 的“沙箱”库，条目名 pay-sandbox。' });
  // 答复之后有了新的工作结果，或又受阻但还没答复：没有待转达的答复。
  expect(latestAnswer([...history, entry('submit', '新结果')])).toBeUndefined();
  expect(latestAnswer([...history, entry('block', '工作结果：受阻\n又缺别的')])).toBeUndefined();
  expect(latestAnswer([entry('owner_reply', '来源：web\n决定：reply\n没有受阻记录的答复也带上')])).toEqual({ blocker: undefined, reply: '没有受阻记录的答复也带上' });

  const body = composeMessage('rework', { ...card, answer }, true);
  expect(body).toStartWith('上一轮你报告受阻：缺支付沙箱的密钥。\n老板答复：\n密钥在 1Password 的“沙箱”库，条目名 pay-sandbox。\n按答复接着做。\n\n上一轮被退回，先修复 findings/round-NN.md 里的问题。\n\n给订单列表');
  const long = composeMessage('execute', { ...card, answer: { reply: '答'.repeat(ANSWER_LIMIT + 1) } });
  expect(long).toStartWith('上一轮你报告受阻。\n老板已答复，答复较长，全文在 answer.md，先读。\n按答复接着做。\n\n');
  const ctx = { sckBin: '/bin/sck', commDir: '/comm/e1', taskId: 't1' };
  const shown = renderMessage(long, ctx);
  expect(shown).toContain('全文在 /comm/e1/answer.md，先读。');
  expect(renderMessage(unrenderMessage(shown, ctx)!, ctx)).toBe(shown);

  const dir = mkdtempSync(join(tmpdir(), 'sck-answer-'));
  try {
    writeFileSync(join(dir, 'task.md'), '# 导出\n\n## 需求\n\n导出 CSV\n');
    expect(taskMaterial(dir).answer).toBeUndefined();
    writeFileSync(join(dir, 'answer.md'), answerFile(answer!));
    const material = taskMaterial(dir);
    expect(material.answer).toBe('## 上一轮受阻\n\n缺支付沙箱的密钥。\n\n## 老板答复\n\n密钥在 1Password 的“沙箱”库，条目名 pay-sandbox。\n');
    const prompt = vendorPrompt({ provider: 'jules', prompt: 'x' } as never, { slug: 'o/r', branch: 'b', defaultBranch: 'main' } as never, material);
    expect(prompt).toContain('## 上次受阻与老板的答复（按答复接着做）\n## 上一轮受阻');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('完工分析的模型输出要过校验：枚举、长度、条数', async () => {
  const { turnAnalysis } = await import('../src/turn-analysis.ts');
  const ok = { status: 'partial', summary: '做了导出，没贴测试输出', needs: ['测试账号'], next: '先补单元测试的输出。', confidence: 'low' };
  expect(turnAnalysis(ok)).toEqual(ok as never);
  expect(turnAnalysis({ ...ok, needs: undefined }).needs).toEqual([]);
  for (const bad of [null, [], { ...ok, status: 'done' }, { ...ok, confidence: 'sure' }, { ...ok, summary: '' }, { ...ok, summary: 42 }]) {
    expect(() => turnAnalysis(bad)).toThrow();
  }
  // 长度和条数不靠模型自己数：超出的截断，不是文本的丢掉，next 可以为空。
  const loose = turnAnalysis({ ...ok, summary: 'x'.repeat(900), next: '', needs: ['a', 7, '', 'b'.repeat(300), 'c', 'd', 'e', 'f'] });
  expect(loose.summary).toHaveLength(400);
  expect(loose.next).toBe('');
  expect(loose.needs).toEqual(['a', 'b'.repeat(200), 'c', 'd', 'e']);
  expect(turnAnalysis({ ...ok, needs: 'none' }).needs).toEqual([]);
});

test('返工消息的复盘段：在“先修复退回意见”之后、任务说明之前；只有返工带', () => {
  const lead = analysisLead('上一轮导出报 500。先修接口。')!;
  expect(lead).toBe('上一轮的情况（系统读退回意见后整理的，与退回意见原文不一致时以原文为准）：\n上一轮导出报 500。先修接口。');
  expect(analysisLead('  ')).toBeUndefined();
  const task = { title: '导出', requirement: '给订单列表加导出', acceptance: '能下载', analysisLead: lead };
  expect(composeMessage('rework', task)).toStartWith(`上一轮被退回，先修复 findings/round-NN.md 里的问题。\n\n${lead}\n\n给订单列表加导出`);
  expect(composeMessage('execute', task)).not.toContain('上一轮的情况');
  expect(composeMessage('review', task)).not.toContain('上一轮的情况');
});

test('云端与网页通道收到的正文就是派工消息：路径换成“下文《…》”，文件内容附在后面', async () => {
  const { laneMessage, vendorPrompt } = await import('../src/runner/cloud-lane/lane.ts');
  const { botMessage } = await import('../src/runner/grok-bot/turn.ts');
  const dir = mkdtempSync(join(tmpdir(), 'sck-lane-message-'));
  try {
    writeFileSync(join(dir, 'task.md'), '# 写三条口号\n\n完整任务卡正文\n');
    writeFileSync(join(dir, 'notes.md'), '口号不要用感叹号。\n');
    const ctx = { sckBin: '/Users/x/Application Support/bin/sck', commDir: dir, taskId: 't1' };
    const body = composeMessage('execute', { title: '写三条口号', requirement: '给新品写三条口号，每条不超过 8 个字。', resources: '品牌手册在官网“关于”页。', acceptance: '三条，各不超过 8 个字。' });
    // 老板在页面上改过的消息：改成什么，agent 收到的就是什么。
    const edited = renderMessage(`${body}\n\n老板补充：语气要克制。`, ctx);
    const execute = taskMaterial(dir, `${edited}\n工作目录：/repo/worktree`);
    expect(execute.message).toStartWith('给新品写三条口号，每条不超过 8 个字。\n\n可以用：\n品牌手册在官网“关于”页。\n下文《这条线的笔记》 是这条线积累的经验，先读。');
    expect(execute.message).toContain('老板补充：语气要克制。');
    expect(execute.message).toContain('## 这条线的笔记\n\n口号不要用感叹号。');
    // 本机才有的东西不带：绝对路径、工作目录行、公司命令的指引；没指向 task.md 就不附整份任务卡。
    expect(execute.message).not.toContain(dir);
    expect(execute.message).not.toContain('工作目录：');
    expect(execute.message).not.toContain('company_cmd_catalog');
    expect(execute.message).not.toContain('完整任务卡正文');
    expect(botMessage('m1', execute)).toContain(execute.message!);
    expect(vendorPrompt({ provider: 'jules', prompt: 'x' } as never, { slug: 'o/r', branch: 'b', defaultBranch: 'main' } as never, execute)).toEndWith(execute.message!);

    // 返工：退回意见一定附上，即使老板把那句话删了；老板的答复较短时正文里已有原话，不再附一遍。
    mkdirSync(join(dir, 'findings'), { recursive: true });
    writeFileSync(join(dir, 'findings', 'round-01.md'), '第 2 条超过 8 个字。\n');
    writeFileSync(join(dir, 'answer.md'), '## 老板答复\n\n可以用“轻”字。\n');
    const rework = renderMessage(composeMessage('rework', { requirement: '给新品写三条口号。', acceptance: '三条。', answer: { blocker: '不知道能不能用“轻”字', reply: '可以用“轻”字。' } }), { ...ctx, findingsFile: 'findings/round-01.md' });
    const reworked = laneMessage(rework, dir, taskMaterial(dir))!;
    expect(reworked).toContain('先修复 下文《上一轮的退回意见》 里的问题。');
    expect(reworked).toContain('## 上一轮的退回意见\n\n第 2 条超过 8 个字。');
    expect(reworked).toContain('老板答复：\n可以用“轻”字。');
    expect(reworked).not.toContain('## 老板答复全文');
    // 老板整段改写成一句话：答复、退回意见和整份任务卡都附上，一样不丢。
    expect(laneMessage('老板把消息改成了别的话', dir, taskMaterial(dir))).toBe('老板把消息改成了别的话\n\n## 老板答复全文\n\n## 老板答复\n\n可以用“轻”字。\n\n## 上一轮的退回意见\n\n第 2 条超过 8 个字。\n\n## 任务全文\n\n# 写三条口号\n\n完整任务卡正文');

    // 复核：待复核成果只在 task.md 里，一定附上。
    rmSync(join(dir, 'findings'), { recursive: true }); rmSync(join(dir, 'answer.md'));
    writeFileSync(join(dir, 'task.md'), '# 写三条口号\n\n## 待复核成果\n\n轻一点 / 再轻一点 / 轻到刚好\n');
    const review = taskMaterial(dir, renderMessage(composeMessage('review', { title: '写三条口号', requirement: '给新品写三条口号。', acceptance: '三条。' }), ctx));
    expect(review.review).toBe(true);
    expect(review.message).toContain('提交的成果在 下文《任务全文》 的“待复核成果”一节。');
    expect(review.message).toContain('## 任务全文\n\n# 写三条口号\n\n## 待复核成果\n\n轻一点 / 再轻一点 / 轻到刚好');
    // 没有派工消息时退回到整份任务材料。
    expect(taskMaterial(dir).message).toBeUndefined();
    expect(botMessage('m2', taskMaterial(dir))).toContain('轻一点 / 再轻一点 / 轻到刚好');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('老板插话的开头：在老板答复之后、正文之前，逐条原话', async () => {
  const { noteLead, ownerLead } = await import('../src/outbound-render.ts');
  expect(noteLead([])).toBeUndefined();
  expect(noteLead(['列头用中文。', ' 金额两位小数。 '])).toBe('老板补充（上一轮进行中说的，按这个调整）：\n列头用中文。\n金额两位小数。');
  const task = { requirement: '给订单列表加导出', answer: { blocker: '缺账号', reply: '用 test_kit 领。' }, notes: ['列头用中文。'] };
  expect(composeMessage('execute', task)).toStartWith(`${ownerLead(task)}\n\n给订单列表加导出`);
  expect(ownerLead(task)).toBe('上一轮你报告受阻：缺账号\n老板答复：\n用 test_kit 领。\n按答复接着做。\n\n老板补充（上一轮进行中说的，按这个调整）：\n列头用中文。');
});
