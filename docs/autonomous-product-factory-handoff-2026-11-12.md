# Surreal CK 自主产品工厂：Hermes 替代评估与迭代交接

> **文档日期：2026-11-12**  
> **目标：每个对外服务的产品背后，都能持续运行“搜集需求 → 过滤需求 → 整理需求 → 分配任务 → 开发 → 验证 → 上线 → 观察效果”的自主闭环。老板是可选监督者，不是日常流水线的必需节点。**  
> **结论：采用 Hermes 承担通用 Agent 执行平台；将 Surreal CK 收缩并升级为产品自主控制层。**  
> **决策性质：可据此拆分工程任务；没有实施生产切换、执行迁移或完成故障实测。**  
> 本文取代上一版 `SurrealCK_Hermes_Migration_Handoff.md` 中“保留逐项老板确认作为长期前提”的方案。历史研究仍可参考，但实施顺序与授权设计以本版为准。

| 审查对象 | 固定基线 |
| --- | --- |
| 运营系统 | `MainListActivity/surreal-ck-operations`，提交 `e196fa58e21d633676e0f614fd157eaac0915a56`，项目版本 `0.11.24` |
| Hermes | `NousResearch/hermes-agent`，提交 `92d9dd4d04fa66d35370c4630d1443431b9476c5` |
| 官方文档 | 2026-11-12 检索的 Hermes 文档；网站可能继续更新，落地时以锁定版本和契约测试为准 |
| 分析依据 | 需求入口、分类、审批、规划、执行、运行器、成本、权限代理、验收相关代码和测试，以及 Hermes 官方实现与文档 |
| 验证边界 | 源码与架构分析；未启动真实 Hermes 工作流、未运行本次集成测试、未读取实际生产配置或证明生产行为。不能将仓库测试文件存在视为本次测试通过 |

## 0. 给接手者的一页结论

**可以用 Hermes 替代现有系统中大部分通用 Agent 基础设施；不应把整个产品自主运行机制等同于一个 Hermes 会话，也不应保留一套与 Hermes 并行竞争的自研派工平台。**

应当采用以下长期分工：

| 层次 | 谁负责 | 长期是否值得自研 |
| --- | --- | --- |
| 工具调用、模型运行、会话、工作目录、任务队列、依赖、Worker、常规恢复、复核交接 | Hermes 及其 Kanban、Profile、Gateway 等能力 | 原则上不再重复建设 |
| 产品目标、需求事实、可自动执行的范围、预算、不可变授权、实际发布事实、业务结果 | Surreal CK 产品自主控制层 | 是，这是本系统的产品价值 |
| 代码托管、检查、构建和部署执行 | 产品已有 GitHub / CI/CD | 复用，不让 Agent 再造一套发布平台 |
| 生产权限、敏感工具、合并执行、证据验真、回退 | 受信服务与受保护流水线；复用并拆解现有 OpsBroker / 验收模块 | 保留必要规则与适配，不能只写进提示词 |

“老板可有可无”的正确实现，不是给某个 Agent 老板令牌，让它自动调用 `requirement.approve`。应当将：

> **老板逐项批准需求**

改成：

> **产品预设目标与授权策略 → AI 提出需求和计划 → 确定性策略服务核对条件并签发授权 → 自动执行与独立验证。**

日常合规范围内的工作，不等待真人回复。范围外、证据不足、预算不够的工作，可以自动拒绝、延期、隔离或进入有恢复条件的异常队列；不能因此卡住整个产品，也不能把“老板没回复”当作同意。

**下一阶段的优先级应从“把 AI 员工管理得更细”转向“让一个真实产品在无人回复的情况下完成一次可验证、可恢复的改进”。** 界面、大屏、员工编制和通道适配不再是主线。

本建议不以一个未经测量的“替换 80% 代码”作为承诺。“多数可替换”指通用能力覆盖，而不是代码行数、成本或维护工时的已验证节省比例。

---

## 1. 本次目标与上一版方案的关键差异

### 1.1 必须解决的是产品持续运行，不是派工界面替换

系统需要持续回答以下问题：

- 产品当前出了什么问题、用户真正需要什么，哪些信号可信？
- 哪些需求值得做、符合产品方向、风险与成本在授权范围内？
- 谁来执行、怎么验收、何时能合并和上线？
- 结果真的上线了吗，问题真的解决了吗，失败如何自动恢复？
- 老板连续不看系统、不批准、不回复时，哪些工作仍能正常推进？

因此，成功标准不是“有一个会自动分配任务的 AI 总经理”，而是**产品生命周期中的事实、授权、执行和恢复都能自动闭环**。

### 1.2 修改上一版的五项假设

| 上一版倾向 | 本版决定 |
| --- | --- |
| 保留每个需求的老板批准 | 保留授权约束，但允许由受限的策略服务自动签发，不要求真人逐项操作 |
| 老板是工作入口 | 产品反馈、故障遥测、客服记录、用户行为和主动检查都是入口；老板只是其中之一 |
| 看板任务完成是主要交付终点 | 实际部署、线上验证、效果观察与反馈闭环才是产品级终点 |
| 先把 Hermes 接成另一种员工运行器 | 可以短期接入，但终态必须移交任务运行职责，不能永久保留两套调度器 |
| 围绕“有哪些员工、谁在忙”建设界面 | 围绕“产品健康、待解决问题、自主交付、成本和异常”建设可选监督界面 |

### 1.3 “老板可选”的边界

产品仍需有初始配置：服务什么用户、解决什么问题、可使用哪些资源、允许哪些变更、预算是多少、哪里部署、怎样验证和回退。这些可以来自产品模板、一次性配置或预先授权，不必由老板每天维护。

**老板可以不在每条工作流里，但目标和授权不能不存在。** 本文不把“自动完成所有任意需求”当作可交付承诺；对无法自动判定或安全实施的事项，自动延期或拒绝也是有效运行结果，而不是偷偷扩大权限。

---

## 2. 当前代码实际到了哪里

现有系统已经具备相当完整的后半段交付链。真正阻碍自主化的，不是缺少一个多 Agent 框架，而是需求准入、身份授权、恢复策略和产品结果模型仍然以老板为中心。

### 2.1 当前真实主链

```text
产品反馈组件 / API
        |
        v
receiveFeedback：来源约束、限流、幂等接收
        |
        v
triageFeedback：分类、候选去重、生成 pending 需求
        |
        v
requirement.approve：老板身份创建不可变确认快照
        |
        v
planRequirements：将确认快照拆为 1–6 个顺序任务
        |
        v
reconcileIterations：
产品核对计划 -> 工程实施 + QA -> 工程合并 + CI/CD + QA 线上复验
        |
        v
deployedSha：匹配实际提交、production 部署证据、轮次与独立复核
        |
        v
released
```

这条链不是全自动需求工厂：**自动反馈整理停在 `pending`；规划和执行都依赖老板确认快照；发布后的业务效果没有在该链中形成持续评价闭环。** [S01] [S02] [S03] [S04] [S05]

### 2.2 需要直接改动的代码事实

| 代码位置 | 当前行为 | 对迭代方向的含义 |
| --- | --- | --- |
| `src/iteration/feedback.ts` / `receiveFeedback` | 已有产品级来源检查、请求幂等、每 IP/产品每小时 20 次和每产品每小时 1000 次限流；Origin 不是用户身份认证 | 保留产品入口，不应简单替换成一个公开聊天机器人；增加可靠信号来源与来源身份 |
| `src/iteration/triage.ts` / `triageFeedback` | 每轮最多整理 3 条反馈；最多 3 次尝试；提供给模型的需求候选最多 30 条；新需求始终进入 `pending` | 当前是分类整理，不是完整的产品价值决策；不能宣称已有全历史去重 |
| `src/iteration/requirements.ts` / `approve` | 对需求修订和产品策略进行校验，在同一事务中固化确认快照并置为 `queued` | 不可变快照和并发保护值得保留；授权来源需要扩展 |
| `schema/063-product-iteration.surql` | 生产中 `requirement_approval` 只允许 owner 身份创建，禁止修改/删除；计划需要关联批准记录 | 自主化必须改授权契约及消费者，不能只改按钮或给自动化字段设为 true |
| `src/iteration/planning.ts` | 只规划已批准快照；输出 1–6 个顺序步骤；不允许模型指定执行身份、凭证或发布授权；每轮最多规划 1 条 | 继续限制模型只生成工作方案；将资格判断交给策略服务，将执行图交给 Hermes |
| `src/iteration/execution.ts` | 已经不要求二次发布批准；开工确认包含独立复核后合并 PR 的授权 | 不要重复建设“自动批准发布”；优先移除前端开工的人为瓶颈 |
| 同文件 `deployedSha` | 任务 done 不足以上线，要求同一 SHA、production、验收轮次和部署成功证据，并有独立复核记录 | 保留“事实发布”语义，不能把 Hermes done 直接映射成 released |
| `owner-end/src/iteration-commands.ts` | 当前迭代命令由网关先核对老板身份 | 新增受限机器入口，不把整份老板命令目录开放给 Agent |
| `owner-end/src/cron.ts` | 需求整理/规划与员工身份、消息翻译等共用 cron；模型调用依赖 `cfg.magpie` | 抽离产品闭环职责，避免自主产品引擎依赖老板端功能 |
| `src/runner/run.ts` | 原生执行器启动时加载 owner 凭证并核对 owner 角色 | 无人值守的机器运行应使用明确的服务身份，不继续借用老板身份 |
| `src/task-cost.ts` | 汇总已完成任务的 Magpie 用量，记录未计价与不完整情况 | 这是成本结算，不等于执行前的预算预留与执行中的消费上限 |
| `src/ops/broker.ts` / `call` | 每次敏感调用经 `core.opsScope` 校验当前任务租约，并包含尝试预留、执行、审计与故障处理 | 替换任务执行层时，必须同时替换授权上下文来源，不能只包一层 MCP 就删除旧核心 |

