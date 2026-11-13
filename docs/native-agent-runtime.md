# 公司执行模块与原生 agent

0.8.0 已融合 main 的 0.7.1：保留节点自动升级、云端公司库直连，以及删除本机库和 MCP 的行为。共享模块从宿主注入发行版本戳，不依赖插件目录。

## 模块与兼容策略

`src/runner/` 是公司执行模块。公司初始化、派工循环、sidecar、环境清理和回合收尾不再依赖 Paseo SDK，也不导入插件目录。`plugin/server/` 保留兼容入口，通过 vendor 构建取得同一份实现；Paseo 生命周期事件继续驱动同一套业务。默认安装仍使用 Paseo，不会自动把正在执行的会话切换到原生 CLI。

公司插件不再注册页面、侧边栏、命令中心或会话面板。老板日常使用现有 `owner-end/` 网页。旧 UI 源码暂留作后续页面重设计参考，不在客户端入口中加载。

`AgentRuntime` 是派工器的执行接口。Paseo CLI 与 `NativeRuntime` 实现它。为兼容存量数据库，员工上的 `paseo_agent_id` 暂作为执行器会话引用字段：原生引用以 `native:<节点>:<UUID>` 命名。真正的 provider session ID 只存在节点私有 `sessions.json`，不会把 Paseo ID 当作原生 ID。无需立即迁移所有历史记录。

原生模式每轮启动一个进程：

- Factory：`droid exec --output-format stream-json`，下一轮 `--session-id`。
- Claude：`claude -p --output-format stream-json --verbose`，下一轮 `--resume`。
- Codex：`codex exec --json`，下一轮 `codex exec resume <ID> --json`。

prompt 通过 stdin 传递，参数用数组，不经 shell 拼接，不使用 ACP。Factory/Claude 逐行读取原生事件；公开文本和工具状态通过既有 30 秒执行端心跳上报，启动和结束时立即尝试上报。老板端以 SurrealDB Live Query 收到变更后刷新，不新增页面轮询。进程退出、正式终态和公司 submit/review 分别判断。退出码 0 且终态成功只表示本轮 agent 结束，不能代替任务验收。

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

独立入口从现有 `private/owner-token` 文件加载建单与迭代推进凭证，并在开始派工前核验老板身份。文件缺失、无效或与公司库身份不符时拒绝启动；不在启动时生成新凭证或改写老板身份。凭证仍从员工子进程环境中清除。

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

节点存储使用排他 `writer.lock`，第二个写者拒绝启动。执行端进程退出后内核写锁自动释放，不删除锁文件。旧格式锁须先核对原进程；会话子进程仍存活时保持 unknown，不接管或重复发送。同一会话的原 PID 仍存活时恢复为 unknown，禁止自动重载或重放。会话存储损坏、版本不匹配、节点 ID 不匹配都会拒绝启动。

保留 Paseo 执行适配层是回退手段。回退时先停止新原生节点并处理它的在途任务；不能直接让 Paseo 接管原生 session ID。不要回退到不识别 runner_id 的旧插件并同时保持原生节点运行。

## 验证范围

新增测试使用真实子进程执行可控 fixture，验证首轮绑定、stdin、provider 终态、续跑、重复发送、进程停止、输出上限、重启与单写者。公司 fork 临时数据库测试验证节点归属、看板合并、心跳及既有任务/消息/运维作业竞争认领。

本机真实 Factory、Codex CLI 已通过员工 sandbox 启动，验证首轮、同会话 ID 续跑、上下文保留和自动回到 idle。Codex 对非 Git 工作目录显式传入 `--skip-git-repo-check`；Claude 兼容 verbose 配置产生的 JSON 事件数组，只接受末项正式 result。真实业务派工和远程节点验证仍需单独执行，不能以 CLI 冒烟结果替代。生产默认继续使用 Paseo 执行层，不迁移在途会话。

协议依据：
- Factory：https://docs.factory.com/droid-exec/overview
- Claude：https://code.claude.com/docs/en/headless
- Codex：本机 `codex exec --help` 与 `codex exec resume --help`

## 0.11.6：明确路由与独立常驻服务

`bun scripts/native-service.ts <节点ID> <配置绝对路径>` 安装 launchd/systemd 常驻服务；`--no-load` 仅生成配置。服务不是定时任务，不依赖 Paseo 进程。安装需要正式发行的 `current` 和现有 `bin/bun-runtime.sh`，不复制凭证。新服务默认待命，安装不会改变派工路由。

切换顺序：先把本节点 Paseo 插件升级到支持路由的版本，再安装/启动原生服务，核对 `native:<节点ID>` 心跳、命令与模型配置，最后原子写入服务目录 `private/runtime-routes.json`：

```json
{"version":1,"routes":{"claude":"native:mac-native","factory-droid":"native:mac-native"}}
```

