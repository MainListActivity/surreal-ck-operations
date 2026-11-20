# 云端员工通道（cloud lanes）

云端通道让 `employee_def` 直接使用供应商的云端 agent：任务在供应商的云端环境里跑，用的是老板自己的云订阅，不占本机 CLI 会话。公司这边仍然走同一套派工、租约、复核与收尾协议。

## 三条通道

| provider | 供应商 | 老板订阅 | 工作方式 |
| --- | --- | --- | --- |
| `codex-cloud` | Codex Cloud | ChatGPT 套餐 | 云端任务在指定环境对远端分支跑；结束后执行端把 diff 应用到本地工作树、提交、推送并自动建 PR |
| `devin-cloud` | Devin Cloud | Devin | ego-browser 驱动 app.devin.ai 的 Free 档位会话（SWE-2），让 Devin 自己在远端分支上推送并开 PR，本地随后快进 |
| `jules` | Jules | Google AI Pro | Jules REST API 建会话（AUTO_CREATE_PR），轮询到 COMPLETED 后本地快进 |

三种 provider 的 `model` 只用 `default`（云端任务不解析本地模型槽位）。

## 一次性准备（老板）

- **codex-cloud**：在 chatgpt.com 的 Codex 里为目标仓库建好云端环境，并在 `native-runner.json` 的 `lanes["codex-cloud"].environments` 里登记 `"owner/repo": "<环境ID>"`；没有登记的仓库退化为把仓库名当环境标签传给 `codex cloud exec`。
- **devin-cloud**：Devin 组织里已连接目标 GitHub 仓库；老板的 ego-browser 里已登录 app.devin.ai，且账号有 Free 档位（Free 菜单项选中后显示 `Free (powered by SWE-2)` 与 `N/M in use` 席位计数）。通道不再调用 `devin` CLI：CLI `3000.x` 的 `--cloud --model free` 会被 CLI 拒成 `Unknown model`，云免费能力只存在于网页。通道不依据 CLI 报错文字判定，页面核验不过就有界重试后受阻。会话地址（`app.devin.ai/sessions/<id>`）由页面返回并写进 lane 状态，续轮/返工/复核都回到同一 Devin 会话发跟进消息，不另开新会话；会话页读不到席位，续轮先到组织首页读席位，再回原会话发送。
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
    "codex-cloud": { "environments": { "MainListActivity/surreal_ck": "surreal_ck" }, "maxMinutes": 180,
      "bin": { "codex": "/Users/y/node/bin/codex", "gh": "/opt/homebrew/bin/gh" } },
    "devin-cloud": { "maxMinutes": 180, "bin": { "ego-browser": "/Users/y/.local/bin/ego-browser" } },
    "jules": { "dailyLimit": 100, "maxConcurrent": 3, "maxMinutes": 180 }
  }
}
```

`lanes.<通道>.bin`：命令名 → 绝对路径（`codex`、`ego-browser`、`gh`、`git` 等），给不在服务 PATH 里的 CLI 指路；配置后该命令按此路径执行，其所在目录（不是 realpath）前置进子进程 PATH，node shim 形式的 CLI 因此找得到同目录的 `node`。重装服务（`bun scripts/native-service.ts`）时这些目录连同 `commands` 里的绝对路径一并并入服务脚本 PATH。

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
- 云端 agent 读不到本机文件也调不了 `sck`。0.13.19 起发给它的正文就是派工消息（老板在派工消息页看到、改过的那条，`laneMessage`）：消息里指向的文件路径换成“下文《…》”，文件内容附在后面（笔记、最新的 `findings/round-NN.md`、较长的老板答复、复核轮的 `task.md`）；工作目录行和公司命令的指引不带。退回意见按文件取、返工轮一定附上，不看派工消息的措辞；正文不是三段式时整份 `task.md` 也附上；没有派工消息时退回到整份任务材料。网页通道（Grok Bot、muse-web）同样。Devin 云模式固定网页 Free 档位：`lanes.devin-cloud.model` 只能缺省或写 `free`，其它值（含空白、空串）在 `validateLanes` 配置校验时拒绝；执行入口（`driveDevin`）在推送分支、发会话之前再校验一次，所以绕过配置也不会发出非 free 的云端会话，失败也不回退到账号默认或其它模型。新会话、续轮与复核发送前都在页面核验 Capability 选中 Free、档位详情为 `Free (powered by SWE-2)` 且读得到席位 `N/M in use`，核验失败整轮不发、不降级到 Normal/Ultra/Lite/Fusion 任何付费档。这条约束只适用于 devin-cloud，本地 Devin/Paseo 的模型名不受它限制。复核轮（task.md 含「## 待复核成果」）要求只读复核，最终答复首行必须是「复核结论：通过/退回」，缺了按错误回合处理。
- 代码任务要求 cwd 是关联 GitHub origin 的工作树；任务分支缺远端时先推送。非代码任务或仓库未映射 → 回合按「工作结果：受阻」收尾（成功回合，不记供应商故障）。
- **codex-cloud**：`codex cloud exec --env <环境> --branch <分支>` → `codex cloud status` 轮询 → READY 后 `codex cloud apply` 到本地、`git add -A`、提交「<任务标题> (Codex Cloud <id>)」、推送、`gh pr list/create` 保证有 PR；空 diff 按受阻收尾。Codex Cloud 的最终消息 CLI 取不到：复核轮要求供应商把结论写进 `.sck/review.md`，桥接从 `codex cloud diff` 的补丁行提取。
- **devin-cloud**：ego-browser 执行 `src/runner/cloud-lane/devin-web.ts` 里的页面脚本（`main.ts` 经 `LaneDeps.browse` 注入 `egoBrowse`），不再调用 `devin` CLI、不带任何 `--model` 参数（CLI 3000.x 拒绝 `--model free`，云免费能力只在网页）。新会话前脚本在 app.devin.ai 组织页选中 Free：用 ego-browser 指针点击（`page.click`）打开唯一的 Capability 按钮，有界等待菜单里恰好一个 Free 行后指针点它；旧版（0.13.41）用页面内 `element.click()` 选 Free，选不中的具体机制未证实（程序化点击是否开菜单、旧行选择器是否漏掉 Free 行、读数时序都未在页面验证），本版不再用它。菜单仍打开时回读 `Free (powered by SWE-2)` 与席位计数 `N/M in use`。真实页面（负责人 2026-11-17 实测）选中 Free 后菜单是两层：第一次 Escape 只收 Free 详情、列表仍开，第二次才收起列表。脚本逐层按 Escape，每次只在可见菜单仍在时按一次，按完等 DOM 更新，可见菜单数为 0 即停，最多 4 次。选中 Free、powered、席位可读、未满四项都成立才发送，菜单收不起也不发送。席位满则在 `maxMinutes` 内等待，仍满按「工作结果：受阻」收尾；选不中或读不到有界重试后同样受阻，不切付费档、不改用其它模型。消息带 `[SCK-ROUND <标记>]` 行；按下发送前执行端先在 lane 状态里落盘 attempt 标记（与 grok-bot 同一做法），会话地址记入 `taskUrl`/`vendorSession`。续轮、返工与复核回到同一会话地址发跟进消息：会话页的 Capability 按钮是禁用的、读不到席位，所以先到组织首页选中 Free 读席位（满座直接等待或受阻），再回原会话复核一次并发送，不新建会话、不占新席位。按下发送之后绝不重发：会话地址或回执丢失时只做受理核对：续轮只看原会话转录里有没有本轮标记，新会话在会话列表与最近会话里找；核对仍不确定，或空闲的转录里连续看不到本轮标记，都按「工作结果：受阻」收尾并保留在途状态，交人工核对后恢复本任务即可，不会另建会话或另开 PR。终稿只认本轮收尾约定之后、Devin 发言块里的 `[SCK-DONE <标记>]` 行：工具输出里的 DONE/PR、派工消息、用户提示词里的例子都不算。读取会话页时还有两道额外核验：①转录是虚拟化长列表，常驻 DOM 可能只剩 Devin 作者块、本轮用户消息已被滚出挂载（真实事故 15eaf1b8 的根因）——脚本在找不到本轮锚点时，定位承载作者块的最近可滚动祖先，在它的可滚动范围（0 到 `scrollHeight-clientHeight`）里等分取 5 个检查点（含绝对顶部与绝对底部，中间按比例插值），依次滚过去、等 300ms 重渲染后重找锚点，命中就停、不再试其它点，全部检查点都落空才还原滚动位置；找不到可滚动祖先就不恢复。这是系统地遍历顶部、中段与底部，不是只把容器滚到绝对顶部试一次。证据边界要分清：真实 DOM 采样证实过两种形态——2026-11-17 事故的「本轮是会话第一轮、锚点在顶部」（滚到顶等一次重渲染即命中），以及负责人第三轮的只读补证（同一真实会话在 0.13.50 跑过真实续轮后，按同一比例公式在真实容器上取 0/0.25/0.5/0.75/1.0 五个位置，续轮用户锚点与本轮 DONE 在全部五个位置挂载、读完还原滚动）——后者真实证实了「虚拟化窗口跟随 scrollTop」的构造假设与比例遍历的可逆性，但那次采样里续轮锚点在自然位置本就可见，不是「锚点漏出自然位置、靠中段检查点救回」的真实复现，不能引为那种证据；同一采样还证实更早轮次的用户锚点可彻底滚出、任何位置（含绝对顶部）都不挂载，而其 DONE 文本在部分位置单独挂载——所以恢复出的锚点仍要求标记与本轮一致，不把旧轮或工具/用户文本冒充本轮终稿，这条边界绝不可省。「自然位置漏锚点、中段检查点救回」这一恢复路径只有标明为合成的夹具验证（本仓库测试，及负责人独立回放：基线取不回、本版取回并还原）。这仍是有界遍历而非逐像素扫描，真实虚拟化窗口若明显窄于检查点间距，理论上仍可能漏判夹在两个检查点之间的锚点。②`openPage` 的 `page.goto` 失败会被自身 `.catch` 吞掉，可能让页面停留在导航前的另一个合法会话上——脚本读完 DOM 后额外核验 `location.href`（query/hash 规范化后比较）是否等于本次调用的目标会话地址，不等则整条回执按 `wrong_session` 拒绝（即使那页恰好带着同标记的用户/Devin 作者块），驱动层不把它当已受理证据或终稿，也不重发：发送/续轮阶段按「页面还没就位」重试，轮询阶段计入未读到标记的重试次数，到上限后降级为下面的受阻收尾（已受理场景保留在途状态）。驱动层对每一份回执还独立比对回执里的 `s.url` 与本次目标会话（同样规范化 query/hash）：即使脚本回执误报 `ok:true`，别的合法会话上的内容也不当本轮受理或终稿；续轮发送后的受理回执同样要求地址仍是原会话，页面漂走时按「已按下、未确认」回原会话核对，不重发。状态短语只看最近一次收尾约定之后的文字：续轮前上一轮还在工作就等它空下来、不发送；更早轮次残留的状态不算。状态 unknown 不收尾；两次读数一致才收尾。空闲却没有终稿连续确认后受阻。Devin 停下等用户（blocked on the user）按受阻收尾并带回现场。非复核回合取 `PR:`/`SHA:` 行后 `git fetch + git merge --ff-only FETCH_HEAD`，非快进只报错不 reset；声明 SHA 与实际远端 HEAD 不符时按实际 HEAD 注明。活动流分开报「尝试」与「已受理」：尝试显示为运行中；转录里出现本轮标记或会话地址后才是已受理，之前不报已派。受阻文本首行单独成行「工作结果：受阻」，原因写在下一行起。派工提示（代码轮）写明同一供应商会话可以先后处理不同仓库，以本轮仓库与分支为准；写文件或提交前核对工作树的 origin 与分支，不一致时先找到、克隆或复用本轮仓库的正确任务工作树，核对一致后再继续，取不到才受阻；PR 只开在本轮仓库。复核轮是只读，不带这一段。
- **jules**：REST 会话状态机 QUEUED/PLANNING/IN_PROGRESS → COMPLETED/FAILED；`AWAITING_USER_FEEDBACK`/`AWAITING_PLAN_APPROVAL` 按受阻收尾并把 Jules 的问题带回来；续轮 `:sendMessage` 复用同一会话。
- **幂等**：提交前把云端任务 ID、prompt 摘要、分支原子写入 `$SCK_COMM_DIR/.lane/state.json`；同摘要重启重连轮询不重复提交。提交结果不明绝不重发，报错误回合并带任务 ID/URL。Devin 网页入口同样：按下发送之后不重发，只核对受理（见上）。返工改了摘要（findings 等）时登记键跟着变，所以共享登记另记公司任务号（`claim.json` 的 `task.id`），换摘要重派也按它找到同一任务在别的员工目录里的在途发送：未确认受理且没有会话地址的，受阻交人工核对，不发送、不另建会话，登记保留；已有会话地址的，沿用该会话发跟进消息（标明是同一任务的后续轮次），不另开会话。
- **超时**：`lanes.<provider>.maxMinutes`（默认 180 分钟），约 25 秒轮询一次；超时按错误回合处理，文案说明云端任务可能仍在运行。devin-cloud 例外：会话已受理（登记了 taskId）之后超时，按「工作结果：受阻」收尾（成功回合，保留原会话地址与在途状态，不重发、不当失败终态），避免真实已受理、仍在运行的回合被错误回收成空交付的 silent turn；发送/续轮意图还没确认受理时超时仍按错误回合处理，不生造受理假象。

## 额度

执行端 `listUsage`（沙箱外）为已配置的通道上报 `company_meta:quota_<provider>`：

- `codex-cloud`：`GET https://chatgpt.com/backend-api/wham/usage`，用 `~/.codex/auth.json` 的 `tokens.access_token` / `tokens.account_id`；`primary_window`/`secondary_window` 映射成 5 小时/周窗口。
- `jules`：桥接进程在 `<native根>/lanes/jules-usage.json` 记录每次创建会话的时间，按滚动 24 小时计数对照 `lanes.jules.dailyLimit`（默认 100）。
- `devin-cloud`：没有独立额度端点；Free 档位的并发席位（`N/M in use`）在每次新会话、续轮与复核发送前由页面实时核验（续轮的席位读自组织首页），读数记入 lane 状态 `devin.seats`。满座等待到时限按受阻收尾，不记供应商故障。

