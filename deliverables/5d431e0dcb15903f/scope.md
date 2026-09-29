# 范围提案：把公司仓库里剩余的规划和已经拆完的票实现完

- 目标：5d431e0dcb15903f（program）
- 提案人：product-devin-016290，2026-09-29
- 老板原始输入：把公司仓库里剩余的规划和已经拆完的票实现完
- 盘存口径：`surreal_ck` origin/main `.scratch/`（207 张票）+ `ma_hono` `.scratch/`（4 张）+ `surreal-ck-operations`（无票）；票状态以 `Status:` 字段为准。结论与 2026-09-18 `.scratch/EXECUTION_PATH.md` 的既定顺序一致，另计入其后新增的 legal-content-access 簇。

## 盘存事实（2026-09-29 盘点）

| 仓/簇 | 剩余 | 性质 |
| --- | --- | --- |
| surreal_ck `.scratch/virtual-employee-runtime` | VER-01..06 全 ready | 实施票，顺序执行，VO 的底座 |
| surreal_ck `.scratch/virtual-office` | VO-01..06 全 ready | 实施票，依赖 VER 簇 |
| surreal_ck `.scratch/legal-content-access` | LCA-04..14 共 11 张 ready（LCA-03 已生产上线、验收链在途，main 上 Status 待收口 PR 合入） | 实施票，簇内依赖链明确（PRD 路线图） |
| surreal_ck `.scratch/claims-vertical` | 仅 PRD（ready-for-agent），**未拆票** | 需先拆票再实施 |
| surreal_ck `.scratch/legal-data-product-wayfinder` | 09/10/11/12（in_progress/open） | **设计/决策票**，产出规格不是代码；其中 12 是内容采集管线规格（首期已定调：本地 agent 采集成品经 MCP 提交） |
| surreal_ck `.scratch/legal-content-mcp` | LCM-07（open；第三项验收「真实 DCR/PKCE/refresh 联测」已由 LCM-10 于 2026-09-11 生产实测完成并标 done/verified） | **证据收口票**：核实勾选与状态后关票，不重复实现 |
| surreal_ck `.scratch/native-resource-quota` | 实施票全 done；剩余为**生产运维收口**（EXECUTION_PATH.md「Operations-only remainders」与 quota PRD 明确） | 非代码工作流，见批次 0 第 4 项 |
| surreal_ck `.scratch/shadcn-migration` | SHADCN-04 ready | 小实施票 |
| surreal_ck `.scratch/server-skeleton` | WP-B-06 ready-for-human（Dockerfile/.env.example/启动文档 sign-off） | 早于现行 systemd+Cloudflare 发布形态，疑似过时，需先判定 |
| ma_hono `.scratch/` | ops-mcp-oauth 01–03 done；content-reader 已随 PR #2 上线 | 无剩余实施票 |
| 其余 16 个簇 | 全部 done / wontfix | — |

合计剩余：实施票有效工作量 **25 张**（VER 6 + VO 6 + LCA-04..14 共 11 + SHADCN-04 + WP-B-06 判定）+ 证据收口票 1 张（LCM-07）+ 生产运维收口 1 条工作流（native quota 切换）+ 决策票 4 张（wayfinder 09–12）+ 待拆票规划 2 个（claims-vertical、内容采集管线=wayfinder-12）。

## 目标用户与场景

- **首要交付客户**：破产债权管理人律师团队（claims-vertical 的第一交付客户），同时保持产品对非法律通用客户可交付（垂直内容必须是可整体移除的数据行，不渗入平台代码）。
- **工作区用户**：管理员与普通成员——获得授权内容检索/阅读/AI 研究能力，以及可观察、可干预的虚拟员工办公室。
- **平台运营**：内容采集发布、权益解释与临时授权、DDL 确认等控制面能力。

## 最小可用版本功能（按优先级分批）

**批次 0：收尾与解锁（小票与非代码收口，先清）**
1. SHADCN-04 视觉对齐收尾。
2. WP-B-06 判定：现行发布为 systemd + Cloudflare，非 Docker——若确认过时则标记关闭（wontfix 并记录理由），若仍需则交付。
3. LCM-07 证据收口：其第三项验收（真实 DCR/PKCE/scope/refresh 联测）已按票内转交约定由 SCK-LCM-10 在 2026-09-11 生产完成（未预注册客户端 DCR、PKCE、五工具、刷新/撤销成功，票标 done/verified）。本项只做窄收口：核对 LCM-10 证据覆盖后更新 07 的勾选与状态；只有核实出新缺口才补实现，不重复已完成的联调。
4. **native quota 生产运维收口（非代码工作流）**：按 `docs/runbooks/native-quota-release-cutover.md` 与 `native-quota-legacy-migration.md` 执行——阶段一维护窗（停写+snapshot+隔离目录 restore drill）与 migration-conductor 四命令（inventory/import/prepare/assert-reopen）；阶段二 cohort 晋级（synthetic_internal→one_percent→ten_percent→fifty_percent→remainder，前两档各观察≥24h、后两档≥48h，remainder 过实时门禁后入全局 30 日稳定窗）；阶段三 30 日 delayed cleanup。验收证据为每阶段运行记录与 `native-quota-acceptance-matrix.md` 口径；观察期按 runbook 固定天数执行，不以工单关闭代替。**红线关口时序（必须在动作前逐个过老板关口，未获批准不得执行对应动作）**：
   - 阶段一 exact digest fork 启动 RocksDB 并执行 format migration——涉及生产数据目录/surrealdb 服务变更，先过红线；
   - **首次** cohort `quota:migration cutover`——runbook 明确其在事务内 reassert native policy 并**删除生产旧 event**，已属「改写或删除生产已有数据」红线，老板批准前不得执行任何含删改旧数据的 cutover；
   - 阶段三 cleanup migration 删除旧 events/tables/installer——同样红线，按 `max(all_native_verified_at, product_stable_since)+30d` 门禁与老板批准双重前置。

