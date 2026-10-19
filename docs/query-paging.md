# 管理查询的字节预算、快照分页与完整读取（SYS01）

本文说明员工与经理（gm）通过 sck（comm 通道）和 MCP 读取任务、历史、工作树与公司汇总时的契约。依据为经理裁决 v15（2026-10-19，C1 至 C6，见第 6 节）与经理裁决 v25（SYS01 P0，任务 04195c93）：预算 R3、快照 R4、工作树范围 R8、null 语义、拆分项 R6 与 R7。第 2 节、第 4 节、第 6 节以 v25 为准。

实现位置：`src/response-budget.ts`（字节预算、UTF-8 切分、写回显、游标封装）、`src/query-input.ts`（参数校验与查询摘要）、`src/snapshot-store.ts`（快照存储与库内配额）、`src/core.ts`（读取与汇总）、`plugin/server/sidecar.ts`（通道分发与响应检查）、`src/mcp/server.ts`（MCP 工具）、`src/mcp/client-cli.ts`（comm 客户端）。新增 schema 为 `schema/021-query-snapshot.surql`（快照行）与 `schema/022-snapshot-quota.surql`（全库计数）。

## 1. 截断层定位（AC01）

复现夹具：1000 条任务，中文与 emoji 标题，每 25 条有一条长正文（约 7500 个码位）。响应经 comm 通道写回，由 shell 慢速管道读取：读取者先 `sleep 2`，管道在此期间被写满。测试为 `tests/comm-slow-pipe.test.ts`。

| 客户端 | 期望字节 | 实际字节 | 结果 |
|---|---|---|---|
| 旧版 `8d03d35`（`tests/fixtures/comm-client-8d03d35.ts`） | 1 082 845 | 65 536 | JSON 解析失败，退出码 0（红灯） |
| 本次 `src/mcp/client-cli.ts` | 1 082 845 | 1 082 845 | 完整可解析（绿灯） |

截断层是 comm 客户端的 stdout 写出。旧版调用 `process.stdout.write` 后立即 `process.exit`，管道未排空时尚未写出的字节丢失。本次改为同步写完整个 stdout（遇 EAGAIN 重试）后才退出。

边界：慢管道实验只复现了 comm 客户端这一层，未在真实 Paseo 输出链路复现。用 `Bun.spawn` 读取的复现不能形成红灯（旧版同样完整输出），不作为依据。

旧版基线（`8d03d35` 源码，同一 1000 条夹具）：`get_context` 默认 212 642 字节（500 条）；`get_context state=ready` 212 191 字节（500 条）；`get_task_history` 483 384 字节（31 条）。三者均超过 131 072 字节。

## 2. 字节预算（AC03）

- 预算按序列化后的 UTF-8 字节计算，不按字符串长度计算。`RESPONSE_BUDGET_BYTES` 为 48 KiB（49152 字节），覆盖每个 MCP 或 sidecar 工具整个序列化响应，包括信封。
- 46 KiB（`ITEM_BUDGET_BYTES`，预算减去 2 KiB 的页信封余量）只是内部余量，不是对外上限。条目本身不超过该余量时保持完整。
- 两道检查：sidecar 写回中继响应时（`guardRelayResponse`），以及 MCP 的 `toolResult`。超过预算的成功响应替换为 JSON 错误 `response_too_large`（`retryable: false`，缩小查询后重试）。comm 客户端退出码为 1，stdout 为一行 JSON。
- 完整读取从不截断（见第 3 节）。分页读取只在单条超过 46 KiB 时截断该条，并标注 `contextTruncated` 与 `contextNextOffset`（证据为 `evidenceTruncated` 与 `evidenceNextOffset`），其余部分用 `read_task_text` 按段读取。
- `read_task_text` 每段默认 16 KiB，最大 24 KiB，最小 4 字节。段边界落在字符边界上，各段拼接即为原文，不产生 UTF-8 断字符。

写接口的回显（SYS01，`echoTask`）：检查点、提交、验收、退回、阻塞（`report_blocker`）、创建、释放、续做、延后、退役、项目换绑、仓库绑定与负责人决定返回的任务回显，同样受预算限制。回显中的依赖列表（`dependencies`）与任务、工作树的意图路径（`workIntent.paths`、`worktree.intent.paths`）各取不超过 `min(4 KiB, 本次回显的字节上限 / 8)` 的最长前缀，超出的列表在 `listsTruncated` 中给出完整条数（`count`）与完整 JSON 的 SHA-256（`sha256`），完整列表用 `read_task_text` 读取。之后 `context` 取剩余空间，超出时截断并标注（`contextTruncated`、`contextNextOffset`）。`contextBytes` 与 `contextSha256` 始终描述完整正文。`create_delivery` 把预算按腿数均分，每条腿不超过 `floor(46 KiB / 腿数)`。写接口的回显不含项目环境正文。

写入先于回显提交。正文（`context`）与列表超出时截断，所以正文长度与列表条数不会使已提交的写入失败。写入时依赖条数与项目文本大小均未设上限（R6、R7 未在本变更实现，见第 6 节），回显只能按上述规则截断。回显的其余固定字段未单独设字节上限。若整体仍超过 48 KiB，MCP 与通道会返回 `response_too_large`，此时写入已经提交，调用方须用 `get_context`（带 `taskId`）或 `get_task_history` 核对状态，不得重复提交。