读取失败一律 fail open：不报这行，绝不当成额度为 0。老板端运维页「订阅额度」与 `sck owner quota.list '{}'` 展示全部快照和耗尽中的 provider。

## 失败与回退

- 回合报「<供应商> 提交失败：找不到可执行文件 <命令>」：服务 PATH 里没有该 CLI。把它的绝对路径配进 `lanes.<通道>.bin`（见上）并重装服务，或直接修好服务脚本 PATH；同一原因重复三次会自动停用该员工定义，修好后重新启用。
- 供应商额度耗尽的报错（Codex 限流、Jules 429）走既有 quota-failure 链：记入 `provider_health` 冷却，任务留在原员工名下。Devin Free 席位在发送前由页面核验，满座等待/受阻不经过这条链。
- 执行目录边界：通道只在 `claim.json` 指定的任务工作树里执行，会话 cwd（可能是共享主 checkout）不是回退。缺 claim、无 worktree、路径无效、工作树分支与派工要求不一致或在默认分支上时，回合安全受阻且一个 git/供应商命令都不发。codex 通道只暂存 `codex cloud diff` 补丁覆盖的路径（`git add -A -- <paths>`），暂存后出现补丁外路径只取消暂存不动文件，因此工作树里的无关未跟踪文件（error.log、.wrangler 状态等）不会被提交。
- 云端任务可能仍在运行时只报错误回合，不自动取消、不重发；老板可凭任务 URL 人工核对。devin-cloud 的会话已受理之后属例外（见上「超时」一节）：按受阻收尾而不是错误回合，但同样不自动取消、不重发，原会话地址同样留在文案里供人工核对。
- 回退：停用对应员工定义、从 `runtime-routes.json` 移除路由、从 `native-runner.json` 移除 commands 条目即可；在途云端任务按上文人工核对，通道不自动接管。

