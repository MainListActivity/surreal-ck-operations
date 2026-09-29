# SCK-LCA-03 发布准备方案

- 编写：engineering-grok-4e9709；退回修订：engineering-codex-06006c
- 任务：d5ba0dea-2ce3-40ed-8ea4-f27f3fd7d4fa
- 目标：639ddcfae11dda57
- 分支：task/d5ba0dea
- 上一版：ef8306a6bbd0f270d3fe947c91b192a438349bf5
- 经理恢复（version 6）后的边界：这是发布准备方案，不是读者已在生产可用的证明。本轮没有合入、没有停写、没有复制、没有切换 origin、没有改 ma_hono、没有用 root 冒充用户、没有改现有客户工作区。

产品可以按本文验收“步骤真实、责任明确”。文中凡写“待部署执行”的项都还不是生产通过。

## 已完成

### 发布链（只读）

claim 返回的现行 `project.release`：Quality gate 后合入 main，GitHub Actions 的 Deploy production 先 Deploy origin，再发 Cloudflare。不允许 SSH 上主机发布。新的服务端环境变量用 `gh secret set ORIGIN_ENV_<NAME> --env production`，由 CI 写入 server.env。需要停写的一次性迁移放进 `scripts/deploy/origin-pre-start.sh`，CI 在停服务后执行。

核对结果：

| 项 | 证据 |
| --- | --- |
| origin/main | `e8e4a5aa8db99ca21813005a8dfd4a42ec27f9cb`。#31–#34 带 `[skip ci]`，没有 Quality gate，不能当应用回滚点。Deploy production 的 Cloudflare job `needs: origin`。 |
| 本地产品检出 | 仍停在 `15c49fb`，其 `docs/runbooks/production-release.md` 只写 Cloudflare。origin/main 的同一文件已经写成先 origin。后续执行以 origin/main 和工作流为准，不能按这份旧手册漏发 origin。共享检出本轮未改。 |
| 当前 origin | `af8c8b3087ef4d033a40063fdb39c39da2325893`，目录 `releases/af8c8b3-ci36491649136`。成功运行 https://github.com/MainListActivity/surreal_ck/actions/runs/36491649136 。自动回滚上一目录是同一提交的 `releases/af8c8b3`。更早且通过 Quality gate 的提交是 `f1e5bf750698483548428b8635270049c1dcb878`。 |
| #29 | `15c49fb933dd473d25498799d5ac2425d959c743`，Quality gate https://github.com/MainListActivity/surreal_ck/actions/runs/36059850053 成功。当日 Cloudflare https://github.com/MainListActivity/surreal_ck/actions/runs/36060079192 成功，那时还没有 origin job。主机 current 不是这个 SHA。 |
| 密钥名 | GitHub production secret `ORIGIN_ENV_CONTENT_PUBLISHER_SECRET` 已存在（更新时间 2026-09-29T00:50:42Z）。只核对了名称，没有读取值。 |
| 迁移钩子 | PR https://github.com/MainListActivity/surreal_ck/pull/36 ，head `9641a3a046947e533890fc634d0e09f27bf37d2e`，Quality gate https://github.com/MainListActivity/surreal_ck/actions/runs/36505327347 成功，未合入。钩子在旧服务已停止后执行 `bun run --env-file="$ORIGIN_ENV_FILE" src/content/migrate-legacy-cli.ts --writes-frozen`。只复制，已有行只做一致性断言，不删除。 |

`15c49fb` 的 `migrate-legacy.ts` 对 `_system` 的 18 张表做 create-if-missing，不一致就抛错，然后写 `content_migration_state:legacy`。`startServer` 在没有该标记且 `_system` 已有内容时拒绝启动。因此钩子必须在切换 `current` 之前成功。代码回滚不删除已复制的行。

此前只读计数（仍是准备基线，本轮没有再复制）：`platform_content` 不存在；`_system` 中 content_item 1807 且全部 published（legislation 24，judicial_document 1783）。18 表行数见上一版提交。许可动作只有 submit/publish/withdraw/restore。`source_license_revision` 的 UPDATE 会抛不可变错误。

源库标识，只作定位，不表示客户可以读：

| kind | publication_status | public_id |
| --- | --- | --- |
| legislation | published | item_052c480ddfdf4755921cbb26e045e7a2 |
| legislation | published | item_06982d29e23b4d2a9db1a5c4b88842a6 |
| judicial_document | published | debug_publish_probe |

这些 id 的动作矩阵、不可变新修订和可撤回/到期样本属于 product→gm 任务 `b068f582-dbef-4c97-8ce9-694fdb6104b4`。本方案不把 submit/publish 解释成 read，也不新增许可行。目标库里的 public_id 要等复制后再核对。