认领回显（`claim_next`，缺陷 1；心跳同源）：认领在回显之前已经提交（租约、审计、出站事件与 `claim.json`），所以回显不能报错。`deliveryId`、`fence` 与 `leaseExpiresAt` 总是返回。`expectedVersion` 不在认领回显中，版本号位于 `task.version`。可变部分各自有界，并标注：

- `task.context` 超出时截断，标注 `contextTruncated` 与 `contextNextOffset`，其余用 `read_task_text` 读取。
- `dependencies`、任务的 `workIntent.paths` 与工作树的 `worktree.intent.paths` 各不超过 4 KiB（`CLAIM_LIST_ECHO_BYTES`）。超出时保留最长前缀，并在 `listsTruncated` 中给出该列表的完整条数（`count`）与完整 JSON 的 SHA-256（`sha256`）。完整列表在 `claim.json` 中，可用 `read_task_text` 的 `dependencies`、`workIntentPaths`、`worktreePaths` 读取。
- `project` 不超过 8 KiB 时完整返回。超出时只回显身份字段（`id`、`name`、`repoPath`、`defaultBranch`、`release`、`rollback`、`pipeline`，每个文本字段最多 512 字节）与红线（每条最多 1 KiB，放得下几条就留几条），并标注 `projectTruncated`、`projectBytes` 与 `projectSha256`。完整项目可用 `read_task_text` 的 `project` 读取（仅持有人与 gm）。
- 交接历史（`history`）不是固定的 16 KiB 窗口。核心先读出最新的 60 条协议记录与 20 条运维记录（按条数，不按字节）。回显再按字节动态填充：最新条目优先，至少保留 8 KiB（`CLAIM_HISTORY_FLOOR_BYTES`），其余预算留给上下文。边界条目若放不下，只保留证据的最长前缀，并标注 `evidenceTruncated`、`evidenceBytes`、`evidenceSha256`、`evidenceNextOffset`。更早的条目不被编造，也不附 `nextOffset`。
- `historyCount` 为任务历史的全部条数。`historyComplete` 只有在全部条目都以完整形式出现在回显中，且条数一致时才为 `true`。若核心窗口或回显预算使部分条目未出现，则为 `false`，完整历史用 `get_task_history` 分页读取。
- 工作树只在顶层 `worktree` 出现一次，`task.worktree` 不重复。心跳的回显（MCP `heartbeat`）不含工作树：核心心跳结果没有顶层 `worktree`，`echoClaim` 删除 `task.worktree` 后无处补回（`src/response-budget.ts` 的 `echoClaim`，`src/core.ts` 的 `heartbeat`）。

字节上界：标题不超过 200 字符，目标不超过 100 字符，`context` 不超过 20 000 字符（创建时限定）。认领回显中，前驱最多 6 条（核心 `predecessors` 按最近 6 条返回），交接窗口按上文动态填充，列表与项目按上文截断，`echoClaim` 把认领回显的可变部分限定在预算之内。存储层的依赖条数与项目文本大小尚无上限（见第 6 节 R6 与 R7），回显截断它们并以 `listsTruncated`、`projectTruncated` 标注。其余固定字段（标识符、角色、状态、轨道名 `discipline`、工作树的仓库、分支与路径）未设字节上限，只受创建时的校验与文件系统路径长度约束。核心 `claim()` 仍返回完整认领，供 `claim.json` 与调度器使用。

## 3. 工具与参数（AC02）

| 工具 | 参数 | 旧调用（不带 pageSize、cursor） | 分页调用（带 pageSize 或 cursor） | 权限 |
|---|---|---|---|---|
| `get_context` | `taskId?`、`state?`、`goalId?`、`role?`、`since?`、`includeCompany?`、`fields?`、`pageSize?`（1–100，默认 25）、`cursor?` | `{ principal, company?, tasks }`，完整或拒绝 | `{ principal, company?, tasks, page }` | 员工见自己可见的任务；gm 见全部 |
| `get_task_history` | `taskId`、`pageSize?`、`cursor?` | 通道为 `{ history }`，MCP 为裸数组（与 `8d03d35` 相同）；均为完整（按时间正序）或拒绝 | `{ history, page }`，页序从新到旧，页内按时间正序 | 与 `get_task` 相同 |
| `list_worktrees` | `taskId?`、`includeReleased?`、`pageSize?`、`cursor?` | 数组，完整或拒绝 | `{ worktrees, page }`，按路径排序 | 非 gm 须带 taskId（缺省或 null 一律 `forbidden`）；gm 可全局 |
| `read_task_text` | `taskId`、`field`（`context`、`evidence`、`project`、`dependencies`、`workIntentPaths`、`worktreePaths`）、`auditId?`、`offset?`、`limit?`、`expectSha256?` | 无 | `{ taskId, field, auditId?, totalBytes, sha256, offset, bytes, nextOffset, text }` | 每段都检查权限 |
| `get_admin_summary` | `since?`、`goalId?` | 无 | `{ cutoffAt, since, goalId?, scope, tasks, audit, outboxSequence, integrity }`（第 5 节） | 仅 gm |

要点：

