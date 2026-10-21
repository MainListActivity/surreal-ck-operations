import type { CreateTask, GoalTier, TaskKind } from './contracts.ts';

export const GOAL_TIERS: readonly GoalTier[] = ['quick', 'standard', 'program'];

/** Production lines: each has its own goal template. `software` is the original delivery flow. */
export const PIPELINES = ['software', 'video', 'story'] as const;
export type PipelineId = typeof PIPELINES[number];
export const isPipeline = (value: unknown): value is PipelineId => PIPELINES.includes(value as PipelineId);

type Spec = Pick<CreateTask, 'title' | 'context' | 'executorRole' | 'reviewerRole'> & { kind: Exclude<TaskKind, 'goal'> };

const AUTHORITY = '决策边界：能在公司内决定的事不找老板。技术方案与拆分由经理定，是否上线由运营定，运营定不了交经理；只有花钱/充值、签约、对外联系、公司方向和项目红线才 report_blocker to=owner，并写明已查过哪些来源。';

const OPS_HINT = '你不持有任何凭证：测试账号、workspace、成员、生产登录一律用运维工具 ops_*（sck call ops_info \'{}\' 看当前项目能做什么）；运维工具没有的能力用 report_blocker to=gm 说明要补什么工具。';

function chainHead(title: string, spec: string): string {
  return `交付项：${title}\n需求与验收标准：\n${spec}\n\n项目环境（仓库、发布方式、生产地址、红线）见 claim.json 的 project。${OPS_HINT}\n`;
}

/** 实现 → 上线申请 → 合入部署与生产实测. Used by standard/program plans via the create_delivery tool. */
export function deliveryChain(title: string, spec: string): Spec[] {
  const head = chainHead(title, spec);
  return [
    {
      title: `${title} · 实现`, kind: 'task', executorRole: 'engineering', reviewerRole: 'engineering',
      context: `${head}
你是工程。按 claim.json.worktree 的登记路径、分支与写权实现：树和分支由调度按任务或所属线（worktree.lane）分配，同一线的任务共用一棵树和一个分支，接手时在现有提交上继续，不另开分支；已有未合入 PR 就追加提交。仅在 intent=code 的登记分支提交，不自行新建/checkout/reset/pull，遵守该仓库 AGENTS 与技能；附件写 evidenceDir。
完成标准：测试通过，推送分支并创建 PR（不要合入）。
submit 证据：PR 链接、分支、提交 SHA、测试命令与结果、数据库迁移类型（无 / 只新增结构 / 改写或删除已有数据）、需要的新环境变量或主机准备。
验收者是另一位工程师：读 diff、跑测试、确认 PR 的 CI 通过；不通过就 return 并写明问题。`,
    },
    {
      title: `${title} · 上线申请`, kind: 'release', executorRole: 'engineering', reviewerRole: 'product',
      context: `${head}
你是工程。前置任务的 PR 已通过代码复核。提交上线申请：PR 链接与提交、改动摘要、影响面、数据库迁移类型、新环境变量或主机准备、回滚方式、生产验证要点。
验收者是运营，由运营决定是否上线（调度器用 Jev 判断，高置信安全时自动批准）。运营 accept = 同意上线；return = 暂不上线并写明需要补什么。
运营：只在触碰 project.redLines 或需要花钱、对外联系时 report_blocker to=gm，其余自己决定。
${AUTHORITY}`,
    },
    {
      title: `${title} · 合入部署与生产实测`, kind: 'deploy', executorRole: 'engineering', reviewerRole: 'qa',
      context: `${head}
你是工程。上线申请已批准。按 project.release 发布：合入 PR、等待 CI 发布完成、确认生产运行的就是该提交（health、版本或页面）。
发布失败或自动回滚：先按 project.rollback 恢复生产，再修复后重新发布；修不好就 report_blocker to=gm。
submit 证据：合入提交、CI 运行链接与结论、生产健康检查结果。
验收者 qa：在生产环境按上面的验收标准逐条实测。测试账号、workspace、登录用运维工具（ops_login、ops_workspace_ensure、ops_browser_login 等）；你拿不到也不需要密码或 token，证据里只写账号别名和 workspace slug。
accept 证据逐条写：入口链接 → 操作 → 实际结果（截图路径或响应摘要）。任何一条不通过就 return 给工程。`,
    },
  ];
}

