# 云端员工通道（cloud lanes）

云端通道让 `employee_def` 直接使用供应商的云端 agent：任务在供应商的云端环境里跑，用的是老板自己的云订阅，不占本机 CLI 会话。公司这边仍然走同一套派工、租约、复核与收尾协议。

## 三条通道

| provider | 供应商 | 老板订阅 | 工作方式 |
| --- | --- | --- | --- |
| `codex-cloud` | Codex Cloud | ChatGPT 套餐 | 云端任务在指定环境对远端分支跑；结束后执行端把 diff 应用到本地工作树、提交、推送并自动建 PR |
| `devin-cloud` | Devin Cloud | Devin | `devin --cloud -p` 同步跑一个云端会话，让 Devin 自己在远端分支上推送并开 PR，本地随后快进 |
| `jules` | Jules | Google AI Pro | Jules REST API 建会话（AUTO_CREATE_PR），轮询到 COMPLETED 后本地快进 |

三种 provider 的 `model` 只用 `default`（云端任务不解析本地模型槽位）。

## 一次性准备（老板）

- **codex-cloud**：在 chatgpt.com 的 Codex 里为目标仓库建好云端环境，并在 `native-runner.json` 的 `lanes["codex-cloud"].environments` 里登记 `"owner/repo": "<环境ID>"`；没有登记的仓库退化为把仓库名当环境标签传给 `codex cloud exec`。
- **devin-cloud**：Devin 组织里已连接目标 GitHub 仓库；本机 `devin` 已登录。`devin --cloud -p` 不暴露云端会话 ID，通道自己生成逻辑会话 ID，续轮开新会话并在 prompt 里说明在同一分支/PR 上继续。
- **jules**：在 jules.google 安装 Jules GitHub App（覆盖目标仓库），在设置页创建 API key，写入 `<服务目录>/private/lanes/jules.env` 一行 `JULES_API_KEY=<key>`。桥接进程在员工沙箱里读不到 private，key 由执行端进程在沙箱外读出后注入子进程环境；没有 key 时回合立即失败并提示配置方法。

## 配置

`native-runner.json`（示例）：

```json
{
  "commands": {
    "codex": ["/绝对路径/service/sandbox/launch.sh", "/绝对路径/codex"],
    "codex-cloud": ["/绝对路径/service/sandbox/launch.sh", "/Users/y/.bun/bin/bun", "/绝对路径/service/current/server/vendor/src/runner/cloud-lane/main.ts", "codex-cloud"],
    "devin-cloud": ["/绝对路径/service/sandbox/launch.sh", "/Users/y/.bun/bin/bun", "/绝对路径/service/current/server/vendor/src/runner/cloud-lane/main.ts", "devin-cloud"],
    "jules": ["/绝对路径/service/sandbox/launch.sh", "/Users/y/.bun/bin/bun", "/绝对路径/service/current/server/vendor/src/runner/cloud-lane/main.ts", "jules"]
  },
  "models": { "codex-cloud": ["default"], "devin-cloud": ["default"], "jules": ["default"] },
  "lanes": {
    "codex-cloud": { "environments": { "MainListActivity/surreal_ck": "surreal_ck" }, "maxMinutes": 180 },
    "devin-cloud": { "maxMinutes": 180 },
    "jules": { "dailyLimit": 100, "maxConcurrent": 3, "maxMinutes": 180 }
  }
}
```

`private/runtime-routes.json` 与本地 CLI 一样写：`{"version":1,"routes":{"codex-cloud":"native:<节点>","devin-cloud":"native:<节点>","jules":"native:<节点>"}}`。不改文件就不启用通道，行为与旧版一致。

员工定义在老板端编制页选对应 provider（模型 default），或 `sck owner def.ensure '{"id":"engineering-codex-cloud","role":"engineering","provider":"codex-cloud","model":"default"}'`。

### 让云端通道优先接活

派工默认「Factory 优先」：factory-droid 还有合格候选时新任务保留等它。要把空闲的云端额度用起来，把公司配置 `preferred_provider` 改成通道 provider：