- `get_context` 缺省的工作集是 `ready`、`doing`、`review`、`blocked`，并排除调用人自己提交的 `review` 任务（`taskRowsAt` 中的 `NOT (state = 'review' AND submitted_by = $me)`）。`state` 给定时只看该状态。`since` 按任务创建时间（`created_at`）下限过滤。
- `fields` 只能选白名单内的字段，未知字段返回 `invalid`。
- `includeCompany` 缺省值取决于调用形态：旧调用缺省包含 `company` 块，分页调用缺省不包含，需显式传 `includeCompany: true`。
- `taskId` 读取整条任务，`context` 完整返回，并附 `contextBytes` 与 `contextSha256`。超出预算时拒绝，并给出 `read_task_text` 的读取示例。与 `cursor` 同用会返回 `invalid`。
- 旧调用的完整集合上限：任务 500 条，历史 1000 条。超过即拒绝为 `response_too_large`，并给出 `pageSize` 与 `cursor` 的重试示例。
- `page` 字段：`pageSize`、`returned`、`hasMore`、`total`（快照内的总条数）、`snapshotAt`（快照读取时刻的数据库时间）、`budgetBytes`，以及 `hasMore` 为真时的 `nextCursor`。
- 统计条数时，按 `page.nextCursor` 读完全部页，并累加每页的 `returned`（或数组长度）。`page.total` 是快照内的总数，可用来核对。
- `pageSize` 取 1 至 100，缺省 25。`pageSize` 不属于游标的绑定，续页时可以改用另一个值，每次请求按它取行。
- 每页的条数由预算决定，不一定等于 `pageSize`。`returned` 为本页实际条数。

null 语义（MCP、sidecar 与核心一致）：

- `pageSize`、`cursor`、`list_worktrees` 的 `taskId` 为 null 与缺省相同，即视为未提供。`get_context` 的 `taskId`、`state` 等筛选同样视为未提供。
- `get_task_history` 的 `taskId` 为必填。null 被拒绝：MCP 在参数校验阶段拒绝（schema 不接受 null）；sidecar 经 `taskIdOf` 以 `invalid` 拒绝。核心的 `history` 与 `historyView` 接收的是已校验的字符串，本身不再检查 null，调用方须先校验。`read_task_text` 的 `taskId` 同样必填（`parseTextInput` 以 `invalid` 拒绝）。

`read_task_text` 的要点：

- `auditId` 在读取证据（`field: evidence`）时必需。
- `offset` 大于 0 时必须带 `expectSha256`，即第一段返回的 `sha256`。若原文已变化，返回 `conflict`，要求从 `offset: 0` 重读，不混拼两个版本。
- 证据必须属于该任务，否则返回 `not_found`。

## 4. 快照与游标（C4）

分页读取的第一页时，服务端把匹配的行与返回字段一次性物化为一个快照（表 `query_snapshot` 与 `query_snapshot_row`，由 schema 021 新增；容量计数见第 4 节末段的 schema 022）。此后每一页只读取已存储的行，不重新执行查询。

- 成员与字段固定。快照的成员、排序与返回字段在首页时刻确定。遍历中新增、状态变化、标题或其它字段变化、离开过滤集合、工作树登记增删，都不改变本次遍历的成员与字段。状态过滤的成员同样在首页时刻确定。
- 每个任务在一次遍历中恰好出现一次，遍历中的写入不造成重复或遗漏。
- 需要最新状态时，发起一次新的遍历（不带游标）。
- 历史与工作树同样物化为快照。

游标格式为 `v1.<payload>.<mac>`，payload 为 JSON，mac 为 HMAC-SHA256。密钥只存在于 `company_meta:cursor_key`，首次分页时由服务端生成，不返回给调用方。游标绑定以下内容：

- 调用人：他人使用的游标返回 `forbidden`。
- 查询摘要：筛选、`fields`、`includeCompany` 与 `includeReleased`，不含 `pageSize`。换了任一项返回 `forbidden`。
- 读取类型与快照标识，以及已交付的位置。
- 有效期与快照相同，即快照的 6 小时。

每一页都重新做身份校验。身份被撤销后，下一页即返回 `unauthorized`。角色变化后，原快照不可用，返回 `forbidden`，角色恢复后可以继续。

错误码汇总：

| 码 | 情形 | 处理 |
|---|---|---|
| `invalid` | 游标格式错误、被篡改或非本服务签发；参数非法 | 改正参数，不重试同一调用 |
| `forbidden` | 游标属于他人、其它查询或其它读取类型；角色变化 | 从第一页重新开始 |
| `unauthorized` | 身份已撤销 | 停止读取 |
| `snapshot_gone` | 快照过期、被淘汰或已删除；游标已过期 | 不带游标重新开始 |
| `temporarily_unavailable` | 全库快照容量已满，或同一身份的快照都还在写入且等待超时，或快照未能写入 | 稍后重试（`retryable: true`） |
| `response_too_large` | 快照超过 5000 行或 8 MiB；单页信封或单条超过预算 | 收窄筛选后重试 |

快照上限（`DEFAULT_SNAPSHOT_LIMITS`，v25 R4，代码中为固定值，没有运营配置项）：

- 有效期 6 小时。游标的有效期与快照相同。
- 每个快照最多 5000 行、8 MiB（UTF-8 字节）。超过时整体拒绝，不存部分。
- 每个身份最多 4 个快照。超过时淘汰该身份最旧的已完成快照，其游标随后返回 `snapshot_gone`。仍在写入的快照保留其名额。
- 全库最多 64 个快照。预留与已存快照都计入。已满时拒绝新快照（`temporarily_unavailable`），不淘汰任何快照。
- 全部快照合计最多 64 MiB，同样计入预留。
- 预留从准入起即计入上限。写入中的快照保留名额，直到提交、释放或超时。
- 若某身份的快照全部仍在写入，该身份的新请求最多等待 5 秒，等待其中一个提交。超时返回 `temporarily_unavailable`。
- 写入中的快照超过 5 分钟仍未完成，视为遗弃，连同其行一并删除。
- 过期快照与遗弃快照由快照存储的清扫删除。清扫在每次新建快照时执行，也可直接调用存储的 `sweep`。当前没有定时任务调用它，过期快照占用的名额会在下一次新建快照时释放。
- 释放恰好一次：快照行、表头与名额在同一事务中删除，并只扣减一次。

