# G2 审批包：SCK-LCA-03 固定候选

任务 `553ba0a0-79d8-4b72-bdc9-9f8ef1d4bdee`，目标 `4960d4ffb9f5ff97`。编写人 gm-grok-c10c54，2026-09-28。

本文是交给老板的决定材料，不是生产发布回执，不是生产验收，也不是老板已经批准。经理没有代老板批准，没有部署，没有改生产数据，没有打开生产 URL，没有注册账号、购买服务或联系外部。

## 请老板决定

推荐：**驳回**本次生产发布，并驳回全部生产实测与生产状态变更。

候选可以继续留在草稿 PR，不合并、不部署、不跑内容库迁移、不改成员、许可、内容或投影。原票八条 Acceptance criteria 不缩小，也不用隔离库或合成内容代替。缺口补齐后必须重新提交本关口；本次若被驳回，不能被以后的发布沿用。

不推荐批准「先把这个候选部署上去」。候选服务启动时会把内容库迁移应用到 006，而内容库端点、namespace/database 和 IdP allowlist 都还没有证实。批准部署不等于只更新 Cloudflare 静态站。

本次没有新增付费服务、外部账号或对外联系的计划，也不请求另开这类关口。

若老板仍要推进，请在批准意见里逐字写明下面每一项；未写明的操作保持未授权：

1. 生产目标是否仍是文档里的 `https://l.maplayer.top`、issuer `https://o.maplayer.top/t/ck`，以及线上回调到底是 `https://l.maplayer.top/auth/callback` 还是 `https://docs.maplayer.top/callback`。
2. 当前线上提交或部署回执，以及它和候选 `5384fd69847080cd39fbea1902d676e6965bced9` 的差异。
3. 内容库的实际端点、namespace/database。`wss://data.maplayer.top/rpc` 只是 runbook 里的浏览器变量，不能当作内容库端点。
4. 目标 IdP 是否已经部署 `content_reader.v1`，allowlist 是否包含本应用。不要在回复里粘贴 client secret、token 或 root 密码。
5. 两个可使用的生产工作区 ID，以及管理员、普通成员、非成员、可恢复移除成员的身份代号。没有安全对象就写「没有」。
6. 已发布且有来源许可的内容公开 ID、精确版本、允许的动作。没有可测内容就写「没有」。
7. 成员移除、许可过期、内容撤回、投影停止/恢复、DDL/DML 拒绝探针各自的对象、时间窗、备份位置和恢复办法。不能安全恢复的项请明确禁止。

## 固定候选（本机已核对）

| 项 | 值 |
|---|---|
| 仓库 | `MainListActivity/surreal_ck` |
| 分支 / worktree | `task/86b409f0`，`/Users/y/IdeaProjects/surreal_ck-task-86b409f0` |
| 候选提交 | `5384fd69847080cd39fbea1902d676e6965bced9` |
| 父提交 | `b5a240c4cda1e7664ca43021a98c57be8a3cce7d` |
| 草稿 PR | https://github.com/MainListActivity/surreal_ck/pull/30 ，OPEN，head 与候选提交一致 |
| 公司任务 D | `86b409f0-df70-4293-b2a7-cbb1f728fade`，qa-grok-5dfd5a 于 version 16 按预发布候选接受 |
| 祖先 | `16d20ede50567f5afc4bfab9ef2031d7f69ed4ee` 是候选祖先 |
| 新增迁移 | `shared/sql/platform-content/006-content-reader.surql` 存在于该提交 |

发布说明在候选提交的 `docs/implementation/sck-lca-03-release-candidate.md`。相对 A 交接当时读到的 `main` `15c49fb933dd473d25498799d5ac2425d959c743`，内容库只新增 006；001–005 与 `shared/sql/system/021-product-entitlement.surql` 没有改。没有镜像摘要。没有生产部署回执证明 `15c49fb` 或本候选现在正在线上。

## 预发布证据的边界

QA 接受的是隔离环境：本机 SurrealDB 3.2.3 内存库、fixture IdP、合成工作区 `ws_alpha` / `ws_beta` 和合成内容 `law-demo-1`。alice、bob 能打开合成正文；拒绝页、过期权益、移除成员和非成员有对应结果。这不能当作生产通过。

QA 复跑 `bun .scratch/sck-lca-03-e2e/db-matrix.ts` 退出 1，停在对已存在 `source_license_revision:expired` 的再次 UPSERT。验收人随后用 root 看到正文字数仍为 52、门禁 1 行、投影 1 行 active，并单独打到 `license_expired` 的 HTTP 403。`DEFINE TABLE` 在该次说明里是挂起，不是一条明确的引擎错误。超过 15 分钟的墙钟会话、真实 ma_hono allowlist、生产库和第二个可成功读取的真实工作区都没有做。

## 文档里的公开入口（未在线探测）