/**
 * quick 目标的合并交付链：实现+上线申请合一（工程交活时一并写上线申请，运营/Jev 决定是否上线）
 * → 合入部署与生产实测。比标准链少一轮复核与派工；quick 即小改动，不再走独立的工程互审。
 */
export function quickChain(title: string, spec: string): Spec[] {
  const head = chainHead(title, spec);
  return [
    {
      title: `${title} · 实现与上线申请`, kind: 'release', executorRole: 'engineering', reviewerRole: 'product',
      context: `${head}
你是工程。按 claim.json.worktree 的登记路径、分支与写权实现：树和分支由调度按任务或所属线（worktree.lane）分配，同一线的任务共用一棵树和一个分支，接手时在现有提交上继续，不另开分支；已有未合入 PR 就追加提交。仅在 intent=code 的登记分支提交，不自行新建/checkout/reset/pull，遵守该仓库 AGENTS 与技能；附件写 evidenceDir。
完成标准：测试通过，推送分支并创建 PR（不要合入）。
本任务是实现与上线申请合一，submit 证据要同时包含：PR 链接、分支、提交 SHA、测试命令与结果、改动摘要、影响面、数据库迁移类型（无 / 只新增结构 / 改写或删除已有数据）、需要的新环境变量或主机准备、回滚方式、生产验证要点。
验收者是运营，由运营决定是否上线（调度器可能先用 Jev 判断，高置信安全时自动批准）。accept = 同意上线；return = 需要补什么写明。
运营：复核证据与 PR、CI 是否通过、迁移类型与红线；只在触碰 project.redLines 或需要花钱、对外联系时 report_blocker to=gm，其余自己决定。
${AUTHORITY}`,
    },
    deliveryChain(title, spec)[2],
  ];
}

function productAcceptance(goalId: string, head: string, final: boolean): Spec {
  return {
    title: '运营验收', kind: 'task', executorRole: 'product', reviewerRole: 'gm',
    context: `${head}
你是运营。本目标的开发、上线和 qa 生产实测已完成。对照老板原始输入和 qa 的实测记录确认结果符合预期，需要时自己在生产上操作一遍。
写《验收记录》到 deliverables/${goalId}/acceptance.md，全文作为 submit 证据：交付了什么、生产入口链接、验收步骤（打开哪里 → 用什么账号 → 点什么 → 应看到什么）、qa 实测结论、已知限制、回滚方式。
不符合预期：用 create_delivery 或 create_task（带 goalId="${goalId}"）创建返工，本任务会自动等待返工完成，然后结束本轮。
${final ? '本目标是小开发任务：经理确认后目标即完成并记录结果，不通知老板。' : '经理确认后进入 G3，由老板最终验收。'}`,
  };
}

function plan(goalId: string, head: string, afterScope: boolean): Spec {
  return {
    title: '任务拆解与分派', kind: 'task', executorRole: 'gm', reviewerRole: 'product',
    context: `${head}
你是经理。${afterScope ? '先读依赖任务里运营的《范围提案》。' : ''}把目标拆成可独立交付的任务，全部带 goalId="${goalId}"：
- 每个代码改动用 create_delivery（自动生成 实现 → 上线申请 → 合入部署与生产实测，上线由运营决定、qa 在生产实测）。
- 非代码工作用 create_task，执行者与验收者不同岗位；小需求不要拉 ai-content、cs 参与。内容产线按段派工：原型/概念设计（P 段，老板 demo 验收）→ executorRole=concept-design、reviewerRole=owner；量产制作（M 段，GM/QA 验收）→ executorRole=asset-production、reviewerRole=gm 或 qa，并把对应原型任务写进 dependencies（老板 approve 前量产任务不解锁）。项目内更细的产线分工（编剧/角色设计/分镜等岗位轨，见项目 AGENTS.md 与 project.disciplines 词表）不要当成全局岗位；create_task/create_delivery 传 discipline=<轨名>，只有挂该轨的编制会接活，不带轨的任务按普通岗位匹配。
**编剧轨例外**：所有编剧轨任务（故事大纲、剧本初稿、二次创作修订、多轮打磨）一律用 executorRole=screenwriter 且必须 discipline=编剧——包括 P 段原型剧本（这是对『P 段=concept-design』的有意例外），P 段仍由 reviewerRole=owner 验收；M 段量产剧本 reviewerRole=gm。
**剧本修订链**：P 段剧本被老板真实驳回后，gm/product 用 create_task 传 revises=<上一版任务id> 原子开下一版（executorRole=screenwriter、reviewerRole=owner、discipline=编剧，标题带新版本号 v(N+1)，context 写逐条修订要点）；服务端校验真实 owner 驳回后把旧稿置 void 并写 supersededBy 指向新稿，旧稿保留在任务图与审计中。普通下游依赖挂哪一版都一样解析到谱系最新版，最新版未经老板真实批准前全部保持 blocked，批准后统一解锁。M 段量产剧本（reviewerRole=gm）及任何非编剧轨、非 owner 验收任务不得用 revises，仍走同任务 return→返修流程。不要为了让下一轮解锁而验收不合格的稿子，验收通过 = 认可交付。存量任务不迁移。
submit 证据：任务清单（id、标题、执行/验收岗位、依赖）。运营验收和 G3 会自动等待全部任务完成。
${AUTHORITY}`,
  };
}