准入上限在数据库内强制执行，由单一记录 `query_snapshot_quota:global`（schema 022）计数。每次预留、淘汰与释放都在同一事务中改动计数并递增 `version`，写入前校验版本；提交只把快照状态改为 `ready`，不改计数。因此 MCP 服务与插件 sidecar 两个进程共用同一上限，上限是硬限制，不是软限制。全库已满时，被拒绝的请求不淘汰任何快照。

## 5. 汇总（C5，AC04）

`get_admin_summary` 只读，仅 gm 可用，其他角色返回 `forbidden`。它不返回任务正文。

- `cutoffAt`：事务内读取的数据库时间（`time::now()`）。
- `tasks`：每个任务在截止时刻所处状态的计数，可按 `goalId` 限定。`since` 不适用于任务计数。
- `audit`：审计事件在 `[since, cutoffAt]` 内的动作计数。`since` 缺省为调用时服务端时钟的 24 小时前（在事务开始前计算，不随 `cutoffAt` 调整）。给出 `goalId` 时只计该目标任务的事件。
- `outboxSequence`：与上述计数在同一事务内读取。
- `scope`：逐项声明口径。它不是“窗口内新建或更新的任务数”。
- `integrity.complete` 为真，当且仅当以下四项全部成立：`taskCountsMatchRows`（状态计数之和等于任务总数）、`auditCountsMatchRows`（动作计数之和等于审计总数）、`statesKnown`（所有状态均为已知状态）、`repeatableRead`（同一事务内第二次读取与第一次一致）。
- `integrity.complete` 为假时，返回的数字不能作为完整结论，应重试。

读取在一个 `BEGIN…COMMIT` 事务内完成。`repeatableRead` 只是一致性的一项检查。并发一致性另由公司 fork 的并发用例验证：任务状态变化与审计写入同时进行时，每次汇总的完整性检查都通过，任务总数保持不变，审计计数不减少。

## 6. 兼容性与偏差（请经理与复核确认）

按经理裁决 v15：

- C1（`list_worktrees`）：旧调用保留数组形态，且必须是完整集合。超预算时拒绝，不截断。显式分页返回 `{ worktrees, page }`。
- C2（`get_context`、`get_task_history` 旧调用）：完整或明确失败。超预算不返回第一页，不返回不完整的列表。公司块不被裁剪，超预算时整体拒绝，并提示改用分页或 `includeCompany: false`。
- C3（旧详情与历史）：整体不超过 48 KiB 时完整返回全文，包括超过 16 KiB 的 `context` 与证据。超出时拒绝，并给出 `read_task_text` 的入口（`taskId`、`field`、`auditId`）与分段、sha256 重组的方法。旧调用不返回预览。
- C4（状态过滤遍历）：采用不可变快照，成员在首页时刻固定（第 4 节）。
- C5（汇总）：按第 5 节的口径。`tasks` 为截止时刻的存量，`audit` 为 `[since, cutoffAt]`。
- C6（上线与 QA）：本实现由另一位工程师独立复核，复核通过只代表实现通过。上线由运营决定（申请 `1c7544fa`）。部署后，由 QA `6b6cb5b9` 以真实员工 sck 完成最终检查，AC01 与 AC05 的生产通道验收以此为准。

已记录的偏差：

- D1（认领的交接窗口，已按 v25 R3 处理）：认领结果中的 `history` 不再是固定 16 KiB 窗口，而是按字节动态填充（第 2 节）。认领已经提交，提交后不能拒绝，所以回显有界而非完整。核心读取的窗口仍按条数限定（最新 60 条协议记录与 20 条运维记录）。`historyComplete` 为假时，表示较早的条目未包含在内，完整历史用 `get_task_history` 分页读取。这与 C2 的“完整或明确失败”措辞不同，认领作为已提交写入是 R3 的例外。
- D2（准入原子性，已按 v25 R4 处理）：快照准入上限由数据库内的 `query_snapshot_quota:global` 版本校验执行，MCP 与插件 sidecar 两个进程共用（第 4 节）。跨进程用例（`tests/snapshot-quota.fork.test.ts`，经 `tests/snapshot-quota.child.ts` 由三个子进程并发准入 20 次）列入第 9.1 节的门禁。
- D3（运行时）：证据覆盖 Bun 1.3.11 与部署运行时 Bun 1.4.2，见第 9 节。两种运行时的门禁与红灯结果一致（见第 9 节）。
- D4（核心认领的字节数）：`claim()` 的返回值是完整认领（写入 `claim.json`，供调度器使用），字节数可以超过预算，它不是 RPC 应答。预算约束的是 RPC 回显：MCP `claim_next` 与 `heartbeat` 的应答（`echoClaim`）。复核断言针对 MCP 与通道的应答，不针对 `core.claim`。这一层次已由经理裁决 v25 确认。sidecar 没有 `claim_next` 与认领回显（见第 9.6 节）。

