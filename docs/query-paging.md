# 管理查询的字节预算、快照分页与完整读取（SYS01，0.7.0）

本文说明员工与老板（owner）通过 `sck`（comm 通道）读取任务、历史、工作树与公司汇总时的契约。0.7.0 起只有这一条路径：`bin/sck` → `current/server/vendor/src/sck-cli.ts` → 插件 sidecar（`plugin/server/sidecar.ts`）→ 核心。MCP 服务已删除，本文不再描述 MCP 形态。

实现位置：`src/response-budget.ts`（字节预算、UTF-8 切分、写回显、游标封装）、`src/query-input.ts`（参数校验与查询摘要）、`src/snapshot-store.ts`（快照存储与库内配额）、`src/core.ts`（读取与汇总）、`plugin/server/sidecar.ts`（通道分发与应答检查）、`src/sck-cli.ts`（comm 客户端）。快照表为 `schema/023-query-snapshot.surql`（快照行）与 `schema/024-snapshot-quota.surql`（全库计数）。

## 1. 客户端输出

`sck` 必须把整个应答写到 stdout 之后才退出。`src/sck-cli.ts` 的 `writeStdout` 同步写完全部字节，遇到 EAGAIN 重试。若提前退出，管道未排空时尚未写出的字节会丢失，调用方会得到不可解析的 JSON。

应答为一行 JSON。成功时 stdout 为 `{ ok: true, data }` 的 JSON；失败时 stdout 为 `{ ok: false, code, error, retryable }` 的一行 JSON，原因写入 stderr，退出码为 1。

## 2. 字节预算

- 预算按序列化后的 UTF-8 字节计算，不按字符串长度计算。`RESPONSE_BUDGET_BYTES` 为 48 KiB（49152 字节），覆盖 sidecar 写回的整条应答，信封也计入。
- 测量函数为 `answerBytes`（`src/response-budget.ts`）。它按一个答案计两次：`content[0].text` 为答案的 JSON 文本，`structuredContent` 为 `{ok: true, data}`，两份各自计入（`dualBytes`），再加上 256 字节的帧预留（`RESPONSE_FRAME_BYTES`）。中继、分页、分段与回显都用这一个测量。
- 待确认：这套双份计量来自 0.6.x 的 MCP 结果形态，MCP 删除后 sidecar 仍沿用它，保证 48 KiB 上限的数值不变。是否取消双份、改为单份计量，需要老板或复核人决定，不属于本次文档改写的范围。
- 分页条目的上限为 `ITEM_BUDGET_BYTES`，即 46 769 个双份字节（约 45.7 KiB）。它等于数据可占的 `DATA_BUDGET_BYTES`（48 817）减去 2 KiB 的页信封余量（`PAGE_ENVELOPE_BYTES`）。条目不超过它时保持完整。
- 检查点：sidecar 写回中继应答时（`guardRelayResponse`）按 `answerBytes` 计。超过预算的成功应答替换为 `response_too_large`（`retryable: false`，缩小查询后重试）。附带在成功回包上的未确认持有人通知（`notices`）计入同一条应答：带通知时守卫取 `answerBytes(data)` 与整条写回行两者的较大值。放不下的通知按 `fitAttachedNotices` 截掉，`noticesTruncated`（`count` / `bytes` / `sha256`）只描述被截掉的那几条，未附带的仍未确认，下一次调用再附带。
- 完整读取从不截断（见第 3 节）。分页读取只在单条超过 `ITEM_BUDGET_BYTES` 时截断该条：列表按下文截断，正文取剩余空间并标注 `contextTruncated` 与 `contextNextOffset`（证据为 `evidenceTruncated` 与 `evidenceNextOffset`），其余部分用 `read_task_text` 按段读取。
- 工作树分页条目（`list_worktrees` 带 `pageSize`/`cursor`）：单个工作树连同全部 references 超过 `ITEM_BUDGET_BYTES` 时，references 只保留放得下的最长前缀，并标注 `referencesTruncated`（完整条数 `count`、完整 JSON 的 SHA-256 `sha256`、读取时使用的 `includeReleased`，以及恢复入口 `tool: "read_worktree_refs"`）。该条仍留在页里，分页继续前进。完整引用列表用 `read_worktree_refs` 按段读取。不靠缩小 `pageSize`、静默丢引用或关闭 `includeReleased`。
- `read_worktree_refs` 的 `worktreePath` 用 listing 返回的规范路径，`includeReleased` 必须与当时 listing 一致，这样 `referencesTruncated.sha256` 覆盖的就是读回的全文。每段默认 16 KiB，最大 24 KiB，最小 4 字节。段边界不拆字符，`sha256` 覆盖全文。`offset` 大于 0 时必须带第一段的 `expectSha256`，列表在两次读取之间变化则返回 `conflict`。权限与 `list_worktrees` 相同：非老板必须带 `taskId`，老板可全局读。
- `read_task_text` 每段默认 16 KiB，最大 24 KiB（`SEGMENT_MAX_BYTES`），最小 4 字节，且不超过 `limit` 原始字节。段长同时按整条应答的 `answerBytes` 计：控制字符写成 6 字节、引号写成 2 字节，所以控制字符或引号密集的正文，段会短于 `limit`，每条应答都不超过 49 152 字节。段边界落在字符边界上，各段拼接即为原文，`sha256` 为整段正文的摘要。

