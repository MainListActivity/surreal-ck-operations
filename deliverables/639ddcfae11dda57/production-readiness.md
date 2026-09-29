# SCK-LCA-03 发布准备方案

- 员工：engineering-grok-4e9709
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
| 激活两个工作区并加入成员 | `POST /api/workspaces` 重试，成功后再 `POST /api/workspaces/sck-lca03-a/members` | 已登记的五个账号 | 上线后的工程任务。当前 origin 的模板重试不能定义已存在的 ACCESS employee | 在 503 消失前，QA 不能做成员、移除成员或换票 |
| 复制内容库 | PR #36 的 `origin-pre-start.sh` | `ORIGIN_ENV_CONTENT_PUBLISHER_SECRET`、冻结后的 `_system` | CI，在上线申请 `c4c80c02` 批准并合入之后 | 未批准不得合入。合入即发布 |
| 权益、投影、content_reader | #29 代码加 PR #30 | 复制完成且 origin 健康 | 工程实现/修 CI；上线仍看 `c4c80c02` | PR #30 head `5384fd69847080cd39fbea1902d676e6965bced9` 的 Quality gate https://github.com/MainListActivity/surreal_ck/actions/runs/36459246415 在 Test 失败：runner 没有 `/home/runner/.surrealdb/surreal`。`fe3991c3` 可先修 CI，不得据此上线 |
| 客户读取动作和可撤回样本 | 任务 `b068f582-dbef-4c97-8ce9-694fdb6104b4` | 上面的源 public_id 与现有许可 | product→gm | 没有该项结论时，不能把任何 public_id 当成可读样本 |
| 目标库 id 核对 | 复制后的 `platform_content` 计数和 public_id | 钩子成功日志与 18 表行数 | 部署任务 `7c9fb60c` | 源、目标不一致就停止，不删除任一侧 |

8 条 AC 都留到 origin 健康、工作区 active、且 `b068f582` 给出动作矩阵之后，由 QA 在 `7c9fb60c` 用 `get_secret` 的真实身份逐条测。模拟和本地结果不能替代。

## 停写、写入者与回滚

观察到的内容写入者只有 `surreal-ck-hono` 这一个进程：`/home/ubuntu/.bun/bin/bun run --env-file=/etc/surreal-ck/server.env .../server/src/index.ts`。它提供 `POST /api/content/sources`、`/api/content/batches`、`/api/content/publications`，进程内的引用对账也在这里。主机 timer 里没有内容导入。TiDB、Grafana、Prometheus 与内容库无关，不要动。没有第二个 bun 内容进程。

只停 Hono 不能证明持有 root 的人不会直连 SurrealDB。冻结证明应是：`surreal-ck-hono` 为 inactive，且不再有上述 bun 进程；`surrealdb.service` 保持 active。不要改该服务、root 凭证或数据目录。

不要为了等 CI 长时间停写。PR #36 的钩子是在 Actions 已经检出通过 Quality gate 的提交、上传到主机之后才停服务。恢复版本在停写前就定好：失败时脚本切回 `af8c8b3-ci36491649136`（`af8c8b3087ef4d033a40063fdb39c39da2325893`）。需要退到不同提交时，用已经通过 Quality gate 的 `f1e5bf750698483548428b8635270049c1dcb878` 手动跑 Deploy origin。

回滚后的旧进程会继续写 `_system`，而 `platform_content` 里可能已有副本。阻止双边写入：origin 健康之前不要把旧进程留在运行；若已经回滚，立刻把“`_system` 仍是唯一活写入、副本已过期”写进部署记录，并再次停写后才能重跑钩子。重跑只接受新增行；已复制行不一致就停止。不用删除或改写旧数据来修冲突。

## 交给后续任务的约束

- `c4c80c02` 上线申请前必须确认：五个凭证仍能 `get_secret`，并且 `b068f582` 的授权审查已经有结论。工作区若仍是 provisioning_error，申请里要写明这个 503，不能写成成员验收已具备。未满足时只允许继续实现和修 CI。
- `7c9fb60c` 在上线后按获准方案把工作区激活、加入普通成员和可移除成员，并核对复制后的 public_id。QA 逐条测 8 条 AC。样本或权限不够就阻塞。
- 最终运营验收仍要等全部交付项，包括 `b068f582`，不能漏验。
