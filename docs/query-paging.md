# 管理查询的字节预算、分页与完整读取（SYS01）

本文档说明员工与经理通过 sck（sidecar 通道）与 MCP 读取任务、历史、工作树与公司汇总时的契约。实现位于
`src/response-budget.ts`（纯函数：字节预算、UTF-8 切分、游标封装）、`src/query-input.ts`（参数校验）、
`src/core.ts`（分页读取与汇总）、`plugin/server/sidecar.ts`（通道分发与最后一道预算检查）、
`src/mcp/server.ts`（MCP 工具）与 `src/mcp/client-cli.ts`（comm 客户端）。

## 1. 截断层定位（AC01）

复现夹具：1000 条任务，含中文、emoji 与超长 context（每 25 条一条长正文）。响应经 comm 通道写回，由 shell 慢速管道读取：读取者先 `sleep 2` 再读，管道在此期间被写满（`tests/comm-slow-pipe.test.ts`）。

| 客户端 | 期望字节 | 实际字节 | 结果 |
|---|---|---|---|
| 旧版 `8d03d35` | 1 082 845 | 65 536 | JSON 解析失败，退出码 0（红灯） |
| 本次 `src/mcp/client-cli.ts` | 1 082 845 | 1 082 845 | 完整可解析（绿灯） |

截断层是 sck 客户端的 stdout 写出。旧版调用 `process.stdout.write` 后立即 `process.exit`，管道未排空时尚未写出的字节丢失。本次改为同步写完整个 stdout（遇 EAGAIN 重试）后才退出。复核人另用 70 101 与 300 101 字节的假 sidecar 做了同样对照，结论一致（`review-ac01-pipe-experiment.txt`）。

早先以 `Bun.spawn` 读取的复现脚本无法形成红灯（旧版同样完整输出），不作为依据。`sys01-ac01-prefix-truncation-repro.log` 只在开发 Bun 1.3.11 下执行。本文档的证据均在 Bun 1.3.11 下取得；service 运行时的 Bun 版本未取得同批证据，列为未验证。

旧版基线（`8d03d35` 的源码，同一 1000 条任务的夹具，`sys01-ac01-base-measurement.log`）：

| 调用 | 字节数 | 条目数 | 超过 131072 |
|---|---|---|---|
| `get_context`（默认） | 212 642 | 500 | 是 |
| `get_context state=ready` | 212 191 | 500 | 是 |
| `get_task_history` | 483 384 | 31 | 是 |

## 2. 字节预算（AC03）

- 预算按序列化后的 UTF-8 字节计，不按字符串长度计：`RESPONSE_BUDGET_BYTES = 48 KiB`，分页数据块上限为预算减去 1 KiB 余量。
- 分页通过二分查找确定能放入预算的最大条目数（`fitCount`）。每页至少返回一个条目，否则报可恢复的
  `temporarily_unavailable`，绝不返回空页。
- 长文本只做按字节、且不切断字符的预览：列表中 `context` 预览 512 字节（`contextChars`、`contextTruncated`）；单条详情 `context` 预览 16 KiB（`contextBytes`、`contextSha256`、`contextTruncated`）；历史证据预览 2 KiB（`evidenceBytes`、`evidenceSha256`、`evidenceTruncated`）。预览是显式的，不是静默截断。
- 完整原文通过 `read_task_text` 按字节段读取（默认 16 KiB，上限 24 KiB）。段边界落在字符边界上，各段拼接即为原文。
  读取方用 sha256 核对拼接结果。
- 最后一道检查：sidecar 的响应写回（`guardRelayResponse`）与 MCP 的 `toolResult` 都会检查序列化后的字节数。超过预算的成功响应被替换为可恢复的 JSON 错误 `response_too_large`（comm 客户端退出码 1，stdout 为 JSON）。

## 3. 参数、分页与游标（AC02）