function finalGate(head: string): Spec {
  return {
    title: 'G3 老板最终验收', kind: 'gate', executorRole: 'gm', reviewerRole: 'owner',
    context: `${head}
你是经理。运营验收已完成，交付已在生产上线。写《G3 最终验收》，格式固定，全文作为 submit 证据：
1. 一句话结论：做完了什么。
2. 已上线的提交与生产入口链接。
3. 老板验收步骤：打开哪里 → 用什么账号 → 点什么 → 应看到什么（逐条）。
4. qa 生产实测与运营验收结论（证据所在任务）。
5. 已知限制与回滚方式。
不要请老板决定是否部署，交付已经上线。老板驳回时，按意见用 create_delivery / create_task（带 goalId）返工，然后结束本轮；G3 会自动等待返工完成。`,
  };
}

const VIDEO_PLAN = `把目标拆成可独立交付的任务，全部带 goalId，并按本项目的岗位轨工作（项目 AGENTS.md 与 project.disciplines 词表）。本目标走视频产线，不涉及软件上线，不要建 create_delivery，也不要把任务派给 product。
- 原型/概念设计（P 段，老板 demo 验收）：executorRole=concept-design、reviewerRole=owner。新角色、视觉风格、场景基调先交 demo，老板批准后才解锁依赖它的量产任务。
- 量产制作（M 段，GM/QA 验收）：executorRole=asset-production、reviewerRole=gm 或 qa，并把对应原型任务写进 dependencies。
- 音频腿（配音/对白/音效/配乐/主题曲）：一律用 sck call media_* 生成（先 media_info 看配置、当日额度与输出目录），产物在证据目录 media/ 下，自行拷进交付位；台词/对白/声线挂 配音 轨，背景音乐/音效/主题曲挂 配乐 轨（词表无该轨时挂 配音）；声线设计可作为 P 段 demo 由 concept-design 承接（owner 验收）。media_* 报错（额度用尽、key 未配置、上游故障）就如实写进证据并 report_blocker，不要绕过。
- 浏览器会话生成腿：media_image 走老板已登录的 ChatGPT/Higgsfield/Gemini/Grok 网页账号（Higgsfield 只用套餐内标记“无限”的图像模型，不花 credits；其余 provider 的账号配额与登录态同样受控）；media_video 走 Gemini/Grok。先 media_browser_info 看 provider 与当日额度，provider=auto 自动 failover；login_required=网页会话过期，limit_reached=账号配额，均如实报 blocker 不绕过。产物同样落在证据目录 media/ 下。
- 每个任务必须传 discipline=<轨名>（词表内的轨名，不是 slug），单任务只挂一轨；产线岗不挂轨的任务会被拒绝。
**编剧轨例外**：所有编剧轨任务（剧本初稿、二次创作修订、多轮打磨）用 executorRole=screenwriter 且 discipline=编剧；P 段由 owner 验收，M 段 reviewerRole=gm。剧本被老板真实驳回后，用 create_task 传 revises=<上一版任务id> 开下一版（标题带 v(N+1)，context 写逐条修订要点）。
**摄影轨**：运镜设计、摄影机调度、镜头运动语言类任务用 executorRole=cinematography 且必须 discipline=摄影（建单与 claim 双端强制）；P 段运镜 demo 由 owner 验收，M 段量产运镜 reviewerRole=gm 或 qa。摄影岗只做镜头语言，不画分镜（concept-design）、不做合成渲染（asset-production）。
成片验收用抽帧与音画检查（见项目 AGENTS.md「QA 终验标准」）。`;

