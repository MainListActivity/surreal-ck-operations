# 管理查询的字节预算、分页与完整读取（SYS01）

本文档说明员工与经理通过 sck（sidecar 通道）与 MCP 读取任务、历史、工作树与公司汇总时的契约。实现位于
`src/response-budget.ts`（纯函数：字节预算、UTF-8 切分、游标封装）、`src/query-input.ts`（参数校验）、
`src/core.ts`（分页读取与汇总）、`plugin/server/sidecar.ts`（通道分发与最后一道预算检查）、
`src/mcp/server.ts`（MCP 工具）与 `src/mcp/client-cli.ts`（comm 客户端）。

## 1. 截断层定位（AC01）

在 `$SCK_COMM_DIR` 通道上，用真实的 comm 客户端（`src/mcp/client-cli.ts`）与一个只回写响应的 sidecar 替身做复现，
响应为 40 KB、70 KB、140 KB、300 KB 的中文与 emoji 混合 JSON，stdout 在 0 与 1.5 秒后读取，分别在
service 运行时 Bun 1.4.2 与开发 Bun 1.3.11 下执行。结果：四个尺寸、两种读取时机、两种运行时全部完整可解析
（`sys01-ac01-prefix-truncation-repro.log`）。因此 sck 进程、comm 请求/响应文件与 sidecar 写回均不截断。

截断发生在调用方的输出捕获环节（推断，未确认：截断点位于 64 KiB 与 128 KiB 附近，与按 64 KiB 分块的输出捕获相符）。在 Paseo 包内未找到对应的
输出上限常量，这一点只能推断，未做真实终端链路的复现。无论截断位于哪一层，修复都是让每个响应都在 48 KiB 之内，
从而低于两个边界。

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
- 长文本只做按字节、且不切断字符的预览（列表 512 字节，单条详情 16 KiB），并给出 `contextBytes` /
  `evidenceBytes`、`contextSha256` / `evidenceSha256` 与 `…Truncated` 标志。预览是显式的，不是静默截断。
- 完整原文通过 `read_task_text` 按字节段读取（默认 16 KiB，上限 24 KiB）。段边界落在字符边界上，各段拼接即为原文。
  读取方用 sha256 核对拼接结果。
- 最后一道检查：sidecar 的响应写回与 MCP 的 `toolResult` 都会检查序列化后的字节数。超过预算的成功响应被替换为可恢复的
  JSON 错误 `response_too_large`（comm 客户端退出码 1，stdout 为 JSON）。

## 3. 参数、分页与游标（AC02）

| 工具 | 参数 | 返回 | 权限 |
|---|---|---|---|
| `get_context` | `taskId?`、`state?`、`goalId?`、`role?`、`since?`、`pageSize?`（1–100，默认 25）、`cursor?`、`includeCompany?`、`fields?` | `{ principal, company?, tasks, page }` | 员工：自己可见的任务（执行或复核岗位匹配）；gm：全部 |
| `get_task_history` | `taskId`、`pageSize?`、`cursor?` | `{ history, page }`（页内按时间正序，页序为从新到旧） | 与 `get_task` 相同 |
| `list_worktrees` | `taskId?`、`includeReleased?`、`pageSize?`、`cursor?` | `{ worktrees, page }`，每项含 `releasedReferences` | 与原规则相同（员工须有 taskId；gm 可全局） |
| `read_task_text` | `taskId`、`field`（`context` 或 `evidence`）、`auditId?`、`offset?`、`limit?` | `{ totalBytes, sha256, offset, bytes, nextOffset, text }` | 与 `get_task` 相同 |
| `get_admin_summary` | `since?`（默认 24 小时）、`goalId?` | `{ cutoffAt, since, goalId?, tasks, audit, outboxSequence, integrity }` | 仅 gm（其他角色 forbidden） |

