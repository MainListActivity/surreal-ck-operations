# 公司运行手册 v3

## 组成

| 组件 | 位置 | 作用 |
|---|---|---|
| 任务服务 | launchd `org.surrealck.company-mcp`，`127.0.0.1:38473/mcp` | 任务、租约、审计、目标、关口；GitHub 投影 |
| 调度器 | launchd `org.surrealck.company-dispatcher` | 不消耗模型 token：读队列、叫醒/新开员工、续租、收回并改派、订阅健康、老板通知 |
| 员工 | Paseo 会话 | 按 [协议](../agents/PROTOCOL.md) 领取、执行、交接 |
| 数据 | SurrealDB `sck_agent_company/control_plane` | 唯一事实来源 |

服务目录：`~/Library/Application Support/SurrealCKCompany/`（`active` 指向固定发布目录；`private/` 为配置与凭证，0700；`logs/` 为日志）。安装、启停：发布目录内 `sh scripts/company-service.sh install|status|restart|stop|uninstall`，默认同时管理两个服务，用 `SCK_COMPONENTS=dispatcher` 只操作调度器。服务依赖本机 Paseo、SurrealDB、网络与 GitHub 登录；调度器以 `caffeinate -i` 运行，Mac 合盖或关机时公司暂停。

## 老板入口

三种方式等价，都会写入 `owner_command` 表，由调度器（或命令行本身）执行：

1. **命令行**（在发布目录 `~/Library/Application Support/SurrealCKCompany/active` 下）：

   ```
   pnpm run company goal "我要一个 B2C 商城"
   pnpm run company inbox
   pnpm run company approve <任务ID> [意见]
   pnpm run company reject <任务ID> <意见>
   pnpm run company reply <任务ID> <回答>
   pnpm run company direction "先服务律师团队"
   pnpm run company pause | resume | status
   ```

2. **直接写 SurrealDB**（`sck_agent_company/control_plane`）：

   ```sql
   CREATE owner_command CONTENT { kind: 'goal', text: '我要一个 B2C 商城' };
   CREATE owner_command CONTENT { kind: 'approve', task: '<任务ID>', text: '同意' };
   CREATE owner_command CONTENT { kind: 'reject', task: '<任务ID>', text: '需要修改：…' };
   CREATE owner_command CONTENT { kind: 'reply', task: '<任务ID>', text: '回答：…' };
   CREATE owner_command CONTENT { kind: 'direction', text: '公司方向…' };
   CREATE owner_command CONTENT { kind: 'pause' };   -- 或 'resume'
   ```

   执行结果回写在同一行的 `status`（applied / failed）和 `result`。

3. **在 Paseo 里直接和经理说**：经理用 `create_goal` / `set_direction` / `record_owner_decision` 转录，并逐字记录你的原话，审计来源为 `gm-relay:<经理编号>`。

安全边界：本机所有 AI 员工都有完整权限，数据库 root 与老板命令行没有密码学隔离；老板身份靠审计来源和协议约束，不是防伪机制。

## 员工编制（SurrealDB）

- **员工定义** `employee_def`：`role`、`provider`（codex / grok / devin）、`model`、`thinking`，可选 `max_instances`（默认 1）、`priority`（越小越优先）、`enabled`。可直接写库，例如：

  ```sql
  UPSERT employee_def:engineering-grok CONTENT { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', max_instances: 2, priority: 20 };
  ```

  或 `pnpm run admin def set|list|enable|disable`、`pnpm run admin seed-defs`（写入默认 18 个定义：六岗位 × 三订阅）。
- **员工实例**：`employee` 表中带 `def` 的记录，由调度器按需生成（身份 + 独立凭证 + Paseo 会话），`paseo_agent_id` 记录实际会话。会话报错或关闭即退役并撤销凭证；同一定义连续 3 次异常会自动停用并通知老板。`pnpm run admin inst list` 查看。
- 旧员工（gm-01 等）以 `admin bind <员工编号> <agentId> <def>` 挂到定义上，继续保留身份和历史。

## 运行参数

`company_meta:config`（`pnpm run admin config <key> <json>` 或直接写库）：

| 键 | 默认 | 含义 |
|---|---|---|
| `max_running` | 4 | 同时运行的员工会话上限 |
| `provider_max` | `{codex:3, grok:2, devin:2}` | 每个订阅同时运行上限 |
| `poll_seconds` | 20 | 调度间隔 |
| `stall_minutes` | 90 | 无 checkpoint 多久视为卡死 |
| `redispatch_minutes` | 15 | 派工后多久未领取可改派 |
| `paused` | false | 暂停派工（也可用 `company pause`） |

## 排障

- 调度日志：`logs/stdout-dispatcher.log`、`logs/stderr-dispatcher.log`；只在有变化时写入一行 `tick {...}`。
- 订阅状态：`pnpm run company status`，或查询 `SELECT * FROM provider_health`。
- 手动让某订阅立即重试：`UPDATE provider_health:<provider> SET until = 0;`（下一轮只派一个探测任务）。
- 任务历史：经理员工 `get_task_history`，或查询 `SELECT * FROM audit WHERE task = task:<id> ORDER BY at`。

## v2 归档

`scripts/queue.py`、`agents/registry.json` 与 GitHub 标签队列只用于收尾 v2 旧工单（#23、#28 等），新工作一律进入任务服务。启动任务 #3—#16 已由老板决定取消。

## 上线记录

- 2026-09-28：v3 上线，发布 `af63565`（`releases/<sha>`，`active` 指向当前版本）。写入 18 个默认员工定义；gm-01、product-01、eng-01、eng-02、ai-01、qa-01、cs-01 挂到各自的 `*-codex` 定义上，身份与历史保留。旧 Paseo 定时巡检 `d747edb8` 已到期，额度巡检 `cc85bb8f` 已暂停，由调度器取代。启动任务 #3—#16 已按老板决定取消（not planned）。
- 演练 A（GitHub #34）：调度器派 qa-01 执行 → checkpoint → submit → 自动派 eng-01 独立验收 → done。
- 演练 B（GitHub #35）：codex 并发临时设为 0，调度器按定义新开 `cs-grok-9d59da`；它存下 ALPHA 进度后会话被强制归档。约 25 秒内调度器退役该实例并撤销凭证、收回租约并附交接包、新开 `cs-grok-580043` 接手；接手者读到 ALPHA 与交接包，跳过已完成步骤存下 BETA 并提交；`qa-grok-5dfd5a` 独立验收通过。旧凭证调用返回 401。
- 未在真实环境演练的路径：真实订阅额度耗尽（错误文本分类、冷却与探测恢复由集成测试用模拟网关覆盖），所有订阅耗尽时的充值提醒。
