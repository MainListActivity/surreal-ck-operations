# SYS-DISP 发布清单与运行手册（退役硬门禁）

> 历史记录：本文档记录 0.7.0 之前的状态（MCP 服务、`releases/` 与 `active`），已被 0.7.0 取代。正文不再适用，命令与路径不要照用。

适用范围：PR #1469 分支上的 SYS-DISP 派工改动，包括退役与撤凭证硬门禁（`src/retirement.ts`、`Workforce.retire`、`LocalEnrollmentAdmin.revoke`、`admin retire`、`admin revoke`、调度器各退役点与场景回收）。本文件是部署腿的执行依据，本身不授权合入或部署。合入、部署与上线申请仍按 [company-service-operations.md](../company-service-operations.md) 的双面流程与既有审批执行。

## 0. 本次交付的边界

- 本单不合入、不部署、不改生产。生产变更为零，全部验证在公司 fork 的隔离库完成。
- 数据库迁移：无。`employee`、`task`、`audit` 为 SCHEMALESS，没有 schema 文件变更。新增的 `implementer_bound_at` 是可选字段，旧运行版忽略它。
- 新环境变量：无。主机准备：无。`plugin/server/vendor/` 不入库，发布时由 `plugin/scripts/vendor.sh` 生成。
- 头 SHA 以 PR #1469 正文记录为准。本文件不写死提交号。
- 运维工具 `ops_info` 不带 project 是当前预期限制。不要为满足它而借绑 `surreal_ck` 等业务环境。

## 1. 角色

- 发布负责人：原部署 QA 腿（3381c477）的实际工程领取人。以该腿任务历史中的 claim 记录为准，本文件不预先指定人员。2026-10-20 核对时，该腿的任务历史只有 v1 创建记录，尚无领取人。
- 独立 QA：该腿的独立 QA 领取人，负责验收。不得是发布负责人，也不得是本单任何作者。
- 独立工程复核：非作者的工程员工，由正常调度选择。不得是 §2 列出的任何作者，包括 engineering-factory-droid-9aeb10。
- 运营：决定是否上线（上线申请 589b3a2e）。本单 done 后，上线申请才重新送运营。
- 经理：协调维护窗口、暂停与恢复编制、接手。

开工时由经理填写下表。未填写的项目不得视为已核对：

| 角色 | 员工号 | 核对时间（UTC） | 核对结果 |
| --- | --- | --- | --- |
| 发布负责人（3381c477 腿的实际工程领取人） | 待填 | 待填 | 待填 |
| 独立 QA（3381c477 腿的独立 QA 领取人） | 待填 | 待填 | 待填 |

## 2. 治理事实（经理已核，写入交接）

- v51 要求 engineering-factory-droid-7ef5c9 续做；v52、v54、v56 由其执行；v57 提交 a9d8bd5。
- v60 return 后，v61 由 engineering-factory-droid-88ca95 领取，v63 提交 3099bc8；v64、v66 由独立的 engineering-claude-7129c1 复核并 accept。
- 旧运行版 bdf9732 没有运行中实现者的硬绑定，正式历史中没有 `implementer_takeover`。
- 本次管理决定不倒签 v61 的授权，也不抹历史。
- 本补修的接手（经理 gm-codex-488999 v23 决定，受控的一次性人工责任交接）：
  - 原实现人 engineering-factory-droid-88ca95 当时持有另一任务的代码租约。经理不允许其同时改两棵树，因此批准一次受控交接，不做归档或座位调整。
  - v22 的代码领取给了 engineering-factory-droid-f3bd7d。它在写码前被阻塞（v23），未提交代码，不计为作者。
  - 恢复后，由正常调度首次合法领取本单代码写权的工程员工承接返修：engineering-factory-droid-9aeb10，领取于 v25（2026-10-20T16:46:45Z）。它承接 ca5c11e，提交 299967a（R1 代码与测试）及两个文档与注释提交（见 PR #1469 正文）。提交的 Git 作者字段为本机配置身份，员工身份以提交说明与任务历史为准。
