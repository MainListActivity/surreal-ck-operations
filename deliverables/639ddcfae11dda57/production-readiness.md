# SCK-LCA-03 生产就绪包

- 员工：engineering-grok-4e9709
- 任务：d5ba0dea-2ce3-40ed-8ea4-f27f3fd7d4fa
- 目标：639ddcfae11dda57
- 分支：task/d5ba0dea
- 原票：surreal_ck `.scratch/legal-content-access/issues/03-authorized-content-reader.md`（8 条 AC，未关闭）
- 本轮只读。没有停写、没有改 `/etc/surreal-ck/server.env`、没有执行复制、没有切换 `current`、没有合入 PR、没有登记 `env_secret`、没有打印任何凭证值。

验收身份和客户读取许可在已查来源里不存在，8 条 AC 不能对应到可领取的生产测试身份。部署与复制步骤本身可以执行，且不需要改写或删除已有生产数据，也不碰 `surrealdb.service`、root 凭证或数据目录。缺项不能当成通过。

## 已核对的事实

### 远端工作流与回滚点

输入：claim 返回的 `project.release` / `project.rollback` / `project.notes`，以及 origin/main 上的工作流。操作：`git fetch` 后阅读 `origin/main`，并用 `gh run list` / `gh run view` / `gh api` 看检查结果；SSH 只读 `current`、发布目录名和服务状态。

| 项 | 结果 |
| --- | --- |
| origin/main | `e8e4a5aa8db99ca21813005a8dfd4a42ec27f9cb`。其上 4 个提交（#31–#34）都带 `[skip ci]`，该提交没有 Quality gate，只有一次手动 Deploy origin 的 job 成功。不能把这个 SHA 当作应用回滚点。 |
| 本地产品共享检出 | 仍是 `15c49fb933dd473d25498799d5ac2425d959c743`，比 origin/main 落后 4 个提交，工作树另有无关改动。本任务未改共享检出。 |
| 现行发布链 | `origin/main:.github/workflows/deploy-production.yml`：job `origin` 调用 `Deploy origin`，job `deploy`（Cloudflare）`needs: origin`。origin 不健康时 Cloudflare 不会发布。 |
| 主机 | `ubuntu@129.146.179.37`。`surreal-ck-hono` 与 `surrealdb` 均为 active。 |
| 当前 origin | `/home/ubuntu/surreal_ck/current` → `releases/af8c8b3-ci36491649136`。代码 SHA `af8c8b3087ef4d033a40063fdb39c39da2325893`（#28）。成功运行：https://github.com/MainListActivity/surreal_ck/actions/runs/36491649136 （2026-09-28T22:20:15Z）。日志：从 `releases/af8c8b3` 切到该目录后 healthy。 |
| 自动回滚目标 | 同一次切换的上一目录是 `releases/af8c8b3`，与当前是同一提交。下一次失败部署会切回现在的 `af8c8b3-ci36491649136`。 |
| 更早且通过 Quality gate 的提交 | `f1e5bf750698483548428b8635270049c1dcb878`（#27，其 Cloudflare Deploy production 已成功）。主机上还留有目录 `013023cad77720063c3d1febd453696fdae1d6d3`（#26）。手动 Deploy origin 只能填已经通过 Quality gate 的完整 SHA。 |
| 生产健康 | `GET https://l.maplayer.top/health` 返回 `status=ok` 且 `surrealdb=up`。应用与营销站 HTTP 200。这只说明当前 af8c8b3 origin 活着，不说明 #29 或 PR #30 已上线。 |

#29 合并提交 `15c49fb933dd473d25498799d5ac2425d959c743` 的 Quality gate 成功：https://github.com/MainListActivity/surreal_ck/actions/runs/36059850053 。同日 Cloudflare Deploy production 成功：https://github.com/MainListActivity/surreal_ck/actions/runs/36060079192 。那次工作流还没有 origin job。主机 `current` 不是 15c49fb，发布目录列表里也没有 15c49fb。隔离内容库尚未进 origin。

### 运行手册差异

`15c49fb` 的 `docs/runbooks/production-release.md` 只写 Cloudflare，并写明 origin 由主机另行管理。`origin/main` 的同一文件已经改成：Deploy production 先 Deploy origin，90 秒内 `http://127.0.0.1:8080/health` 必须出现 `"status":"ok","surrealdb":"up"`，失败则切回上一 `current` 且不发布 Cloudflare。这与 claim 里的 `project.release` 一致。

后续执行不能按本地落后的 15c49fb 手册只发 Cloudflare。origin/main 的顺序已经对齐，不需要为这句话再改一份产品代码。后续代码任务只在工作流再次偏离 `project.release` 时修改手册。发布工具取自工作流所在分支，应用代码单独检出（#34）。

### 内容库与迁移入口