上述事实分别见 [S01]–[S11]、[S14]。

### 2.3 不要沿用过期架构描述

当前 `src/runner/` 已是共享执行模块，`plugin/server/` 主要保留 Paseo 兼容入口；原生执行支持 Factory、Claude、Codex，并有独立服务与节点路由。不能继续按“所有能力都只能在 Paseo 插件里运行”制定迁移计划。具体运行器是否在生产启用，仍需读取实际部署配置确认。 [S13] [S14]

同样，历史 `docs/external-agent-integration.md` 不是现成可调用的公司 MCP 服务说明。新的 Hermes MCP / HTTP 工具适配应明确作为新增能力，不假设仓库已经部署该接口。 [S19]

### 2.4 当前值得保留的资产

应保留的是**工程契约和可验证能力**，不必保留它们现在的全部耦合：

- 不可变需求修订、并发控制、任务幂等和审计。
- 真实 SHA、部署环境、验收轮次与独立复核的证据规则。
- 敏感凭证代持、作用域校验和操作审计。
- 失联、迟到结果、未知运行态不被冒充成功的恢复原则。
- 已有反馈接收、产品配置和历史数据，以及覆盖这些条件的测试。

`tests/product-iteration.fork.test.ts` 已包含拒绝伪造审批、反馈幂等、崩溃后不重复建单、无需二次发布批准、错误 SHA/轮次/部署结果不能宣称上线等测试。它默认受环境变量控制而跳过，本次没有运行；迁移应继承这些约束，而不是把旧测试连同旧实现一起删除。 [S12] [S15] [S16] [S17]

---

## 3. Hermes 到底能替代多少

### 3.1 按整条闭环评估，而不是按宣传功能评估

下表中“可复用”表示存在对应的原生机制，不等于本项目已经完成集成或生产验证。

| 环节 | Hermes 可提供的能力 | 仍需本系统承担的内容 | 结论 |
| --- | --- | --- | --- |
| 搜集需求 | Gateway、签名 Webhook、Cron、脚本和工具连接外部信号 | 产品级来源身份、客户数据范围、事件去重、遥测/客服适配、隐私处理 | 大部分触发与工具基础设施可复用；产品采集语义保留 |
| 过滤需求 | Agent 对内容分类、关联、研究和复现；可配置 Profile/Skills | 产品目标匹配、可信证据、反滥用、优先级规则、预算和风险准入 | AI 判断可迁；准入权不能直接交给模型 |
| 整理需求 | 生成结构化说明、验收标准、实施计划 | 规范校验、需求版本、来源链、不可变授权、跨历史去重索引 | 主要模型工作可迁 |
| 分配任务 | Kanban 的持久任务、依赖、Profile 路由、Worker 调度和 Review | 授权后才能派工、产品容量、公平性、预算、资源锁及必要的特殊 Provider 策略 | 通用派工是优先替换对象 |
| 开发 | 终端、文件、工作树、模型工具；可选 Codex App-Server | 仓库写权、分支保护、依赖供应链、实际订阅兼容 | 运行基础设施大部分可替换 |
| 验证 | 独立复核与返工流程；显式 PR completion contract 的检查 | 可信独立身份、不能被实现者删除的测试基线、生产证据和业务判定 | 流程复用，强制验真保留 |
| 上线 | 工具调用可以参与 PR/流水线流程 | 真正的合并授权、部署权、固定版本验真、灰度和自动回退 | 不应由聊天结果直接决定 |
| 上线后观察 | Cron / Webhook / 工具能够驱动检查 | 产品健康与业务指标、观察窗口、问题是否解决、后续学习 | 需要建设产品结果层 |
| 可视化与沟通 | 自带看板、运行信息和消息通道 | 产品级健康、授权解释、成本、结果与异常聚合 | 通用员工/任务界面停止重复建设 |
| 多产品运行 | 多 Board、多 Profile、多 Gateway 等组织能力 | 服务身份、运行环境隔离、产品权限、部署资源冲突与数据隔离 | 能作为基础，但不是现成的 SaaS 租户安全边界 |

依据：Hermes Kanban、Worker Lanes、Webhooks、Cron、Security 与 Codex Runtime 官方文档，以及 Kanban 的事务实现。 [H01] [H02] [H04] [H05] [H07] [H08] [H10]

**判断：足以承担新架构的主要执行底座，不值得继续自研一套同等范围的通用 Agent 平台。** 但“自主运营产品”所需的业务目标、授权和实际结果，并不是安装 Hermes 后自动出现的功能。

### 3.2 必须提前处理的七个适配陷阱

**第一，`/goal` 不是产品控制系统。** 它服务于一个会话内的持续执行，不会自动建立完整的持久产品需求流水线。应将它限制在具体 Worker 的有界任务中，不以一个永不退出的“CEO 会话”持有公司状态。 [H03]

**第二，Hermes 与当前 SCK 的结束协议不同。** 当前 SCK 执行器根据最终成果自动送审和记录评审；Hermes Kanban Worker 需要调用完成、送审、退回或阻塞等终结工具。只把原来的 `task.md` 和最终答复格式搬过去，可能得到“进程正常退出，但任务协议未完成”的失败。必须重写交接模板并测试该差异。 [S15] [H02] [H12]

**第三，PR 检查不是默认覆盖所有卡片。** 原生实现中没有 completion contract 或 `local-only` 不会执行 PR 验收。代码任务必须在受信创建入口明确绑定仓库/PR，并验证不能用另一个绿灯 PR 替换；即便 PR 检查通过，也不是生产上线证据。 [H01] [H11]

**第四，生命周期通知不具备授权含义。** 已检查的 Kanban 生命周期 Hook 在事务提交后调用，失败被吞掉；官方 outbound webhook 也是尽力投递。不能用“完成后触发一个 Hook”作为阻止越权发布的唯一关口。 [H06] [H10]

**第五，Board/Profile 隔离不能替代操作系统隔离。** 官方 Worker Lanes 明确区分合作式运行约束与 OS confinement。相同用户下的文件访问、直接打开 SQLite 等能力，不会因为提示词或 Board 名字不同而消失。生产凭证和授权数据库必须放在 Worker 无法改写的边界外。 [H02] [H07]

**第六，Codex App-Server 不等于所有原生 CLI 已兼容。** 它有官方运行时集成，但与直接派一个 Claude Code / Factory CLI Worker 不是同一件事。官方 Codex 文档列出若干上下文工具和浏览器回调限制，不能把所有 Profile 一起切到该运行时。试点可使用 Codex 做工程执行，研究/规划和需要浏览器的 QA 使用已验证的 Hermes 原生配置。 [H02] [H08]

**第七，Multi-gateway 不等于跨主机高可用调度。** 本地 SQLite 的 WAL、写事务和 CAS 可以解决同一数据库的并发领取；不能据此承诺多主机共享磁盘、任意失联接管或分布式一致性。首先采用每个执行单元单活的部署方式，灾备按受控恢复处理。 [H09] [H10]

---

## 4. 推荐终态：产品自主控制层 + Hermes 执行单元

以下均为**建议的新架构**，不是对现有系统已实现能力的描述。

### 4.1 职责分离

```text
产品反馈 / 产品遥测 / 支持渠道 / 主动检查
                       |
                       v
        产品自主控制层（现有 Bun/TS + SurrealDB）
        - 产品目标与版本化策略
        - 信号、需求、授权、预算
        - 执行请求与产品结果记录
        - 发布证据与恢复决定
                       |
             只提交已授权的工作流
                       v
            Hermes 产品执行单元
        - 持久 Kanban / 依赖与运行记录
        - Research / Product / Engineering / QA
        - 通用运行、重试、复核、工作树
                       |
                产物与证据候选
                       v
       受信操作与发布服务 + 受保护 GitHub / CI/CD
        - 重新核验授权和当前版本
        - 合并、部署、验证、回退
                       |
                       v
          线上结果 / 观察窗口 / 用户问题是否解决
                       |
                       +----> 新的产品信号
```

老板/运营人员可以查看、暂停、调整授权、处理特例，但不位于普通工作链的必经路径。

### 4.2 只保留一份各自领域的事实

