# 公司任务 MCP 适配器（#25）

本实现使用 `@modelcontextprotocol/server`/`client` 2.1.0，Bun 的 Web `Request`/`Response` 适配一个 `/mcp` Streamable HTTP 端点。业务状态、员工身份与租约均由 #24 `CompanyCore` 持有。适配器不执行任务正文中的命令，也不管理 SurrealDB root 或自建外部 agent。

## 认证与传输

服务仅绑定 `127.0.0.1`。每次 HTTP 请求先校验 Host、Origin 与 `Authorization: Bearer <opaque credential>`，随后调用 `core.authenticate`；凭证被撤销后下次请求被拒绝。Paseo 会话 ID、MCP Session-Id 和工具入参均不作为身份。无效 Host/Origin 返回 403，无凭证或无效凭证返回 401。运营人员应将员工凭证放在受控的本机环境或权限为 0600 的文件中；不写入仓库、URL、日志或 Issue。MCP 工具仅拿认证后同一请求的凭证，再由核心执行业务授权。

工具：`get_context`、`claim_next`、`heartbeat`、`checkpoint`、`submit`、`report_blocker`、`review`、`create_task`、`resume_task`。`claim_next` 无 ID 时先考虑本人可验的 review，再考虑本岗位 ready；数据库内并发裁决仍以核心 `claim` 为准。`create_task` 与 `resume_task` 即使出现在工具列表，也只能由核心的 manage 权限执行。员工 enroll/revoke 遵循 #24 冻结契约 `EnrollmentAdmin`，由本机受控管理命令处理，不向普通 MCP tool 暴露。

CLI 客户端使用 `SCK_MCP_URL=http://127.0.0.1:<port>/mcp` 和 `SCK_EMPLOYEE_CREDENTIAL`，执行 `pnpm run mcp:client -- list` 或 `pnpm run mcp:client -- call get_context '{}'`。客户端通过官方 `Client.connect` 初始化并使用 `listTools`/`callTool`；可用于已有员工真实领取、提交与独立验收。运行命令时不要在命令行参数或 shell 历史中直接写凭证。

## GitHub 投影

GitHub 仅作为**本服务新建任务**的看板。投影器从核心持久 outbox 读取事件，先查询带 `sck-company-task` marker 的现有 Issue，再新建；每个事件评论有 `sck-company-outbox` marker。完成标记保存在 `.runtime` 下的本地文件；进程在 GitHub 写入后、标记前崩溃，重启时通过 Issue/评论 marker 去重。失败不会标为完成，下一轮重试。投影只写任务 ID、标题、状态、岗位、版本、依赖与事件类型/时间；任务 context、事件 payload 和员工凭证不进入 GitHub。任务完成时关闭相应 Issue。

投影仅由具 manage 能力的凭证运行，`gh` 使用本机现有登录。投影器通过 `Bun.spawn(['gh', ...args])` 调用，不执行 shell，也不把任务文本插入命令。旧 v2 工单没有本服务 marker 且不在新库 outbox，不能被该投影器接管或覆盖。当前核心分页契约待 #24 最终交接；若扫描触及 1000 条上限，投影器显式停止，避免静默漏事件。

## 验证范围

适配器自身测试以真实官方 SDK 和 Bun loopback HTTP 验证 initialize、tools/list、tools/call，以及无/错/撤销凭证和 Host/Origin 拒绝；投影测试验证失败重试、失去本地状态后的 Issue/评论去重。以上测试使用合成核心，不构成真实数据库或 GitHub 的最终验收。#24 最终交接后须在真实目标库运行员工领取→提交→另一员工验收，通过本地 `gh` 验证新任务投影与重启重试，再提交 #25 给 eng-01 独立复核。

官方依据：[SDK 包结构](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/packages.md)、[Web 标准 HTTP 入口与鉴权](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md)、[客户端连接](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md)、[Streamable HTTP 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。
