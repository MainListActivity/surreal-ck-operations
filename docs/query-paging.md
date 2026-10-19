# 管理查询的字节预算、快照分页与完整读取（SYS01）

本文说明员工与经理通过 sck（comm 通道）和 MCP 读取任务、历史、工作树与公司汇总时的契约。依据为经理裁决 v15（2026-10-19，C1 至 C6，见第 6 节）。

实现位置：`src/response-budget.ts`（字节预算、UTF-8 切分、写回显、游标封装）、`src/query-input.ts`（参数校验与查询摘要）、`src/snapshot-store.ts`（快照存储）、`src/core.ts`（读取与汇总）、`plugin/server/sidecar.ts`（通道分发与响应检查）、`src/mcp/server.ts`（MCP 工具）、`src/mcp/client-cli.ts`（comm 客户端）。新增 schema 为 `schema/021-query-snapshot.surql`。

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

- 预算按序列化后的 UTF-8 字节计算，不按字符串长度计算。`RESPONSE_BUDGET_BYTES` 为 48 KiB，覆盖整个 `{ok,data}` 响应。
- 分页条目的截断阈值为 `ITEM_BUDGET_BYTES`，即 46 KiB（预算减去 2 KiB 的页信封余量）。条目本身不超过阈值时保持完整。
- 两道检查：sidecar 写回中继响应时（`guardRelayResponse`），以及 MCP 的 `toolResult`。超过预算的成功响应替换为可恢复的 JSON 错误 `response_too_large`。comm 客户端退出码为 1，stdout 为一行 JSON。
- 完整读取从不截断（见第 3 节）。分页读取只在单条超过 46 KiB 时截断该条，并标注 `contextTruncated` 与 `contextNextOffset`（证据为 `evidenceTruncated` 与 `evidenceNextOffset`），其余部分用 `read_task_text` 按段读取。
- `read_task_text` 每段默认 16 KiB，最大 24 KiB，最小 4 字节。段边界落在字符边界上，各段拼接即为原文，不产生 UTF-8 断字符。

写接口的回显（SYS01）：转移、创建、释放、续做、延后、退役、项目换绑、仓库绑定与负责人决定返回的任务回显，同样受 46 KiB 限制。回显中的 `context` 超出时截断并标注。`contextBytes` 与 `contextSha256` 始终描述完整正文。写入先于回显提交，回显不会使已提交的写入变成错误。`create_delivery` 把预算分给三条腿，每条腿不超过 `floor(46 KiB / 3)`。

## 3. 工具与参数（AC02）

| 工具 | 参数 | 旧调用（不带 pageSize、cursor） | 分页调用（带 pageSize 或 cursor） | 权限 |
|---|---|---|---|---|
| `get_context` | `taskId?`、`state?`、`goalId?`、`role?`、`since?`、`includeCompany?`、`fields?`、`pageSize?`（1–100，默认 25）、`cursor?` | `{ principal, company?, tasks }`，完整或拒绝 | `{ principal, company?, tasks, page }` | 员工见自己可见的任务；gm 见全部 |
| `get_task_history` | `taskId`、`pageSize?`、`cursor?` | 通道为 `{ history }`，MCP 为裸数组（与 `8d03d35` 相同）；均为完整（按时间正序）或拒绝 | `{ history, page }`，页序从新到旧，页内按时间正序 | 与 `get_task` 相同 |
| `list_worktrees` | `taskId?`、`includeReleased?`、`pageSize?`、`cursor?` | 数组，完整或拒绝 | `{ worktrees, page }`，按路径排序 | 员工须带 taskId；gm 可全局 |
| `read_task_text` | `taskId`、`field`（`context` 或 `evidence`）、`auditId?`、`offset?`、`limit?`、`expectSha256?` | — | `{ taskId, field, auditId?, totalBytes, sha256, offset, bytes, nextOffset, text }` | 每段都检查权限 |
| `get_admin_summary` | `since?`、`goalId?` | — | `{ cutoffAt, since, goalId?, scope, tasks, audit, outboxSequence, integrity }`（第 5 节） | 仅 gm |

要点：

