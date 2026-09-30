# VER01 生产独立验收 · accept（qa-devin-745198）

任务：d6f76d02-f020-4f69-877c-8bb7b5e395c5。测试时间：2026-09-30 00:24–00:40 UTC。测试人：qa-devin-745198（独立复核，未沿用前任结论）。

## 版本核对

- 待验提交链：PR #52 seam `79e0d23` → PR #58 contextSnapshot 修复 `aeedef3` → PR #60 resume 终态修复 `d2d5c0b`。
- 发布链（独立 gh run list/view）：Deploy production d2d5c0b SUCCESS run 36649418599（00:15:20Z）；其后另一交付链 PR #54 `9d541988` 于 00:33:35Z SUCCESS（run 36650920701）。`git merge-base` 独立核实 d2d5c0b 是 9d541988 祖先，当前生产包含全部本票提交。
- /health：00:24Z uptime≈493s 对得上 d2d5c0b 重启；00:38Z uptime≈226s 对得上 9d541988 重启。两次进程上均做了关键复测（见下），不凭 uptime 推断版本。
- 本票核心复测（重复 resume 终态重投）先后在 d2d5c0b 进程（00:30Z）和 9d541988 进程（00:40Z）各跑一遍，均通过。

## v23 退回项复测（PR #60 修复点）——通过

入口 `POST /api/chat/runs/:runId/resume`，账号 sck-lca03-a-member（participant, ws_26d695c309e5）。

1. 00:26:42Z `POST /api/chat` composerMode=resource-search，不存在关键词 `VER01_QA_20260930_ZZ99` → run `9cede2dc-20a3-4c7a-8933-9159123f75d8`；stream 收到 progress:routing → agent-step → `suspend:manual-research`（research_session:qp9dii17gt79eftyrrjj）。
2. 提交 `candidate-cancelled` → 00:28:43Z 收到 `done`（finalText「我没有生成有效回复。」），WS 1000。
3. 等待 85s（越过 CHAT_STREAM_TERMINAL_RETENTION_MS=60s、registry TTL 5min 内）。
4. 00:30:09Z 相同 decision 再次 resume → HTTP 200 + 新 streamToken；WS 立即收到 `done`（finalText 与持久化一致）→ 1000。**修复通过**：不再是只有 ping。
5. 9d541988 进程复验：00:38:54Z A admin 导航 run `8f3db6a6-1893-4324-9b21-623e9e46b39e` done → 70s 后 resume → HTTP 200 → WS 仅收 `done`（finalText 相同）→ 1000。

## Router 零回归 —— 通过

- A admin `POST /api/chat` 缺省 contextSnapshot（`帮我打开名为未命名工作簿的工作簿`）→ run `ee4c24fe`：progress:routing → progress:agent-step:navigationAgent → 47×chunk → done（定位到 workbook:eb65071e2a90ac0c）→ WS 1000。
- contextSnapshot={} → HTTP 400 `chat-context-invalid`（启动前 fail-fast，details 含字段错误）。
- resource-search suspend→resume→done 全链（上节）。

## 权限与负路径 —— 通过

- 不存在 runId resume → 403 `chat-run-forbidden`。
- 错误 streamToken → WS close 1008 `stream-forbidden`，无数据。
- member 对 admin 的 run 提交合法 decision → 403 `chat-run-forbidden`（不泄漏存在性）。
- 无 Authorization → 401。
- 新签发 token 认证矩阵（全部本轮新登录 + switch-workspace）：A admin `ws_26d695c309e5/admin` RL=["Owner"] → authenticate 成功、workbook 查询返回 eb65071e2a90ac0c；A participant `ws_26d695c309e5/participant` → resource-search run 正常；B admin `ws_fdc9ddd0e47a/admin` → authenticate 成功、workbook 空；B participant（A member 账号在 B 库）`ws_fdc9ddd0e47a/participant` → authenticate 成功、查询可读。
- 并发隔离：A admin ∥ B admin 同时 POST 相同导航文本（A run `2d4b6ffe` / B run `a79a236a`）→ 均 done；A 找到 A 库 workbook:eb65071e2a90ac0c，B 报告找不到 —— 互不串台。

## 原验收条款逐项

1. **所有 tool 只经共享执行上下文取会话**：PR #52 diff 独立核对——4 个 tool 模块（navigation/dashboard/claim-analysis/resource）改为从 `execution-context.ts` 导入 `getSurrealSession`，旧 `tool-session.ts` 删除；生产 nav/resource 链路 tool 以调用者会话取到正确数据。**通过**。
2. **缺会话 fail-closed、无 root/兜底**：源码 `getSurrealSession` 缺会话直接抛错且注释明确无 root/service 兜底；本地独立跑 seam 相关测试 26 pass（worktree 3cf32f4）。生产无注入缺会话的入口，注入本身**未验证**（结构性不可测）。**按证据记为通过（源码+测试）**。
3. **并发 run 不同会话不串台**：生产 A/B admin 并发实测（上文）+ 前任 v23 已验的研究 session 分库归因。**通过**。
4. **最小 employee run 经同一 seam 用 employee session 调只读 tool**：生产尚无 employee Mastra run 入口（claims-risk dispatcher 用直连 store，不经 seam）；seam 本身身份无关（`MastraExecutionContext.surrealSession: Surreal`），execution-context 单测以替身会话验证注入。真实 employee 生产 run **未验证**（该能力在 virtual-office 后续簇才接线），不冒充通过。
5. **现有 Router/tool session/暂停恢复/归因测试保持通过**：CI Quality gate（d2d5c0b、9d541988）SUCCESS；本地独立执行 execution-context/chat-service 等 26 用例 0 fail；生产 suspend→cancel→done、重复 resume 重投、负路径均通过。**通过**。

## content_reader（前任 block 的认证面补充）

- `POST /api/session/content-reader` 门禁链是活的：假 publicId → 403 `content-reader-content_not_published`（到达事实查询后 fail-closed）；客户端塞 `ac` 越权字段 → 400 `content-reader-client_authority_rejected`。
- 真实 content_reader token 对 platform_content authenticate **未验证**：测试工作区无已知已发布 contentPublicId（entitlement projectionStatus=pending_delivery，SCK-LCA-03 内容入口未上线），拿不到签发输入。

## 观察到的瞬时异常（不判为本票问题）

- 00:34:11Z 并发 `switch-workspace`（两用户并行）一次返回 500 `internal`；串行重试即成功，同用例随后并发 /api/chat 正常。/api/auth/token 一次 502。与已知 IdP 延迟问题（任务 8c2eff55 在办）吻合；两条链路均不在本票改动范围，且重试即恢复，不计入验收结论。

## 边界与未验证

- 5min registry TTL 之后 resume → 403 的边界未单独计时复测（工程已声明为已知边界；ghost-runId 的 403 路径已验）。
- 未修改产品代码、生产既有业务数据、schema 或基础设施；仅新增一个 research_session 测试夹具（research_session:qp9dii17gt79eftyrrjj）与本去敏报告。
