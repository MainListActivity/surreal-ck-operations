# Mac 本机派工故障修复（2026-10-22）

范围：本机会话完成代码修复、PR 合入 main，再从 main 固定快照同步发布 MCP 与 Paseo 插件。运行在 Mac，不改云端部署架构。

## 修复行为

- Paseo `turn_ended` 的 failed outcome、最后一条结构化 error，以及以 `API Error:` 开头的 assistant quota/429 消息均进入订阅熔断。正常任务文本提及 429、已恢复的早期错误、仅零 token，不构成熔断证据。
- 熔断先持久化，再摄取真正的 report/blocker；无交付时保留执行/复核阶段释放租约，不催办、不增加沉默轮数。持久化或严格释放失败时保留通道租约以便重试。重复 turnId 幂等，拒绝轮次的 wake_count 只退一次。
- 明确时区的未来 reset 生效，最多接受 14 天；只有 `until 08:00` 时不猜时区，沿用既有 30 分钟起步、最长 6 小时的退避。
- 评分输入排除明确标记为基础设施故障、没有 checkpoint/submit/review/block 的纯领取轮次；同一个员工其他轮次的实际贡献保留。普通无收尾退出仍进入评分。
- `admin repair-infrastructure-scores` 默认 dry-run；`--execute` 为有明确审计证据的历史卡片添加排除标记，再重算汇总，不删除原始卡片。没有明确证据的旧低分不自动改写。
- 没有可用 GM 时先保留待办并产生去重提醒，不反复取得/释放唤醒锁；候选恢复后立即重试，仍保留既有跨进程 CAS 保护。
- 默认周额度底线 6%，默认上下文轮换 200k。已有显式配置优先，编制的额度豁免语义保留。

## 验证与回滚

定向复现已确认旧行为会催办 completed 429，且在无经理时反复取得/释放唤醒锁。新增回归经过先失败后通过；数据库只使用 `~/.surrealdb/surreal` 公司 fork。

全量回归另发现 origin/main 原有过时断言（已在未修改的 main 快照复现）：GM 测试未提供持久唤醒 API、旧测试把项目身份与员工私有 cwd 混为一谈、snapshot 测试固定旧 schema 版本、GitHub 投影测试仍期待单事件故障终止整批投影。本次补齐测试桩、分别核对私有 cwd 与 repoHome、允许后续 schema 迁移，并核对投影失败事件保持待重试。

发布必须跑根/插件 typecheck、全量 fork 回归、PR CI 和当前 SHA 的 slow-pipe / sidecar-review 本机门禁。两面发布和回滚遵循 `docs/company-service-operations.md`；保留上一固定版本，回滚同时恢复 MCP 与插件来源。配置回滚单独恢复发布前记录的值。

老板审批关口不属于技术故障，继续由老板本人决定；本修复不代批内容。孤儿进程、磁盘归档、status-tunnel、防睡眠和 Paseo daemon 托管属于独立主机维护范围，未在本变更中修改。