## 本地员工：Warp / Grok / Muse / Factory 双模式

云端通道之外，公司还可以这样补充员工：

- **Warp（provider `warp`）**：Warp Build 的 oz agent 走原生执行端的本地桥接进程（`src/runner/warp/main.ts`），事件流与云端通道相同。配置步骤：在 `runtime-routes.json` 把 `warp` 路由到本节点（`"warp": "native:<节点ID>"`），在 `native-runner.json` 的 `commands` 加 `"warp": ["<服务>/sandbox/launch.sh", "<bun 绝对路径>", "<服务>/current/server/vendor/src/runner/warp/main.ts", "warp"]`，并按需加 `lanes.warp`：`{"bin": {"oz": "/Applications/Warp.app/Contents/Resources/bin/oz"}, "maxMinutes": 120}`。每轮 prompt 正文写进 commDir 的 `.warp/turn-<时间戳>.md`（0600），oz 参数只带文件路径；有 claim 任务工作树就用它，否则用会话 cwd（本地 agent 与普通员工同规则，公司提交由 agent 自己在任务分支完成）。Warp 没有可读额度端点，额度保持 unknown。
- **Grok（provider `grok`）**：走 Paseo ACP。`scripts/sandbox/install.sh` 会把 `~/.local/bin/grok` 包进员工沙箱并把 provider command 设为 `[<包装脚本>, "agent", "--always-approve", "stdio"]`（`--always-approve` 是无人值守必需）。升级后需重跑 install.sh。
- **Muse Code（provider `muse`）**：Paseo 内置 provider。安装并登录后重跑 install.sh，脚本会把包装脚本写进其 command 并启用；未安装则跳过。注意：老板要接的“Muse”是 Meta 的 muse.ai（网页/App 里的通用 agent），不是这个编程 CLI；老板端编制页已不再列出 Muse Code。
- **Factory 双模式（provider `factory-paseo`）**：与原生 `factory-droid` 并存的 Paseo ACP 入口（同一 droid 包装脚本、`exec --output-format acp-daemon`），install.sh 自动创建。两个 provider id 走同一份订阅：额度窗口、耗尽冷却与「优先订阅」判定都按订阅合并，任一侧耗尽另一侧同步冷却；`preferredProvider` 设任一个，另一个也算优先候选。