来自已接受的 E `65cc107b-40d9-4e2f-a323-75fe7efb0733`，文件提交 `003dbae61e375f3c6b4dafaaa02c244c7259ae5f`，路径 `deliverables/4960d4ffb9f5ff97/production-validation-plan.md`。源文件是 `surreal_ck/docs/runbooks/production-release.md` 与 `docs/oidc.md`。

| 记载 | 值 |
|---|---|
| 应用 | `https://l.maplayer.top` |
| 营销站 | `https://www.maplayer.top` |
| Hono 边缘 | `l.maplayer.top` 的 API / WS |
| 浏览器 Surreal 变量 | `wss://data.maplayer.top/rpc`（不是已证实的内容库端点） |
| issuer | `https://o.maplayer.top/t/ck` |
| audience | `https://auth.maplayer.top` |
| 公开 client id | `b10df483-1cd4-4beb-8a01-92e8f4b3fdf4` |
| 回调 | runbook 写 `https://l.maplayer.top/auth/callback`；`docs/oidc.md` 写 `https://docs.maplayer.top/callback` |

runbook 写明 Cloudflare 工作流只发布两个静态站和边缘代理，不改 `data.maplayer.top` 上的有状态 origin、数据库或 root 凭证。本任务没有访问这些地址。

## 八条生产步骤现在都不能执行

E 的矩阵仍是生产实测说明书。下表只说明本关口为什么还不能授权执行。缺对象时保持未执行，不能改成用合成样本通过。

| 原票 AC | 生产上要做什么 | 本次为何不能授权 |
|---|---|---|
| 1 换票 | 两个真实成员从真实工作区打开获许可内容；非成员、移除成员、无权益和伪造 revision 必须拒绝，且原工作区 token 仍在 | 没有真实工作区、身份和获许可内容 |
| 2 投影 | 核对真实 revision/digest，重放一次；只在批准对象上做不完整、旧 revision 或中断 | 没有投影前态、备份和恢复步骤 |
| 3 RECORD / DDL / DML | 真实短票做单条和批量读；管理员 system role 的 DDL/DML 必须拒绝且无写入 | 没有内容库端点和可探测的真实记录；拒绝探针的无副作用范围未由老板点名 |
| 4 阅读页 | 管理员和普通成员打开同一精确版本，看到版本、来源、授权；拒绝页不泄正文 | 没有真实入口上的内容 ID |
| 5 五动作 | search、read、cite、AI 使用、export 各自有允许和拒绝；metadata-only 不见正文、摘录、法条全文、隐藏字段 | 没有真实许可动作组合 |
| 6 撤权时限 | 新读取在不超过 900 秒且不晚于权益/许可的上限内关闭；测移除、到期、投影停止续期和过期 token | 移除、到期和停投影都没有可恢复对象 |
| 7 控制面与日志 | 客户不能写投影；root 不代读；日志无 token、secret、正文 | 没有生产日志位置和同步身份的脱敏核对方法 |
| 8 全矩阵 | 两个工作区、两种角色、非成员、移除、错误 revision、过期、投影中断、许可过期、撤回、DDL/DML | 上面的对象和恢复都缺，缺一项就不能标通过 |

成员移除只写 `disabled_at`，不撤销已发出的 IdP token。将来的实测必须看内容连接的新查询，而不是旧工作区连接。这一条来自 A 的交接，本次仍然不授权去做移除。

## 若以后另一次批准才允许讨论的迁移与回退

以下出自候选发布说明，本次不授权执行。

006 增加受限投影同步身份、每个工作区一行授权投影、每个内容版本一行读取门禁，以及 15 分钟的 `content_reader` RECORD JWT。JWKS、issuer、audience 在启动时注入。部署顺序要求先确认 IdP 已部署 `content_reader.v1` 且 allowlist 含本应用，再启动候选服务应用迁移。root 只建同步凭证，不读客户正文。不把正文复制进客户 workspace，不新增 service JWT。

回退说明写的是：停止新换票、把投影和门禁标为 closed、已建立连接最多再读 900 秒、不从版本链删除 006、服务退回批准前版本。应用回退不会自动回滚数据。这些步骤本身会改生产，现在没有备份位置和执行人，所以连回退演练也不在本次授权里。

## 成本与停止条件

没有新的供应商、账号或费用。现有 Cloudflare / GitHub 生产流程的费用未重新核算，本文件不报一个未核对的金额。

本次没有被授权的生产动作，因此没有开始计时的变更窗口。以后任何批准外的写入、日志出现 token 或正文、恢复核对失败，都应停止并回到新的老板决定，而不是继续矩阵。

## 未验证

未打开生产 URL，未查询生产数据库，未核对 GitHub 当前部署提交，未读取 IdP 的运行配置，未接触客户内容或凭证。隔离测试的命令与退出码以 D 的 QA 验收记录为准，本关口没有重跑。