写接口的回显（`echoTask`）：检查点、提交、验收、退回、阻塞（`report_blocker`）、创建、释放、续做、延后、退役、项目换绑、仓库绑定与负责人决定返回的任务回显，同样受预算限制。任务与工作树的意图路径（`workIntent.paths`、`worktree.intent.paths`）各取不超过 `min(4 KiB, 本次回显的双份字节上限 / 8)` 的最长前缀，超出的列表在 `listsTruncated` 中给出完整条数（`count`）与完整 JSON 的 SHA-256（`sha256`），完整列表用 `read_task_text` 读取。之后 `context` 取剩余空间，超出时截断并标注（`contextTruncated`、`contextNextOffset`）。`contextBytes` 与 `contextSha256` 始终描述完整正文。写接口的回显不含项目环境正文。

写入先于回显提交。正文（`context`）与列表超出时截断，所以正文长度与列表条数不会使已提交的写入失败。回显的其余顶层文本字段各不超过 2 KiB（`TASK_FIELD_ECHO_BYTES`），超出时截断并在 `fieldsTruncated` 中标注。若整条应答仍超过 49 152 字节，sidecar 返回 `response_too_large`。此时写入已经提交，调用方须用 `get_context`（带 `taskId`）或 `get_task_history` 核对状态，不得重复提交。

认领回显（`claim_next`，心跳同源）：认领在回显之前已经提交（租约、审计与 `claim.json`），所以回显不能报错。`deliveryId`、`fence` 与 `leaseExpiresAt` 总是返回。`expectedVersion` 不在认领回显中，版本号位于 `task.version`。可变部分各自有界，并标注：