**批次 1：虚拟员工执行基础设施（VER-01..06）**
共享执行上下文 seam（Router 零回归）→ 幂等员工生命周期 → 通用持久化触发接管每日债权风险员工 → 可恢复执行窗口与幂等副作用 → 预算/循环/重试/全局背压 → 连接监督与容量验收。理由：它是 VO 簇与后续一切自治员工的底座，且把现有专用 dispatcher 泛化——先做它防止基础设施散落到业务里（PRD 原话）。

**批次 2：虚拟办公室（VO-01..06）**
办公室领域与通知兼容 → 项目经理派单到报告 tracer → 人类请求一次性闭环 → 实时花名册与活动页 → 分析师提议+浏览器管理员确认 DDL → 幂等 onboarding。依赖批次 1 完成。

**批次 3：法律内容产品线续段（LCA-04..08 + LCA-11）**
授权检索/阅读/收藏 → 工作区共享 AI 额度闭环 → AI 用平台内容+私有资料生成可核验回答 → 暂停/恢复/追问重新鉴权 → 订阅变更驱动权限生效收回 → 公开预览与安全缺口提示。按簇内 PRD 依赖链执行；这批构成商业闭环主体。

**批次 4：深一层与垂直交付（LCA-09/10/12/13、claims-vertical、采集管线）**
LCA-09 历史成果保留、LCA-10 七日 Pro 试用、LCA-12 语义类案检索（需 embedding 链路）、LCA-13 运营解释与临时授权；claims-vertical 先拆票再实施（模板包机制、Excel 导入、领域提示注入，全部以 `workbook_template` 数据行承载、可整体移除）；wayfinder-12 采集管线先拆票再实施（首期=本地 agent 采集成品经 MCP 提交，不做服务端爬虫）。批次内可并行，依赖关系由经理拆解时排定。

**批次 5：生产收口（LCA-14）**
真实身份矩阵验收与生产灰度——只能最后做，依赖 LCA-07/09/10/11/12/13 全部落地。

**规划侧（贯穿，不占实施排期）**
wayfinder 09（运营控制面设计）/10（定价与单位经济实验设计）/11（实施规格汇总）。产出是规格文档；10 的实验若涉及真实收费决策属老板专属事项，届时单独上报。

## 明确不做

- 不复活 Electrobun / sidecar / renderer↔main RPC / service JWT / NS-admin / 后端业务 CRUD 代理 / LIVE 转发（EXECUTION_PATH.md 明令）。
- 不做服务端爬虫与整页抓取首期（wayfinder-12 已定调本地 agent + MCP 提交；绕过登录/验证码/访问限制的来源一律不做）。
- 不承诺全量裁判文书覆盖；不向未授权来源获取内容；不把合成内容当真实法律内容。
- 不在本目标内改 ma_hono（无剩余票）或 operations 仓库规则文件。
- 不做定价实验的真实收费动作、不新增付费资源/订阅（红线）。
- native quota 收口工作流中所有删改生产旧数据/变更 surrealdb 服务的动作（阶段一 format migration、首次 cohort cutover 删旧 event、阶段三 cleanup migration）均不默认执行——属红线事项，逐个在动作前走老板关口，未批准即停在该步骤并保留运行记录。
- 不重做已完成票；不把设计票当实施票交付（wayfinder 09–11 交付物是规格）；不把已由 LCM-10 生产联调覆盖的 LCM-07 剩余项当成新实现重做。

## 依赖与风险

- **顺序硬依赖**：VER→VO；LCA 簇内 PRD 依赖链（04←03，06←04+05，07←06，09←06+08，10←08+09，12←06，13←03+05+08，14←多数尾票）；LCA-14 排最后。
- **LCA-03 收口在途**：运营验收已提交、G3 待老板终验；LCA-04 起可在其代码基座上并行推进，不阻塞。
- **许可合规**：内容采集与客户动作授权沿用 LCA-03 建立的许可修订机制；未知权利一律拒绝，不扩大第三方许可——采集管线只能接入许可已核实的来源。
- **embedding/AI 成本**：LCA-12 语义检索与 AI 研究需要 embedding 与 LLM 用量；假设沿用现有已配置 provider key（后端持有），不新增付费服务；若需新 provider 再行上报。
- **WP-B-06 过时风险**：先判定再执行，避免交付无用产物。
- **共享 checkout 与凭证纪律**：所有代码改动走任务分支 worktree；凭证经 get_secret/随任务下发，不落证据。

## 成本假设

- 全部在公司自有基建内完成：GitHub Actions 发布、surrealdb origin、Cloudflare、IdP——**零新增付费资源**（红线）。
- 员工执行成本为既有订阅额度内的 agent 工时；规模约 25 实施票 + 1 证据收口 + 1 条生产运维工作流（含固定观察期，墙钟约 30+ 天拖尾）+ 2 拆票 + 3 设计票，属多交付链工程，按既有「实现→上线申请→合入部署→QA 实测」链逐条推进。
- 内容采集首期是本地 agent 运行成本，不建常驻爬虫基础设施。
