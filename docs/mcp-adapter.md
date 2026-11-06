# 公司任务 MCP 适配器（#25）

本实现使用 `@modelcontextprotocol/server`/`client` 2.1.0，Bun 的 Web `Request`/`Response` 适配一个 `/mcp` Streamable HTTP 端点。业务状态、员工身份与租约均由 #24 `CompanyCore` 持有。适配器不执行任务正文中的命令，也不管理 SurrealDB root 或自建外部 agent。

## 认证与传输

服务仅绑定 `127.0.0.1`。每次 HTTP 请求先校验 Host、Origin 与 `Authorization: Bearer <opaque credential>`，随后调用 `core.authenticate`；凭证被撤销后下次请求被拒绝。Paseo 会话 ID、MCP Session-Id 和工具入参均不作为身份。无效 Host/Origin 返回 403，无凭证或无效凭证返回 401。运营人员应将员工凭证放在受控的本机环境或权限为 0600 的文件中；不写入仓库、URL、日志或 Issue。MCP 工具仅拿认证后同一请求的凭证，再由核心执行业务授权。核心 `CompanyError.code` 与 `retryable` 映射到 MCP 错误结构；数据库内部错误不返回给客户端。

工具：`get_context`、`claim_next`、`heartbeat`、`checkpoint`、`submit`、`report_blocker`、`review`、`create_task`、`resume_task`。`claim_next` 无 ID 时先考虑本人可验的 review，再考虑本岗位 ready；数据库内并发裁决仍以核心 `claim` 为准。`create_task` 与 `resume_task` 即使出现在工具列表，也只能由核心的 manage 权限执行。asset 类 `workIntent.paths` 至多 50 条且每条至多 300 字符；上限由核心判定，适配层不截断，超限返回结构化 `invalid` 且不写任务/审计/outbox。员工 enroll/revoke 遵循 #24 冻结契约 `EnrollmentAdmin`，由本机受控管理命令处理，不向普通 MCP tool 暴露。任务链后继用 `parent` 指针：链上前驱未验收的子任务保持 `planned`，在 accept 同事务里激活。

CLI 客户端使用 `SCK_MCP_URL=http://127.0.0.1:<port>/mcp` 和 `SCK_EMPLOYEE_CREDENTIAL_FILE`（仅文件 owner 可读），执行 `pnpm run mcp:client -- list` 或 `pnpm run mcp:client -- call get_context '{}'`。受控环境也可传 `SCK_EMPLOYEE_CREDENTIAL`；若同时提供，文件优先。直连 `call` 只向 stdout 打印一份答案（与通道模式相同）：成功时为返回数据，失败时为一行 `{"ok":false,"code",…}` 并以退出码 1 结束（SYS01 AC03，F1）。客户端通过官方 `Client.connect` 初始化并使用 `listTools`/`callTool`；可用于已有员工真实领取、提交与独立验收。运行命令时不要在命令行参数或 shell 历史中直接写凭证。

任务视图（`get_context`/`get_task` 等）的 blocked 行带 `blockedTo` 事实：等老板关口时 `blockedTo=owner`（`resumeState` 记录恢复阶段，缺失为 `unknown`；复核等待显示原复核岗位）。链上前驱在任务 `parent` 字段。

工具结果形态（SYS01 终版，经理裁定方案 b）：成功时 `content[0].text` 为答案的 JSON 文本（与 SYS01 之前发送的文本相同），`structuredContent` 为 `{ok: true, data}`，两者承载同一份数据。预算按整条结果计：两份副本各自计入字节，另加 256 字节的 JSON-RPC 帧预留（`answerBytes`），整条不超过 49 152 字节（`RESPONSE_BUDGET_BYTES`）。因此一份答案的数据最多占约一半预算，分页条目的上限为 46 769 双份字节（`ITEM_BUDGET_BYTES`，约 45.7 KiB）。超出时结果为 `isError`，`content[0].text` 与 `structuredContent` 都是同一个 `{ok: false, code: "response_too_large", retryable: false, error}` 的 JSON（复核 v47 的 D1：失败文本也是 JSON）。请求 id 的序列化长度超过 128 字节时，HTTP 入口在调用任何工具之前返回 HTTP 400、JSON-RPC 错误 `-32600`、id 为 null（D2）。`sck` 直连、通道与本仓库测试读取 `structuredContent`；只读 `content` 的第三方客户端读到的是与之相同的 JSON 文本。MCP 规范建议同时返回文本副本，本仓库即采用这一形态；方案比较与经理裁定见 `query-paging.md` 第 9.8 节。