`page` 包含 `pageSize`、`returned`、`hasMore`、`nextCursor?`、`snapshotAt` 与 `budgetBytes`。

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
- 状态过滤在读取时判定。遍历中状态变化、离开过滤集合的行，可能在后续页缺席。
  需要完整稳定视图的调用方应当只按 `created_at` 或 `goalId` 过滤。
- 历史按 `(at, id)` 倒序分页，审计行只追加，因此遍历稳定。
- 工作树按路径排序分页。清单本身仍在每次请求时完整计算，只有响应是有界的。
- 汇总先读 `cutoffAt` 与 `outboxSequence`，再读计数。截止时刻之前已提交的变更必定计入；之后的变更可能计入。计数按语句依次读取，不是单一事务快照。

## 4. 兼容性（有意的决定，请复核）

- 不带 `pageSize` 与 `cursor` 的旧调用仍返回旧的键（`get_context` 的 `principal/company/tasks`；`get_task_history` 的
  `history`）。只是返回的第一页受预算限制，并带有 `page.nextCursor`。
- `list_worktrees` 的返回形态由数组变为 `{ worktrees, page }`。数组无法携带分页元数据，若不改形态，超出预算的部分会被静默丢弃，
  这与 AC03 的要求相冲突。这是唯一改变既有返回形态的工具。
- `get_context` 的 `company` 块被有界化：goals、directions、projects 按预算裁剪，并给出各自的 `…Total` 计数。
- 没有分页方法的 core（测试替身）回退到原有的单次返回路径。
- comm 客户端的错误输出保持 stderr 的原因文本，同时在 stdout 上输出 JSON（`{"ok":false,"error":…}`）。

## 5. 回滚隔离（RB01）

| 新增状态 | 写入方 | 旧版（SYS01 之前）的表现 |
|---|---|---|
| `company_meta:cursor_key`（一条随机密钥） | 新版在首次分页时创建 | 旧版从不读取该记录，忽略它。 |
| 无新的任务状态、无新的 audit/outbox 动作、无 schema 变更 | — | 任务与历史数据按旧语义读取；调度与认领不受影响。 |
| 游标（仅存在于响应中，不持久化） | 新版 | 旧版不识别 `cursor` 与 `pageSize` 参数，忽略它们，返回旧的全量形态（可能超出预算，但不会误派工）。 |
| 汇总与 `read_task_text` 只读 | — | 旧版没有这些工具，调用返回“未知工具”。 |

已验证：`reads add no task, audit or outbox state…` 测试证明，分页、历史、汇总与工作树读取前后，`task`、`audit`、`outbox`
的行数不变，只新增 `company_meta:cursor_key`。

未完成：在隔离 fork 中执行完整的“新版写入 → 回滚旧版 → 调度若干轮”演练，并断言零误派工。本轮未执行该演练，列为遗留项。

## 6. 验证映射

| AC | 服务端位置 | 测试 |
|---|---|---|
| AC01 复现 | 本文第 1 节；`sys01-ac01-*.log` | 复现脚本（scratch）与旧版基线（scratch） |
| AC02 分页与游标 | `core.ts` 的 `contextView`、`historyView`、`worktreePage`；`query-input.ts`；`response-budget.ts` 的 `sealCursor`/`openCursor` | 集成套件：遍历 1000 条、快照、游标绑定与过期、过滤、工作树紧凑化与分页 |
| AC03 传输 | `response-budget.ts` 的 `fitCount`、`guardRelayResponse`、`utf8Prefix`、`utf8Segment`；`sidecar.ts` `handle()`；`mcp/server.ts` `toolResult`；`client-cli.ts` `writeStdout` | 单元套件；集成套件的 relay 回环与超预算拒绝 |
| AC04 汇总 | `core.ts` 的 `adminSummary` | 集成套件：计数与 cutoff、非 gm 拒绝 |
| AC05 证明 | 全部上文位置 | 1000 条夹具、长文本段拼接 sha256、历史证据段拼接 sha256、comm 回环 |
| RB01 | 第 5 节 | 集成套件：只新增 cursor_key 的读取测试 |