- `get_context` 缺省的工作集是 `ready`、`doing`、`review`、`blocked`。`state` 给定时只看该状态。`since` 按任务创建时间（`created_at`）下限过滤。
- `fields` 只能选白名单内的字段，未知字段返回 `invalid`。
- `includeCompany` 缺省值取决于调用形态：旧调用缺省包含 `company` 块，分页调用缺省不包含，需显式传 `includeCompany: true`。
- `taskId` 读取整条任务，`context` 完整返回，并附 `contextBytes` 与 `contextSha256`。超出预算时拒绝，并给出 `read_task_text` 的读取示例。与 `cursor` 同用会返回 `invalid`。
- 旧调用的完整集合上限：任务 500 条，历史 1000 条。超过即拒绝为 `response_too_large`，并给出 `pageSize` 与 `cursor` 的重试示例。
- `page` 字段：`pageSize`、`returned`、`hasMore`、`total`（快照内的总条数）、`snapshotAt`（快照读取时刻的数据库时间）、`budgetBytes`，以及 `hasMore` 为真时的 `nextCursor`。

`read_task_text` 的要点：

- `auditId` 在读取证据（`field: evidence`）时必需。
- `offset` 大于 0 时必须带 `expectSha256`，即第一段返回的 `sha256`。若原文已变化，返回 `conflict`，要求从 `offset: 0` 重读，不混拼两个版本。
- 证据必须属于该任务，否则返回 `not_found`。

## 4. 快照与游标（C4）

分页读取的第一页时，服务端把匹配的行与返回字段一次性物化为一个快照（表 `query_snapshot` 与 `query_snapshot_row`，由 schema 021 新增）。此后每一页只读取已存储的行，不重新执行查询。

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
| `temporarily_unavailable` | 快照容量已满，或快照未能写入 | 稍后重试 |
| `response_too_large` | 快照超过 5000 行或 8 MiB；单页信封或单条超过预算 | 收窄筛选后重试 |

快照上限（`DEFAULT_SNAPSHOT_LIMITS`）：

- 有效期 6 小时。
- 每个快照最多 5000 行、8 MiB。
- 每个身份最多 4 个快照。超过时淘汰该身份最旧的快照，其游标随后返回 `snapshot_gone`。
- 全库最多 64 个快照。已满时拒绝新快照（`temporarily_unavailable`），不淘汰任何快照。
- 全部快照合计最多 64 MiB。
- 写入中的快照超过 5 分钟仍未完成，视为遗弃，连同其行一并删除。
- 过期快照由 sweep 删除，表头与行一起删除。

准入上限只在单个进程内原子生效。另一进程的并发写入可能使上限被超过一个并发量（第 6 节 D2）。

## 5. 汇总（C5，AC04）

`get_admin_summary` 只读，仅 gm 可用，其他角色返回 `forbidden`。它不返回任务正文。

- `cutoffAt`：事务内读取的数据库时间（`time::now()`）。
- `tasks`：每个任务在截止时刻所处状态的计数，可按 `goalId` 限定。`since` 不适用于任务计数。
- `audit`：审计事件在 `[since, cutoffAt]` 内的动作计数。`since` 缺省为截止前 24 小时。给出 `goalId` 时只计该目标任务的事件。
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

- D1（认领的交接窗口）：认领结果中的 `history` 限定为 16 KiB，每条证据预览 2 KiB。认领已经提交，提交后不能拒绝，所以窗口有界而非完整。`historyComplete` 为假时，表示较早的条目未包含在内，完整历史用 `get_task_history` 分页读取。这与 C2 的“完整或明确失败”措辞不同，请复核。
- D2（准入原子性）：快照准入上限只在单个进程内原子生效（第 4 节）。
- D3（运行时）：证据覆盖 Bun 1.3.11 与部署运行时 Bun 1.4.2，见第 9 节。

## 7. 回滚隔离（RB01）

新版新增的持久状态，以及旧版（SYS01 之前）对它们的表现：