- **Devin（provider `devin-paseo`）**：老板自己的 `devin` provider 保持原样；公司员工用独立的 `devin-paseo`（`sandbox/bin/devin acp`），install.sh 自动创建，与 `devin` 共用订阅额度与耗尽冷却。Devin 不走云端模式。

`factory-paseo`、`grok`、`muse`、`devin-paseo` 不路由（不在 runtime-routes.json 出现），由 Paseo 直接派工。

## 网页 agent 员工：Grok Bot（`grok-bot`）与 muse.ai（`muse-web`）

Grok 的 bot（grok.com 左栏 Bots）没有 API，只能在网页或 App 里聊天；每个 bot 是一个常驻 agent（自带云电脑），且只有一条对话。原生执行端的桥接进程（`src/runner/grok-bot/main.ts`）用 ego-browser 驱动老板已登录的 grok.com：

- **用哪个 bot**：员工定义的 `model` 填 bot 的 UUID（`https://grok.com/bot/<UUID>`）。公司用专用 bot「公司员工」，不用老板自己在用的 bot（一个 bot 只有一条对话，混进去会和老板的工作搅在一起）。`maxInstances` 必须是 1。
- **协议**：建 bot 后先发一条约定消息；之后每轮发 `[SCK-TASK <标记>]` + 内联的 task.md（与复核退回意见），bot 完成后最后一条消息以 `[SCK-DONE <标记>]` 开头给出终稿。标记 = 任务 ID 前 8 位 + 本轮内容摘要：同一轮重启得到同一标记，发送前先查对话里是否已有它，有就只轮询不重发。
- **判定**：页面主区有 `Working` 状态时视为在忙（发送前也等它空闲，老板正用着就不插话）；连续两次看到「不在 Working 且有同一份终稿」才收稿。bot 停下来出选择题卡片 → 回合按「工作结果：受阻」收尾并带回问题，绝不代答；停下但没给终稿也按受阻收尾。
- **范围**：bot 读不到本机工作树、没接公司 GitHub，代码改动任务（`intent=code`）直接受阻、不碰浏览器；适合调研、写作、资料整理等文本交付。
- **配置**：`runtime-routes.json` 加 `"grok-bot": "native:<节点>"`；`native-runner.json` 的 `commands` 加 `"grok-bot": ["<服务>/sandbox/launch.sh", "<bun>", "<服务>/current/server/vendor/src/runner/grok-bot/main.ts", "grok-bot"]`，`models` 加 `"grok-bot": ["<bot UUID>"]`，`lanes["grok-bot"]` 只接受 `bin`（`{"ego-browser": "<绝对路径>"}`）、`maxMinutes`（默认 120）、`pollMs`（默认 20000）。ego-browser 在员工沙箱里可用。没有额度端点，员工定义设 `quotaLimited:false`。
- **失败**：grok.com 登录过期 → 错误回合，需要老板在 ego-browser 里重新登录；超时只报错不重发（bot 可能仍在工作，标记写在错误里便于人工核对）。
- **多个 bot 与专属编制**：每个 bot 一条编制（`model` 填各自 UUID，`maxInstances 1`），`native-runner.json` 的 `models["grok-bot"]` 列出全部 UUID。老板自己的 bot（如「架构师」）接成员工时，编制 `tracks` 设 `["专属:架构师"]`：它只接 `discipline` 为「专属:架构师」的任务，公司专用 bot 和其它同岗编制也不会接这类任务。点名派给它的任务用 `discipline: "专属:架构师"`，审阅者用 owner 或其它岗位。bot 在为老板干活（Working）时通道等它空闲再发；确认发出后 commDir 的 `.webchat/<标记>.json` 记 `sent`，重启只等终稿不重发。
- **muse.ai（`muse-web`）**：同一个桥接进程（`src/runner/grok-bot/main.ts muse-web`），同一套标记协议。区别：Muse 的主对话是老板私人的，公司任务**每轮新建一个侧聊**（左栏 Side chats 的「New side chat」），侧聊地址写进 commDir 的 `.webchat/<标记>.json`；重试与重启回到同一侧聊，不另开新侧聊重复发送。工作中判定为「Stop task」按钮或「is working / typing」状态。`model` 用 `default`，`maxInstances` 可大于 1（侧聊互相独立）。Muse 在发邮件、付款等动作前会向老板要批准，这类停顿按受阻收尾。配置与 grok-bot 相同，只把 provider 换成 `muse-web`、`models` 写 `["default"]`。
- **ChatGPT（`chatgpt-web`）与 Gemini（`gemini-web`）网页版聊天**：同一个桥接进程、同一套标记协议，只接文字任务（代码改动任务按受阻退回）。每轮打开首页即新对话，发出后把对话地址（`chatgpt.com/c/<id>`、`gemini.google.com/app/<id>`）记进 `.webchat/<标记>.json`，之后只读那一个对话。这两个站点的页面左侧是老板的私人聊天列表，所以页面文本只从对话区读（`SiteSpec.scope`），侧栏内容不会进入回传的现场文本。页面用自己的话提示额度用完时，本轮按失败收尾、文案带 `usage limit`，执行端据此给这条通道记额度冷却（`quota-failure.ts`），所以这两个编制要保持默认的“受额度限制”。ChatGPT 的「Stop」按钮在答完后还会留十几秒，判断是否还在生成要同时看最后一轮的 `data-talvt-turn-state`。图片不走这条通道：出图由员工调用 `media_image`（`src/media/browser.ts`，顺序 ChatGPT→Higgsfield→Gemini→Grok）。站点配置都在 `src/runner/grok-bot/turn.ts` 的 `SITES` 里，新增站点要把每一项都写出来。`chatgpt-web` 于 2026-11-14 用真实页面跑通一轮；`gemini-web` 的选择器取自写作通道已在用的页面结构，聊天员工这条路还没有实测。
- **Figma Make**：已查过网页（Make 文件里有「Make prompt」输入框），但老板的 Education 团队 AI 额度已用完、11 月 30 日重置，届时再做通道。