| 对象 | 唯一权威来源 | 禁止的做法 |
| --- | --- | --- |
| 产品目标、策略和授权版本 | SCK 产品控制层 | Hermes Memory、聊天记录或 Skills 自行修改正式授权 |
| 信号、规范需求、来源链、修订 | SCK 产品控制层 | 同一需求在聊天历史和两个数据库中各自演进 |
| Hermes 工作流的卡片、依赖、Run、重试和复核运行态 | Hermes Kanban | SCK Dispatcher 再竞争领取同一工作 |
| 合并/部署操作是否发生 | GitHub / CI/CD / 目标环境事实，由受信服务核验并落账 | 以模型声称“已发布”代替真实结果 |
| 产品需求是否已发布、观察是否成功 | SCK 的证据驱动结果记录 | 卡片 done 自动等于产品 released |
| 历史 SCK 任务 | 旧核心只读归档或在途排空 | 迁移时重写历史审批和验收结论 |

这不是双重调度，而是业务状态与执行状态分离。SCK 可以保存 Hermes ID 与只读投影，但不维护第二份可独立推进的 Worker 状态机。

### 4.3 不增加一套新的重型基础设施

第一阶段只需要：

- 复用现有 TypeScript/Bun 后端与 SurrealDB，划出产品控制、授权、操作代理等模块。
- 一个固定版本的 Hermes 常驻执行单元，以及必要的 Profile、工具适配。
- 产品现有 CI/CD，加上可验证的合并、部署和回退约束。

不以建设微服务集群、重写数据库、引入另一种大型工作流平台为前提。模块可以先在现有可信服务进程内运行；只有安全隔离或实际规模要求时才拆服务。

### 4.4 产品复制方式

每个产品应有一个可版本管理的配置包：产品标识、仓库、反馈与遥测入口、目标、工作范围、验收目录、部署环境、凭证引用、预算、回退操作和 Hermes 执行单元绑定。

产品的运行控制与信号适配留在 SCK；产品 Board 和必要的 Profile 在 Hermes。对于客户代码或数据互不信任的场景，执行单元需要独立容器/系统身份及凭证范围，不能只创建不同 Board。

初期使用单活执行单元，故障时恢复持久数据和外部产物后重建工作。跨机器迁移不得复制一个正在活跃写入的 SQLite 文件并同时启动两个 Dispatcher。

## 5. 核心改造：从“老板审批”变成“机器可执行授权”

### 5.1 产品章程 ProductCharter

每个产品必须有版本化的长期授权策略。它描述“什么可以自动做”，而不是预先列出每个任务。

建议至少包含：

| 字段组 | 内容 |
| --- | --- |
| 目标 | 服务对象、核心用户旅程、当前目标、禁止偏离的业务边界 |
| 工作范围 | 可自动处理的缺陷/改进类型、允许修改的仓库与路径、明确保护的路径 |
| 风险 | 可自主实施的风险等级、变更影响、数据敏感度、不可逆操作规则 |
| 验收 | 固定的基础检查、独立 QA 要求、产品行为验证、环境与版本识别方法 |
| 预算 | 产品周期预算、单需求预算、并发上限、模型与恢复尝试上限 |
| 发布 | 允许的目标环境、合并条件、已有部署流水线、灰度与观察规则 |
| 恢复 | 自动回退操作、适用条件、最后已知正常版本、无法回退时的安全状态 |
| 授权管理 | 策略版本、签发主体、生效/过期、撤销方式、策略本身的修改规则 |

以下仅为**建议的产品契约示例，不是现有 Hermes 配置文件，也不是可直接运行的配置**：

```yaml
product_id: example-service
policy_version: 1
mode: autonomous_bounded

objectives:
  - reduce_verified_failures_in_core_user_journeys

work_scope:
  repositories: ["example-org/example-service"]
  autonomous_categories: ["reproducible_bug", "approved_scope_improvement"]
  protected_paths:
    - ".github/workflows/**"
    - "security/**"
    - "billing/**"
    - "production-migrations/**"
    - "autonomy-policy/**"

authorization:
  issuer: product-policy-service
  require_evidence: true
  require_acceptance_spec: true
  unknown_risk_action: defer
  allow_worker_policy_changes: false

release:
  require_independent_qa: true
  require_current_head_checks: true
  require_verified_deployment: true
  require_runtime_version_match: true
  environment: production
  merge_executor: trusted-release-broker
  pipeline_ref: registered-existing-pipeline

recovery:
  allowed_actions: ["retry_within_budget", "switch_approved_provider", "rollback"]
  unresolved_action: quarantine_requirement

budget:
  policy_ref: registered-product-budget
  unknown_price_action: use_reserved_upper_bound_or_stop

execution:
  backend: hermes
  cell_ref: registered-example-cell
```

示例中的受保护目录是策略模板，不应直接套用到实际仓库而漏掉真实敏感路径。执行前必须根据产品代码和部署结构生成并验证规则。

### 5.2 新增 RequirementAuthorization，而不是伪造 OwnerApproval

建议新增不可变授权记录，统一支持两种来源：

```text
RequirementAuthorization
  id
  product_id
  requirement_id
  requirement_revision
  requirement_digest
  policy_id / policy_version / policy_digest
  issuer_principal
  kind = policy | human
  allowed_scope
  permitted_actions
  risk_facts_digest
  acceptance_contract_digest
  budget_reservation_id
  issued_at / expires_at
  revocation_epoch
  decision_evidence_refs
```

具体原则：

1. AI 可以提出需求、分类与计划，但不能给自己签发授权，也不能自行扩大允许范围。
2. 策略服务根据不可变输入与可核实事实作出 `allow / defer / reject`；只有 allow 才签发授权。
3. 授权绑定需求修订、策略版本与验收契约，不能在任务执行后偷偷改写目标。
4. 授权撤销、产品停用、预算耗尽时，新的敏感操作必须被拒绝；不能只在建单时检查一次。
5. 人工特例也经过同一契约，只是签发来源不同，不为手动操作保留绕过全部检查的捷径。

### 5.3 对现有代码的迁移方式

**保留 `requirement_approval` 历史表和 owner-only 约束。不要把它改成所有 automation 都能写。**

建议增加独立的 `requirement_authorization` 表、受限服务身份与公共的授权读取/验证模块：

- `Requirements.approve()` 保留显式人工批准入口，并产生或映射为 human 类型授权。
- 新 `authorizeRequirement()` 只供策略服务使用，不接受调用者自报 owner 身份。
- `planRequirements()` 和 `reconcileIterations()` 改为读取统一的授权契约，不再硬编码“必须有老板确认快照”。
- 旧任务通过只读适配器引用原批准记录；不修改历史 actor，不补造过去不存在的机器批准。
- 当前 `approved_revision` 可以阶段性保留作为兼容字段；新逻辑以授权引用和其修订校验为准，避免一次迁移同时改遍所有 UI 和状态枚举。
- 数据库访问规则、令牌签发范围、命令网关、测试夹具同步更新，不能只在 TypeScript 函数中增加一个 boolean。

`schema/063-product-iteration.surql` 的 owner-only 防线不是“阻碍自动化的坏设计”，而是需要被**新的明确机器授权路径**补充。没有策略的自动化身份仍应无法签署任何需求。 [S04]

### 5.4 风险分级不能只相信模型自评

建议按三个层次进行判定：

| 类别 | 自动行为 | 无老板响应时 |
| --- | --- | --- |
| 授权范围内、证据充分、可验证且可恢复 | 自动规划、实现、独立验证、发布与观察 | 完整运行 |
| 证据不足、范围不清、依赖缺失或成本超限 | 自动补充调查；有界尝试后延期/隔离 | 记录原因和重试条件，其他需求继续 |
| 修改安全边界、支付权限、不可逆数据操作、扩大生产权限等未预授权行为 | 拒绝自动执行；可生成安全替代方案 | 不执行，不把沉默视为同意 |

风险应结合实际文件变更、依赖变化、权限变化、数据迁移、影响范围等确定性事实。模型可以提高风险等级或补充解释，但不能仅凭一句“这是小改动”降低保护。

需求、计划、实际 diff 三个阶段都要重新核对范围。原需求低风险，不代表它最后产生的代码仍然低风险。与策略自身、安全网关、受信验收代码相关的变更应通过独立的受保护发布路径，不能由被评估的产品 Worker 自行修改规则并放行自己。

### 5.5 合并授权与上线证明是两件事

一次生产交付应分别记录：

- **准入授权**：这个需求及其修订可以开始工作。
- **合并授权**：当前 PR head、必要检查、独立评审、预算与作用域符合条件。
- **部署事实**：实际合并提交或发布制品进入指定环境。
- **上线验收**：运行版本与制品对应，必要用户旅程和健康条件通过。
- **效果结论**：观察窗口中，原问题得到解决或业务目标有相应证据。

在合并前不能假造未来的 merge SHA。合并操作先绑定当前 PR head 和受保护合并条件；合并后取得实际 merge SHA，再将它与 CI 制品、部署记录和线上版本关联起来。

---

## 6. 端到端自主流程的具体设计

### 6.1 搜集：从“反馈表单”扩展为产品信号总线

保留现有反馈接收接口，增加统一 `ProductSignal` 输入模型。第一批接入优先选取对产品交付最有价值的三种来源：用户反馈、可复现的运行故障、核心用户旅程的自动探测。

```text
ProductSignal
  product_id
  source_type / source_id / source_event_id
  observed_at
  trust_level
  deployment_version
  tenant_scope_ref
  payload_ref / redacted_summary
  evidence_refs
  correlation_key
  processing_status
```