- `sck owner dispatch.preference '{"provider":"codex-cloud"}'` 或 `pnpm run admin config preferred_provider '"codex-cloud"'`；
- 老板端员工页「职能」面板的「优先订阅」下拉同样生效；
- 传 `""` 表示不设优先，所有合格候选纯按 `weight` 竞争。

优先订阅额度耗尽或健康冷却时照常回退：其余合格供应商按权重分流，不会卡死任务。

## 回合怎么跑

- 桥接进程（`src/runner/cloud-lane/main.ts`）被当成普通原生 CLI 启动：prompt 走 stdin，逐行输出 `system`(session_id) → `lane_status`（老板端活动流显示「云端运行中：…」）→ `result` 事件。
- 云端 agent 读不到本机文件也调不了 `sck`：每轮把 `task.md` 与派工消息点名的最新 `findings/round-NN.md` 内联进供应商 prompt。复核轮（task.md 含「## 待复核成果」）要求只读复核，最终答复首行必须是「复核结论：通过/退回」，缺了按错误回合处理。
- 代码任务要求 cwd 是关联 GitHub origin 的工作树；任务分支缺远端时先推送。非代码任务或仓库未映射 → 回合按「工作结果：受阻」收尾（成功回合，不记供应商故障）。
- **codex-cloud**：`codex cloud exec --env <环境> --branch <分支>` → `codex cloud status` 轮询 → READY 后 `codex cloud apply` 到本地、`git add -A`、提交「<任务标题> (Codex Cloud <id>)」、推送、`gh pr list/create` 保证有 PR；空 diff 按受阻收尾。Codex Cloud 的最终消息 CLI 取不到：复核轮要求供应商把结论写进 `.sck/review.md`，桥接从 `codex cloud diff` 的补丁行提取。
- **devin-cloud**：`devin --cloud -p --prompt-file` 同步等待答复；prompt 要求在 `<owner>/<repo>` 的分支上工作、推送、开/更新 PR 并以 `PR:`/`SHA:` 行结尾；随后 `git fetch + git merge --ff-only FETCH_HEAD`，非快进只报错不 reset。
- **jules**：REST 会话状态机 QUEUED/PLANNING/IN_PROGRESS → COMPLETED/FAILED；`AWAITING_USER_FEEDBACK`/`AWAITING_PLAN_APPROVAL` 按受阻收尾并把 Jules 的问题带回来；续轮 `:sendMessage` 复用同一会话。
- **幂等**：提交前把云端任务 ID、prompt 摘要、分支原子写入 `$SCK_COMM_DIR/.lane/state.json`；同摘要重启重连轮询不重复提交。提交结果不明绝不重发，报错误回合并带任务 ID/URL。
- **超时**：`lanes.<provider>.maxMinutes`（默认 180 分钟），约 25 秒轮询一次；超时按错误回合处理，文案说明云端任务可能仍在运行。

## 额度

执行端 `listUsage`（沙箱外）为已配置的通道上报 `company_meta:quota_<provider>`：

- `codex-cloud`：`GET https://chatgpt.com/backend-api/wham/usage`，用 `~/.codex/auth.json` 的 `tokens.access_token` / `tokens.account_id`；`primary_window`/`secondary_window` 映射成 5 小时/周窗口。
- `jules`：桥接进程在 `<native根>/lanes/jules-usage.json` 记录每次创建会话的时间，按滚动 24 小时计数对照 `lanes.jules.dailyLimit`（默认 100）。
- `devin-cloud`：没有可读端点，靠 `provider_health` 耗尽冷却（供应商的额度报错会被 quota-failure 模式接住并记入冷却）。

读取失败一律 fail open：不报这行，绝不当成额度为 0。老板端运维页「订阅额度」与 `sck owner quota.list '{}'` 展示全部快照和耗尽中的 provider。

## 失败与回退

- 供应商额度耗尽的报错（Devin「weekly usage quota has been exhausted」、Codex 限流、Jules 429）走既有 quota-failure 链：记入 `provider_health` 冷却，任务留在原员工名下。
- 云端任务可能仍在运行时只报错误回合，不自动取消、不重发；老板可凭任务 URL 人工核对。
- 回退：停用对应员工定义、从 `runtime-routes.json` 移除路由、从 `native-runner.json` 移除 commands 条目即可；在途云端任务按上文人工核对，通道不自动接管。