- `task.context` 超出时截断，标注 `contextTruncated` 与 `contextNextOffset`，其余用 `read_task_text` 读取。
- 任务的 `workIntent.paths` 与工作树的 `worktree.intent.paths` 各不超过 4 KiB（`CLAIM_LIST_ECHO_BYTES`）。超出时保留最长前缀，并在 `listsTruncated` 中给出该列表的完整条数与 SHA-256。完整列表在 `claim.json` 中，可用 `read_task_text` 的 `workIntentPaths`、`worktreePaths` 读取。
- `project` 不超过 8 KiB 时完整返回。超出时只回显身份字段（`id`、`name`、`repoPath`、`defaultBranch`、`release`、`rollback`、`pipeline`，每个文本字段最多 512 字节）与红线（每条最多 1 KiB，放得下几条就留几条），并标注 `projectTruncated`、`projectBytes` 与 `projectSha256`。完整项目可用 `read_task_text` 的 `project` 读取（仅持有人与老板）。
- 交接历史（`history`）不是固定窗口。核心先读出最新的 60 条协议记录与 20 条运维记录（按条数）。回显再按字节动态填充：最新条目优先，至少保留 8 KiB（`CLAIM_HISTORY_FLOOR_BYTES`），其余预算留给上下文。边界条目若放不下，只保留证据的最长前缀，并标注 `evidenceTruncated`、`evidenceBytes`、`evidenceSha256`、`evidenceNextOffset`。更早的条目不被编造，也不附 `nextOffset`。
- `historyCount` 为任务历史的全部条数。`historyComplete` 只有在全部条目都以完整形式出现在回显中，且条数一致时才为 `true`。完整历史用 `get_task_history` 分页读取。
- 工作树只在顶层 `worktree` 出现一次，`task.worktree` 不重复。心跳的回显不含工作树。

字节上界：标题不超过 200 字符，目标不超过 100 字符，`context` 不超过 20 000 字符（创建时限定）。认领回显中，前驱最多 6 条，交接窗口按上文动态填充，列表与项目按上文截断。核心 `claim()` 仍返回完整认领，供 `claim.json` 与调度器使用，它不是 RPC 应答，不受预算约束。

## 3. 工具与参数

| 工具 | 参数 | 旧调用（不带 pageSize、cursor） | 分页调用（带 pageSize 或 cursor） | 权限 |
|---|---|---|---|---|
| `get_context` | `scope?`（`tasks` 缺省，或 `company`）、`section?`（仅 `scope: company`，`directions`、`goals`、`projects`）、`taskId?`、`state?`、`tag?`、`role?`、`since?`、`includeCompany?`（缺省 `false`）、`fields?`、`pageSize?`（1–100，默认 25）、`cursor?` | 任务：`{ principal, companyIncluded, companyRead, tasks, company? }`，完整或拒绝；`scope: company`：`{ principal, scope, section?, company }`，完整或拒绝 | 任务：`{ principal, companyIncluded, companyRead, tasks, company?, page }`；`scope: company`：`{ principal, scope, section?, parts, page }` | 员工见自己可见的任务；老板见全部；公司块对所有已认证身份可读，但项目环境（`envs`、凭证别名与角色）仅老板与持有该项目有效任务租约的员工可见，其它人得到空 `envs` 与 `envsWithheld: true` |
| `get_task_history` | `taskId`、`pageSize?`、`cursor?` | `{ history }`，完整（按时间正序）或拒绝 | `{ history, page }`，页序从新到旧，页内按时间正序 | 与 `get_task` 相同 |
| `list_worktrees` | `taskId?`、`includeReleased?`、`pageSize?`、`cursor?` | 数组，完整或拒绝 | `{ worktrees, page }`，按路径排序 | 非老板须带 taskId（缺省或 null 一律 `forbidden`）；老板可全局 |
| `read_worktree_refs` | `taskId?`、`worktreePath`、`includeReleased?`、`offset?`、`limit?`、`expectSha256?` | 无 | `{ worktreePath, includeReleased, totalBytes, sha256, offset, bytes, nextOffset, text }` | 与 `list_worktrees` 相同 |
| `read_task_text` | `taskId`、`field`（`context`、`evidence`、`project`、`workIntentPaths`、`worktreePaths`）、`auditId?`、`offset?`、`limit?`、`expectSha256?` | 无 | `{ taskId, field, auditId?, totalBytes, sha256, offset, bytes, nextOffset, text }` | 每段都检查权限 |
| `get_admin_summary` | `since?`、`tag?` | 无 | `{ cutoffAt, since, tag?, scope, tasks, audit, integrity }`（第 5 节） | 仅老板 |

要点：