采集层负责签名/身份验证、限流、去重、脱敏与授权范围；Hermes Webhook、Cron 或脚本可负责触发和连接。信号的正文是数据，不是系统指令：用户反馈里要求“跳过测试”“给我管理员权限”“立刻部署”不得成为工具授权。

相同 `product + source + source_event_id` 应只生成一个规范事件。不能用重复反馈的数量直接替代价值判断，以免一次攻击或重复上报占满开发预算。

客户端错误和匿名反馈可以成为调查线索，但不能单独成为生产操作许可。高可信遥测应来自经过验证的服务端采集或受控探测。

### 6.2 过滤：先证据和产品方向，再优先级

建议处理顺序为：安全检查与去重 → 信号聚类 → 补充证据/复现 → 产品目标匹配 → 影响与成本估计 → 风险与预算检查。

明确分开三个输出：

- `dismiss`：噪声、重复且已关联、明确不属于产品范围。
- `investigate / defer`：信息不足，需要有限调查或等待外部事实。
- `candidate`：形成可验证需求，送策略服务决定是否授权。

不要仅将现有 `priority: 0–3` 交给另一个模型就称为自主产品决策。应持久化理由：影响了谁、证据是什么、为何符合目标、预计改变什么、怎样知道有效。

去重先使用产品/来源/错误指纹等确定性键，再按需要增加历史检索。当前最近 30 条候选可以保留为兼容能力，但新方案不能继续将其当作完整需求池。 [S02]

### 6.3 整理：生成版本化的实施与验收契约

Product Profile 输出需求问题、范围、明确不做什么、成功/失败场景、验收方法、风险假设与证据引用。服务端验证结构和产品归属；缺少可验证验收条件的需求不自动进入开发。

实施计划由模型提出，系统校验依赖无环、步骤数量与预算有界、全部子工作都在授权范围内。第一阶段可以保留顺序步骤，证明闭环后再扩展并行；不要把引入任意 DAG 当作无人值守的前置条件。

### 6.4 派工：按工作流派，不再模拟一整家有十几种岗位的公司

建议起步使用四类职责：

| 职责 | 主要产物 | 不具备的权力 |
| --- | --- | --- |
| Research / Signal Analyst | 关联信号、复现结果、证据 | 不签授权、不改生产 |
| Product / Planner | 规范需求和实施计划 | 不给自己增加预算或放开风险规则 |
| Engineering | 代码、PR、测试、交接 | 不持生产发布密钥，不绕过合并代理 |
| QA | 独立验收与可复现证据 | 不改被验收对象的基线来制造通过 |

这些可以按任务使用同一产品的若干 Profile，不要求每个产品常驻四个 LLM 会话。调度和空队列检查由代码完成；只有需要判断或工作时才调用模型。

对于代码任务，首期选择一种清晰的复核建模：**同卡 Review 或独立下游 QA 卡**。不要两种同时叠加导致双重签署、重复消费或依赖死锁。外部产品验收事实独立记录，不由卡片状态单独决定。 [H02]

### 6.5 开发与验证：把测试变成外部可核验事实

工程在隔离工作区提交 PR；新增测试是交付物之一，但基础验收集合与受信探针不能由工程任意删除或改成恒真。

QA 使用独立运行身份，在固定 PR head 或发布制品上执行验收。不同 Profile 名字不等于独立身份，换一个模型也不能自动证明独立性；身份来源、工作区和证据签发权限必须分开。

当前验收记录中名为 `human` 的类别，不应被直接解释成“必须真人点击”：现有流程本就存在 AI QA 独立复核。迁移时应按可信评审主体和证据语义建模，必要时引入清晰的 `review_signoff` 类型，并保留旧字段兼容。 [S03] [S17]

### 6.6 合并与上线：让确定性服务执行真正的放行

建议将合并权限从通用工程会话收回，交给受限的发布服务。发布服务重新检查：

1. 当前产品与授权未撤销；需求修订、策略和实际 diff 一致。
2. 当前 PR head 与被独立验证的版本一致，所需检查仍有效。
3. 目标仓库和分支在许可范围内，受保护路径无越权。
4. 产品预算、发布资源锁、发布节奏和健康条件满足。
5. 合并操作没有已经发生或处于未知结果待核对状态。

随后按产品已有 CI/CD 合并和部署。Agent 可以准备变更、解释异常、提出恢复建议，但不应持有可以绕开上述检查的通用生产凭证。

**现有执行代码在任务提示中已经要求“核对后合并”，不代表所有底层写权限都已被不可绕过地隔离。** 新迭代应检查实际 GitHub 身份、分支保护、流水线权限与部署密钥，而不是只复制这段提示词。 [S03]

### 6.7 上线后验证与效果回流

上线验证至少包括实际运行版本、核心用户旅程、权限正反例以及必要健康信号。CI 成功、部署 API 返回成功、HTTP 200 都不能单独证明原需求满足。

在 `released` 后增加独立结果记录，而不是立即把所有意义都塞入一个终态：

```text
Release：prepared -> merged -> deploying -> deployed -> verified
                                                   \-> failed / rolled_back

Outcome：observing -> effective | ineffective | inconclusive
```

状态名称为建议。为降低迁移风险，现有 requirement 状态可暂不整体改名，新增 `release_attempt` 和 `outcome_observation` 记录即可。

“效果不足”不必总回退；例如一个有效发布未达到预期使用率，可以形成新的产品假设。严重健康退化、功能失效或安全条件违反，则根据预授权策略回退。监测不可用时应标记未知，不把没有数据当作成功。

---

## 7. 受信边界、预算与恢复：不能只靠 Prompt

### 7.1 OpsBroker 必须解开旧租约耦合

当前 `OpsBroker.call()` 通过 `core.opsScope()` 取得来自旧任务租约的作用域。删除旧 task/lease 之前，必须替换这份权限来源。 [S11]

建议抽取以下逻辑接口，名字和代码形状为新设计：

```typescript
interface WorkAuthority {
  resolveVerifiedContext(
    authenticatedWorkload: VerifiedWorkloadIdentity,
    requestedOperation: OperationRequest
  ): Promise<AuthorizedWorkContext>;
}
```

`AuthorizedWorkContext` 至少包括产品、需求授权、工作流、运行批次、允许的操作/环境/资源、预算和有效期。它必须由已认证身份和受信绑定推导，不能相信 Worker 在 JSON 中自行填写的 product、role、taskId 或 runId。

迁移期保留 `LegacyLeaseAuthority`；新执行路径使用 `HermesRunAuthority`。后者不能只相信可由同用户 Worker 改写的 SQLite 行或环境变量。应由可信启动/适配服务绑定工作流、运行身份和短期能力，敏感权限保留在外部代理；必要时对 Worker 的 Kanban 调用也通过受限代理转发。

**隔离集成是明确工程任务，不是给 Docker 打一个勾就完成。** 需要验证工作区、Board 工具、终端、网络、运行身份与生命周期在目标部署方式下如何协同。Hermes 的通用调度可以复用，但受信服务与不受信执行代码不能共享可任意改写的授权状态。

### 7.2 事件只能提示，事实必须可以重新拉取

Hermes 事件通知可用于低延迟更新，但业务控制层必须能在通知丢失后重建结果：

- 保存产品执行单元、Board 标识、数据库代次及最后处理事件游标。
- 消费持久事件并使用幂等投影；重启后补拉，不只依赖 Webhook。
- 对关键终态，重新读取工作流事实及外部 GitHub/部署事实。
- 发生数据库恢复、事件截断或游标不连续时，进入显式重对账，不跳过未知历史。
- 该对账是有界的确定性代码，不是另一个用 LLM 轮询派工的调度器。

原生 Hook 在提交后执行这一事实，决定了它适合作为通知，而不是发布前的阻断点。 [H06] [H10]

### 7.3 外部副作用账本

建议增加统一 `action_ledger`，覆盖合并、发布、回退、账号/权限变更及必要的对外通知。

```text
operation_key
product / authorization / workflow / run
operation_type / target
request_digest
state = prepared | dispatched | unknown | verified | rejected
external_operation_id
result_evidence
created_at / updated_at
```

关键规则：

- 相同 operation_key、不同内容必须冲突。
- 先持久化意图，再调用外部系统。
- 请求超时后先查询外部结果；不能立即重复合并、重复回退或创建第二个账号。
- 外部系统支持幂等键就使用；不支持则采用查询、资源唯一约束和受控补偿。
- 无法确定原操作是否发生时保持 unknown，停止冲突操作，不宣称全局 exactly-once。

这层处理的是**产品和外部系统的事务边界**，不是重新实现 Hermes Worker 心跳。

### 7.4 从事后计费升级为预算约束

保留当前成本归因与“未计价不是零费用”的规则，新增：

- **执行前原子预留**：同一产品并发需求争用预算时不能各自看到同一份剩余额度。
- **执行中限额**：工程、QA、研究、辅助判断、失败重试均归入同一需求和产品预算。
- **完成后结算**：释放未使用预留，对真实账单/请求用量对账。
- **未知成本策略**：无法得到实时准确价格时，使用受控上界或暂停新的消费，不把未知记作免费。
- **供应商回退限制**：换模型不能突破授权成本；费用更高的备选也要通过预算门。