| 新增状态 | 写入方 | 旧版表现 |
|---|---|---|
| `company_meta:cursor_key`（一条随机密钥） | 新版首次分页时创建 | 旧版不读取，忽略 |
| `query_snapshot`、`query_snapshot_row`（schema 021，只新增表） | 新版分页读取时创建，6 小时后由新版 sweep 删除 | 旧版不读取，忽略 |
| 游标（只在响应中，不持久化） | 新版 | 旧版忽略 `pageSize` 与 `cursor`，返回旧的全量形态（可能超预算，但不误派工） |
| 无新的任务状态，无新的 audit 或 outbox 动作 | — | 任务与历史按旧语义读取，调度与认领不受影响 |
| 工具 `get_admin_summary`、`read_task_text` | — | 旧版返回 `unknown_tool` |

隔离 fork 演练（`tests/rollback-isolation.fork.test.ts`，8 项）：同一夹具分别写入两个隔离命名空间。A 只有旧版，B 先由新版写入（分页、汇总、工作树读取，以及快照过期清理）。两边都运行 `8d03d35` 的调度器与旧版客户端若干轮。旧版源码取自 `git archive 8d03d35`。

断言：

- A 与 B 的派工结果一致。
- 受保护任务（等待中、owner 关口、持有中、终态、void）未被派工，版本号不变。
- gm 关口任务不被认领，只产生 gm-attention 通知。
- `cursor_key` 只在 B 出现，回滚运行不改动它。
- 快照表在回滚运行前后不变。
- 旧版读取新数据得到旧形态，新工具返回 `unknown_tool`。

阳性对照：旧版调度器认领了就绪任务（零误派工断言之外的正向检查）。

红灯对照（误派工突变）：把等待中的任务改为 `ready` 并清空依赖，零误派工断言失败，结果为 7 通过、1 失败（终态树，`rework7-red-rb01-misdispatch-mutant.log`，退出码 1）。

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
| RB01 | 第 7 节 | 隔离 fork 8 项；误派工红灯 7 通过、1 失败 |

## 9. 验证结果

本节为最终门禁结果。运行时：本机 Bun 1.3.11；部署运行时 Bun 1.4.2（`runtime-bun`，`bun --version` 实测为 1.4.2）。代码与测试在门禁运行后未改动（以文件时间核对），之后只改文档；测试不读取文档。日志位于任务证据目录（`rework6-*`、`rework7-*`）。

### 9.1 门禁

| 门禁 | 命令 | Bun 1.3.11 | Bun 1.4.2 |
|---|---|---|---|
| 工具链 | `sh plugin/scripts/vendor.sh`；`pnpm typecheck`；`pnpm -C plugin typecheck` | exit 0 | — |
| 单元（响应预算） | `bun test tests/response-budget.test.ts` | 17 pass / 0 fail | 17 pass / 0 fail |
| 公司 fork 默认清单（27 文件） | `bun scripts/test-worktrees.ts` | 256 pass / 0 fail | 256 pass / 0 fail |
| 公司 fork 分页与 RB01 | `bun scripts/test-worktrees.ts tests/query-paging.integration.test.ts tests/rollback-isolation.fork.test.ts` | 包含在默认清单内 | 52 pass / 0 fail（分页 44 + RB01 8） |
| 桥接（11 文件，269 项） | `pnpm test:bridge` | 246 pass / 23 skip / 0 fail | — |
| 服务 | `pnpm test:service` | 12 pass / 0 fail | — |
| 通道（9 文件，81 项） | `pnpm test:channel` | 80 pass / 1 skip / 0 fail | — |
| 通信（3 文件，9 项） | `pnpm test:comm` | 8 pass / 1 skip / 0 fail | — |
| 慢管道（新客户端绿，旧客户端红） | `SCK_COMM_CONTROL=1 bun test tests/comm-slow-pipe.test.ts` | 2 pass / 0 fail | 2 pass / 0 fail |
| 内部 AI 证明（公司 fork） | `RUN_COMPANY_PROOF_FORK_TESTS=1 bun test tests/internal-ai-proof.fork.test.ts` | 23 pass / 0 fail | — |

### 9.2 跳过项