### 验收身份（IdP 已开通，工作区未激活）

入口是现有租户 `https://o.maplayer.top/t/ck` 的自助注册 `POST https://auth.maplayer.top/api/t/ck/register`，以及 `POST https://auth.maplayer.top/api/login/ck/password`。没有改 ma_hono，没有伪造 token。密码只通过 `put_secret` 写入 production，角色 engineering、qa、product。值不在本文。

| 凭证名 | 邮箱 | subject | 角色 |
| --- | --- | --- | --- |
| LCA03_A_ADMIN_PASSWORD | sck-lca03-a-admin@maplayer.top | 014ac9c4-4423-4e03-9507-356733f6d405 | 工作区 A 管理员 |
| LCA03_A_MEMBER_PASSWORD | sck-lca03-a-member@maplayer.top | 0a06e1a6-a01c-411e-a5a6-fc368da83770 | 工作区 A 普通成员 |
| LCA03_A_REMOVABLE_PASSWORD | sck-lca03-a-removable@maplayer.top | e1a62e00-4228-4ee8-a2f3-2615d90b7b47 | 工作区 A 可移除成员 |
| LCA03_B_ADMIN_PASSWORD | sck-lca03-b-admin@maplayer.top | a1f12bef-27a4-471c-9c76-4ef14e49217d | 工作区 B 管理员 |
| LCA03_NONMEMBER_PASSWORD | sck-lca03-nonmember@maplayer.top | 56af5eff-b491-4278-baf3-508d1e471512 | 非成员 |

`POST https://l.maplayer.top/api/workspaces` 用 A/B 管理员的登录态创建 `sck-lca03-a`、`sck-lca03-b`。两次都返回 503 `workspace-template-apply-failed`：`The access method 'employee' already exists`。只读复核：两行 status=`provisioning_error`，stage=`policy_applied`，库 `ws_26d695c309e5` 与 `ws_fdc9ddd0e47a`，schema_version=4，ACCESS 已有 admin、employee、participant。重试会再次撞上同一错误。没有手写剩余模板，也没有删除这两个库。成员接口因此返回 workspace-not-found。现有客户工作区未改。

所以：五个 IdP 用户可以登录；两个专用工作区还不是 active，普通成员还没加进去，可移除成员也还没加入。这不是生产验收通过。

## 待部署执行

责任角色写成后续任务，不把它们记成已通过。

| 项 | 入口 | 输入 | 责任 | 阻断 |
| --- | --- | --- | --- | --- |
| 修复后恢复两个预留工作区、加入成员 | 下文“工作区恢复门槛”；修复版本发布后以原 owner、原 slug 重试 `POST /api/workspaces`，再走成员接口 | 已登记的五个账号、原预留库及 schema_version | 经理安排独立产品代码修复任务；修复 PR 经 Quality gate、上线申请后由部署工程执行，QA 复核 | 当前代码直接重试必定再次 503；未修复、未部署、未达到 active 不得声称身份条件具备，也不得无条件申请上线 |
| 复制内容库 | PR #36 的 `origin-pre-start.sh` | `ORIGIN_ENV_CONTENT_PUBLISHER_SECRET`、冻结后的 `_system` | CI，在上线申请 `c4c80c02` 批准并合入之后 | 未批准不得合入。合入即发布 |
| 权益、投影、content_reader | #29 代码加 PR #30 | 复制完成且 origin 健康 | 工程实现/修 CI；上线仍看 `c4c80c02` | PR #30 head `5384fd69847080cd39fbea1902d676e6965bced9` 的 Quality gate https://github.com/MainListActivity/surreal_ck/actions/runs/36459246415 在 Test 失败：runner 没有 `/home/runner/.surrealdb/surreal`。`fe3991c3` 可先修 CI，不得据此上线 |
| 客户读取动作和可撤回样本 | 任务 `b068f582-dbef-4c97-8ce9-694fdb6104b4` | 上面的源 public_id 与现有许可 | product→gm | 没有该项结论时，不能把任何 public_id 当成可读样本 |
| 目标库 id 核对 | 复制后的 `platform_content` 计数和 public_id | 钩子成功日志与 18 表行数 | 部署任务 `7c9fb60c` | 源、目标不一致就停止，不删除任一侧 |

### 工作区恢复门槛（当前阻断；需要经理安排产品代码任务）