拆分项与 v25 裁决（R6、R7 未在 SYS01 实现）：

- R6（有界性）：本轮未实现，拆分为三项链路。实现为工程 `d8069d8c-bebc-4df8-a7e5-bb608147825b`（工程到工程），发布申请为 `69e862fd-0acc-4f5d-9955-bdd7bd204ef8`（工程到产品），部署为 `9890243a-47c5-4b15-9505-cc03d4717c83`（工程到 QA）。部署依赖 SYS01 部署 `6b6cb5b9-dd3d-4a59-b611-c897a3ec67df`。裁定数值：`create_task` 的 `dependencies` 至多 50 条，按去重前的原始条数计。`workIntent.paths` 至多 50 条，每条至多 300 字符。当前代码中，`dependencies` 只去重（`src/core.ts` 第 543 行），无条数上限。`workIntent.paths` 的条数与长度只对 `kind: assets` 检查（`validateIntent`，`src/dispatcher/worktree-registry.ts` 第 95 至 98 行；核心在 `src/core.ts` 第 533 行调用），其它 `kind` 带 `paths` 即拒绝。以上裁定数值在拆分链交付前均未执行，写入时依赖条数不受限。标识符、角色、轨道名 `discipline`、工作树的仓库、分支与路径等固定字段仍无字节上限。
- R7（项目自由文本）：裁定 `release` 与 `rollback` 各至多 16 KiB（UTF-8），`notes` 至多 32 KiB，`runbooks` 至多 50 条，每条 2 KiB，合计 32 KiB。现有超限数据不做追溯裁剪，变更的字段必须满足新上限，超限在写入前拒绝。当前 `ProjectStore.upsert`（`projects.ts` 约 95 至 111 行）未做长度检查。认领回显中，项目超过 8 KiB 时只回显身份与红线（第 2 节）。
- R8（员工的工作树缺省范围，已在代码中落实）：sidecar 的 `list_worktrees` 不再回退到调用人的当前租约任务。核心 `listWorktrees`（`core.ts` 约 801 行）对非 gm 且未带 taskId（含 taskId 为 null）的调用一律 `forbidden`，MCP 与 sidecar 都经此判定。显式 taskId 走 `getTask` 授权与仓库范围。gm 保留全局读。员工与 QA 的指令须带 taskId。

## 7. 回滚隔离（RB01）

新版新增的持久状态，以及旧版（SYS01 之前）对它们的表现：

| 新增状态 | 写入方 | 旧版表现 |
|---|---|---|
| `company_meta:cursor_key`（一条随机密钥） | 新版首次分页时创建 | 旧版不读取，忽略 |
| `query_snapshot`、`query_snapshot_row`（schema 021，只新增表） | 新版分页读取时创建，6 小时后由新版清扫删除 | 旧版不读取，忽略 |
| `query_snapshot_quota:global`（schema 022，新增计数表，并为 `query_snapshot` 新增三个可缺省字段） | 新版快照存储首次使用时创建，之后随预留、提交、淘汰与释放更新 | 旧版不读取，忽略；既有快照行没有新字段时按 0 处理 |
| 游标（只在响应中，不持久化） | 新版 | 旧版忽略 `pageSize` 与 `cursor`，返回旧的全量形态（可能超预算，但不误派工） |
| 无新的任务状态，无新的 audit 或 outbox 动作 | 无 | 任务与历史按旧语义读取，调度与认领不受影响 |
| 工具 `get_admin_summary`、`read_task_text` | 无 | 旧版返回 `unknown_tool` |

隔离 fork 演练（`tests/rollback-isolation.fork.test.ts`，8 项）：同一夹具分别写入两个隔离命名空间。A 只有旧版，B 先由新版写入（分页、汇总、工作树读取，以及快照过期清理）。两边都运行 `8d03d35` 的调度器与旧版客户端若干轮。旧版源码取自 `git archive 8d03d35`。

该测试直接断言的内容：`cursor_key` 只在 B 出现，回滚运行后不变；快照表（`query_snapshot`、`query_snapshot_row`）在回滚运行前后不变；新读取前后任务、审计与出站表行数不变；过期快照的游标返回 `snapshot_gone`，清扫删除其表头与行并保留有效快照。它不直接断言 `query_snapshot_quota` 表。

断言：

- A 与 B 的派工结果一致。
- 受保护任务（等待中、owner 关口、持有中、终态、void）未被派工，版本号不变。
- gm 关口任务不被认领，只产生 gm-attention 通知。
- `cursor_key` 只在 B 出现，回滚运行不改动它。
- 快照表在回滚运行前后不变。
- 旧版读取新数据得到旧形态，新工具返回 `unknown_tool`。

阳性对照：旧版调度器认领了就绪任务（零误派工断言之外的正向检查）。

红灯对照（误派工突变）：把等待中的任务改为 `ready` 并清空依赖，零误派工断言应失败。本次门禁在 HEAD `6b517b8` 上重跑了该突变，两种运行时均为 7 通过、1 失败（见第 9.4 节）。

未覆盖：真实 Paseo 员工会话（演练中为桩），以及真实 sidecar 与 sck 包装器（包装器执行部署版 `active` 目录下的客户端）。

回滚基线：RB01 的旧版 oracle 为 `8d03d35`。发布前须按实际 main 核对包含关系，确认回滚目标包含所需修复，不把缺修复的旧版当作无条件兼容的回滚。

## 8. 验证映射