输入：主机 `/etc/surreal-ck/server.env` 只判断键是否存在、值是否达到 32 字符；用现行 origin 自带的 bun（`/home/ubuntu/.bun/bin/bun --env-file=/etc/surreal-ck/server.env`）对 `main` 做计数。没有选出正文、邮箱、subject 或密钥。

| 项 | 结果 |
| --- | --- |
| `CONTENT_PUBLISHER_SECRET` | 不存在。 |
| `CONTENT_DATABASE` | 未设置。15c49fb 的代码默认 `platform_content`。 |
| `platform_content` 库 | 不存在。 |
| `content_migration_state` | `_system` 中不存在。 |
| `content_authorization_projection` / `content_read_gate` | 不存在。 |
| `workspace_product_entitlement`、`content_grant`、`product_plan`、`content_collection` | `_system` 中不存在。权益表随 #29 的 schema，尚未进这台 origin。 |
| 命名空间 | `main`。另有库 `_system`、`control_plane`、`d`、`docs`、`main`、以及 1 个 `ws_` 工作区库。 |

`_system` 中待复制表的行数（2026-09-28 只读计数）：

| 表 | 行数 |
| --- | --- |
| content_source | 9 |
| source_license_revision | 12 |
| content_item | 1807 |
| content_source_record | 1806 |
| content_version | 1808 |
| legal_article_version | 3670 |
| content_citation | 9228 |
| citation_resolution | 10818 |
| cites_article | 2603 |
| cites_legislation | 2801 |
| ingestion_batch | 359 |
| ingestion_entry | 10633 |
| validation_revision | 0 |
| publication_request | 153 |
| publication_item_result | 1810 |
| publication_event | 1810 |
| content_publication_projection | 1807 |
| platform_content_audit_event | 524 |

`content_item.publication_status`：published 1807，没有 unpublished 或 withdrawn。kind：judicial_document 1783，legislation 24。

`content_source.allowed_actions` 与 `source_license_revision.allowed_actions` 只有 `submit`、`publish`、`withdraw`、`restore`。12 条许可修订里：8 条仅 submit，3 条 submit+publish，1 条四动词齐全。没有 search、read、cite、export，也没有 AI 的 research/generate。`source_license_revision` 在 schema 里对 UPDATE 抛 `immutable-platform-content-record`。不能靠改写这些行给客户开阅读权。

迁移实现在 15c49fb 的 `server/src/content/migrate-legacy-cli.ts` 与 `migrate-legacy.ts`。现行 af8c8b3 发布目录没有这条命令。CLI 在缺少 `--writes-frozen` 时直接退出。复制只对目标缺行 `create`，已存在且字段一致则跳过，不一致则抛错；核对全部 18 张表的行数、字段（忽略 `updated_at` / `last_seen_at`）和引用，然后写入 `content_migration_state:legacy`。源库 `_system` 没有删除语句。`package.json` 的 `content:migrate` 固定 `--env-file=../.env`，不能用于生产。生产入口是：

```bash
/home/ubuntu/.bun/bin/bun --env-file=/etc/surreal-ck/server.env \
  server/src/content/migrate-legacy-cli.ts --writes-frozen
```

工作目录必须是 15c49fb 的检出或归档，并且已经 `pnpm install --frozen-lockfile`，且该目录不是 `current`。

`startServer` 在 publisher 会话之前调用 `assertLegacyContentMigrated`。`_system` 已有内容行，目标没有 `content_migration_state:legacy` 时，15c49fb 进程会拒绝启动。因此必须先复制并写上标记，再让 Deploy origin 切换 `current`。健康检查失败时，脚本只把 `current` 切回上一目录并重启；`platform_content` 里已复制的行会留下。数据库不能随代码回滚，回退时也不删除这些新行或 `_system` 旧行。

## 尚未执行的发布顺序

下面是给后续交付链的步骤。本任务没有执行其中任何写操作。

