# 本机公司任务 MCP 接入准备（#29，2026-09-26）

范围：供 [核心 #24](https://github.com/MainListActivity/surreal-ck-operations/issues/24) 冻结接口及 [适配器 #25](https://github.com/MainListActivity/surreal-ck-operations/issues/25) 开工使用。#25 须在 #24 由 ai-01 独立验收通过、gm 解锁后实施。本文件是接入核实与接口建议，不表示核心、适配器、数据库或正式端到端已完成。#23 的本机边界是 127.0.0.1、独立 operations 仓库与新 NS/DB；无外部公开访问/OAuth。

## 官方 SDK 与实测结论

2026-09-26 查询 npm registry：`@modelcontextprotocol/server`、`@modelcontextprotocol/client`、`@modelcontextprotocol/core` 的 latest 均为 `2.1.0`，包元数据 `engines.node >=20`；旧单包 `@modelcontextprotocol/sdk` 的 latest 为 `1.30.1`、`engines.node >=18`。新项目建议选定拆分包的**精确同版本** 2.1.0，用 pnpm 锁定，不混用旧单包的 `@modelcontextprotocol/sdk/server/mcp.js` 导入。v2 服务端使用 `McpServer`、`createMcpHandler`；客户端使用 `Client`、`StreamableHTTPClientTransport`。官方 v2 文档示例支持 Web `Request`/`Response` 和 Bun；Node engine 字段本身不证明 Bun 兼容，以下仅证明实测路径。

在独立 `/tmp/sck-mcp-sdk-ai-29` 中用 `pnpm add @modelcontextprotocol/server@2.1.0 @modelcontextprotocol/client@2.1.0 zod@4` 安装（退出 0；实装 zod 4.6.5）；`bun --version` = 1.3.11、`pnpm --version` = 10.32.1。两个独立临时脚本通过 `rtk proxy bun run smoke.ts` 和 `rtk proxy bun run auth-smoke.ts` 运行，均退出 0：

- Bun.serve `hostname:'127.0.0.1', port:0`，`handler.fetch(request)` 真实 HTTP：`Client.connect(new StreamableHTTPClientTransport(url))` 完成 2025 系 initialize，`client.listTools()` 返回注册的 `echo`，`client.callTool({name:'echo',arguments:{text:'ok'}})` 返回 `ok`。
- 独立静态测试值的 Bearer 验证：无 token/错 token 为 401，非法 Host/Origin 各为 403；通过 `handler.fetch(request,{authInfo:{token,clientId:'ai-01',scopes:[]}})` 后，tool callback 读取 `ctx.http?.authInfo?.clientId` 返回 `ai-01`；模拟撤销后下一次 tools/call 被 401 拒绝。初次测试错用无 inputSchema 工具的双参数 callback，得到 tool 内错误；按已安装 2.1.0 类型声明修正为单参数 callback 后复测通过。这是参数形态陷阱，#25 应用 TypeScript 检查固定。
- 上述为 SDK/Bun 接线探针，未使用实际员工密钥、产品数据库或 GitHub；未证实产品服务真实启动、持久租约、任意 MCP 客户端互操作性或跨进程恢复。临时脚本未作为产品实现提交。

## #25 HTTP 与员工客户端建议

使用一个 `/mcp` Streamable HTTP endpoint。Bun 原生 `fetch` 上先限定 URL/method，**每次**请求（包括 initialize、POST、GET/DELETE）先做 Host 和 Origin 校验，再验证 `Authorization: Bearer <员工独立凭证>`，之后才调用 `handler.fetch(request,{authInfo})`。进程只绑定 `127.0.0.1`；Host 只接受 `127.0.0.1`（是否允许 `localhost` 要作为显式配置/测试），Origin 缺失可供本机非浏览器 client，通过不受信 Origin 应返回 403。官方 `hostHeaderValidationResponse`、`originValidationResponse` 是便于 Bun 复用的辅助函数；`createMcpHandler` 本身不鉴权、不校验 Host/Origin。不要仅依赖 CORS、监听地址或 MCP session ID 作为员工身份。每个请求重验凭证撤销与角色；凭证只保存在本机受控存储/环境，不进 URL、工具参数、日志或 Issue。Paseo `agent_id` 是归因信息而不是密钥。生产凭证配置方式由 #24 核心冻结，不在此创建或读取。

若 #24 决定 MCP 层无会话状态，`createMcpHandler` 的请求工厂每次新建 server，工具 handler 通过 `ctx.http.authInfo` 获取验证后的调用者，再交给核心；不能在模块级共享 mutable actor。业务租约必须由持久核心维护，不由 MCP Session-Id 表示。若要有状态 HTTP session，请 #25 先核对所选 2.1.0 的 API 与生命周期；不得把 2026 文档的 `server/discover` 当作已验收的 2025 initialize。首次交付明确 pin 2025 系握手并记录 negotiated protocol version，后续若启用 2026 系另做互操作验证。

SDK 客户端验证步骤：

1. 使用独立员工凭证创建 `StreamableHTTPClientTransport(new URL('http://127.0.0.1:<port>/mcp'), {authProvider:{token: async () => credential}})`；`Client({name,version})` 的 `connect()` 执行 initialize。无需手写 JSON-RPC 或把凭证写进 tools/call 参数。
2. `client.listTools()` 检查 `get_context`、`claim_next`、`heartbeat`、`submit`、`report_blocker`、`review`，以及按授权可见的管理工具；`client.callTool` 返回结构化结果，禁止仅 curl 健康检查冒充 MCP 完成。
3. 测两位已有 AI 员工分别凭各自客户端调用：A 领取/提交、B 独立验收；同岗员工可取不同任务。另测缺 token、错 token、撤销、改伪 agent_id、非法 Host/Origin、自验、旧租约、重复 submit 与网络重试。结束时 `client.close()`；若服务端发 session ID，客户端处理关闭。

## 建议 #24 冻结的核心接口（建议，不是已实现 API）

核心入口只接受**认证中间件解析出的** `Actor {employeeId, role, credentialId, active}`，不接受 tool payload 指定执行人或岗位。任意输出均有 `contractVersion`、`taskId`、`taskVersion`、服务端 `now`；敏感字段脱敏。建议最小操作与输入输出如下：

| 操作 | 必要输入 | 成功输出/作用 |
|---|---|---|
| `get_context` | 可选 taskId | 当前员工、可领 ready/review 任务及依赖摘要；review 排除 `submittedBy` 为本人 |
| `claim_next` | 可选 taskId、`requestId` | 原子选择本岗任务；`deliveryId`、不可猜的 lease/fencing 值、`leaseExpiresAt`、`taskVersion`、任务上下文 |
| `heartbeat` | `taskId`、`deliveryId`、lease/fencing 值、`requestId` | 核心时间续租后的 `leaseExpiresAt` 与版本；旧 holder/过期租约拒绝 |
| `submit` | `taskId`、`deliveryId`、lease/fencing 值、`expectedVersion`、`requestId`、结构化交付正文 | 持久交付 ID、状态 review、审计 ID/outbox ID；同一 idempotency key 同 payload 重放同结果 |
| `report_blocker` | 同上、`to`、说明与恢复点 | blocked 状态、责任岗位、版本及 outbox ID |
| `review` | review `deliveryId`、`expectedVersion`、`requestId`、accept/return、验收正文 | 验收事件、状态、解锁候选、版本及 outbox ID；不能自验 |
| 管理操作 | 经独立管理员能力校验的参数 | 任务/员工创建或授权变更及审计；普通 MCP 员工不可自授角色 |

核心要明确 `claim_next` 是“指定 ID 或按队列优先级自动领取”还是两个方法，并规定同岗并发、review 排除本人、租约到期恢复和重复领取返回值。`requestId` 为调用方每个逻辑动作产生的 UUID；同 key 不同 payload 应是明确冲突，而非执行第二次。`expectedVersion` 防止旧读后写；`deliveryId` + lease/fence 绑定本次领取；心跳不能复活已过期执行。服务器时间为准。核心对状态变更与审计/outbox 同一事务提交；GitHub 只投影该服务新任务，不双写原 v2 queue 任务。tool 层仅把核心结果映射为 MCP `structuredContent`/简短文本，绝不替代核心验权与原子性。

建议冻结错误码集合和 HTTP/MCP 映射：`UNAUTHENTICATED`（HTTP 401，进入 MCP 前）、`FORBIDDEN`（403）、`NOT_FOUND`、`INVALID_INPUT`、`DEPENDENCY_BLOCKED`、`ALREADY_CLAIMED`、`LEASE_EXPIRED`、`FENCE_MISMATCH`、`VERSION_CONFLICT`、`SELF_REVIEW`、`IDEMPOTENCY_CONFLICT`、`TEMPORARILY_UNAVAILABLE`。业务拒绝以结构化稳定 code、可重试标记和当前 taskVersion/lease 状态返回；不把 secret、SQL、原始数据库错误装进 tool 文本。网络超时后客户端应以同 `requestId` 重试并可读回交付结果，不能盲目生成新键。`tools/list` 可对所有认证员工列出一般工具，调用时由核心再核验；管理员工具的可见性和执行权限分别检验。

待 #24 在原 Issue 明确：核心 TypeScript export 路径/包名、Actor 结构及凭证校验入口、业务 DTO 精确字段、错误枚举、时间与 lease/fencing 单位、`requestId` 作用域与结果查询、事务/outbox 读取契约、只读任务投影字段、版本化 schema、测试数据库与启动命令。冻结前 #25 不复制/修改 eng-01 核心文件。

## 主要来源

- 官方 TypeScript SDK 拆分包与 v1/v2 差异：https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/packages.md
- 官方 HTTP/Bun handler、authInfo 与 Host/Origin：https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md 和 https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md
- 官方客户端 connect：https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md
- MCP 2025-11-25 Streamable HTTP、Origin、session 与 protocol header 规范：https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- 2026/2025 握手差异：https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md
- npm registry：`pnpm view @modelcontextprotocol/server version engines --json` 与同法检查 client、旧 sdk（2026-09-26）