| AC | 服务端位置 | 测试与证据 |
|---|---|---|
| AC01 复现 | 第 1 节 | `tests/comm-slow-pipe.test.ts`：新客户端为绿，`tests/fixtures/comm-client-8d03d35.ts` 为红。证据见第 9 节 |
| AC02 分页与游标 | `core.ts` 的 `contextView`、`historyView`、`worktreePage`、`listingPage`；`snapshot-store.ts`；`query-input.ts`；`response-budget.ts` 的 `sealCursor`、`openCursor` | 集成：1000 条遍历，并发遍历，状态移动，目标与角色变化，过期与篡改，跨身份，容量耗尽，断线后同游标重试 |
| AC03 传输 | `response-budget.ts` 的 `fitCount`、`utf8Prefix`、`utf8Segment`、`guardRelayResponse`、`echoTaskContext`；`sidecar.ts` 的 `handle()`；`mcp/server.ts` 的 `toolResult`；`client-cli.ts` 的 `writeStdout` | 单元：`tests/response-budget.test.ts`。集成：超预算拒绝，长文本段拼接，中文与 emoji 段拼接，写回显的红灯对照（第 9 节） |
| AC04 汇总 | `core.ts` 的 `adminSummary` | 集成：计数与 cutoff，窗口口径，并发写入下的完整性，非 gm 拒绝 |
| AC05 证明 | 以上全部位置 | 1000 条夹具全量遍历；长文本段拼接的 sha256 校验；断线后同游标重试；资源占用的测得上界（第 9 节） |
| 缺陷 1（认领回显，SYS01 复核） | `src/mcp/server.ts` 的 `claim_next`（显式 id 与队列两条路径都经 `echoClaim`）；`response-budget.ts` 的 `echoClaim`、`cutList` | 单元：`tests/response-budget.test.ts` 的认领回显用例（列表截断与计数、完整 JSON 的 sha256、合法上限、历史安全网）。集成：`tests/query-paging.integration.test.ts` 的「claim_next over MCP …」，经真实 MCP HTTP 服务与真实核心认领 19 000 字符上下文，并以 `reassemble` 校验全文。红灯：显式 id 路径不回显（直接返回核心完整认领），该测试与另外两项 R3 用例失败（47 通过、3 失败），返回 `response_too_large`。绿灯见第 9 节 |
| 缺陷 2（null 路由，SYS01 复核） | `src/query-input.ts` 的 `isPaged`、`taskIdOf`、`parseWorktreeInput`；`src/mcp/server.ts` 的 `pageArgs` 与各 `.nullish()` 参数；`plugin/server/sidecar.ts` 的 `list_worktrees`、`get_task_history`、`get_context`、`resume_task` | 单元：`tests/response-budget.test.ts` 的 null 参数用例。MCP：`tests/mcp.transport.test.ts` 的「null is absent on every MCP read argument…」。通道：`tests/sidecar.test.ts` 的「null is absent on the sidecar relay…」。fork 级（真实核心）：`tests/null-absent.fork.test.ts`（9 项）。红灯：MCP 分页参数退回 `.optional()`，两个 null 用例失败（5 通过、2 失败）；通道的 `list_worktrees` 分页判断退回 HEAD 写法（`args.pageSize !== undefined \|\| args.cursor !== undefined`，null 视为存在），通道 null 用例失败（18 通过、1 失败）。绿灯见第 9 节 |
| RB01 | 第 7 节 | 隔离 fork 8 项；误派工红灯 7 通过、1 失败 |

## 9. 验证结果

本节是经理裁决 v25 之后的门禁与红灯对照结果。门禁脚本为 `v25/gate-chain-v25.sh`，在 HEAD `6b517b8` 上运行，开始于 2026-10-19 21:20:59Z，结束于 21:29:46Z。开始与结束时工作树变更计数均为 0，树索引前后一致。门禁之后的提交只改本文档，不改变被测代码。

红灯脚本为 `v25/red-controls-v25.sh`，在同一 HEAD 上运行（21:30:37Z 至 21:32:06Z）。每个突变运行后都已还原，`v25/red/red-summary.txt` 中每项均有还原记录，还原后工作树干净。

证据包 `v25/` 包含门禁汇总 `gate-summary.txt`、各步骤日志 `gate-wt-<步骤>-<运行时>.log`、红灯汇总 `red/red-summary.txt` 与各突变日志。证据包的发布链接见 PR #1468 正文与交付报告。

运行时：默认 Bun 1.3.11；部署运行时 Bun 1.4.2（`runtime-bun`）；pnpm 10.32.1。除工具链外，每个步骤在两种运行时上各运行一次。

### 9.1 门禁

