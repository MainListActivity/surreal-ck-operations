# 订阅接入与派工整合报告（2026-11-13）

目标：把老板的各家订阅接成公司员工，按擅长领域派工，老板不用盯。本报告覆盖 0.12.2 – 0.13.7 的结果，状态分四类：**已端到端验证**、**已接入未验证**、**等老板操作**、**未开始**。

## 1. 各订阅状态

| 订阅 | 接入方式 | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| Factory | 原生 `factory-droid` + Paseo `factory-paseo`（双模式，共用额度） | 已端到端验证 | Paseo 模式：任务 bd9c5e4f → surreal_ck PR #249（只改 .gitignore，CI 过）→ QA 复核通过 |
| Codex | 原生 `codex` + 云端 `codex-cloud` | 已端到端验证 | 云端：任务 eb57a119 在任务工作树完成，CI 过，复核通过（0.12.4 修复了云端补丁误提交到老板分支的事故） |
| Claude Code | 原生 `claude` | 已在用 | 主力员工；TUI 指挥按老板决定不做，Claude Code 作私人助手手动使用 |
| Warp Build | 原生桥接 `warp`（oz） | 已端到端验证 | 任务 cea218b6 → PR #248，CI 过；首启偶发 “team metadata” 超时，0.13.1 起自动重试 |
| Grok（CLI） | Paseo ACP `grok`，经员工沙箱 | 暂缓（老板决定） | 本机未登录（无 `~/.grok/auth.json`），需 `grok login` 后验证 |
| Muse（muse.ai） | Meta 的通用 agent，网页/App 聊天；拟走 ego-browser 网页驱动 | 等老板操作 | 老板澄清要的是 muse.ai 而不是 Muse Code CLI；需老板在 ego-browser 里用手机号/邮箱+验证码登录一次（登录页已打开） |
| Devin | Paseo `devin-paseo`，经员工沙箱（不走云端，按老板决定） | 已端到端验证 | 0.13.4（PR #2244）。编制 `engineering-devin-paseo` 用免费的 swe-2-high，设 `quotaLimited:false` 不受 Devin 周额度限制；只读任务 314b418a 不到 1 分钟送审，结果与工作树提交精确一致。换成 adaptive 等付费模型时要恢复额度限制。`engineering-devin-cloud` 已停用 |
| Grok Bot | 原生执行端 `grok-bot` 网页通道（0.13.7），ego-browser 驱动专用 bot「公司员工」 | 通道实测通过 | 每个 bot 只有一条对话，老板自己的「架构师」不用；协议 `[SCK-TASK]`/`[SCK-DONE]` 标记、忙时不插话、重启不重发；只接文本交付，代码任务受阻 |
| Figma Make | 设计：经 ego-browser 驱动网页 | 未开始 | Figma MCP 的 send_prompt 对 student 档未开放；需老板先在 ego-browser 登录 Figma |
| Google AI Pro | Antigravity（`antigravity`，story-author 编制）；Jules 已下线 | 已端到端验证 | 任务 6666cedf（原著轨短篇梗概）约 1.5 分钟送审；重复且无轨的编制 `story-author-antigravity` 已停用 |
| Higgsfield | 网页免费通道（ego-browser，无限模式）+ CLI 付费兜底 `higgsfield-cli`（0.13.6） | CLI 已实测；网页通道未验证 | CLI 无无限模式，每张扣 credits；实测 gpt_image_2_6 一张 0.25 credits、PNG 1024²。只在免费通道都失败后使用，单张 ≤0.5、近 24 小时 ≤20 credits（套餐每月 600，月初清零） |

## 2. 额度现状（`sck owner quota.list`，2026-11-13 13:00 UTC）

| 订阅 | 读数 | 说明 |
| --- | --- | --- |
| claude | 96% 可用 | 当天读数 |
| codex / codex-cloud | 77% 可用 | 当天读数，两者共用 |
| factory-droid | 36% | 0.13.5 起恢复更新（11-13 14:16 UTC；30 天窗口） |
| antigravity | ~100% | 0.13.5 起恢复更新 |
| grok | 不可用 | 未登录 |
| devin | 0% | 周额度耗尽；swe-2 系列免费，不受影响 |
| warp | 无读数 | oz 不提供额度查询 |

## 3. 老板一次性操作清单

1. （暂缓）终端运行 `grok login`（浏览器登录）。
2. 在 ego-browser 里登录 muse.ai（手机号或邮箱 + 验证码）。
3. 在 ego-browser 里登录一次 Figma。

## 4. 本轮事故与修复

- **云端补丁提交到老板分支（0.12.4 修复）**：通道在共享 checkout 里 `git add -A` 推到了 `design/collaboration-client-v1`，已恢复到 `7231e2c0`，PR #244 已关；GitHub 的 `refs/pull/244` 仍可访问到那次提交（内容无密钥，仅 codex 的 account_id）。
- **spawn 被拒导致节点更新死锁（0.13.3 修复）**：0.13.0 的沙箱门禁拒绝 factory-paseo，派工记录卡在 pending，租约被无限续期，节点更新器一直暂缓，修复门禁的 0.13.2 上不去。已人工结案后上线；0.13.3 起插件拒绝建会话会自动结案为 `rejected`（schema 068）。人工结案那一条记录显示为 `confirmed` / 消息 `sent`，实际没有投递（实例 `engineering-factory-paseo-cda44c`）。

## 5. 已知问题（未修）

- **原生执行端切版本后首轮卡住一次**：重启后首个 tick 持有运营仓库 worktree 分配锁超过 8 分钟无日志，重启后恢复；原因未查明，下次切版本时可能复现。

## 6. 下一步

1. 老板完成第 3 节操作后：接 muse.ai 网页通道、写 Figma Make 网页通道并实测；Grok CLI（`grok login`）按老板意见暂缓。
2. Grok Bot 通道上线后派一条真实文本任务端到端验证。
3. 复现并定位执行端首轮卡锁。
4. 老板在 ego-browser 登录 Higgsfield 后验证免费网页通道。

已修（0.13.5）：插件对原生端职能的“无编制”误报；额度改用 `private/magpie-quota.key` 后 Factory/Devin/antigravity 读数恢复。