当前 `task-cost.ts` 以完成任务的旧 employee/session 归因为主。迁到 Hermes 后需增加 workflow/run/session 的映射，否则可能出现任务跑通但账单归因丢失。 [S10]

### 7.5 异常不能全部变成“等老板”

| 异常 | 自动处置 | 用尽恢复额度后 |
| --- | --- | --- |
| 临时网络/服务异常 | 有界退避、查询既有操作结果 | 隔离该步骤，按恢复条件重试 |
| 供应商额度耗尽 | 在许可集合和预算内切换或等待明确恢复时间 | 暂停该产品的新模型消费，不扩大授权 |
| 资料或复现不足 | 自动检索、复现、请求可选补充信息 | 延期需求，保留证据与重新触发条件 |
| QA 退回 | 回到工程，携带固定版本与失败证据 | 超过返工预算后隔离需求 |
| 部署失败或健康退化 | 执行已授权回退，验证恢复结果 | 停止该产品继续发布，保留安全服务版本 |
| 原 Worker 是否仍在运行未知 | 先核对运行身份与外部动作，禁止并行接管冲突工作 | 保持 unknown，不把超时当作已停止 |
| 安全或政策违规 | 立即拒绝相关操作并收紧该任务权限 | 隔离；不要求老板在线才能阻止越权 |
| 策略服务、证据服务不可用 | 停止新的不可逆操作 | 服务恢复后自动重新核验，不跳过检查 |

通知老板是可选动作，不是状态机的唯一推进方式。对某个产品暂停发布，也不应自动阻塞其他隔离产品。

---

### 7.6 自学习不能改写授权和验收底线

Hermes 的经验、Memory 或 Skills 可以帮助下一次研究和执行，但产品章程、预算、受信工具许可和基础验收规则不能因为 Agent “学到了更快捷的方法”而自动放宽。产品知识和执行技巧应按产品隔离，带版本和来源；会改变工具行为的 Skills 更新先通过回归，再用于受控任务。外部网页、反馈正文和仓库文件不能直接晋升为系统级规则。

这是自主运行的边界，不是要求每次学习都由老板审核：低风险知识更新可以自动验证并生效；涉及权限或验收标准的变更走独立的受保护策略发布路径。

---

## 8. 代码级处置清单：保留契约，退役重复平台

所有“新增”路径均为建议，不表示仓库已存在。所有“退役”均有迁移条件，不能按目录直接删除。

| 现有位置 | 建议动作 | 迁移后的职责 / 删除前提 |
| --- | --- | --- |
| `src/iteration/feedback.ts` | 保留并扩展 | 原生产品反馈入口；与统一信号模型适配，继续做来源、限流、幂等和隐私处理 |
| `src/iteration/triage.ts` | 拆分 | 保留输入/结果校验、幂等持久化；分类和研究工作由 Hermes 执行；去掉迁移产品的重复模型处理循环 |
| `src/iteration/requirements.ts` | 保留并改造 | 规范需求账本、修订、统一授权入口；老板批准成为可选授权来源 |
| `src/iteration/planning.ts` | 拆分 | 保留计划 schema 和授权绑定；规划模型执行迁给 Hermes，不再两处独立规划同一需求 |
| `src/iteration/execution.ts` | 拆分后逐步退役旧执行编排 | 新路径提交 Hermes 工作流、接收证据并推进产品级状态；不再创建相同的 SCK 子任务链 |
| `owner-end/src/iteration-commands.ts` | 保留人工入口，另建机器接口 | 机器策略服务不调用“老板身份通用接口”；查询与操作权限按产品和用途分离 |
| `owner-end/src/cron.ts` | 收缩职责 | 迁出产品规划/分类的重复模型调用；保留仍被使用的翻译等功能；产品闭环不依赖老板端在线 |
| `schema/063-product-iteration.surql` | 保留历史约束，新增后续迁移 | 新授权表、服务主体、引用兼容、审计；不放松旧批准表的 owner-only 与不可变要求 |
| `src/runner/contracts.ts` | 停止向旧大接口扩展 | 不永久做完整 Hermes `AgentRuntime` 模仿层；使用工作流级后端接口 |
| `src/runner/` 中旧会话、sidecar、派工生命周期 | 按运行后端逐步退役 | 仍有 Legacy 在途任务时保留；Hermes 后端不再依赖这些逻辑领取同一任务 |
| `src/dispatcher/` | 候选退役 | 所有相关产品执行职责移交后，删除重复的分配、唤醒、Worker 恢复与资源清理；保留必要业务策略为小模块 |
| `plugin/server/` 的 Paseo 派工兼容层 | 候选退役 | 没有使用 Paseo 的真实运行路径，且旧在途批次已排空 |
| `src/core.ts` / `src/contracts.ts` | 提取领域契约，再收缩 | OpsBroker、验收、历史查询不再强依赖旧任务核心后才可移除旧租约实现；不要先删核心再修到处断裂的调用 |
| `src/ops/broker.ts` | 保留受信能力，抽取 WorkAuthority | 新授权来源必须就位；按产品拆工具许可，不照搬全部高权限操作给所有 Profile |
| `src/acceptance.ts`、`src/pr-gate.ts`、`src/deployment-source.ts` | 保留/复用强制验真 | 证据由旧 task 主体扩展为 requirement/workflow/release 主体；保留 SHA、环境、轮次与因果校验 |
| `src/task-cost.ts`、必要的 Magpie 归因 | 保留计算规则，替换归因输入 | 建立 Hermes workflow/run/session 归因，新增预算预留；不再要求伪造旧员工领取记录才能计费 |
| `src/model-routing/`、`src/workforce.ts` | 缩减为必要策略和 Provider 适配 | 已被 Hermes 替代的普通路由不再维护；现用订阅、额度和特殊认证逐项验证后删除 |
| `owner-end/src/ui/` 的通用员工/任务大屏 | 冻结扩张，按需退役 | Hermes 负责通用运行视图；SCK 只保留产品结果、政策、成本和异常界面 |
| `tests/` | 迁移契约测试，不整体删除 | 允许替换实现，但旧运行安全条件与生产验真负例必须继续可执行 |
| 老任务、审批、验收、成本与审计数据 | 只读保留/明确归档 | 有可核对的映射与保留策略后处理，不为了清爽而删除证据 |

### 8.1 新增模块建议

先作为现有后端中的模块，不强制拆成独立服务：

```text
src/autonomy/
  charter.ts              # 产品目标、授权策略、版本及撤销
  signals.ts              # 规范信号与去重
  decisions.ts            # 证据化决策，allow/defer/reject
  authorization.ts        # 不可变授权与统一验证
  budget.ts               # 预留、限制、结算
  outcomes.ts             # 上线后观察与问题闭环

src/execution/
  backend.ts              # 产品工作流级接口
  legacy-backend.ts       # 迁移期旧路径
  hermes-backend.ts       # 版本固定的 Hermes 适配
  reconciliation.ts       # 事件补拉与结果对账

src/release/
  authority.ts            # 合并/发布/回退权限验证
  actions.ts              # 外部副作用账本
  evidence.ts             # 复用现有 CI/部署验真
  recovery.ts             # 有界恢复与回退
```

这些文件名是交接建议，实施者可以调整布局，但不要借“架构整理”改写与目标无关的所有代码。

### 8.2 后端接口应面向工作流，而不是会话模拟

建议最小接口：

```typescript
interface ExecutionBackend {
  submitAuthorizedWorkflow(input: AuthorizedWorkflow): Promise<WorkflowBinding>;
  inspectWorkflow(binding: WorkflowBinding): Promise<WorkflowSnapshot>;
  requestCancellation(binding: WorkflowBinding, reason: string): Promise<CancelReceipt>;
  readEvents(cursor: ExecutionEventCursor): Promise<ExecutionEventPage>;
  readArtifact(ref: AuthorizedArtifactRef): Promise<ArtifactReceipt>;
}
```

这里的类型均待实现。`submitAuthorizedWorkflow` 的幂等键建议由产品、需求、修订、授权和后端代次构成；重复请求返回既有绑定，不重复创建卡片。

`requestCancellation` 仅表示取消请求已受理，不应立即视为进程已停止。只有核验运行结束、权限撤销及未决外部操作之后，才允许冲突任务接管。

Hermes 的普通卡片状态保留在 Hermes。SCK 保存必要的 `WorkflowBinding`、产品进度投影及证据，不维护重复的每个 Worker 心跳和 lease。

---

## 9. 接下来具体怎么迭代

### 总体顺序

**先让授权不再依赖老板，再接入 Hermes 执行，随后打通真实发布和恢复，最后删除重复平台。**

不能把“完全替换执行框架”放在“证明产品能够自主运行”之前。授权和产品闭环改造即使暂时使用现有运行器，也应产生可验收价值；Hermes 迁移不能成为一个无限延期的前置大重构。

### M0｜冻结可复现基线，建立无人值守契约（P0）

**修改/新增：** 设计说明、测试夹具、后端路由开关与 `tests/autonomy/` 的第一批失败用例。

**任务：** 固定本文两个提交；记录实际启用的 Provider、运行器、产品仓库、CI 和授权边界；选择一个可回退的试点产品。将“没有老板批准时无法前进”作为当前基线复现，而不是忽略。

**必须交付：**