| 门禁 | 命令 | Bun 1.3.11 | Bun 1.4.2 |
|---|---|---|---|
| 工具链 | `sh plugin/scripts/vendor.sh`；根目录与 `plugin` 目录的 `bun x tsc --noEmit` | 三项均 exit 0（只运行一次） | 不重复运行 |
| 单元（响应预算） | `bun test tests/response-budget.test.ts` | 33 通过、0 失败 | 33 通过、0 失败 |
| 桥接 | `pnpm test:bridge` | 263 通过、23 跳过、0 失败（286 项，11 个文件） | 263 通过、23 跳过、0 失败 |
| 服务 | `pnpm test:service` | 12 通过、0 失败 | 12 通过、0 失败 |
| 通信 | `pnpm test:comm` | 8 通过、1 跳过、0 失败（9 项，3 个文件） | 8 通过、1 跳过、0 失败 |
| 通道 | `pnpm test:channel` | 81 通过、1 跳过、0 失败（82 项，9 个文件） | 81 通过、1 跳过、0 失败 |
| 慢管道对照 | `SCK_COMM_CONTROL=1 bun test tests/comm-slow-pipe.test.ts` | 2 通过、0 失败 | 2 通过、0 失败 |
| 内部 AI 证明（公司 fork） | `RUN_COMPANY_PROOF_FORK_TESTS=1 bun scripts/test-worktrees.ts tests/internal-ai-proof.fork.test.ts` | 23 通过、0 失败 | 23 通过、0 失败 |
| 公司 fork 聚焦（分页、RB01、null、快照配额） | `bun scripts/test-worktrees.ts tests/query-paging.integration.test.ts tests/rollback-isolation.fork.test.ts tests/null-absent.fork.test.ts tests/snapshot-quota.fork.test.ts` | 77 通过、0 失败（4 个文件：分页 50、RB01 8、null 9、快照配额 10） | 77 通过、0 失败 |
| 公司 fork 默认清单 | `bun scripts/test-worktrees.ts` | 284 通过、0 失败（29 个文件） | 284 通过、0 失败 |
| 复核脚本 v3（只读复现） | `bun scripts/test-worktrees.ts <证据包>/indep-sys01-repro-v3.test.ts` | 8 通过、0 失败 | 8 通过、0 失败 |

### 9.2 跳过项

跳过项都由环境变量门控。每一项都在对应的启用步骤中运行并通过，没有遮盖本次必测项。

- 桥接 23 项：`tests/internal-ai-proof.fork.test.ts`，由 `RUN_COMPANY_PROOF_FORK_TESTS` 门控。桥接步骤未设置该变量。`proof-fork` 步骤设置后运行，两种运行时均为 23 通过。
- 通道 1 项：`tests/dispatcher-sidecar.fork.test.ts` 的「company fork: restart quarantine, actual lease fencing, fresh dispatch and independent review」，由 `RUN_SCK_CHANNEL_FORK_TESTS` 门控。公司 fork 默认清单中同一用例实际运行，两种运行时均通过。
- 通信 1 项：`tests/comm-slow-pipe.test.ts` 的「control: the 8d03d35 client cuts the same answer at the pipe buffer」，由 `SCK_COMM_CONTROL` 门控。`slowpipe-control` 步骤设置后运行，两种运行时的 2 项均通过。

### 9.3 AC03 与 AC05 数字

预算为 49 152 字节（48 KiB），按序列化后的 UTF-8 字节计。下表取自门禁日志中 `AC03 channel bytes` 与 `AC05 resource` 的输出。它们是本次运行的测得值，不是固定指标。

AC03 通道（`tests/query-paging.integration.test.ts` 中经真实 sidecar 与 comm 客户端的全量遍历，881 条任务）：

| 运行 | 所在门禁 | 页数 | 每页最大字节 | 旧调用整表超预算的拒绝响应字节 | 超长 context 的旧详情拒绝响应字节 |
|---|---|---|---|---|---|
| Bun 1.3.11 | 公司 fork 聚焦 | 27 | 49 021 | 262 | 545 |
| Bun 1.4.2 | 公司 fork 聚焦 | 27 | 49 012 | 262 | 545 |
| Bun 1.3.11 | 公司 fork 默认清单 | 27 | 48 976 | 262 | 545 |
| Bun 1.4.2 | 公司 fork 默认清单 | 28 | 49 021 | 262 | 545 |

AC05 资源（同一文件的 AC05 资源用例，881 条任务，`pageSize` 为 25，全量遍历 38 页）：

| 运行 | 所在门禁 | 每页最大字节 | 页耗时 P50 / 最大（ms） | 堆基线（MiB） | GC 后堆（MiB） | 堆增量上界（MiB） |
|---|---|---|---|---|---|---|
| Bun 1.3.11 | 公司 fork 聚焦 | 48 945 | 1 / 238 | 49.2 | 32.1 | 0 |
| Bun 1.4.2 | 公司 fork 聚焦 | 48 945 | 2 / 249 | 20.4 | 20.3 | 10.5 |
| Bun 1.3.11 | 公司 fork 默认清单 | 48 954 | 2 / 272 | 45.4 | 22.4 | 0 |
| Bun 1.4.2 | 公司 fork 默认清单 | 48 954 | 2 / 274 | 20.3 | 20.2 | 11.1 |

- 所有页的字节都低于 49 152。
- 堆基线随同一进程内先前运行的用例而变，因此只把增量上界当作测得值，不代表恒定内存占用。
- 页耗时为用例内测得的每页耗时。

### 9.4 红灯与绿灯对照

四个突变都在 HEAD `6b517b8` 上运行。每个突变都是临时修改，运行后已还原。

