# SCK-LCA-03 生产身份、内容与权限矩阵方案

任务：`65cc107b-40d9-4e2f-a323-75fe7efb0733`；目标：`4960d4ffb9f5ff97`；版本：v2，2026-09-28。本文供 G2 `553ba0a0-79d8-4b72-bdc9-9f8ef1d4bdee` 审批具体候选和生产操作，再交 QA `aa7c0cfe-ba98-4aa6-9a95-7a16650b3580` 执行。本文不是生产执行记录、许可证明或上线授权。v2 按 gm 退回补上仓库已记载的公开入口，并与仍未知的生产对象分开。

## 决策与证据等级

老板在公司任务 `fc5dc61b-b386-4b4e-ab7a-0d2212f3aea6` 的 `owner_approve` 明确要求：SCK-LCA-03 八条 Acceptance criteria 不缩减；工程发布生产后，在生产用真实身份和内容逐项验收，隔离环境与合成数据不能作为最终依据；生产发布仍走正常上线关口。原票为产品仓库 `.scratch/legal-content-access/issues/03-authorized-content-reader.md`，父规格为同目录 `PRD.md`。前置 A 的已验收交接文件位于 `surreal_ck-task-1494f9cb/docs/implementation/sck-lca-03-handoff.md`，共享契约为该分支 `shared/src/content-reader.ts`。IdP 上游 `ma_hono/.scratch/content-reader-scope/handoff-surreal-ck.md` 定义 `content_reader.v1`。

已从这些文件确认的是**规格/候选契约**：服务端自行核验成员、权益、内容与 lease，IdP 最长默认 900 秒，内容库需以 RECORD schema 权限拒绝无权字段和 DDL/DML。A 文档特别指出 IdP 契约当时尚未成为已提交、已部署工件。下一节列出仓库已经写下的公开入口；那些是本地文件记载，不是在线探测，也不能代替部署回执。正式来源许可、真实工作区与账号仍没有权威记录。下表把「文档已记载」和「仍未知」分开，未知项不能视为已经具备。实际操作只能在 G2 对固定版本、对象、影响和恢复办法逐项批准后开始。

## 仓库已记载、本任务未做在线探测

2026-09-28 只读本地文件。没有打开下列 URL，没有查询生产数据库，没有核对 GitHub 上当前部署提交是否仍等于文档或 `15c49fb`。

`surreal_ck/docs/runbooks/production-release.md` 的 Cloudflare 生产面与 GitHub `production` Environment Variables：

| 记载项 | 文件中的值 |
|---|---|
| Svelte 应用 | `https://l.maplayer.top` |
| Astro 营销站 | `https://www.maplayer.top` |
| Hono 边缘代理 | `l.maplayer.top` 的 API / WS 路由 |
| `VITE_API_BASE_URL` | `https://l.maplayer.top` |
| `VITE_SURREAL_URL` | `wss://data.maplayer.top/rpc` |
| `VITE_OIDC_ISSUER` | `https://o.maplayer.top/t/ck` |
| `VITE_OIDC_AUDIENCE` | `https://auth.maplayer.top` |
| `VITE_OIDC_CLIENT_ID` | `b10df483-1cd4-4beb-8a01-92e8f4b3fdf4`（公开 client id；同文件写明会进入浏览器 bundle） |
| `VITE_OIDC_REDIRECT_URI` | `https://l.maplayer.top/auth/callback` |

同文件「边界」写明：该工作流只部署 Cloudflare 上的两个静态站点和边缘代理；`data.maplayer.top` 上的 Bun/Hono origin 与 SurrealDB 由主机侧管理，Cloudflare 发布不改动数据库、root 凭证或 origin 进程。

`surreal_ck/docs/oidc.md` 记载同一 issuer，以及 Discovery `https://o.maplayer.top/t/ck/.well-known/openid-configuration`、JWKS `https://o.maplayer.top/t/ck/jwks.json`、scope exchange 示例 `POST https://o.maplayer.top/t/ck/scope`。该文件的 Client ID 与 audience 和 runbook 相同。它的 Redirect URI 写成 `https://docs.maplayer.top/callback`，与 runbook 的 `https://l.maplayer.top/auth/callback` 不一致；两处都只是文档，不能认定线上回调是哪一个。文中 `ws_a1b2c3d4e5f6` 是 claim 示例，不是本方案的生产工作区 ID。