启动入口：设置 `SCK_MCP_PORT`（1–65535）并执行 `pnpm run mcp:serve`。进程读取 #24 的 `SCK_PRODUCT_ENV`/数据库配置，连接并 bootstrap 公司库，然后监听本机端口。若同时设置 `SCK_PROJECTOR_CREDENTIAL_FILE`（老板凭证私有文件）和 `SCK_GITHUB_REPOSITORY=owner/repo`，同进程启动 GitHub outbox worker；投影状态默认 `.runtime/gh-projection.json`，可用 `SCK_PROJECTION_STATE_FILE` 指定。缺少配对配置会拒绝启动。SIGINT/SIGTERM 会停止 worker、HTTP 服务并关闭数据库连接。常驻与进程监管属于 #27。

## GitHub 投影

GitHub 仅作为**本服务新建任务**的看板。投影器从核心持久 outbox 读取事件，先查询带 `sck-company-task` marker 的现有 Issue，再新建；每个事件评论有 `sck-company-outbox` marker。完成标记保存在 `.runtime` 下的本地文件；进程在 GitHub 写入后、标记前崩溃，重启时通过 Issue/评论 marker 去重。失败不会标为完成，下一轮重试。投影只写任务 ID、标题、状态、岗位、版本、依赖与事件类型/时间；任务 context、事件 payload 和员工凭证不进入 GitHub。任务完成时关闭相应 Issue。

投影仅由具 manage 能力的凭证运行，`gh` 使用本机现有登录。投影器通过 `Bun.spawn(['gh', ...args])` 调用，不执行 shell，也不把任务文本插入命令。旧 v2 工单没有本服务 marker 且不在新库 outbox，不能被该投影器接管或覆盖。按 #24 最终 `listOutbox(after)` 契约，投影器逐页读取最多 1000 条，以最后事件 ID 继续，核心通过持久全局 sequence 确定页序；每次启动从头扫描并跳过本地已完成事件。`runProjectionWorker` 在进程内反复执行，失败后最多退避 60 秒，并在关闭信号到来时退出。

## 验证范围

适配器单元测试以真实官方 SDK 和 Bun loopback HTTP 验证 initialize、tools/list、tools/call，以及无/错/撤销凭证和 Host/Origin 拒绝；投影测试验证失败重试、失去本地状态后的 Issue/评论去重及 1001 条分页。单元测试的核心和 GitHub 均为替身。

真实联调用 `SCK_LIVE_CREDENTIAL_DIR` 指向 0700 私有目录（含 gm-01、ai-01、eng-01 的 0600 token 文件），设置 `SCK_GITHUB_REPOSITORY` 后执行 `pnpm run test:mcp:live`。该脚本在 `sck_agent_company/control_plane` 新建合成任务并实际写入 GitHub，不在普通 `pnpm run test` 中自动运行。2026-09-27 最终实跑通过：task `f9741fd9-f708-4df9-a5bb-ff15b7a64090`，GitHub [#31](https://github.com/MainListActivity/surreal-ck-operations/issues/31)，6 个 outbox 事件；真实数据库 HTTP 拒绝无凭证、错误凭证及已撤销凭证；SDK 三员工完成领取、心跳、检查点、幂等提交、禁止自验和独立接受。投影重跑为 0 个新增事件；更换本地状态后仍只保留一份 Issue/每事件一条评论，旧 v2 #25 正文完全相同。另以独立 `mcp:serve` 进程在空闲端口 `127.0.0.1:38473` 和 `mcp:client -- list` 实测端口监听与官方工具发现；测试后已停止，常驻与进程监管属于 #27。#25 仍须 eng-01 独立复核；#28 负责整体 QA。

官方依据：[SDK 包结构](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/packages.md)、[Web 标准 HTTP 入口与鉴权](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md)、[客户端连接](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md)、[Streamable HTTP 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。