- `get_context` 缺省的工作集是 `ready`、`doing`、`review`、`blocked`，并排除调用人自己提交的 `review` 任务。`state` 给定时只看该状态。`since` 按任务创建时间（`created_at`）下限过滤，只接受 ISO 8601 日期（按 UTC 零点）或带时区的时间（`Z` 或 `±hh:mm`）。`October 19, 2026`、`2026/10/19`、RFC 2822 日期、无时区的时间与不存在的日期（如 `2026-02-30`）返回 `invalid`。
- `fields` 只能选白名单内的字段，未知字段返回 `invalid`。
- `includeCompany` 缺省为 `false`，旧调用与分页调用一致，不随任务答复返回公司块。每个任务答复都带 `companyIncluded` 与 `companyRead`（读取公司块的参数 `{"scope":"company","pageSize":25}`）。`includeCompany: true` 只在整包装得下时返回公司块，否则整体拒绝并指路分页。
- 公司块读取（`scope: company`）：不带 `pageSize`、`cursor` 时返回完整块（或 `section` 指定的一节），超预算则 `response_too_large`。带 `pageSize` 或 `cursor` 时返回一页条目段 `parts`：每段是某一条目（`meta`、`directions`、`projects` 的一项）的 JSON 文本的一段，不超过 16 KiB，带 `offset`、`totalBytes`、`sha256`（整条目 JSON 的 UTF-8 字节数与 SHA-256）。读取方按 `section` 与 `key` 归组，按 `part` 升序拼接，校验字节数与 `sha256` 后再解析。缺段、重复段或校验不符即拒绝，不得当作较短的条目。逐页续读直到 `page.hasMore` 为 false。游标绑定调用人与查询条件（`section`）：他人或其它查询使用返回 `forbidden`，篡改返回 `invalid`，过期返回 `snapshot_gone`。游标还绑定项目环境的可见范围：持有有效租约时取得的快照，租约结束后续读返回 `forbidden`，不再带出环境段。
- `taskId` 读取整条任务，`context` 完整返回，并附 `contextBytes` 与 `contextSha256`。超出预算时拒绝，并给出 `read_task_text` 的读取示例。与 `cursor` 同用会返回 `invalid`。
- 旧调用的完整集合上限：任务 500 条，历史 1000 条。超过即拒绝为 `response_too_large`，并给出 `pageSize` 与 `cursor` 的重试示例。
- `page` 字段：`pageSize`、`returned`、`hasMore`、`total`（快照内的总条数）、`snapshotAt`（快照读取时刻的数据库时间）、`budgetBytes`，以及 `hasMore` 为真时的 `nextCursor`。
- 统计条数时，按 `page.nextCursor` 读完全部页，并累加每页的 `returned`（或数组长度）。`page.total` 是快照内的总数，可用来核对。
- `pageSize` 取 1 至 100，缺省 25。`pageSize` 不属于游标的绑定，续页时可以改用另一个值。
- 每页的条数由预算决定，不一定等于 `pageSize`。`returned` 为本页实际条数。

null 语义（sidecar 与核心一致）：

- `pageSize`、`cursor`、`list_worktrees` 的 `taskId` 为 null 与缺省相同，即视为未提供。`get_context` 的 `taskId`、`state` 等筛选同样视为未提供。
- `get_task_history` 的 `taskId` 为必填。null 经 `taskIdOf` 以 `invalid` 拒绝。核心的 `history` 与 `historyView` 接收的是已校验的字符串。`read_task_text` 的 `taskId` 同样必填（`parseTextInput` 以 `invalid` 拒绝）。
- `reclaim_worktrees` 的参数，sidecar 与核心一致：整包 null 或非对象 → `invalid`；缺省 `dryRun` 为回收，`dryRun: true` 为预演，`dryRun` 为 null、字符串、数字或空串 → `invalid`；`repos` 缺省为全部仓库，给出时必须是非空路径字符串的列表，否则 `invalid`。参数在任何工作树被触碰之前校验，null 不会被当作缺省值读取。核心的次序是鉴权、校验参数、判老板：非老板的畸形参数得到 `invalid`，合法参数得到 `forbidden`。