A 交接 `surreal_ck-task-1494f9cb/docs/implementation/sck-lca-03-handoff.md` 前置基线表记录：当时读到的 `surreal_ck` `main` 为 `15c49fb933dd473d25498799d5ac2425d959c743`，生产部署列写「未知。交 E / G2」。同文件「仍未知并交给后续关口」再次写明：`15c49fb` 是否就是当前生产版本、内容库迁移是否已在生产执行，均为未知；目标 IdP 是否已部署当时尚未提交的 `content_reader` 契约，以及 allowlist / max TTL 的生产值，也未知。未配置 `content_reader_allowed_client_ids` 时，A 所读 IdP 代码会拒绝签发。

这些记载**不能**证明：当前线上提交仍是 `15c49fb`；内容库的 namespace/database；content-reader allowlist 或生产 TTL；SCK-LCA-03 已经发布。`wss://data.maplayer.top/rpc` 只是 runbook 中的浏览器 Surreal 变量，**不是**已证实的内容库端点。工作区 ID、真人身份、来源许可、内容公开 ID/版本、五动作正反例、可安全到期或撤回的对象、投影恢复步骤继续未知，不编造，也不因此缩小八条矩阵。

## 生产对象登记（G2 前填实，不在任务证据记录秘密）

| 代号 | 所需真实对象与证明 | 当前状态 / 提供人 |
|---|---|---|
| ENV | 生产应用页面、Hono/API、IdP issuer/audience/公开 client id、浏览器回调；以及仍须证明的当前线上提交、内容库端点与 namespace/database、content-reader allowlist/TTL、部署回执 | **部分已记载、未在线探测**：应用 `https://l.maplayer.top`，营销站 `https://www.maplayer.top`，Hono 边缘在 `l.maplayer.top`，issuer `https://o.maplayer.top/t/ck`，audience `https://auth.maplayer.top`，公开 client id `b10df483-1cd4-4beb-8a01-92e8f4b3fdf4`，runbook 回调 `https://l.maplayer.top/auth/callback`（`docs/oidc.md` 另写 `https://docs.maplayer.top/callback`）。A 交接记录当时 main `15c49fb933dd473d25498799d5ac2425d959c743`。**仍未知**：该提交是否仍是线上版本、内容库端点与 namespace/database、allowlist/TTL、IdP 是否已部署 `content_reader`、SCK-LCA-03 是否已发布。`wss://data.maplayer.top/rpc` 不是已证实的内容库端点。工程/运维在 G2 前提供部署回执；QA 只记受控证据位置，不记连接凭证 |
| W-A、W-B | 两个不同的实际生产工作区 ID、各自当前产品版本/内容权益 revision、digest、集合、有效期及授权来源 | **未知**；Workspace Scope 权威导出与运营核对；不得用旧资源 Plus 名称推断权限 |
| A-admin、A-member、B-admin、B-member | 四个获许可真人的测试身份代号、当前成员记录及角色、是否允许执行相应动作 | **未知**；owner 确认使用范围，身份本人/运营通过受控渠道操作；不复制 token |
| outsider、removed | 真实非成员身份；拟在可恢复的 W-A 测试成员上执行移除/恢复的身份及影响评估 | **未知**；不能把真实客户成员随意移除；若无可安全变更的对象，G2 保持等待 |
| C-read | W-A 确实获授权集合中的已发布真实法律内容：公开 ID、精确版本、来源许可证明、允许 read/cite 的动作及到期时间 | **未知**；内容负责人/owner 核对许可、披露范围和可测试性；仅记受控证据代号，不复制正文 |
| C-meta、C-denied | metadata-only 的真实许可/权益组合，以及同库但 W-A 无权读取的真实内容/版本；需能区分来源禁止、未发布、撤回与集合不符 | **未知**；若当前商业配置不具备这些组合，不得暗造权益，需提交具体最小生产变更给 G2 |
| C-expire、C-withdraw | 可在批准时间窗内安全过期或撤回、随后可恢复的真实许可/内容；业务影响对象与恢复校验值 | **未知**；内容权利人与 owner 确认；不能撤回正在服务真实客户的内容来测试 |
| P-revision | 当前投影 active revision/digest、`confirmed_until`、同步能力与可安全中断/恢复的工作区范围 | **未知**；工程/运维提供脱敏检查结果、备份和重放方式；不能由客户写投影 |

任何对象无来源许可、无可证明的成员授权或无安全恢复路径时，对应行保留「未执行」，**整票生产验收不能通过**。模拟账号、合成内容与隔离库仅可用于发布前预检。G2 需决定如何补齐生产对象，不得用本文件自动批准新增账号、购买内容、外部联系或生产变更。

## 执行前门禁与最小影响控制