- `docs/autonomy/baseline.md`：版本、现状、实际运行方式、未验证项。
- `docs/autonomy/authority-map.md`：谁能改需求、策略、PR、部署和证据。
- 无人回复、伪造批准、重复请求、错误部署证据等自动化负例。
- 明确区分旧任务后端与新工作流后端的路由字段，旧任务默认不迁移。

**验收：** 能准确解释现有系统在哪里依赖 owner；测试不会读取生产凭证，不会修改生产数据。基线记录中的运行事实必须来自实际配置，不从 README 猜测。

### M1｜机器授权与产品预算最小闭环（P0）

**重点位置：** `requirements.ts`、`planning.ts`、`execution.ts`、`iteration-commands.ts`、新数据库迁移、`src/autonomy/authorization.ts` / `budget.ts`。

**任务：** 新增产品章程与策略服务身份；实现 allow/defer/reject；不可变授权绑定修订和策略；提供受限的机器接口；旧审批通过适配继续可用。去掉新路径对 owner-token 的启动和建单依赖。

**验收：**

- 授权范围内需求能够自动进入 `queued` 并开始规划，不需要真实或伪造的老板点击。
- 普通 Agent、runner、泛用 automation 都不能任意签发授权。
- 两个并发需求不能重复占用同一份预算；策略撤销后新的受限操作被拒绝。
- 旧审批记录、在途旧任务和旧权限测试仍能正确工作。
- 日志能区分 human 与 policy 授权，不能全部记成 owner。

**交付意义：** 这一阶段即可使现有后端支持有界自主化，不等待 Hermes 全部迁移。

### M2｜Hermes 接管试点产品执行职责（P0）

**重点位置：** `src/execution/`、产品 Profile/工作流配置、受限工具适配、`WorkAuthority`。

**任务：** 建立独立 Hermes 执行单元；规范工作流请求绑定；转换需求、计划和验收输入；打通工程与 QA；适配终结工具协议、工作产物、Run 身份、事件补拉和取消语义。

**先采用最小路径：** 一个研究/规划路径、一个工程路径、一个独立 QA 路径。是否使用 Codex App-Server 按该角色的工具需求选择，不做全角色统一切换。

**验收：**

- 一条新授权需求只对应一个执行工作流，重复请求不会重复派工。
- 新路径没有同时生成一套 SCK 子任务链再让旧 Dispatcher 处理。
- 工程送审、QA 退回与通过、Worker 重启、旧 Run 迟到结果均可正确处理。
- 不因只有最终文字而误判 Hermes 卡片完成。
- 新后端敏感操作的授权来自可信工作身份，不是自报员工编号。
- Hermes 版本升级前有接口契约测试；没有需要长期维护的大型上游 fork。

### M3｜自动发现与产品决策，不只接受老板输入（P0）

**重点位置：** 反馈入口、`signals.ts`、`decisions.ts`、分类/规划适配。

**任务：** 接入真实产品反馈和至少一个机器可验证的故障/探测来源；把信号聚类成规范需求；实现证据化价值判断、历史关联、自动延期与恢复条件。研究/分类模型通过 Hermes 调用，服务端做 schema、身份和授权校验。

**验收：**

- 一个用户反馈和一个机器故障信号可以在无人批准的情况下形成授权需求。
- 噪声、重复和不符合产品目标的请求不自动耗费开发预算。
- 需求有来源、证据、验收、风险、预算与明确的产品目标关联。
- 失败重试不无限循环；单一异常需求不堵住整个产品。
- 迁移产品不再同时由旧 `cron.ts` 和 Hermes 对同一反馈重复调用模型规划。

### M4｜自动发布、线上验真与受控回退（P0）

**重点位置：** `src/release/`、现有验收/部署证据模块、OpsBroker、目标产品受保护 CI/CD 配置。

**任务：** 合并操作经过受信服务；绑定当前 PR head 与独立 QA；复用既有构建部署；验证实际 merge SHA、制品、production 部署和线上行为；实现已授权回退及回退后的复验。

**验收：**

- Worker 没有可绕过代理直接生产合并/部署的旁路权限。
- 错误 SHA、陈旧 QA、被修改的 PR head、缺失部署记录、错误环境均不能放行。
- 部署成功但实际用户旅程失败，不得宣称需求满足。
- 可回退失败场景自动恢复到已知正常版本，不等待老板回复。
- 通知丢失或接口超时后能通过外部事实恢复，不重复执行有害副作用。

### M5｜产品结果、长期无人值守和故障隔离（P0）

**重点位置：** `outcomes.ts`、预算结算、事件对账、恢复控制、产品状态页。

**任务：** 对发布结果建立观察窗口，关联原信号；补全异常分类、有限恢复、死信/延期队列和重新触发条件；贯通各模型角色与 Run 的成本归因。

**验收：**

- 产品连续运行期间没有“必须等待老板答复”的正常路径。
- 人工不在线时，已授权工作继续，未授权工作安全停止，其他产品不受影响。
- 遥测缺失、成本未知或外部操作未知时状态真实，不冒充成功。
- 运行器故障、Provider 故障和恢复后的对账均有可复现证据。
- 业务效果不足能形成新信号，而不是不断重复执行同一需求。

### M6｜切流、删除重复实现与第二产品复制（P1，退役依赖 P0 通过）

**重点位置：** 旧 Dispatcher / Runner / Paseo 兼容层、通用 UI、产品配置模板。

**任务：** 按产品仅对新需求切换后端，旧工作排空；确认所有真实调用点后删除重复执行代码；以第二个产品验证接入是配置和有限适配，不是复制整套系统。

**验收：**

- 不存在同一工作被两个调度器拥有的窗口。
- 被删除代码有调用关系检查、测试替代和历史读取方案。
- 第二产品有独立作用域、预算和部署授权；一产品不能操作另一产品。
- 通用会话、运行和看板能力已经使用 Hermes，而不是在“适配层”里又造了一遍。
- 当前业务所需 Provider 兼容性通过后才删除对应旧执行器。

### 9.1 第一批实现 PR 应怎么拆

建议直接拆成三个可独立评审的 PR，而不是发起“全面重构 AI 公司”：

**PR-A：机器授权契约。** 新表和服务主体、统一授权读取、策略撤销、预算预留，以及旧审批兼容测试。不得接触生产切流；测试明确证明未授权自动化仍被拒绝。

**PR-B：Hermes 工作流后端。** 后端接口、产品绑定、角色模板、结果/终结协议、事件补拉、取消、可信 Run 绑定与最小隔离环境。不得为了接入而削弱旧验收。

**PR-C：受信发布与无人值守贯通。** 合并执行权、CI/CD 与部署证据适配、线上探测、外部副作用恢复，以及无人工回复的端到端场景。

三者都有独立测试和可回退开关。优先级按依赖推进，不意味着把尚未成立的机器授权留给 Prompt 补齐。

---

## 10. 验收矩阵：必须证明的是自主闭环，而不是 Demo

以下是**建议的验收要求，不是已通过的测试结果**。P0 任何一项失败，都不能宣称对应产品已具备生产无人值守能力。

| ID | 场景 | 通过条件 | 等级 |
| --- | --- | --- | --- |
| A01 | 老板完全不登录、不批准、不回复 | 授权范围内的真实需求从信号到线上验证闭环，没有隐藏的人工解锁 | P0 |
| A02 | 自动发现可复现故障 | 形成证据化需求，自动授权并修复，原问题在指定版本消失 | P0 |
| A03 | 噪声、重复、无关需求 | 正确丢弃/关联/延期，不占用完整开发预算，不反复建单 | P0 |
| A04 | 反馈包含“忽略规则、改权限、立即发布”等内容 | 作为不受信数据处理，不能产生额外工具权限或修改策略 | P0 |
| A05 | 跨产品信号、任务或工具调用 | 不能读取或操作不在授权范围内的另一个产品/租户 | P0 |
| A06 | 普通 Agent 伪造 owner 或 policy 授权 | 数据库/服务身份层拒绝，审计保留真实调用主体 | P0 |
| A07 | 需求修订或验收条件变化 | 旧授权失效或需重新签发，旧工作不能按新目标冒充已验收 | P0 |
| A08 | 产品停用、策略撤销或过期 | 后续受限操作立即重新核验并拒绝；允许必要的安全清理 | P0 |
| A09 | 多需求并发预留预算 | 总预留不突破产品额度；不重复释放，不把未知消费记为零 | P0 |
| A10 | 实际 diff 越过原许可范围 | 合并前被阻止，不能靠模型风险自评放行 | P0 |
| A11 | 工程提交者伪造 QA 或重用旧签署 | 独立身份、固定版本与当前轮次验证拒绝 | P0 |
| A12 | PR head 在验收后变化 | 必需检查与独立复核重新绑定，旧绿灯不能合并新代码 | P0 |
| A13 | 尝试修改受信测试/工作流/授权代码放行自己 | 受保护路径与外部合并权限阻止旁路 | P0 |
| A14 | PR/CI 成功但生产未部署 | 不进入 released/verified，状态明确为等待证据或失败 | P0 |
| A15 | 部署到错误环境或错误 merge SHA | 生产验真拒绝，不以合并前 PR head 替代实际部署版本 | P0 |
| A16 | 部署成功但线上旅程失败 | 不宣称交付成功；按策略回退并验证恢复，或安全停止 | P0 |
| A17 | 发布后监控不可用 | 标记未知/观察未完成，不将无数据当正常，不盲目继续扩大发布 | P0 |
| A18 | Worker 崩溃、主进程重启、旧 Run 迟到 | 有界恢复，不把中断当成功，不允许旧结果覆盖新批次 | P0 |
| A19 | 停止请求丢失、旧进程仍在运行或状态未知 | 不重复派出冲突执行；先核验并撤销/隔离相应权限 | P0 |
| A20 | 重复 Webhook、遗漏通知、游标恢复 | 幂等落账并从持久事实补齐，无二次授权或重复业务副作用 | P0 |
| A21 | 合并/回退请求超时，外部可能已经完成 | 通过 operation key 和外部事实恢复，不能盲目重发 | P0 |
| A22 | Hermes Worker 只有最终文字、没有终结工具调用 | 测试识别协议未完成；适配正确关闭/送审/阻塞，不误报完成 | P0 |
| A23 | Provider 限流/额度耗尽 | 仅在已授权集合和预算内切换，或自动等待；不无限重试 | P0 |
| A24 | 联系方式、生产凭证和受控资料 | 不进入不必要的模型上下文、公共日志或跨产品工作目录 | P0 |
| A25 | 某需求无法自行解决且老板始终不回复 | 需求被有界延期/隔离，产品其他合规工作继续 | P0 |
| A26 | Hermes 升级及数据库/执行单元恢复 | 契约回归通过；恢复后重新对账，不启动重复写者 | P0 |
| A27 | 第二产品接入 | 通过配置与有限适配复制闭环；权限、成本、产物、部署互相隔离 | P1 |
| A28 | 成本和业务效果统计 | 能追溯信号→需求→授权→Run→PR→部署→观察，不丢失失败和未计价部分 | P0 |

