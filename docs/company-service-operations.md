# 本机公司任务服务运维与员工接入（#27）

## 固定版本和边界

本服务从 #24 核心 `7fc39c3`、#25 adapter `5f06b793` 集成，另纳入 [#29 官方 MCP 接入准备](./mcp-integration-preparation.md)和 [#26 QA 验收矩阵](./qa/mcp-company-acceptance.md)。代码发布为独立只读版本目录；运行中的 `active` 链接仅指向已提交、已安装依赖的 release，不指向工程或 QA worktree。服务权威是 SurrealDB 独立 `sck_agent_company/control_plane`；新建任务投影为带 `sck-company-task` marker 的 GitHub Issue。旧 #23—#29 的 v2 票仍由中央 `scripts/queue.py` 管理，不能用新 MCP 修改。

## 私有目录和进程

默认服务目录：`~/Library/Application Support/SurrealCKCompany`，权限 0700。目录结构：`releases/<commit>/` 为固定程序与 pnpm 依赖，`active` 为当前版本链接，`private/service.env` 为 0600 的路径/端口配置，`private/credentials/*.token` 为各员工独立 0600 文件，`private/gh-projection.json` 为 0600 持久投影进度，`logs/` 为仅本人可读日志。root 密码仅由现有产品 `.env` 在进程内加载；日志、Issue、客户端和提交不携带其值。

用户级 launchd label 为 `org.surrealck.company-mcp`。脚本 `scripts/company-service.sh` 安装、启动、停止、重启、查看状态或卸载，仅操作此 label。Plist 位于 `~/Library/LaunchAgents/org.surrealck.company-mcp.plist`，`KeepAlive` 在进程异常退出后重启。停止后不会删除数据库、凭证、日志或发布目录。卸载只去掉本服务 plist 与进程，不动数据。

发布需先固定提交，并在版本目录运行 `rtk proxy pnpm install --frozen-lockfile`；将 `.env.example` 复制到上述 `private/service.env`，填入现有产品 env **路径**、确认空闲端口、GitHub 仓库和私有 GM 凭证**路径**，文件权限 0600。`rtk proxy sh scripts/company-service.sh install '/absolute/release/path'` 安装并立即启动。常用命令（在任意固定版本目录执行）：

```sh
rtk proxy sh scripts/company-service.sh status
rtk proxy sh scripts/company-service.sh restart
rtk proxy sh scripts/company-service.sh stop
rtk proxy sh scripts/company-service.sh start
rtk proxy sh scripts/company-service.sh uninstall
```

`GET http://127.0.0.1:<port>/health` 是进程存活探针；`GET /ready` 检查实际目标库 ownership marker 可读，200 为 ready、503 为不可用。两者仅本机可访问，且同样应用 Host/Origin 检查；MCP `/mcp` 仍须每次 Bearer 鉴权。检查时用 `rtk proxy curl --fail http://127.0.0.1:<port>/ready`，`rtk proxy lsof -nP -iTCP:<port> -sTCP:LISTEN`，`rtk proxy sh scripts/company-service.sh status`。日志在 `logs/stdout.log` 和 `logs/stderr.log`，只记录监听端口、投影数量和不含原始错误的重试消息；不要把完整日志上传到 Issue。启动失败先检查私有配置路径、文件权限、端口占用、现有 SurrealDB 可达性与本机 gh 登录。回滚到前一固定目录：在前一版本运行同一 `install <previous-release>`；卸载如上。

## 员工客户端

实际员工身份由公司库的 `employee` 凭证记录确定。七个独立身份为 `gm-01`(gm)、`product-01`(product)、`eng-01`/`eng-02`(engineering)、`ai-01`(ai-content)、`qa-01`(qa)、`cs-01`(cs)。令 `SCK_MCP_URL=http://127.0.0.1:<port>/mcp` 和 `SCK_EMPLOYEE_CREDENTIAL_FILE=<对应私人路径>`，执行 `rtk proxy pnpm run mcp:client -- list`、`rtk proxy pnpm run mcp:client -- call get_context '{}'`。客户端初始化和调用使用官方 MCP SDK；身份仅由 Bearer 凭证决定，不能在工具参数中伪装。`claim_next` 可传 `{"taskId":"..."}`；返回的 `deliveryId`、`fence`、`task.version` 构成后续 heartbeat/checkpoint/submit 的 proof。提交的 `idempotencyKey` 在网络丢响应重试时保持相同。

首次真实员工接入任务由 GM 管理工具创建，执行岗位 cs、验收岗位 qa。cs-01 必须在**自己的真实会话**用自己的凭证领取、heartbeat、checkpoint、submit；qa-01 在自己的会话领取 review 并 accept/return。工程的合成轮换凭证测试仅证明实现，不替代该交接。回执说明应含实际岗位、允许动作、四个操作的脱敏命令摘要和遇到的问题，不能包含凭证。任务 ID 与各自凭证**路径**交 #28；不要在 Issue 写值。

## QA 对接

按 [#26 B01—B12](./qa/mcp-company-acceptance.md) 独立执行，尤其 B09 重启持久化、B11 非目标库与日志、B12 两位真实员工。#29 的 SDK/Bun 探针属于前期资料，#25 的合成三 token 联调也不等于 B12。QA 应记录本集成提交、`pnpm-lock.yaml` 哈希、URL、目标库、进程状态和脱敏日志路径。当前核心与 adapter 的准确 DTO、错误码、工具参数参见 `src/contracts.ts`、`src/mcp/server.ts` 和 [adapter 文档](./mcp-adapter.md)；本说明不修改已冻结的业务权限与租约语义。