| 工具 | 参数 | 返回 | 权限 |
|---|---|---|---|
| `get_context` | `taskId?`、`state?`、`goalId?`、`role?`、`since?`、`pageSize?`（1–100，默认 25）、`cursor?`、`includeCompany?`、`fields?` | `{ principal, company?, tasks, page }` | 员工：自己可见的任务（执行或复核岗位匹配）；gm：全部 |
| `get_task_history` | `taskId`、`pageSize?`（1–100，默认 25）、`cursor?` | `{ history, page }`（页内按时间正序，页序为从新到旧） | 与 `get_task` 相同 |
| `list_worktrees` | `taskId?`、`includeReleased?`、`pageSize?`、`cursor?` | 不带 `pageSize`、`cursor` 时为数组；带其一时为 `{ worktrees, page }`。每项含 `releasedReferences` | 与原规则相同（员工须有 taskId；gm 可全局） |
| `read_task_text` | `taskId`、`field`（`context` 或 `evidence`）、`auditId?`、`offset?`、`limit?` | `{ taskId, field, totalBytes, sha256, offset, bytes, nextOffset, text }` | 与 `get_task` 相同 |
| `get_admin_summary` | `since?`（默认 24 小时）、`goalId?` | `{ cutoffAt, since, goalId?, scope, tasks, audit, outboxSequence, integrity }` | 仅 gm（其他角色 forbidden） |

`page` 包含 `pageSize`、`returned`、`hasMore`、`nextCursor?`、`snapshotAt` 与 `budgetBytes`。

`get_context` 的 `includeCompany` 缺省值取决于调用形态：不带分页参数的旧调用含 `company` 块；带 `pageSize` 或 `cursor` 的调用不含，除非显式传 `includeCompany: true`。

游标是不透明的 `v1.<payload>.<mac>`：payload 为 JSON，mac 为 HMAC-SHA256。密钥只存放在 `company_meta:cursor_key`，
由服务端生成，不返回给调用方。游标绑定以下内容：

- 调用人（`c`）：他人使用的游标返回 `forbidden`；
- 查询条件摘要（`q`，不含 pageSize 与投影）：换了筛选返回 `forbidden`；
- 读取类型（`k`）；
- 有效期 6 小时（`exp`）：过期返回 `invalid`，原因为 expired；
- 篡改、非本服务签发、格式错误：返回 `invalid`（verification 或 malformed）。

一致性语义（已由测试覆盖）：

- 任务列表的快照为首页时刻的数据库时间。之后创建的任务不在本次遍历中（按 `created_at` 排除）。
- 排序键为 `(created_at, id)`，二者都不会因更新而改变，因此遍历中的更新不会造成重复，也不会让仍匹配过滤条件的行缺失。
- 状态过滤在读取时判定。遍历中状态变化、离开过滤集合的行，可能在后续页缺席（待经理裁决，C4）。
  需要完整稳定视图的调用方应当只按 `created_at` 或 `goalId` 过滤。
- 历史按 `(at, id)` 倒序分页，审计行只追加，因此遍历稳定。
- 工作树按路径排序分页。清单本身仍在每次请求时完整计算，只有响应是有界的。
- 汇总先读 `cutoffAt` 与 `outboxSequence`，再读计数。截止时刻之前已提交的变更必定计入；之后的变更可能计入。计数按语句依次读取，不是单一事务快照。
  任务计数（`scope.tasks`）是截止时刻的全表状态；`since` 只限定审计计数（`scope.audit`）（待经理裁决，C5）。`integrity.complete` 仅在每行都归入已知状态且计数与行数一致时为真。

## 4. 兼容性（有意的决定，请复核）

- 不带 `pageSize` 与 `cursor` 的旧调用仍返回旧的键（`get_context` 的 `principal/company/tasks`；`get_task_history` 的
  `history`）。它们的第一页仍受默认 25 条与预算限制，并带有 `page.nextCursor`。旧客户端不识别 `nextCursor`，会看到不完整的列表（待经理裁决，C2）。
- 旧调用读取超过 16 KiB 的 context 时只返回预览（`contextTruncated: true`），全文需改用 `read_task_text`（待经理裁决，C3）。
- `list_worktrees` 不带 `pageSize`、`cursor` 时保持旧的数组形态，每项为紧凑引用（释放的引用只计数）。数组无法携带分页元数据，
  因此超出预算时返回可恢复错误 `response_too_large`，而不是截断。需要分页时带 `pageSize` 或 `cursor`，返回 `{ worktrees, page }`（待经理裁决，C1）。
- `get_context` 的 `company` 块被有界化：goals、directions、projects 按预算裁剪，并给出各自的 `…Total` 计数。
- 没有分页方法的 core（测试替身）回退到原有的单次返回路径。
- comm 客户端的每个结果都在 stdout 输出一行 JSON：成功时为工具返回值（退出码 0）；错误时为
  `{"ok":false,"code":…,"error":…,"retryable":…}`（退出码 1）。`code` 是可恢复的错误类，`retryable` 表示同一调用稍后可能成功；
  原因同时写入 stderr。本地拒绝（参数非法、缺少 `SCK_COMM_KEY`、通道不可写、超时）与远端拒绝使用同一格式。