- 已知实际作者至少为 factory-droid-b954f0、claude-e3d236、factory-droid-7ef5c9、claude-b5ccb5、factory-droid-88ca95、factory-droid-9aeb10（均带 engineering- 前缀）。所有写过本 PR 及本补修的人，永久排除于本 PR 与本单的独立复核，不能只排最终提交者。
- 经手但未写码，不是作者：engineering-claude-7129c1（v2 代码领取，37 秒后释放，无写码记录，经理 v13 保留其主动回避）。
- f4978d、f3bd7d 按正式记录为复核经手人，不因 review 记录而列为作者。
- 经理批准：若正常调度首次选择原复核人 engineering-claude-7129c1 担任本补修作者，允许从本次决定之后转任实现，但必须新增其作者事实。此时独立复核改为 f3bd7d（前提同上）或另一名无实际贡献冲突的独立工程员工。任何已写代码者不得复核本单。
- 旧运行服务尚不提供 `contributor_dryrun`、`implementer_takeover` 的全部保障。不得裸连生产补字段、换身份或手工 claim。若返修再次派给另一名写手，写代码前先报告归属冲突，不续写以扩大作者集合。

## 3. 发布前：固定 SHA、CI 与生成物

1. 合入：PR 经正常流程合入 `origin/main`。部署只用 main，release 必须可达自 `origin/main`（见 company-service-operations.md §1）。
2. 固定最终 main 集成 SHA：`git fetch origin` 后取 `origin/main` 的完整 SHA，写入部署记录。CI 对该 SHA 必须为绿。若 PR 头与 main SHA 不同，记录差异。
3. 生成固定 release：沿用 company-service-operations.md §2 的步骤（归档、解引用依赖、`plugin/scripts/vendor.sh`、frozen-lockfile 安装、根与插件类型检查）。逐步检查退出码，任何一步失败即停止，保留当前生产版本。
4. vendor 核对：去掉 vendor 文件首行 `// @ts-nocheck` 后，`plugin/server/vendor/src/retirement.ts` 必须与 `src/retirement.ts` 无差异，`plugin/server/vendor/src/workforce.ts` 必须与 `src/workforce.ts` 无差异；`plugin/server/vendor/src/enrollment.ts` 与 `plugin/server/vendor/src/dispatcher/paseo.ts` 同样必须与对应的 `src` 文件无差异。
5. 受影响测试，在公司 fork 隔离库上运行。不得用裸 `bun test` 直连生产库：
   - 根：`bun run typecheck`；插件：`cd plugin && bun run typecheck`。
   - `bun run test:service`、`bun run test:channel`、`bun run test:bridge`，以及全量 `bun run test`，与 §5 基线逐项对照。
   - `bun scripts/test-worktrees.ts tests/retire-gate.fork.test.ts`，应为 20 项全部通过。
   - `bun scripts/test-worktrees.ts tests/retire-gate-revoke.fork.test.ts`，应为 10 项全部通过（撤凭证门禁、场景回收的非拒绝失败、复核阶段合法动作）。
   - 受影响文件集：`bun scripts/test-worktrees.ts` 加下列 14 个文件（共 171 项），应为 148 通过、23 跳过、0 失败：`contributor-cas.integration`、`mcp-run-reclaim.fork`、`worktree-scene`、`worktree-lock`、`implementer-binding.integration`、`dispatcher-sidecar.fork`、`retire-gate.fork`、`v3.integration`、`db.integration`、`retire-gate-revoke.fork`、`dispatch-episode.fork`、`internal-ai-proof.fork`、`paseo-dead-paths`、`worktree-registry.fork`（均为 `tests/` 下的 `.test.ts`）。
6. 记录两面 SHA、`pnpm-lock.yaml` 哈希、vendor 生成物哈希与全部测试数字。

## 4. 切换前采样（回滚候选）

- 只读采样（2026-10-20）：`active` 与插件 SOURCE、DIRECTORY 均为 `bdf9732bddd59dfc5ff5c28be51d73ae51bdf36f`。这是此时的回滚候选，不是未来部署时自动可用的承诺。
- 切换前必须重新采样，并核对：
  - `readlink` 的 `active` 目标，以及 `paseo plugin ls sck-company` 的 SOURCE 和 DIRECTORY；
  - 上一完整 release 目录存在，且其依赖、vendor 与 `scripts/company-service.sh` 可用；
  - 数据库字段兼容（本次无 schema 变更，见 §0）；
  - 插件来源可回到上一完整 release。
- 缺任一项，不切换，报经理。

## 5. 基线对照（发布前复跑，逐项填写）