const STORY_PLAN = `本目标走**长篇故事产线**：只负责把原著写完，由粗到细递归推进。故事作者不关心分集、时长、剧本格式、分镜、配音和渲染——这些是后面改编线的事，任务 context 里不要出现这些词，也不要把任务派给 product、ai-content、cs。
底本：仓库里已有的故事筹备稿（目标描述里的 Markdown）。全部产出放项目的故事目录，不进视频的集数目录。所有故事任务传 discipline=原著，作者岗位 executorRole=story-author（只有这个岗位能承接原著轨，派给别的岗位会被拒绝）。
递归流程（每一层都是：先写概要 → 老板只看概要 → 通过后才展开下一层 → 最后补齐正文）：
1. 第一层：《故事圣经与全书总纲》，executorRole=story-author、reviewerRole=owner。
2. 每一层概要任务通过后才展开下一层：卷概要 → 章概要 → 小章节概要，都是 reviewerRole=owner。
3. 小章节概要通过后建 [正文] 任务（executorRole=story-author → reviewerRole=qa，对照已批概要和故事圣经验收）；QA 通过后建 [小章节交付] 任务（executorRole=gm → reviewerRole=qa，登记章节路径、字数、与概要的对照）。一个小章节交付 = 一个完成单位。正文不由员工亲笔撰写：把原本写给作家的完整写作指令（章节概要、文风要求、字数）作为 prompt 发给 notebook_write（Gemini 壳内笔记本会话），拿回的正文稿经一致性核查后作为正文提交。
4. 概要被老板驳回：在原任务上按意见返修再交，不跳过去写正文。正文被退回：只改正文，不动已批概要。
**不要一次建完所有层级**。每批只建当前层及其审批，并同时建一个 [展开下一层] 任务（executorRole=gm、reviewerRole=qa），让它依赖本层的老板审批任务（概要被老板驳回时在原任务上返修，不另建）；它在老板通过后执行，再建下一层任务和下一个 [展开下一层]——靠它把递归接力下去。全书写完时，由最后一个 [展开下一层] 建一个 kind=gate 的《全书完成确认》交老板。
每个任务写清：对应层级、上游概要所在文件、输出文件路径、字数/篇幅预期（只按故事本身，不按集数）。
**Gemini+笔记本即作家**：概要与正文写作都在 Gemini 网页的笔记本会话里完成（notebook_write，基于老板 Google 账号），员工是操盘手而非写手——概要同样不亲笔。约定**一部作品一本**（标题形如《作品名》，notebook_list 查、没有则 notebook_create），**源只按卷组织**——每卷一个"正文汇编"源，该卷已批正文全部并入；圣经/总纲/各级概要/评审记录只存 git 仓库不进笔记本。写作时把原写作指令（当章概要+文风+字数，需要的圣经设定段摘录进 prompt）发 notebook_write，Gemini 会话以笔记本内前卷正文为上下文 grounded 出稿；**一章=一个会话，自章概要起**——章概要任务起新会话并把返回的「chat」（或 url）记入台账；该章其后的小章节概要、正文、任何驳回修订全部沿用同一会话，不新开冷会话；章层级之上的概要（卷概要等）起各自独立会话登记为卷级条目。给下游建任务时在 context 里写明"执笔沿用 gemini-sessions.md 中本章 chat"——会话归属写进任务书，不靠员工自己找。**会话台账**：每次 notebook_write 返回后把会话归属记下来——证据文件尾自带「gemini-session: <url>」标记，同时把「章节 ↔ 会话 url」登记进 story/<作品>/notes/gemini-sessions.md，章会话首个条目在章概要任务时写入；QA 驳回修订/跨章改动前文时，按台账取目标章最近一次会话的 chat 续写，不新开冷会话；会话里已有但未取回的答复用 notebook_recover 只读拉取（不带 turn 先列轮次地图，绝不重发 prompt）。**档案亲笔**：新登场人物/场景/装置的设定条目由员工亲自撰写回写 bible.md（档案是设定台账不是文学创作，不发 Gemini；可先用 notebook_query 核查冲突）。产物落证据目录 media/ 下照常走评审；批准后先写 story/ 仓库文件（权威副本+git 版本），再用 notebook_remove_source + notebook_add_source 把该卷汇编源更新为最新正文全集。**查询路径**：notebook_query 可随时临时查证设定/回顾前文，答复正文随结果直接返回。login_required/限流如实报 blocker。`;