## 5. 回滚隔离（RB01）

| 新增状态 | 写入方 | 旧版（SYS01 之前）的表现 |
|---|---|---|
| `company_meta:cursor_key`（一条随机密钥） | 新版在首次分页时创建 | 旧版从不读取该记录，忽略它。 |
| 无新的任务状态、无新的 audit/outbox 动作、无 schema 变更 | — | 任务与历史数据按旧语义读取；调度与认领不受影响。 |
| 游标（仅存在于响应中，不持久化） | 新版 | 旧版不识别 `cursor` 与 `pageSize` 参数，忽略它们，返回旧的全量形态（可能超出预算，但不会误派工）。 |
| 汇总与 `read_task_text` 只读 | — | 旧版没有这些工具，调用返回“未知工具”。 |

已验证（只读计数）：`reads add no task, audit or outbox state…` 测试证明，分页、历史、汇总与工作树读取前后，`task`、`audit`、`outbox`
的行数不变，只新增 `company_meta:cursor_key`。

已验证（隔离 fork 演练，`tests/rollback-isolation.fork.test.ts`，7/0，`rb01-rollback-fork-final2.log`；结果 `rb01-rollback-results.json`；默认清单 232/0 亦含本演练，`rework-fork-default-final3.log`）：

- 同一个 8 任务夹具分别写入两个隔离命名空间：A 只有旧版，B 先由新版写入（分页、汇总与工作树读取）。两边都运行 `8d03d35` 的调度器与旧版客户端若干轮。
- 旧版源码取自 `git archive 8d03d35`。一次性核对（未入测试）：其 `src/` 与 `plugin/server/sidecar.ts` 与部署版 release 目录 diff 为空。
- 断言：A 与 B 的派工结果一致；受保护任务（等待中、owner 关口、持有中、终态、void）未被执行派工，版本号不变；gm 关口任务不被认领，只产生 gm-attention 通知；`cursor_key` 只在 B 出现，回滚不触碰它；旧版读取新数据得到旧形态；新工具返回 `unknown_tool`。
- 阳性对照：把一个等待中任务强制改为 `ready` 的变体，零误派工断言失败（`rb01-red-control-misdispatch-final.log`，对最终测试文件的突变副本运行，6 通过 / 1 失败）。证明该断言能抓到误派工。
- 未覆盖：真实 Paseo 员工会话（演练中 Paseo 为桩），以及真实 sidecar 与 sck 包装器（包装器执行部署版 `active` 目录下的客户端）。

## 6. 验证映射

| AC | 服务端位置 | 测试 |
|---|---|---|
| AC01 复现 | 本文第 1 节 | `tests/comm-slow-pipe.test.ts`（绿灯；`SCK_COMM_CONTROL=1` 为旧版红灯对照）；`sys01-ac01-base-measurement.log` |
| AC02 分页与游标 | `core.ts` 的 `contextView`、`historyView`、`worktreePage`；`query-input.ts`；`response-budget.ts` 的 `sealCursor`/`openCursor` | 集成套件：遍历 1000 条、快照、游标绑定与过期、过滤、工作树紧凑化与分页 |
| AC03 传输 | `response-budget.ts` 的 `fitCount`、`guardRelayResponse`、`utf8Prefix`、`utf8Segment`；`sidecar.ts` `handle()`；`mcp/server.ts` `toolResult`；`client-cli.ts` `writeStdout` | 单元套件；集成套件的 relay 回环与超预算拒绝；`tests/comm-client.test.ts`（JSON 错误形态） |
| AC04 汇总 | `core.ts` 的 `adminSummary` | 集成套件：计数与 cutoff、非 gm 拒绝 |
| AC05 证明 | 全部上文位置 | 1000 条夹具、长文本段拼接 sha256、历史证据段拼接 sha256、comm 回环；独立 QA（真实员工 sck）未执行，待部署后 |
| RB01 | 第 5 节 | 只读计数测试（集成）；隔离 fork 演练 `tests/rollback-isolation.fork.test.ts`（7/0）；阳性对照 `rb01-red-control-misdispatch-final.log` |