| 项 | 基线 3099bc8（PR 原记录） | 本分支结果（代码头与证据目录见 PR #1469 正文） |
| --- | --- | --- |
| 根 typecheck | 退出 0 | 退出 0 |
| 插件 typecheck | 退出 0 | 退出 0 |
| `test:service` | 12 通过，0 失败 | 12 通过，0 失败（1 个文件，退出 0） |
| `test:channel` | 132 通过，13 跳过，0 失败 | 132 通过，13 跳过，0 失败（13 个文件，145 项） |
| `test:bridge` | 372 通过，23 跳过，0 失败 | 372 通过，23 跳过，0 失败（24 个文件，395 项） |
| 全量 | 982 个：938 通过，33 跳过，11 失败（gm-attention 5，triage 5，GitHub 重试 1） | 1011 个：967 通过，33 跳过，11 失败（失败名单与基线逐名相同） |
| `retire-gate.fork.test.ts` | 基线不存在 | 20 项，全部通过 |
| `retire-gate-revoke.fork.test.ts` | 基线不存在 | 10 项，全部通过（修复前 ca5c11e 上 9 项失败、1 项通过） |
| 受影响 14 个文件 | 基线不存在 | 171 项：148 通过，23 跳过，0 失败 |

失败名单与基线逐项相同，才算通过。新增失败须先查清，不能以“已知失败”忽略。名单对照见最终头的证据目录（见 PR #1469 正文）中的 `name-diff-vs-baseline.txt`：基线中 981 项的状态不变；1 项旧名称（`employee pre-retire failures do not block scene cleanup; already-retired rows count as handled`，`tests/worktree-scene.test.ts`）被改写为两项新名称；另新增 28 项门禁测试（18 与 10）。因此全量通过数比基线多 29 项，跳过与失败数不变。

## 6. 维护窗口与暂停（由经理协调）

1. 前置条件：运营明确批准，且打包与回滚预检完成。缺一不开窗。
2. 在办采样核实：开窗前，经理通过正式任务历史与任务状态，核实产品侧 barrier、nonce、approval、verification 采样是否在途。
   - 若有采样在途，不取消、不截断，等待其自然收口。
   - 若现有只读入口无法证明无采样，视为未证明，继续等待。不得把任务 blocked 当作无外部运行证据。
   - 不写死日历时间。常规窗口不需要老板决定。
3. 暂停新派工：经理使用现有受权管理通道（manage 能力工具，见 [agent-operations.md](../agent-operations.md) 的「管理工具（manage）」）。
   - 先用 `def_list` 记录受影响编制的原 `enabled` 值，逐个写入发布记录（编制名、原值、记录时间）。恢复时以此为准，不凭记忆。
   - 再以 `def_list` 读出的完整定义为基础，只把 `enabled` 改为 false，用 `def_ensure` 写入。
   - 保留活租约与 comm 目录。不退役、不归档作者、不减少 `max_instances`、不启用原来就停用的渠道。
4. 不做：不裸调 owner 配置（如 `admin config`），不重启整个 Paseo 守护进程，不另建 dispatcher 或定时器，不读取 `private/`、env 或凭证。
5. 缺受控暂停或验证能力时，报精确缺口，不绕行。

## 7. 安装与分层验证

沿用 company-service-operations.md §3 与 §4 的命令与检查。本次额外要求以下分层验证，全部只读：

- 层 1，存活与就绪：`/health` 与 `/ready` 均返回 200。
- 层 2，真实 sck：用已登记员工通道执行 `sck call get_context '{}'`，核对返回。
- 层 3，调度与活租约 adopt：插件重注册后，已有活租约的会话由 sidecar 的 adopt 恢复，不被误退役、不被重派。经理安排一次真实派工，核对 spawn、claim 与任务记录。
- 退役门禁：生产上不执行退役测试，不制造退役或租约故障。门禁以 release 与 vendor 哈希、§3 的隔离测试（19 项与 10 项）及受影响文件集共同证明。
- UI：Paseo Company 页面按 §10 的路径只读核对，不在生产造数。
- 恢复编制（F-C，成功路径）：层 1 至层 3 全部通过，且 §6 的前置条件仍然成立之后，经理按 §6 第 3 步记录的原值逐个用 `def_ensure` 恢复 `enabled`（以 `def_list` 读出的完整定义为基础，只改 `enabled`）。原本即为 false 的编制保持 false。不归档作者，不减少席位，不启用原停用渠道。任一层未通过，不恢复，报经理。

未完成的层次必须标注为未验证，不能宣布部署完成。

## 8. 回滚