`read_task_text` 的要点：

- `auditId` 在读取证据（`field: evidence`）时必需。
- `offset` 大于 0 时必须带 `expectSha256`，即第一段返回的 `sha256`。若原文已变化，返回 `conflict`，要求从 `offset: 0` 重读，不混拼两个版本。
- 证据必须属于该任务，否则返回 `not_found`。

## 4. 快照与游标

分页读取的第一页时，服务端把匹配的行与返回字段一次性物化为一个快照（表 `query_snapshot` 与 `query_snapshot_row`）。此后每一页只读取已存储的行，不重新执行查询。

- 成员与字段固定。快照的成员、排序与返回字段在首页时刻确定。遍历中新增、状态变化、字段变化、离开过滤集合、工作树登记增删，都不改变本次遍历的成员与字段。
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
| `temporarily_unavailable` | 全库快照容量已满，或同一身份的快照都还在写入且等待超时，或快照构建超过 10 秒截止，或构建连接排队超过 2 秒，或快照未能写入 | 稍后重试（`retryable: true`）；答复最迟在 13 秒内返回 |
| `response_too_large` | 快照超过 5000 行或 8 MiB；单页信封或单条超过预算 | 按查询形状收窄：任务与历史列表用 `state`、`tag`、`role`、`since` 或 `pageSize`+`cursor`；公司块与某一节用 `{"scope":"company","pageSize":25}` 或 `section` 分页；工作树引用用 `read_worktree_refs` 按段读取 |

快照上限（`DEFAULT_SNAPSHOT_LIMITS`，代码中为固定值，没有运营配置项）：

- 有效期 6 小时。游标的有效期与快照相同。
- 每个快照最多 5000 行、8 MiB（UTF-8 字节）。超过时整体拒绝，不存部分。
- 每个身份最多 4 个快照。超过时淘汰该身份最旧的已完成快照，其游标随后返回 `snapshot_gone`。仍在写入的快照保留其名额。
- 全库最多 64 个快照。预留与已存快照都计入。已满时拒绝新快照（`temporarily_unavailable`），不淘汰任何快照。
- 全部快照合计最多 64 MiB，同样计入预留。
- 预留从准入起即计入上限。写入中的快照保留名额，直到提交、释放或超时。
- 若某身份的快照全部仍在写入，该身份的新请求最多等待 5 秒（且不超过本次构建的 10 秒截止），等待其中一个提交。超时返回 `temporarily_unavailable`。
- 写入中的快照超过 5 分钟仍未完成，视为遗弃，连同其行一并删除。
- 过期快照与遗弃快照由快照存储的清扫删除。清扫在每次新建快照时执行，也可直接调用存储的 `sweep`。当前没有定时任务调用它，过期快照占用的名额会在下一次新建快照时释放。
- 释放恰好一次：快照行、表头与名额在同一事务中删除，并只扣减一次。
- 空结果不建快照：`get_context`、`get_task_history`、`list_worktrees` 的分页首页在查询零命中时只做一次计数探测，直接返回 `returned: 0, hasMore: false, total: 0` 的空页，不写 `query_snapshot`、不占配额。

快照构建的时限与答复上界：