所有同一物理节点上的运行器读取同一文件。缺失文件保留兼容入口；文件损坏则拒绝新派工。路由指定后，Paseo 既不新建该 provider，也不复用其旧员工会话；无编制引用的旧会话同样受约束。已经运行中的回合保留归属并收尾。节点离线不自动回退，以免重复执行。

原生服务从 `current` 加载发行版本戳。现有心跳发现 `current` 变化后停止接收新工作，待原生进程和本运行器租约排空后退出，由服务管理器重新启动到新版本。状态 unknown 或租约未结束时不会强杀升级。远程 Linux 提供对应 systemd 用户服务生成，但仍需目标机器实际隔离与登录配置及单独验收。

## 进度数据与任务文件

`agent_activity` 按运行器、会话和回合幂等保存最近 40 条公开事件。记录关联实际 `runtime_execution.agent/turn`，不使用员工的 `last_task`。采集不调用模型，不上传推理、工具参数或原始工具输出；公开文本限长并作常见凭证脱敏。工具调用次数和 CLI 成功退出不代表需求验收通过。

保留期为 24 小时。普通记录没有原生 TTL：查询使用 `expires_at > time::now()`，既有执行端心跳每次批量删除最多 200 条过期记录。节点都离线时不承诺立即物理删除；读取时仍排除过期数据。`CHANGEFEED` 和 fork 的 Live Query retention 只清理其内部日志，不能代替业务记录删除。依据：[官方记录过期说明](https://surrealdb.com/docs/learn/schema-management/events-and-triggers/reactive-patterns#records-that-expire)，公司 fork `1171dd0` 的 `core/src/cf/gc.rs`、`core/src/lq/gc.rs`。

老板端候选消息展示按当前任务生成的 `task.md` 预览。派工后保存与实际写文件同源的 `task.md`、`notes.md`、返工意见快照，并绑定 delivery/fence；旧任务快照不会冒充新派工内容。预览不宣称包含 provider 自身系统提示词或所有历史上下文。此版本没有改变业务结果契约，复核结论解析仍沿用原有逻辑。

大屏默认展示员工、当前任务、项目、电脑、本阶段已用时间和预计剩余时间，公开输出在卡片内自动跟随最新内容；上翻查看历史时暂停跟随。核心信息不依赖点击、悬停或弹窗。长任务资料在原页面展开，最近事件也直接在页面滚动查看。

预计时间取最近 30 天同项目、岗位、阶段和任务类型的成功历史，最多 40 个不同任务，至少 5 个样本，显示历史用时的四分位范围扣除已用时间。只配对未被阻塞、退回或新租约打断的领取→提交/领取→验收；小于 15 秒的探针及超过 6 小时的异常记录不参与。样本不足、范围差异过大、超过历史范围或连接未知时明确显示无法估计，不用工具次数假造进度，不承诺后续复核或 GitHub 上线时间。数据变化仍由 Live Query 驱动。

## 0.12.0：云端员工通道

`codex-cloud`、`devin-cloud`、`jules` 三个 provider 走同一原生执行面：命令是 `sandbox/launch.sh bun <服务目录>/current/server/vendor/src/runner/cloud-lane/main.ts <provider>`，桥接进程把回合转交给供应商云端 agent（Codex Cloud / Devin Cloud / Jules），输出与非 codex 原生 CLI 相同的 system/lane_status/result 事件流。模型只用 `default`；续轮参数只有 `--resume <逻辑会话ID>`（云端任务凭任务 ID 重连，逻辑会话 ID 只是会话标识）。

路由、命令校验、额度熔断与 provider_health 与本地 CLI 完全同构：`runtime-routes.json` 可指派云端 provider；`native-runner.json` 新增可选 `lanes` 配置（环境映射、轮询上限），`private/lanes/<provider>.env` 的私密变量由执行端在沙箱外读出后注入，沙箱内桥接进程不读 private。云端额度经 `listUsage` 上报（codex-cloud 读 wham/usage，jules 按本地记录的 24 小时会话数），读取失败不造数。

回合语义：task.md 与最新复核意见内联进云端 prompt；复核轮强制首行复核结论；非 GitHub 工作树按受阻收尾；在途云端任务按 prompt 摘要重连不重复提交。详见 [cloud-lanes.md](cloud-lanes.md)。

`warp`（Warp Build 的 oz agent）是同构的本地桥接：命令是 `sandbox/launch.sh bun <服务目录>/current/server/vendor/src/runner/warp/main.ts warp`，事件流同为 system/lane_status/result。与云端通道不同的是它在本地工作树里干活（提交/推送由 agent 按公司协议自己在任务分支完成），prompt 正文写进 commDir 的 `.warp/turn-<时间戳>.md`（0600），进程参数只带一句短指令；续轮用 `--conversation <conversation_id>`。`lanes.warp` 只接受 `bin`（如 `{"oz": "/Applications/Warp.app/Contents/Resources/bin/oz"}`）与 `maxMinutes`（默认 120）。Warp 无可读额度端点，保持 unknown。