1. 须先取得 D 的集成候选 PR 和 QA 发布前检查的独立通过记录，并固定候选 commit、schema 迁移、IdP 部署版本和配置摘要；这些前提目前未核实。生产部署另由 G2 批准；G 节点提供真实发布回执后，QA 核对 ENV 版本一致才测试。
2. 对 W-A/W-B 权益和投影、C-expire/C-withdraw 内容及许可、removed 成员记录做受控前态快照：ID、revision/digest、状态、有效期、操作时刻、负责人、恢复目标和校验值。只在受控存储保留必要资料，任务证据仅写引用。生产数据库备份/回滚方法由运维在 G2 写定；本计划不假定快照可直接安全回灌。
3. 先做无写入的正反例：现有页面读取与受限 RECORD 直接查询。更改成员、许可、内容发布状态或投影的测试排在最后，限定 W-A/C-expire/C-withdraw/P-revision 的批准对象与时间窗；每项按「前态核对→单一变更→计时验证→恢复→后态复核」执行。若影响超出批准范围，立即停止并按 G2 回退或事件路径处理。
4. QA 使用与浏览器相同的受限 `content_reader` 身份做直连验证；不得用 root 代替，不能打印 token、密钥、正文、客户姓名或未经许可的内容。输出只保留角色代号、内容公开 ID/版本、状态码/拒绝类别、脱敏截图与审计引用。

## 逐项生产验收矩阵

每行由 QA 补「生产时间、固定版本、执行人、实际结果、脱敏证据、恢复结果」，未执行为 `NOT_RUN`，不能按设计预期填 `PASS`。同一内容在 W-A 和 W-B 的对比须用各自真实权益，不默认 W-B 无权。

| 原票 AC / 场景 | 输入与操作（G2 批准后） | 必须观察的结果与证据 | 对生产的影响 / 恢复 |
|---|---|---|---|
| 1 当前真人与独立换票 | A-admin、A-member 分别从 W-A 页面打开 C-read；对 outsider、removed、无权益主体尝试同一路径；客户端试传伪造 workspace/revision/lease | 有效身份取得短期 `content_reader`，原 workspace token/连接继续有效；无效身份在换票前被拒，伪造授权事实拒绝；记 IdP 响应类别、JWKS 验签摘要、页面状态，绝不保存 token | 读取本身无业务写入；removed 的移除/恢复见下方专行 |
| 2 投影精确性、重试与交集 | 核对 W-A active 投影与权威权益 revision/digest；同一事件重放一次；只在批准的 P-revision 上制造不完整、旧 revision 或同步中断；比较来源动作、发布状态、集合和许可 | 只有完整同版摘要且四种授权条件均满足时可读；重复同步不扩大集合；缺项、旧版、异常一律拒绝；记投影前后摘要、同步审计、直接读取结果 | 会改生产投影，须先保存前态，获准同步器恢复并核对 digest/成员/集合；不能由客户执行写入 |
| 3 RECORD 与 DDL/DML | A-admin 和 A-member 各持当前短票直接连内容库，用 C-read ID 作单条/批量读取；对发布表和投影执行只用于拒绝验证的 DDL/DML 尝试 | schema/字段权限控制，不靠页面过滤；管理员 system role 不产生内容库 DDL/DML；拒绝操作无实际写入，查审计/表版本无变化 | 只允许 G2 明列的无副作用拒绝探针；如任何写入成功立即停止并恢复前态、报告安全事件 |
| 4 最小阅读页 | A-admin/A-member 经工作区入口打开同一 C-read 精确版本并返回工作区；用 outsider、错误/不存在 ID、非授权集合重试 | 正向显示正文、版本、来源、授权状态；两角色均仍是有效成员；拒绝页不泄正文/隐藏字段，返回后原工作区仍可操作；留脱敏页面证据 | 正常浏览无业务写入；截图仅显示获准最少内容，记录受控证据位置 |
| 5 五动作与字段 | 为 search/read/cite/AI use/export 各选有权/无权的真实来源许可与权益组合；C-meta 用单条 RecordId、批量和选择字段请求；C-denied 试直接 ID | 每种动作独立允许/拒绝，不能由 export 或 AI 位推出 read/cite；metadata-only 不见正文、摘录、法条全文、隐藏字段；直连与批量同规则。这里验授权边界，非完整搜索/AI/导出产品流程 | 以现有对象只读探测；若需改许可/权益组合，先列具体变更、影响工作区和恢复值交 G2，不私自更改 |
| 6 lease/撤权收敛 | 记录 A 契约配置的 token、投影 `confirmed_until`、DB session 上限与时钟；取得已建立内容连接后分别测试成员移除、权益/许可到期、投影停止续期，按固定间隔尝试**新读取**；另用已过期 token 重连 | lease 不晚于主体、权益、许可有效期，且不超 A 固定上限；旧连接不能无限新增读取，所有新读取在已批准的确定收敛上限内拒绝；记录 UTC 起止、单调计时、每次结果。到期无宽限 | 会影响成员/许可/投影，逐项只操作 G2 对象；每项完成立即按前态恢复并验证双工作区无旁路影响；不可安全恢复则不执行并阻塞验收 |
| 7 受限控制面与日志 | 用普通成员/管理员尝试写投影，核对同步身份权限；检查应用、IdP、DB 的脱敏审计配置及实际本次日志；查 root 是否参与客户查询路径 | 客户不能自授，只有受限同步能力写投影；客户查询由调用者会话执行；日志无 token、secret、全文；提供配置/调用链与脱敏审计引用 | 拒绝探针应无写入；若日志泄漏或 root 代读，停止后续测试，按事故路径处理和清理 |
| 8 完整身份/工作区/异常矩阵 | W-A/W-B 管理员、普通成员、outsider、removed；错误 revision、过期 token、投影中断、许可过期、内容撤回；重复 AC3 的 DDL/DML 拒绝。先验证各前态，再一次只引入一种异常 | 逐格记录预期/实际；无权限者无法直连或伪造 ID 绕过；异常不扩大访问；恢复后原有合法读取恢复、两工作区隔离。八类异常缺一项不得标 AC8 通过 | 仅对批准的成员/内容/投影实施可逆变更；每格有回退人、前后校验；生产记录变化与影响窗口附 G2 审批 |