- 构建截止 10 秒（`buildDeadlineMs`），从工具调用开始计时，包括连接、读取、预留、每批写入与提交。截止后不再开始新语句；在途语句最多再等 500 毫秒（`IN_FLIGHT_WAIT_MS`），之后关闭它的连接。
- 预留的释放在截止后 2 秒内完成（`RELEASE_UNTIL_MS`），在独立的释放通道上执行，不占用构建连接。来不及完成的释放，在 3 秒内（`CLEANUP_BUDGET_MS`）标记为待清扫，下一次清扫释放一次。
- 调用方在截止后至多等待 3 秒，因此构建与首页读取的答复最迟在 13 秒内返回（`REPLY_CEILING_MS`）。超时后不再在后台建快照；在途连接在后台关闭，已预留的配额由释放或清扫归还。
- 13 秒从请求到达时刻计（`src/reply-clock.ts`）。sidecar 对 `get_context`、`get_task_history`、`list_worktrees` 在到达后 13 秒内必须答复：鉴权、连接恢复与构建都计入这 13 秒。超过时不再开始工作，并以可恢复的 `temporarily_unavailable` 答复。其它工具不受此上界约束。
- 构建连接全进程最多 4 个（`MAX_BUILD_CONNECTIONS`，含在用的与温存的）。拿不到连接的构建排队超过 2 秒即返回 `temporarily_unavailable`（`BUILD_QUEUE_MS`）。
- 构建成功后连接回到进程内的温连接池（空闲上限 30 秒，`BUILD_IDLE_TTL_MS`），下一次构建复用它。复用前用一条 `RETURN true;` 探活，失败则换新连接。
- 每批写入 256 KiB（`batchBytes`）。读取超过 5 秒仍未返回的，放弃该连接，在新连接上重试一次（`loadHedgeMs`）；重试仍超时则构建失败。
- 释放与清扫在构建之外各有 3 秒上限（`RELEASE_DEADLINE_MS`），超时即标记待清扫。
- 受限链路（例如 50 KiB/s）上，超过 10 秒可传输量的大工作集会以 `temporarily_unavailable` 明确拒绝。这是可恢复的拒绝，不是数据损坏。请按答复指引收窄 `state`、`tag`、`role`、`since`，或用 `fields` 减少每行字节后重试。

准入上限在数据库内强制执行，由单一记录 `query_snapshot_quota:global`（schema 024）计数。每次预留、淘汰与释放都在同一事务中改动计数并递增 `version`，写入前校验版本。插件进程内的 sidecar 与其它写快照的进程共用同一上限，上限是硬限制。全库已满时，被拒绝的请求不淘汰任何快照。

## 5. 汇总

`get_admin_summary` 只读，仅老板可用，其他角色返回 `forbidden`。它不返回任务正文。

- `cutoffAt`：事务内读取的数据库时间（`time::now()`）。
- `tasks`：每个任务在截止时刻所处状态的计数，可按 `tag` 限定。`since` 不适用于任务计数。
- `audit`：审计事件在 `[since, cutoffAt]` 内的动作计数。`since` 缺省为调用时服务端时钟的 24 小时前（在事务开始前计算，不随 `cutoffAt` 调整）。给出 `tag` 时只计该标记任务的事件。
- `scope`：逐项声明口径。它不是“窗口内新建或更新的任务数”。
- `integrity.complete` 为真，当且仅当以下四项全部成立：`taskCountsMatchRows`（状态计数之和等于任务总数）、`auditCountsMatchRows`（动作计数之和等于审计总数）、`statesKnown`（所有状态均为已知状态）、`repeatableRead`（同一事务内第二次读取与第一次一致）。
- `integrity.complete` 为假时，返回的数字不能作为完整结论，应重试。

0.7.0 起汇总不再返回 `outboxSequence`，因为核心不再写 outbox 事件（表保留，下个版本再删）。

读取在一个 `BEGIN…COMMIT` 事务内完成。`repeatableRead` 只是一致性的一项检查。并发一致性另由公司 fork 的并发用例验证：任务状态变化与审计写入同时进行时，每次汇总的完整性检查都通过，任务总数保持不变，审计计数不减少。

## 6. 历史记录

0.6.x 期间的复核轮次（裁决 v15 至 v47）与 MCP 形态下的验证数字已不再保留在本文。这些记录只属于 0.7.0 之前的版本，需要时查看 git 历史中本文件的旧版本。