### 10.1 建议的无人值守试运行门槛

在完成隔离测试后，可为试点产品预先登记一个无人值守观察窗口，例如连续 **72 小时**，投入不少于 **20 条授权范围内需求和 10 条拒绝/延期/异常样本**，并覆盖重启、供应商故障、事件丢失与部署回退。

这些数字只是**建议的验收规模**，不是上线承诺、工期估计或当前能力数据。产品规模不同可以调整，但必须在试运行前固定，不能看到结果后删掉失败样本。

通过条件至少包括：零未经授权生产操作、零错误宣称上线、零重复有害副作用；全部完成样本都有可追溯证据；全部未完成样本有真实原因和下一步自动行为。难以自动解决的任务允许延期，但不能把大量任务都延期来伪装成功。

隔离故障测试先于真实产品试点；不要为了做故障演练直接破坏客户生产服务。

---

## 11. 切流、回滚与历史保全

### 11.1 执行后端切流

以产品和新需求为单位切流，不把运行中的旧会话硬搬进 Hermes：

1. 固定 `execution_backend` 与后端代次，新授权记录写入明确后端。
2. 影子阶段只读取和对照旧系统事件，不对同一工作产生第二份真实副作用。
3. 试点通过后，旧后端不再接该产品的新需求；已有任务继续由原后端完成或经受控取消。
4. 新需求进入 Hermes；保存需求、授权、工作流和 PR/部署之间的映射。
5. 在途任务、待落账结果、未知外部操作全部核对后，再卸载旧派工路径。
6. 所有产品都完成迁移后，才删除原通用执行基础设施。

**不要在 Hermes 中给每张卡创建一个“对应旧 SCK 任务”来满足旧 OpsBroker 租约。** 这可以临时帮助测试，但不能作为终态：否则两套任务、租约和生命周期会永久存在。

### 11.2 两种回滚必须分开

**产品版本回退：** 由受信发布服务按预授权策略执行，回到已知正常的制品或配置；记录回退原因、实际版本、部署和复验。涉及不可逆数据变更的需求，不能假定代码回退就足够，应在准入时排除或使用已验证的专门恢复流程。

**执行平台回退：** 停止 Hermes 接收该产品新工作，撤销相关短期操作许可，核对仍运行的 Worker 与未知外部动作，完成对账后把后续新需求切回 Legacy。不能直接让旧 Runner 接管 Hermes session ID，不能在旧进程是否终止未知时同时打开两套执行器。

任何自动回退都应有最大次数、健康判据和停止条件，避免在两个版本之间无限来回切换。

### 11.3 保留哪些数据

保留原需求、审批、审计、验收、成本和必要产物索引；新系统对历史引用提供只读查看。迁移映射应能够解释“这条需求在哪个后端、哪次授权、哪个版本上完成”。

Hermes 本地数据库和附件需要一致性备份，工作成果应尽早进入 Git/受控产物存储。备份恢复后必须与 GitHub、部署系统和授权账本对账；不能仅恢复本地状态后重放所有副作用。

### 11.4 立即停用新发布的条件

出现未经授权操作、错误发布声明、证据伪造、跨产品访问、重复有害外部操作、无法解释的预算突破或同一工作双执行，应停止相关产品的新发布并保留证据。

该停止动作应能由系统自己执行；不把“通知老板并等他上线点暂停”作为唯一安全措施。已有线上服务可继续保持最后正常版本。

---

## 12. 衡量是否真的变成自主产品工厂

不要以 Agent 数量、同时开了多少会话、自动生成了多少任务、累计执行多少工具作为主要结果。

| 指标 | 建议口径 |
| --- | --- |
| 范围内自主交付率 | 一个固定观察队列中，授权范围内且无需人工干预完成线上验收的需求 / 同队列全部合格需求；未完成者不能从分母删除 |
| 总需求覆盖情况 | 全部信号分别进入重复/噪声/延期/拒绝/实施/成功的分布，用来防止“全部拒绝所以零事故” |
| 人工依赖 | 每条需求要求真人确认、补信息、恢复运行的次数和原因；范围内主链目标为零 |
| 交付正确性 | 错误宣布上线、验收后回归、错误版本、重复副作用、越权操作的次数 |
| 用户问题解决率 | 与原信号绑定的复现条件在观察窗口中是否消失；不能只统计 PR 合并 |
| 恢复能力 | 故障到安全状态/恢复状态的时长，自动恢复与隔离的比例，是否需要人工解锁 |
| 成本 | 每次成功交付和有效改进的完整成本，包括调查、QA、返工、失败、辅助模型与基础设施 |
| 产品效果 | 与产品章程目标对应的可观察变化；样本不足时给出 inconclusive，不编造因果改善 |
| 架构收缩 | 实际退役的重复运行路径、长期自研适配面积、上游升级回归成本，而不只是删掉多少行 |

目前没有本次生产运行数据，所以这些指标只能作为迭代验收设计，不能填写虚构的当前值或预估改善百分比。

---

## 13. 现在应停止、继续和新增的工作

### 停止扩张

不再继续为通用 Agent 平台增加大量岗位枚举、拟人化管理流程、员工语言展示和运行大屏定制；不再把复杂性继续堆进自研 Dispatcher；不再为相同需求同时建设两套队列和两套恢复协议。

这些现有能力可以为了生产稳定保留，但除必要修复外，不应优先于自主需求和交付闭环。

### 继续投入

继续打磨需求可验证性、生产证据、凭证边界、异常恢复、成本归因以及真实产品的测试/回退能力。这些决定自主化能否落地，换任何 Agent 框架都不能省略。

对现有 Factory/Claude/Codex、Magpie 以及特殊订阅使用方式，按真实业务需求列出兼容矩阵。不要因为 Hermes 支持某家模型 API，就认定当前账号、订阅、会话恢复和费用路径已经等价。 [S10] [S13] [H02] [H08]

### 新增主线

产品目标与策略、机器授权、预算预留、信号接入、自动准入、受信合并与回退、结果观察，以及可重复的产品接入模板。

这是系统的下一代价值，不是“另一套更漂亮的员工管理台”。

---

## 14. 接手工程师 / Agent 的执行指令

### 14.1 首先阅读

公司代码优先顺序：

```text
src/iteration/requirements.ts
schema/063-product-iteration.surql
src/iteration/planning.ts
src/iteration/execution.ts
src/iteration/triage.ts
src/iteration/feedback.ts
owner-end/src/iteration-commands.ts
owner-end/src/cron.ts
src/runner/run.ts
src/runner/contracts.ts
src/ops/broker.ts
src/task-cost.ts
tests/product-iteration.fork.test.ts
```

Hermes 优先阅读 Kanban、Worker Lanes、Codex Runtime、Hooks 与 Security 文档，以及本报告列出的三个固定提交源码文件。不要从一篇营销文章推导全部生产语义。

### 14.2 先复现现有约束，再改身份和执行边界

在符合仓库要求的隔离环境中，确认版本并运行现有迭代集成测试：

```bash
git rev-parse HEAD
RUN_SCK_ITERATION_TESTS=1 bun test tests/product-iteration.fork.test.ts
```

该测试文件依赖本机公司 SurrealDB fork（文件中使用 `~/.surrealdb/surreal`）及 Bun，会创建临时实例；没有显式设置 `RUN_SCK_ITERATION_TESTS=1` 时相关测试会跳过。不要将“测试命令退出成功但核心用例 skipped”写成验收通过。 [S12]