## 公司 MCP（第二期：写工具、次数预算、Devin 通道收尾）

云端执行者（先 Devin Cloud）经原生 MCP 使用公司工具。端点挂在现有 owner-end（`https://company.maplayer.top/api/mcp`，由 VPS `sck-owner-backend` 承载；edge 原样转发，没有新增服务、端口或 Worker）。

- **OAuth**：授权服务器是 ma_hono company 租户（issuer `https://o.maplayer.top/t/company`）。`GET /api/mcp/.well-known/oauth-protected-resource`（无需登录）公布资源与 `['openid','company.work']` scope；客户端走 OIDC discovery → `/t/company/connect/mcp/register` 动态注册 → authorize（resource=`https://company.maplayer.top/api/mcp`，scope `openid company.work`）。MCP 令牌只在本端点有效；控制台/员工令牌调 `/api/mcp` 返回 401（带 `WWW-Authenticate: Bearer resource_metadata=…`），MCP 令牌调 `/api/cmd` 同样 401。
- **主体登记（默认拒绝）**：哪些授权主体（token `sub`）能用工具、各自允许哪些员工 provider，存在 `company_meta:mcp_principals`。未登记或 `enabled=false` 的主体调任何工具都是 forbidden（令牌本身有效）；每次请求重读，停用立即生效。老板用 `mcp.principal.list` / `mcp.principal.set` / `mcp.principal.pending`（仅老板，`mcp.*` 全部老板专属）管理；`mcp.principal.pending` 聚合近 7 天「令牌有效但主体未登记」的尝试，供老板决定是否登记。
- **任务绑定**：需要任务的工具带 `taskId`，必须全部满足才放行：任务存在、`current_employee` 非空、`lease_expires_at` 未过期、该员工实例的 `provider` ∈ 主体的 providers。放行后以 `current_employee` 为 actor 过命令守卫 `decide`（员工策略、停用、保护清单照旧），每次调用（含被拒）写 `ops_audit`（审计命令名 `mcp.<tool>`）。
- **工具（固定 8 个）**：`company_landscape`（同 `landscape.get`）、`task_current`（本身份在租任务，最多 20）、`task_context`（任务投影：需求/验收/分支/项目档案，无本机路径与密钥，整体 ≤64KB）、`company_ops`（白名单 `ops_origin_status`/`ops_origin_health`/`ops_release_diagnose`/`ops_product_pulse`，走执行端作业，超时返回 `{pending,jobId}`）、`company_job`（只能查本身份员工的作业）、`task_submit`、`task_review`、`task_block`。
- **写工具（第二期）**：执行态任务用 `task_submit {taskId, summary, pr?, sha?}` 交卷；复核态用 `task_review {taskId, verdict: pass|return, findings}`；两种状态都可用 `task_block {taskId, reason}` 报受阻。写入只用一条条件 UPDATE（`current_employee`/`delivery_id`/`fence`/`lease_expires_at` 全部匹配才命中）写 `task.mcp_outcome`（kind、脱敏截断后的文本、pr、小写 sha、verdict、员工、delivery、fence、sub、时间），**不改** version/fence/state/current_employee/delivery_id；读后租约变了 → forbidden「任务租约已变化」。同一轮后写覆盖先写。
- **company_ops 次数预算**：按（任务, delivery_id, 工具）计数存 `task.mcp_ops_used`，默认每工具 3 次；`task.mcp_budget`（`{ <tool>: 0..20 }`，0 即禁用）由老板 `mcp.budget.set` 覆盖。入队前扣次（条件 UPDATE 防并发、最多重试 3 次），超限 forbidden 不入队；delivery 换新即清零，作业失败也照计。
- **Devin 通道 MCP 收尾**：lane 每轮发送前先经 sidecar `lane_mcp_open` 开闸（`core.mcpOutcome 'open'` 清上轮结论），并把开闸那一轮的消息标记存 `state.devin.mcpOpen`；assist 回传不重复开闸。轮询期每 tick 先读 `lane_mcp_outcome`：submit → 直接走 closeout（文本 + `PR:`/`SHA:` 行）、review → `复核结论：通过|退回\n<findings>`、block → `工作结果：受阻\n<reason>`；结论与本轮阶段不符按受阻处理。开闸失败、读失败或无结论一律回落原页面 `[SCK-DONE]` 逻辑。vendor prompt 告诉云端执行者先用 `task_context` 取资料、只读运维直接 `company_ops`、收尾用写工具并保留 `[SCK-DONE]` 兜底。