function linePlan(goalId: string, head: string, pipeline: Exclude<PipelineId, 'software'>): Spec {
  return {
    title: '任务拆解与分派', kind: 'task', executorRole: 'gm', reviewerRole: 'qa',
    context: `${head}
你是经理。${pipeline === 'story' ? STORY_PLAN : VIDEO_PLAN}
全部任务带 goalId="${goalId}"。submit 证据：任务清单（id、标题、执行/验收岗位、轨、依赖）。
${AUTHORITY}`,
  };
}

function videoGate(head: string): Spec {
  return {
    title: 'G3 老板最终验收', kind: 'gate', executorRole: 'gm', reviewerRole: 'owner',
    context: `${head}
你是经理。本目标的成片已通过 QA 终验。写《最终验收》，全文作为 submit 证据：
1. 一句话结论：做完了什么。
2. 成片/样片的可点链接（用 deliverable_publish 发布到局域网地址，老板可能不在电脑旁）和抽帧联络表。
3. QA 终验结论（证据所在任务）。
4. 已知限制。
老板驳回时，按意见用 create_task（带 goalId）返工，然后结束本轮；最终验收会自动等待返工完成。`,
  };
}

export interface TemplateTask extends Spec { ref: string; deps: string[] }
export interface GoalTemplate {
  tasks: TemplateTask[];
  anchors: string[];
  refs: { intake?: string; plan?: string; manual?: string; acceptance?: string };
}

/** Task graph for a triaged goal. Refs are local names; the caller maps them to record ids. */
export function goalTemplate(tier: GoalTier, title: string, brief: string, goalId: string, pipeline: PipelineId = 'software'): GoalTemplate {
  const head = `所属目标：${title}（goal=${goalId}，级别 ${tier}${pipeline === 'software' ? '' : `，产线 ${pipeline}`}）\n老板原始输入：\n${brief}\n`;
  if (pipeline === 'story') {
    return { tasks: [{ ...linePlan(goalId, head, 'story'), ref: 'plan', deps: [] }], anchors: [], refs: { plan: 'plan' } };
  }
  if (pipeline === 'video') {
    return {
      tasks: [{ ...linePlan(goalId, head, 'video'), ref: 'plan', deps: [] }, { ...videoGate(head), ref: 'acceptance', deps: ['plan'] }],
      anchors: ['acceptance'], refs: { plan: 'plan', acceptance: 'acceptance' },
    };
  }
  if (tier === 'quick') {
    const chain = quickChain(title, brief).map((spec, i) => ({ ...spec, ref: `d${i}`, deps: i ? [`d${i - 1}`] : [] }));
    return {
      tasks: [...chain, { ...productAcceptance(goalId, head, true), ref: 'manual', deps: [chain.at(-1)!.ref] }],
      anchors: ['manual'], refs: { manual: 'manual', acceptance: 'manual' },
    };
  }
  const tasks: TemplateTask[] = [];
  if (tier === 'program') {
    tasks.push({
      ref: 'intake', deps: [], title: '范围提案', kind: 'task', executorRole: 'product', reviewerRole: 'gm',
      context: `${head}
你是运营。老板给的是方向性目标。写《范围提案》到 deliverables/${goalId}/scope.md，全文作为 submit 证据：目标用户与场景、最小可用版本功能（按优先级）、明确不做、依赖与风险、成本假设。
范围由你决定、经理复核，不送老板审批。只有需要花钱、签约、对外联系或方向取舍时才 report_blocker to=gm。
${AUTHORITY}`,
    });
  }
  tasks.push({ ...plan(goalId, head, tier === 'program'), ref: 'plan', deps: tier === 'program' ? ['intake'] : [] });
  tasks.push({ ...productAcceptance(goalId, head, false), ref: 'manual', deps: ['plan'] });
  tasks.push({ ...finalGate(head), ref: 'acceptance', deps: ['manual'] });
  return {
    tasks, anchors: ['manual', 'acceptance'],
    refs: { intake: tier === 'program' ? 'intake' : undefined, plan: 'plan', manual: 'manual', acceptance: 'acceptance' },
  };
}

export const TIER_CRITERIA: Record<GoalTier, string> = {
  quick: '单一仓库内范围明确的小改动或缺陷修复，一条合并交付链（实现+上线申请→部署与生产实测）即可完成',
  standard: '方向清楚但需要多个交付项或跨模块协作，需要经理拆解',
  program: '方向性、范围宽泛的大目标（例如做一个新产品），需要先做范围提案再拆解',
};