复现入口：用原 A/B 管理员登录态对原 slug 调 `POST /api/workspaces`，返回 HTTP 503 `workspace-template-apply-failed` / `The access method 'employee' already exists`。`_system.workspace` 已为两个 slug 预留 `ws_26d695c309e5`、`ws_fdc9ddd0e47a`，状态 `provisioning_error`、阶段 `policy_applied`、版本 4。`server/src/workspaces/create-workspace.ts:898-914` 对恢复的库仍从第一份模板重放；`shared/sql/workspace-template/001-access.surql:44` 的 `DEFINE ACCESS employee` 不能重复执行。代码路径在 `create-workspace.ts:974-990` 保存错误墓碑，scope gate 拒绝非 active 工作区。这里是代码分析加前任生产观察，尚未实施修复。

经理须安排独立产品代码任务，修 `create-workspace.ts` 的恢复路径：先只读取得原预留库的 `schema_version:current`，核对 `_system` 记录的 slug、owner、db_name、quota policy 与物理库一致，再从**下一版本**连续应用未完成脚本；每一版成功后才推进版本记录。若已记录的版本与实际 schema 不一致，应停止并报错，不能靠 `OVERWRITE` 全量重放掩盖漂移。模板 pack 与 owner/index 阶段也须可重入。增加真实 SurrealDB 回归：从版本 4、三个 ACCESS 已存在的中断现场恢复，二次重试不产生新库或重复成员，失败时仍留 `provisioning_error` 且不签 scope。只改产品代码和测试，不直接手写这两个生产库的表、ACCESS、状态，不删除预留库，不触碰现有客户工作区。具体修复任务 ID 目前未分派，由 gm 登记；本任务不能替代它实施代码改动。

修复 PR 经 Quality gate 且获运营上线批准后，工程以 A/B 原 owner 的真实 IdP 登录态重试原 slug，核对返回成功且仍指向上述原 db_name；只读核对两行状态 `active`、错误字段清除、`schema_version` 达发布版本、quota/entitlement 投影一致、scope gate 能给各自 owner 签本工作区 scope。再由 A 管理员用 `POST /api/workspaces/sck-lca03-a/members` 加普通成员和可移除成员；B 管理员须属于 B，非成员不得加入 A/B。记录成员接口返回和登录后 scope；故意移除可移除成员留给 QA 的 AC8 测试。任何一步失败，保留墓碑并阻止上线验收，交修复任务处理，不能绕过 gate。`c4c80c02` 上线申请在修复真实部署且上述身份判据成立前只能继续修 CI/代码，不能无条件批准。

### 原票 8 AC 的生产核验清单（均待部署与 QA 执行）

固定前置：#29/#30/#36 及工作区恢复修复均通过 Quality gate 和上线批准，origin 健康；两个工作区 active；五个身份从 `get_secret` 领取并经真实 IdP 登录；复制后核对目标 `platform_content` 的 public_id/版本；`b068f582` 出具逐动作读取许可及合法可撤回/到期样本。以下“允许”只对该项确认的动作、版本、工作区成立。发布前只把下表作为步骤，不把任何一格计为通过。入口以 PR #30 head `5384fd6` 的 `/api/session/content-reader`、网页“法律内容”入口/`/w/:slug/content/:publicId`、内容库 `content_reader` RECORD 会话为候选；合入版本若变更须重新核对路由和预期。