| 突变 | 预期失败的测试 | Bun 1.3.11 | Bun 1.4.2 |
|---|---|---|---|
| C1 缺陷 1（认领回显）：`src/mcp/server.ts` 的显式 taskId 路径不经 `echoClaim`，直接返回核心完整认领 | `tests/query-paging.integration.test.ts`：MCP `claim_next` 超预算上下文用例、16 KiB 以上历史用例、长项目与依赖及 paths 用例 | 47 通过、3 失败（共 50） | 47 通过、3 失败（共 50） |
| C2 缺陷 2（null，MCP）：分页参数的 schema 退回 `.optional()` | `tests/mcp.transport.test.ts`：null 缺省用例、「null 不进入分页分支」用例 | 5 通过、2 失败（共 7） | 5 通过、2 失败（共 7） |
| C3 缺陷 2（null，通道）：`list_worktrees` 的分页判断退回 HEAD 写法，即对 pageSize 与 cursor 做 undefined 判断，null 视为存在 | `tests/sidecar.test.ts`：通道 null 用例 | 18 通过、1 失败（共 19） | 18 通过、1 失败（共 19） |
| C4 RB01 误派工：等待中的任务改为 `ready` 并清空依赖。使用临时副本 `tests/rb01-red-mutant.fork.test.ts`，用后删除 | `tests/rollback-isolation.fork.test.ts`：零误派工断言 | 7 通过、1 失败（共 8） | 7 通过、1 失败（共 8） |

- 每个突变的失败项都与预期一致。C1 的三项失败分别对应缺陷 1、R3 历史截断、R3 项目与依赖及 paths 回显。
- 写回显无界突变在前序轮次记录为 42 通过、2 失败，对应的是前序代码。它未在当前树上重跑，结果不代表当前代码。

### 9.5 RB01 回滚隔离

隔离 fork 的 8 项（`tests/rollback-isolation.fork.test.ts`）在两种运行时上均为 8 通过、0 失败。其中阳性对照（旧版认领就绪任务）通过，零误派工断言通过，旧版读取新版数据时分页参数被忽略、新工具返回 `unknown_tool`。

红灯 C4（见 9.4）在两种运行时上均为 7 通过、1 失败，失败项正是零误派工断言。

### 9.6 未验证与限制

- 缺陷 1 的红灯（C1）在两种运行时上均已取得。前次只在 Bun 1.3.11 上取得。
- 缺陷 2 的 fork 级（真实核心）null 用例已补：`tests/null-absent.fork.test.ts`，9 项，两种运行时均通过。覆盖范围：非 gm 不带 taskId 的 `list_worktrees` 在 MCP、sidecar、core 三层均为 `forbidden`，null 与缺省相同；租约任务不作为回退范围；显式 taskId 的授权、无权与不存在；gm 全局读；分页；`get_context`、`get_task_history`、`claim_next`、`heartbeat` 的 null 缺省。MCP 与通道的桩核心用例（`tests/mcp.transport.test.ts`、`tests/sidecar.test.ts`）仍保留。
- 核心 `claim()` 的完整认领可超过预算（D4）。有界的是 MCP `claim_next` 与 `heartbeat` 的应答。复核脚本 v3 的断言已按此层次修正。
- 认领回显的 `history` 按字节动态填充（D1），不是固定 16 KiB 窗口。核心读取的窗口仍按条数限定（60 条协议记录与 20 条运维记录）。`historyComplete` 为假时，完整历史用 `get_task_history` 分页读取。
- 快照准入的跨进程原子性（D2，R4）由库内配额计数实现。`tests/snapshot-quota.fork.test.ts` 的 10 项在两种运行时上均通过，包括三个子进程并发准入 20 次、SIGKILL 后的清理、释放恰好一次。
- sidecar 没有 `claim_next`（调度器代领，员工侧调用直接拒绝），也没有认领回显。sidecar 的 `heartbeat` 回 `{ok:true}`，不回显租约。MCP 的 `heartbeat` 经 `echoClaim` 回显。
- `release` 没有员工侧 MCP 工具，只经共享的 `echoTask` 回显路径。它由调度器的通道回滚（`releaseClaim`）调用。
- null 的未决差异（待经理裁定，不在本次范围）：`reclaim_worktrees` 的 MCP 参数为 `.optional()`，传 null 被 zod 拒绝。sidecar 把 null 与缺省同样处理（`dryRun` 取 `=== true`），即执行回收，不是只读预演。`list_worktree_audits` 在 MCP 与 sidecar 上一致，null 视为缺省。
- MCP 对 `pageSize` 为 0 或 101 的调用由 zod 直接拒绝，错误不带结构化 `code`。core 与 sidecar 返回 `invalid`。
- 观察（非阻断）：快照清扫只在新建快照时进行，没有定时调用。GoalView 与验收回复的字节大小未经预算验证。sidecar 中的 `.stale-<时间戳>` 后缀未在文档中说明。
- 写回显无界突变未在当前树上重跑。长依赖列表（`create_delivery`）与 50 条长 paths（`create_task`）的回显用例在门禁中通过（`tests/query-paging.integration.test.ts`）。
- 公司 fork 的数据库引导（`src/database.ts`）在目标 namespace 已含无关资源时拒绝新建数据库。RB01 隔离演练与快照配额用例使用带随机后缀的独立 namespace。
- 真实 Paseo 员工会话与真实 sidecar、sck 端到端未执行。AC05 的真实员工 sck QA 未执行。独立 QA（真实员工 sck 的全量读取、拒绝用例、分段 hash）由 QA `6b6cb5b9` 在部署后完成。本实现不声称已完成。
- 发布前须核对实际 main 的包含关系（`8d03d35` 与 `f42d99b`），确认回滚目标包含所需修复。
- 本次未部署，未调用 `ops_*`，未读取凭证。
- 慢管道对照的 1000 条载荷由测试替身直接输出，不经过响应预算，只证明客户端的字节传输完整。预算由单元与公司 fork 用例覆盖。