1. 在主机上幂等准备密钥。键已存在且长度至少 32 时保持原值。键不存在时用密码学随机数生成长度远大于 32 的值，以 root 追加到 `/etc/surreal-ck/server.env`，不打印、不写入仓库或任务证据。若键存在但短于 32，停止并交回经理，不要静默换值。当前是“不存在”。
2. 短暂停写：`systemctl stop surreal-ck-hono`。不要 stop、disable 或改写 `surrealdb.service`。停写要一直保持到新 origin 健康；代码里没有单独的冻结开关，停应用进程是现成的停写办法。
3. 把 `15c49fb933dd473d25498799d5ac2425d959c743` 解到 `current` 以外的目录，安装冻结依赖，执行上面的 bun 命令。成功日志只有计数摘要，不能含密钥或正文。
4. 只读复核：`platform_content` 上述 18 表行数与 `_system` 一致，引用可解析，`content_migration_state:legacy` 的 `source_database` 为 `_system`。`_system` 行数不得变少。
5. 立刻对同一 SHA 跑 Deploy origin（或合入后由 Deploy production 的 origin job 执行）。`server.env` 已含新键，systemd 的 `bun run --env-file=/etc/surreal-ck/server.env` 会在新进程读到它。90 秒健康失败则自动回到 `af8c8b3-ci36491649136`。
6. origin 健康后才允许 Cloudflare。15c49fb 的前端已在 2026-09-24 发过；重新发布必须走现在这条“先 origin”的工作流，不能补一次只发 Cloudflare 的旧路径。
7. 若 origin 回滚：立刻再次停写。回滚后的旧进程若又写入 `_system`，重复迁移会在不一致行上失败。失败后停止，不删除任一侧。只有新增且未改旧行时，同一命令可以续跑。
8. PR #30（https://github.com/MainListActivity/surreal_ck/pull/30 ，head `5384fd69847080cd39fbea1902d676e6965bced9`）仍是草稿。Quality gate https://github.com/MainListActivity/surreal_ck/actions/runs/36459246415 在 Test 失败：runner 上没有 `/home/runner/.surrealdb/surreal`，`reader-projection.integration.test.ts` 与 `reader.integration.test.ts` 无法启动。读者代码不能随这次复制一起合入。

复制本身是新增库和新增行，核对失败时不删除。这不触碰项目红线。真正要避开的是：UPDATE 已有许可行、删除 `_system` 内容、以及改 SurrealDB 服务或 root 凭证。

## 生产验收身份

查过的来源：

- claim 的 `project.envs[0].secrets` 为空。`project.notes` 写明生产实测账号尚未登记。
- `docs/agent-operations.md` 有登记路径：`printf '%s' "$VALUE" | pnpm run admin secret set surreal_ck production <名称> <角色> <用途>`，员工之后用 `get_secret` 领取。没有已有合规账号的值，所以没有调用 `secret set`，也没有调用 `get_secret`。
- 生产 `_system.workspace`：1 个，status=active，名称不像 test/qa/验收。`user_workspace_index`：1 行，role=admin，`disabled_at` 为空。对应工作区库里 1 个 human 且 `is_admin=true`，1 个 virtual 且非 admin，没有 disabled。没有第二个工作区，没有 participant，没有非成员，没有已移除成员。
- `platform_operator` 2 行、`system_admin` 1 行。这是运营/系统种子，不是工作区成员，也不能代替 AC 要求的管理员、普通成员和非成员。`SYSTEM_ADMIN_SUBJECTS` 未设置。`PLATFORM_OPERATOR_SUBJECTS` 非空，值未读取。
- 没有内部可领取的密码或 IdP 测试账号。按任务约束，不能改外部 IdP，也不能无依据注册外部账号。

因此不指定任何生产 `public_id` 作为验收样本。1807 篇已发布内容都挂在现有许可上，而那些许可没有客户读取动作；把某一篇客户内容写成“可测样本”会假造可用性。

8 条 AC 在生产上的对应关系：

1. 换票校验成员与权益：origin 没有 #29/#30 代码，权益表不存在，也没有两个已登记测试身份。
2. 投影与 digest：投影表不存在；许可动作与 search/read/cite/export/AI 没有交集。
3. RECORD 权限与管理员不能 DDL/DML：代码未进 origin，生产未测。
4. 阅读页、两角色共享范围：只有一个工作区管理员和一个虚拟用户，没有普通成员。
5. 五种许可边界：生产许可动词是 submit/publish/withdraw/restore。
6. 900 秒租约与撤权：未在生产配置或连接上验证。
7. 受限控制面写入、root 不代客户读：复制命令会用 root 做一次性 schema 与复制，这是迁移控制面，不是客户查询。客户读取路径仍未上线。
8. 两工作区、两角色、非成员、移除、错误 revision、过期 token、投影中断、许可过期、撤回、DDL/DML：身份和可撤回/过期样本都不存在。全部 1807 篇目前都是 published。

## 交给经理的缺口

登记路径是有的，可用身份和客户读取许可没有。需要经理在内部安排，而不是把缺项写成通过：

- 两个专用工作区，以及管理员、普通成员、非成员；另给“移除成员”准备可禁用的成员。凭证用 `admin secret set` 按 engineering、qa、产品所需的最小角色登记，值不进仓库和任务正文。
- 在不 UPDATE 现有 `source_license_revision` 的前提下，确定客户 search/read/cite/export 与 AI research/generate 如何以新增记录授权，并提供可过期、可撤回的真实已发布内容样本。
- PR #30 的 CI 要能找到 SurrealDB 3.2.3，Quality gate 变绿之后，读者发布才能单独申请。本次复制只覆盖 #29。