特别注意：A 文档指出现有成员移除会写 `disabled_at`，但不撤销已发 IdP token；旧工作区连接不能作为内容撤权证据。生产验证必须观察内容连接的**新查询**何时被 schema 拒绝。投影停止续期也要测试；只看换票失败不足以证明旧连接收敛。

## G2 提交包与恢复核对

提交给老板的 G2 包应是具体对象清单，而非泛泛的“允许生产测试”：ENV 固定版本/部署 diff、schema 迁移与回滚、W-A/W-B 及身份代号、许可内容公开 ID/精确版本、每个动作的来源证明、拟变更的成员/权益/许可/发布/投影记录、时间窗、影响人数、受控前态备份位置、恢复命令或正式 runbook、观察和停止条件。G2 应逐项允许或驳回；未列的操作不得执行。涉及新增外部账号、付费服务、联系权利人或客户时另列所需批准，不能隐含在发布许可内。

每个变更的恢复由原系统的受限控制面执行，恢复后复核成员状态、权益 revision/digest、内容发布与许可、投影 revision/digest/confirmed_until、W-A/W-B 正常读取与拒绝路径。回滚应用版本不自动回滚数据或授权；若迁移不可逆，G2 必须给前向修复和暂停访问方案。若安全边界失败、审计泄漏、恢复校验失败或影响非批准对象，停止测试、记录时间与最小脱敏证据，通知 G2 指定的发布/事故责任人；不继续做其它矩阵项。

## 未取得的输入与交接

仓库已经记载公开应用、营销站、Hono 边缘、issuer、audience、公开 client id 和两处不一致的回调文档；本任务没有在线探测，也没有部署回执证明当前线上提交。仍然**没有**：内容库 namespace/database 与已证实的内容库端点、content-reader allowlist/生产 TTL、`15c49fb` 仍为线上版本的证明、SCK-LCA-03 已发布的证明、生产数据库会话到期行为、两个可用工作区与真人角色、获许可真实内容及五动作许可矩阵、可安全撤回/到期内容、生产投影可恢复操作清单、真实客户资料授权或 G2 批准。A 文件把这些生产事实标为未知，并指出跨仓 IdP 当时尚未提交/部署。B/C 的实施进度不等于已发布。故本任务只交完整测试方案，不填虚构 ID，也不执行权限变化；上述缺口必须在 G2 与 QA 生产执行前由相应权威提供并核验。缺资料时经理应向老板报告具体问题，不能缩小 AC 或改用合成样本宣称最终通过。

本任务验证方式：逐项对照原 03 票八条 AC、A 交接、老板 G1 审批，以及 runbook / oidc.md 的公开入口原文；检查表中八行、对象登记、前置门禁和恢复条件齐全。未打开生产 URL，未运行生产查询、浏览器操作或测试，未联系外部，也未修改产品仓库或内容。