| AC | 入口、身份与操作 | 通过判据、依赖与失败判据 |
| --- | --- | --- |
| 1 当前身份、成员、权益换票 | A 管理员与普通成员分别登录 A，调用 `/api/session/content-reader` 打开获准 ID；非成员、A 已移除成员、B 管理员对 A 重做；请求夹带自选 revision/authority；对比浏览器原 workspace token | 仅有效 A 成员且当前权益覆盖时换得短期独立票，原 token 不变；其余拒绝，客户端不能指定 revision。依赖 active 工作区、#30 与权益配置；接受自选 revision 或跨区票即失败。 |
| 2 可核验投影和交集 | 用获准 A/B 样本先核对当前权益 revision/digest 与内容库投影完全一致，再用错误 revision/digest、未 published、无 read 许可、投影停止续期逐一请求 | 只在 revision/digest 完整匹配且来源动作、发布状态、权益均允许时有正文；未知/错误/中断拒绝。依赖 `b068f582` 许可矩阵和部署后的投影记录；不能用源库 published 代替。 |
| 3 RECORD 与库权限 | 使用真实 `content_reader` RECORD 票对目标库执行授权 SELECT，再试 `DEFINE TABLE`、INSERT/UPDATE/DELETE 正文和投影；A 管理员的 workspace system role 试直连内容库 | SELECT 仅自身许可字段；DDL/DML 被拒或零行生效，复核前后摘要/计数无变化；workspace admin 不能凭原票进内容库。root 只做只读复核，绝不代客户查正文。 |
| 4 网页阅读 | A 管理员、A 普通成员各自从“法律内容”入口打开获准 public_id，再切换工作区/注销；核对显示版本、来源、授权状态 | 两个角色都能在真实页面看到获准正文与准确版本/来源；切换或注销后旧正文不可继续展示。依赖复制后目标 ID 与许可；未激活工作区不测成通过。 |
| 5 五动作及字段边界 | `b068f582` 给出 search/read/cite/AI use/export 分别允许与拒绝的样本；通过候选会话和数据库访问按动作、metadata-only、批量查询、直接 RecordId 分别测 | 仅逐动作许可的字段可见；metadata-only 无正文、摘录、法条全文、隐藏字段；批量与直接 ID 不扩大范围。某动作无合法样本即标未验证并阻断对应 AC，不借运营 publish 推断 read。 |
| 6 lease 与失效收敛 | 查看发布配置/运维契约；真实 IdP 换票后核对票、lease、权益/许可截止；过期 token、投影停续期及保持已建立连接超过上限后重新读取 | 票/会话/lease 均不超过 900 秒且不超过权益/许可有效期；到期或投影中断后在契约上限内拒绝新读取，老连接不能无限读取。需记录墙钟和服务端拒绝结果。 |
| 7 受限投影写入 | 使用客户成员票调用或直连尝试自授权益、修改 `content_authorization_projection`/`content_read_gate`；用受限同步身份走正式同步入口后只读核对 | 客户修改失败或零行生效，正式同步只产出与源事实一致的 revision/digest；日志无 token/secret/正文，客户查询链不用 root。依赖获授权同步能力，root 不用于读取正文。 |
| 8 真实矩阵 | A/B active 且 B 有受控权益样本；A admin/member、B admin、非成员、A 可移除成员；依次测错误 revision、过期 token、停投影、许可到期、内容撤回、内容库 DDL/DML | 各项在真实库与浏览器按前七项预期允许或拒绝；移除成员后旧票在契约期限内失效；撤回/到期后正文不可读；DDL/DML 不改变库。每个负例需保留脱敏请求、状态/错误码、只读前后核对。缺 B 权益或合法到期/撤回样本就阻断，不用合成夹具代替。 |

`7c9fb60c` 的 QA 逐格记录身份引用、workspace、目标 public_id 与版本、来源许可 revision、权益 revision/digest、操作、HTTP/数据库实际结果和时间；秘钥与正文不进任务证据。任一待部署条件缺失或实际结果不符，应退回，不得写“8AC 通过”。

## 停写、写入者与回滚

观察到的内容写入者只有 `surreal-ck-hono` 这一个进程：`/home/ubuntu/.bun/bin/bun run --env-file=/etc/surreal-ck/server.env .../server/src/index.ts`。它提供 `POST /api/content/sources`、`/api/content/batches`、`/api/content/publications`，进程内的引用对账也在这里。主机 timer 里没有内容导入。TiDB、Grafana、Prometheus 与内容库无关，不要动。没有第二个 bun 内容进程。

只停 Hono 不能证明持有 root 的人不会直连 SurrealDB。冻结证明应是：`surreal-ck-hono` 为 inactive，且不再有上述 bun 进程；`surrealdb.service` 保持 active。不要改该服务、root 凭证或数据目录。

不要为了等 CI 长时间停写。PR #36 的钩子是在 Actions 已经检出通过 Quality gate 的提交、上传到主机之后才停服务。恢复版本在停写前就定好：失败时脚本切回 `af8c8b3-ci36491649136`（`af8c8b3087ef4d033a40063fdb39c39da2325893`）。需要退到不同提交时，用已经通过 Quality gate 的 `f1e5bf750698483548428b8635270049c1dcb878` 手动跑 Deploy origin。

回滚后的旧进程会继续写 `_system`，而 `platform_content` 里可能已有副本。阻止双边写入：origin 健康之前不要把旧进程留在运行；若已经回滚，立刻把“`_system` 仍是唯一活写入、副本已过期”写进部署记录，并再次停写后才能重跑钩子。重跑只接受新增行；已复制行不一致就停止。不用删除或改写旧数据来修冲突。

## 交给后续任务的约束

- `c4c80c02` 上线申请前必须确认：五个凭证仍能 `get_secret`，`b068f582` 的授权审查已有结论，两个工作区通过上面的修复与 active/成员核验。当前 `provisioning_error` 是明确阻断，不能当成可上线的身份准备。未满足时只允许继续实现和修 CI。
- `7c9fb60c` 在上线后按获准方案把工作区激活、加入普通成员和可移除成员，并核对复制后的 public_id。QA 逐条测 8 条 AC。样本或权限不够就阻塞。
- 最终运营验收仍要等全部交付项，包括 `b068f582`，不能漏验。