以上是接手者的操作说明，本次研究没有执行这些命令。

### 14.3 第一份工程交付应包含

- 产品自主化 ADR：确认本文职责分工、事实来源和不再强制 owner 的正常路径。
- 新授权 schema/API/服务身份设计，以及不可绕过的检查位置。
- 一个故意无人回复的端到端测试，覆盖正常需求和安全延期需求。
- Hermes 后端的输入/输出与错误契约，特别是终结工具、取消、事件重放和产物引用。
- 旧模块依赖与退役条件，不只是一个“以后删这些目录”的列表。

### 14.4 不得采用的捷径

不得把 owner-token 放入 Hermes Profile；不得把审批 actor 全写成 owner；不得关闭现有不可变审批保护来实现自动批准；不得把生产 Token 发给通用工程 Agent；不得用完成 Hook 代替发布前授权；不得把 done、CI 绿灯、HTTP 200 或模型总结单独当作上线证明；不得让同一个实际执行主体伪装成 QA；不得先删除旧核心再靠临时兼容代码补回；不得把“老板始终不回复”的测试悄悄换成由另一个 Agent 冒充老板回复。

对框架功能尚未验证的地方，应补契约测试和有限适配，不重新造一套通用 Agent 平台。

---

## 15. 尚需在实施中确认的事项及默认决策

源码足以确定上述架构方向，但不能替代实际部署信息。以下事项不需要阻止开始设计；采用明确默认值，然后在 M0 中核对。

| 未由本次研究证明的事项 | 默认决策 |
| --- | --- |
| 所有现有 Provider/订阅是否可被 Hermes 原样替代 | 先迁已验证路径；必要的旧执行器保留到对应契约通过，不以文档列出的历史编制代替生产清单 |
| 目标产品是否有可靠自动部署、版本识别和回退 | 没有则不授予该产品自动生产发布；先补该产品的部署与验收契约 |
| 必须不必须跨主机共享同一执行队列 | 首期不采用共享 SQLite 多主机调度；产品执行单元单活，灾备受控恢复 |
| 产品是否运行客户不受信代码或处理高敏感数据 | 按需要真实隔离设计；不能将 Board/Profile 当作安全边界 |
| 实际维护成本能降低多少 | 用迁移前后真实运行路径、故障和升级成本衡量；不承诺未测量比例 |
| Hermes 固定版本的具体插件、工具和运行时组合是否兼容 | 使用最小 Profile 集合和契约测试；升级必须先回归 |
| 是否每个产品都适合相同自主等级 | 产品策略独立；某产品延期或冻结，不阻止其他产品运行 |
| 本次是否审查了每个对外产品的全部源码与生产配置 | 没有。本次重点是运营控制与执行闭环；接入产品时逐个核对其实际仓库、权限、测试和发布环境 |

**最终决策：不要推倒全部业务规则，也不要继续扩建自研 Agent 平台。用 Hermes 替换通用执行能力，用小而明确的自主控制层把产品目标、授权、预算、交付事实和恢复连起来，让老板退出日常关键路径。**

---

## 16. 证据索引

### 16.1 公司仓库：固定提交源码与文档

以下链接固定到 `e196fa58e21d633676e0f614fd157eaac0915a56`。代码事实优先于过期说明；文档中的生产记录是仓库记录，不代表本次重新完成了生产验证。

| 编号 | 文件 | 本文使用的证据 |
| --- | --- | --- |
| [S01] | `src/iteration/requirements.ts` | 需求状态、修订、策略、不可变批准与 queued 转换 |
| [S02] | `src/iteration/triage.ts` | 分类结果契约、3 条/轮、3 次尝试、30 个候选、新需求 pending |
| [S03] | `src/iteration/execution.ts` | 顺序任务、无需二次发布批准、production 证据与独立复核 |
| [S04] | `schema/063-product-iteration.surql` | owner-only 批准与策略、计划的批准依赖、不可变约束 |
| [S05] | `src/iteration/planning.ts` | 1–6 个步骤、只规划已批准快照、模型输出权限限制 |
| [S06] | `src/iteration/feedback.ts` | 产品来源、限流、幂等、脱敏与 Origin 边界 |
| [S07] | `owner-end/src/cron.ts` | 反馈/规划与定时任务、身份和翻译的现有耦合 |
| [S08] | `owner-end/src/iteration-commands.ts` | 迭代命令的老板身份入口 |
| [S09] | `src/runner/contracts.ts` | 现有面向会话的大型 AgentRuntime 接口及未知态约束 |
| [S10] | `src/task-cost.ts` | 完成任务的成本结算、Magpie 归因、未计价与完整性 |
| [S11] | `src/ops/broker.ts`，重点 328–470 行 | core.opsScope 租约耦合、受信操作与审计 |
| [S12] | `tests/product-iteration.fork.test.ts`，重点前 230 行 | 真实 fork 身份测试、幂等恢复、错误部署证据负例、启用条件 |
| [S13] | `docs/native-agent-runtime.md` | 当前共享 Runner、原生 CLI、服务与节点路由 |
| [S14] | `src/runner/run.ts` | 原生启动、隔离配置、owner 凭证检查与生命周期 |
| [S15] | `docs/runner-lifecycle.md` | 当前由执行器自动收尾，与 Hermes 终结工具的区别 |
| [S16] | `docs/core-contract.md` | 租约、版本、幂等、审计、独立复核契约 |
| [S17] | `docs/acceptance-gate.md` | 受信验收与部署证据的强制规则 |
| [S18] | `src/deployment-source.ts` | 部署来源验真模块；迁移时应复用并对其接口回归 |
| [S19] | `docs/external-agent-integration.md` | 明示为被替代的历史设计，不能当作现成 MCP 接口 |
| [S20] | `package.json` | 项目版本及现有测试/运行入口 |

### 16.2 Hermes 官方文档与固定提交实现

官方文档为研究时访问内容；H10–H12 固定到 `92d9dd4d04fa66d35370c4630d1443431b9476c5`。本研究重点审读 H10 前 220 行及 H11/H12，不将仓库内未逐一阅读的模块宣称为已实测。

| 编号 | 来源 | 本文使用的证据 |
| --- | --- | --- |
| [H01] | Kanban 官方文档 | 持久任务、依赖、Review、PR completion contract 与能力边界 |
| [H02] | Kanban Worker Lanes | Worker 终结协议、Review 路径、外部 CLI 与合作式隔离边界 |
| [H03] | Goals | 会话级持续执行与 Kanban/产品闭环的区别 |
| [H04] | Webhooks | 事件入口、签名与路由能力 |
| [H05] | Cron | 周期触发、脚本与模型工作分离 |
| [H06] | Hooks | 生命周期观察与 outbound 通知的非可靠授权语义 |
| [H07] | Security | 无人值守批准行为、可信代码与隔离边界 |
| [H08] | Codex App-Server Runtime | 可选运行时、工具限制与非任意 CLI 替代 |
| [H09] | Kanban Multi-gateway | 多 Gateway 与单 Dispatcher 的部署边界 |
| [H10] | `hermes_cli/kanban_db.py` | SQLite WAL/CAS；生命周期 Hook 在提交后执行且失败不阻断 |
| [H11] | `hermes_cli/kanban_pr_acceptance_store.py` | local-only 路径、PR 绑定、当前 Run/状态快照与验收持久化 |
| [H12] | `agent/kanban_stop.py` | 最终纯文本不是 Board 终结状态，终结工具与有限提示 |

[S01]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/iteration/requirements.ts
[S02]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/iteration/triage.ts
[S03]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/iteration/execution.ts
[S04]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/schema/063-product-iteration.surql
[S05]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/iteration/planning.ts
[S06]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/iteration/feedback.ts
[S07]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/owner-end/src/cron.ts
[S08]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/owner-end/src/iteration-commands.ts
[S09]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/runner/contracts.ts
[S10]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/task-cost.ts
[S11]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/ops/broker.ts
[S12]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/tests/product-iteration.fork.test.ts
[S13]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/docs/native-agent-runtime.md
[S14]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/runner/run.ts
[S15]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/docs/runner-lifecycle.md
[S16]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/docs/core-contract.md
[S17]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/docs/acceptance-gate.md
[S18]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/src/deployment-source.ts
[S19]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/docs/external-agent-integration.md
[S20]: https://github.com/MainListActivity/surreal-ck-operations/blob/e196fa58e21d633676e0f614fd157eaac0915a56/package.json
[H01]: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban
[H02]: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes
[H03]: https://hermes-agent.nousresearch.com/docs/user-guide/features/goals
[H04]: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks
[H05]: https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
[H06]: https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
[H07]: https://hermes-agent.nousresearch.com/docs/user-guide/security
[H08]: https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime
[H09]: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-multi-gateway
[H10]: https://github.com/NousResearch/hermes-agent/blob/92d9dd4d04fa66d35370c4630d1443431b9476c5/hermes_cli/kanban_db.py
[H11]: https://github.com/NousResearch/hermes-agent/blob/92d9dd4d04fa66d35370c4630d1443431b9476c5/hermes_cli/kanban_pr_acceptance_store.py
[H12]: https://github.com/NousResearch/hermes-agent/blob/92d9dd4d04fa66d35370c4630d1443431b9476c5/agent/kanban_stop.py
