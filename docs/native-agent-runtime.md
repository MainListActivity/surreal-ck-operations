# 公司执行模块与原生 agent

0.8.0 已融合 main 的 0.7.1：保留节点自动升级、云端公司库直连，以及删除本机库和 MCP 的行为。共享模块从宿主注入发行版本戳，不依赖插件目录。

## 模块与兼容策略

`src/runner/` 是公司执行模块。公司初始化、派工循环、sidecar、环境清理和回合收尾不再依赖 Paseo SDK，也不导入插件目录。`plugin/server/` 保留兼容入口，通过 vendor 构建取得同一份实现；Paseo 生命周期事件继续驱动同一套业务。默认安装仍使用 Paseo，不会自动把正在执行的会话切换到原生 CLI。

公司插件不再注册页面、侧边栏、命令中心或会话面板。老板日常使用现有 `owner-end/` 网页。旧 UI 源码暂留作后续页面重设计参考，不在客户端入口中加载。

`AgentRuntime` 是派工器的执行接口。Paseo CLI 与 `NativeRuntime` 实现它。为兼容存量数据库，员工上的 `paseo_agent_id` 暂作为执行器会话引用字段：原生引用以 `native:<节点>:<UUID>` 命名。真正的 provider session ID 只存在节点私有 `sessions.json`，不会把 Paseo ID 当作原生 ID。无需立即迁移所有历史记录。

原生模式每轮启动一个进程：

- Factory：`droid exec --output-format json`，下一轮 `--session-id`。
- Claude：`claude -p --output-format json`，下一轮 `--resume`。
- Codex：`codex exec --json`，下一轮 `codex exec resume <ID> --json`。

prompt 通过 stdin 传递，参数用数组，不经 shell 拼接，不使用 ACP。第一版 Factory/Claude 在回合结束后读 JSON；不提供逐 token 的网页聊天流。进程退出、正式终态和公司 submit/review 分别判断。退出码 0 且终态成功只表示本轮 agent 结束，不能代替任务验收。

派工先创建执行器记录，再完成员工与 sidecar 绑定，最后 activate 首轮。无有效会话 ID 的失败回合不会假装续跑。未知状态、运行中或已归档会话拒绝重复发送。

## 节点与切换

员工新增 `runner_id`（employee 是 schemaless）。节点只读取自己拥有的员工和在途任务；空闲任务仍通过原有原子 claim 竞争。节点失联后不会由另一节点直接接管它的原生会话文件。跨节点迁移要先收尾/释放原租约，再依据公司 checkpoint 和代码分支创建新会话。

Paseo 兼容节点默认 ID 为 `paseo:legacy`，接管没有 runner_id 的存量员工。多台 Paseo 节点必须设置不同的 `SCK_RUNNER_ID`，且只有一台设置 `SCK_RUNNER_ADOPT_LEGACY=1`；其他节点设置为 `0`。启用原生节点前，现有 Paseo 节点必须先升级到本实现，否则旧派工器不认识节点归属，可能处理别的节点。

原生节点必须设置唯一、稳定的 `SCK_RUNNER_ID`，只接受字母、数字、下划线和短横线；数据库归属为 `native:<ID>`。每个节点独立保存看板与心跳，网页读取合并后的员工视图。通道位于 `<service home>/native/<ID>/comm`，不与插件共用回收目录。

## 启动配置

这是独立进程入口，不创建 launchd/systemd 定时器，也不会在安装插件时自动启动。

```sh
SCK_RUNNER_ID=mac-native \
SCK_NATIVE_CONFIG=/absolute/private/native-runner.json \
bun run runner:native
```

执行端复用已有公司云端连接和 sck 工具配置。`SCK_NATIVE_CONFIG` 只存启动命令和可用模型列表，不存密钥。只启用已配置 provider 的员工定义；自动模型槽必须有明确 models 列表或已有有效槽位，不能凭空猜测供应商型号。

Mac 配置示意（替换为本机实际绝对路径）：

```json
{
  "commands": {
    "factory-droid": ["/absolute/service-home/sandbox/launch.sh", "/absolute/bin/droid"],
    "claude": ["/absolute/service-home/sandbox/launch.sh", "/absolute/bin/claude"],
    "codex": ["/absolute/service-home/sandbox/launch.sh", "/absolute/bin/codex"]
  },
  "models": {"codex": ["实际可用的模型 ID"]}
}
```

Mac 强制使用 service home 中已安装的 `sandbox/launch.sh` 与 `employee.sb`，启动时缺失就拒绝。Claude 仍由员工 settings 注入直接 Magpie 路由；恢复会话每轮重取 sidecar 通道。公司凭证环境会被清除，provider 原生登录沿用现有配置。

Linux 远程节点必须配置 `isolation: "external"`，commands 指向已提供员工隔离的容器/沙箱启动命令。这里不自动安装 Linux 沙箱、不假装 macOS sandbox-exec 可以在 Linux 使用。仓库路径、云端凭证、sck CLI 和 provider 登录必须已在目标节点配置；当前版本不自动把 Mac 的项目路径映射为远程路径。

## 停止、恢复与回退

SIGINT/SIGTERM 停止派工循环，再停止本执行器拥有的进程组并关闭通道、数据库。子进程不响应 TERM 时升级到 KILL。正常停止不发送业务回合收尾，不借此自动交回或重新分配任务。

节点存储使用排他 `writer.lock`，第二个写者拒绝启动。异常断电留下锁时须先核对锁内 PID、会话文件中的 PID 及目标进程，确认旧执行器及其子进程全部结束后才清理锁；不要直接重复启动。同一会话的原 PID 仍存活时恢复为 unknown，禁止自动重载或重放。会话存储损坏、版本不匹配、节点 ID 不匹配都会拒绝启动。

保留 Paseo 执行适配层是回退手段。回退时先停止新原生节点并处理它的在途任务；不能直接让 Paseo 接管原生 session ID。不要回退到不识别 runner_id 的旧插件并同时保持原生节点运行。

## 验证范围

新增测试使用真实子进程执行可控 fixture，验证首轮绑定、stdin、provider 终态、续跑、重复发送、进程停止、输出上限、重启与单写者。公司 fork 临时数据库测试验证节点归属、看板合并、心跳及既有任务/消息/运维作业竞争认领。

本机真实 Factory、Codex CLI 已通过员工 sandbox 启动，验证首轮、同会话 ID 续跑、上下文保留和自动回到 idle。Codex 对非 Git 工作目录显式传入 `--skip-git-repo-check`；Claude 兼容 verbose 配置产生的 JSON 事件数组，只接受末项正式 result。真实业务派工和远程节点验证仍需单独执行，不能以 CLI 冒烟结果替代。生产默认继续使用 Paseo 执行层，不迁移在途会话。

协议依据：
- Factory：https://docs.factory.com/droid-exec/overview
- Claude：https://code.claude.com/docs/en/headless
- Codex：本机 `codex exec --help` 与 `codex exec resume --help`