- 桥接 23 项来自 `tests/internal-ai-proof.fork.test.ts`，由 `RUN_COMPANY_PROOF_FORK_TESTS=1` 门控。以该开关单独运行，23 项全部通过。
- 通道 1 项是 `tests/dispatcher-sidecar.fork.test.ts` 的「restart quarantine」，由 `RUN_SCK_CHANNEL_FORK_TESTS=1` 门控。公司 fork 默认清单设置了该变量，并在其中通过（即本次修复的重启用例）。
- 通信 1 项是慢管道红灯对照，由 `SCK_COMM_CONTROL=1` 门控。以该变量运行时两项全部通过（见 9.4）。

以上跳过项都不遮盖本次必测项。

### 9.3 AC03 与 AC05 数字

- AC03 通道字节（真实 sidecar、comm 客户端、公司 fork，881 条工作集）：Bun 1.3.11 为 `{"tasks":881,"pages":29,"maxPageBytes":48976,"refusedLegacyBytes":262,"longDetailBytes":545,"budgetBytes":49152}`；Bun 1.4.2 默认清单为 `{"tasks":881,"pages":27,"maxPageBytes":48937,"refusedLegacyBytes":262,"longDetailBytes":545,"budgetBytes":49152}`。
- AC05 资源（881 条，pageSize 25，38 页）：Bun 1.3.11 每页最大 48945 字节，页耗时 p50 2 ms、最大 275 ms，堆基线 51.5 MiB、峰值 51.5 MiB、GC 后 31.7 MiB，峰值增量上界 0 MiB。Bun 1.4.2 每页最大 48954 字节，页耗时 p50 2 ms、最大 273 ms，堆基线 18.5 MiB、峰值 28.5 MiB、GC 后 18.5 MiB，峰值增量上界 9.9 MiB。
- 另有一组 Bun 1.4.2 数字：单独运行分页与 RB01 文件（`rework6-rt142-fork-query-paging-rb01.log`）时，AC05 每页最大 48945 字节，页耗时 p50 2 ms、最大 249 ms，堆基线 6 MiB、峰值 16.1 MiB、GC 后 6 MiB、峰值增量上界 10.1 MiB；AC03 每页最大 49003 字节，页数 29。
- 堆基线随同一进程内先前运行的用例而变（三次运行分别为 51.5、18.5、6 MiB），因此只把上界当作测得值，不代表恒定内存。
- 资源用例在状态迁移与归属变更用例之后运行，工作集已是 881 条。全量遍历（不少于 1000 条）由「a paged traversal yields every working-set task exactly once」覆盖。

### 9.4 慢管道与红灯对照

- 新客户端（`src/mcp/client-cli.ts`）：期望 1082845 字节，收到 1082845 字节，退出码 0，绿灯。两种运行时结果相同。
- 旧客户端（`8d03d35`）：期望 1082845 字节，收到 65536 字节，退出码 0，JSON 解析失败，红灯。
- 误派工突变（RB01）：7 pass / 1 fail，零误派工断言失败，退出码 1，符合预期。
- 回显突变（写回显不受预算限制）：42 pass / 2 fail，两项写回显用例失败，退出码 1，符合预期。

### 9.5 RB01 回滚隔离

隔离 fork 上 8 项全部通过：旧版发布树（`8d03d35`）读取新版数据，决策与无新版写入时一致；零误派工；`company_meta:cursor_key` 只在新版命名空间出现，回滚运行不改动它；快照表在回滚运行前后不变；过期快照由新版 sweep 删除；旧版忽略分页参数，新工具返回 `unknown_tool`。阳性对照（旧版认领就绪任务）同样通过。

### 9.6 未验证与限制

- 真实 Paseo 员工会话在 RB01 中为桩。真实 sidecar 与 sck 包装器的端到端，部署后由 QA `6b6cb5b9` 以真实员工 sck 完成（包装器当前执行部署版）。
- 独立 QA（真实员工 sck 的全量读取、拒绝用例、分段 hash）尚未执行，本实现不声称已完成。
- 发布前须核对实际 main 的包含关系（`8d03d35` 与 `f42d99b`），确认回滚目标包含所需修复。
- 本次未部署，未调用 `ops_*`，未读取凭证。