1. 先由经理用 `def_ensure` 暂停受影响编制（做法同 §6），并先记录原 `enabled` 值。
2. 旧代码失去新绑定防护时，先冻结相关新派工，保留全部新作者、绑定、审计与租约。完成兼容验证后才恢复派工。
3. 回滚同时恢复 MCP `active` 与插件版本：先停用节点更新器（`sh scripts/node-updater.sh uninstall`），再用当前受审 release 的 `install <previous-release>` 切回 MCP，最后按 company-upgrades.md「手动回退」把插件指回上一版目录。命令形式与顺序以 company-service-operations.md「回滚」为准，然后重做 §7 的验证。不能只切 `active`，不能删除新字段。
4. 旧版忽略 `implementer_bound_at`，保留该字段不影响回滚。
5. 回滚后的编制恢复（F-C，回滚路径）：回滚后的 §7 层 1 至层 3 验证全部通过，再按 §6 记录的原 `enabled` 值逐个恢复；原本即为 false 的保持 false。不归档作者，不减少席位，不启用原停用渠道。
6. 回滚失败时保留现场并报阻塞。不回退到 v3 历史树作为生产来源。

## 9. 证据与交付

- 证据目录：`evidenceDir`，即 `/Users/y/Library/Application Support/SurrealCKCompany/evidence/f517e2e4-49a4-4150-84f1-229710cbde99/`。内含基线（`baseline-3099bc8/`）、旧代码红测（`red-ca5c11e/`）、新代码绿测、并发与全量对照（最终头的证据目录，见 PR #1469 正文）及发布前对照的日志。
- 证据中的预览链接只使用 `sck call deliverable_publish` 返回的 URL。本地路径与 `file://` 不算交付。
- 生产证据记录两面路径、SHA、进程状态、探针结果与真实派工时间。未验证的项明确写“未验证”。

## 10. Paseo Company 验收路径（入口、操作、应见）

入口按 `plugin/client/company.tsx` 当前的标签与分区名写出（动态、收件箱、目标进展、编制）。发布当日以界面为准。验收时记录实际点击路径，并把截图写入 `evidenceDir/ui/`。

| 页面 | 入口 | 操作 | 应见 | 建议证据 |
| --- | --- | --- | --- | --- |
| 目标卡（根阻点） | 「目标进展」标签，目标行 | 点开目标行，展开 | 目标行下一行写明根任务、阶段（执行或复核）、工作流、原因与已等待时长；展开后见每条原因、候选、恢复动作与处理人（经理或老板），以及实现者、作者与复核者 | `ui/goal-card-root-blocker.png` |
| 动态·无法派工 | 「动态」标签，「无法派工」分区 | 查看任务卡片 | 每项写明阶段、工作流、可选人数、已等时长、原因、负责人与恢复动作 | `ui/pulse-dispatch-blocked.png` |
| 编制·忙闲 | 「编制」标签，「员工编制」分区，展开角色分组 | 查看分组标题与会话列表 | 标题为「启用 x/y · 忙 N 闲 N」，忙闲数来自本轮 tick 观测的会话状态；与调度器判定的对应在发布当日核对，不一致记为缺口 | `ui/roster-busy.png` |
| 任务卡（两人返工接力） | 「目标进展」→ 目标行 → 任务行 | 工程 A 实现并提交，工程 B 复核并退回，再点开任务行 | 任务回到执行阶段，实现人仍为 A，B 不能认领执行；实现人在目标行的人员信息或任务详情中核对 | `ui/task-rework-relay.png`，`ui/task-rework-relay.txt` |
| 任务卡（作者回避） | 同上，复核认领 | A、B 皆为作者，二人认领复核 | 认领被拒绝，服务端错误码 `self_review`；C 可认领复核 | `ui/self-review-denied.txt` |
| 收件箱·提醒 | 「收件箱」标签，「提醒」分区 | 同一阶段连续多次 tick，中间重启一次 | 同一通知键 `dispatch-blocked:<任务号>:<阶段>` 只有一条未解决项 | `ui/notice-dedupe.png` |

界面文字以发布当日为准。核对不到的字段在证据中写「未核实」，不得填为已通过。

上表操作与 [dispatch-binding.md](../dispatch-binding.md) §五的步骤 1 至 10 对应。

## 11. N2 桌面目视

- 上线前可以完成的部分：插件类型检查、纯函数测试与渲染文本测试。这些是代码级证据，不代表目视通过。
- 上线前不做：生产或真实桌面的截图与目视，留到获批后的 QA 腿。不得为求截图而提前部署。

## 12. 状态

- 本清单不授权合入或部署。
- 本单完成后，经独立工程复核并提交，才重新送运营决定上线。
