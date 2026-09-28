# 公司运行手册 v3

## 组成

| 组件 | 位置 | 作用 |
|---|---|---|
| 任务服务 | launchd `org.surrealck.company-mcp`，`127.0.0.1:38473/mcp` | 任务、租约、审计、目标、关口；GitHub 投影 |
| 调度器 | launchd `org.surrealck.company-dispatcher` | 不消耗模型 token：读队列、叫醒/新开员工、续租、收回并改派、订阅健康、老板通知 |
| 员工 | Paseo 会话 | 按 [协议](../agents/PROTOCOL.md) 领取、执行、交接 |
| 数据 | SurrealDB `sck_agent_company/control_plane` | 唯一事实来源 |

数据位于**产品同一台自托管 SurrealDB**（连接地址与 root 凭证读自 `SCK_PRODUCT_ENV` 指向的产品 `.env`，当前 `wss://data.maplayer.top/rpc`）；公司数据独占 `sck_agent_company` namespace / `control_plane` database，与产品 `main` namespace 隔离。换库或换实例改 `service.env` 的 `SCK_COMPANY_NS` / `SCK_COMPANY_DB` 或 `SCK_PRODUCT_ENV`。

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

- **员工定义** `employee_def`：`role`（六任务岗位 + `eval` 评审）、`provider`（codex / grok / devin）、`model`、`thinking`，可选 `max_instances`（默认 1）、`weight`（派工权重，默认 10）、`enabled`。可直接写库，例如：

  ```sql
  UPSERT employee_def:engineering-grok CONTENT { role: 'engineering', provider: 'grok', model: 'grok-4.7', thinking: 'medium', max_instances: 2, weight: 25 };
  ```

  或 `pnpm run admin def set|list|weight|enable|disable`、`pnpm run admin seed-defs`（写入默认 21 个定义：七岗位 × 三订阅）。

- **派工权重**：同岗位多个合格候选（空闲实例或可新开的定义）按 `weight × 绩效系数` 加权随机选取；`weight=0` 不会被主动选中（同岗位所有候选都是 0 时才均匀分配）。绩效系数 = `clamp(avg_score/3, 0.3, 2)`，尚无评分时为 1。调权：`pnpm run admin def weight <id> <n>`，或直接改 `employee_def.weight`——下一轮 tick 生效，无需重启。

- **绩效评分**：任务进入 done 后进入评审。默认走 **Jev**（TypeSafe System One 决策模型）：调度器进程内一次 HTTPS 调用（约 70–500ms，每任务一次往返），把任务审计时间线和行为指标作为 state，让 Jev 对每位参与者打 1–5 分 × 5 维度（quality / evidence / discipline / timeliness / overall），同时返回逐题**校准置信度**与概率分布，写入 `scorecard`（`judge='jev'`）并滚动更新 `avg_score`。
  - Jev 不信任自己拿不准的判断：任一题 confidence < `jev_min_confidence`（默认 0.7）→ 不记分，任务升级给 `eval` 岗位的 LLM 评审员做深审；Jev 调用连续失败 3 次（`eval_attempts`）同样升级。
  - Jev 对每位参与者另问一条风险 noul：概率 ≥ `jev_flag_threshold`（默认 0.65）→ scorecard 标 `flagged` 并给老板收件箱写一条提醒（是否弹窗再由 Jev 分诊）。
  - `eval_engine`：`auto`（默认，Jev 优先、LLM 兜底）/ `llm`（只用 LLM 评审员）/ `jev`（只用 Jev，低置信度也记录）。
  - 没有 Jev key 时整条 Jev 通道自动关闭，行为与原来一致（LLM 评审员兜底）。
  - 查看：`pnpm run admin scores [任务ID]`、`pnpm run company status`。关闭评审：`pnpm run admin config eval_enabled false`。
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
| `redispatch_minutes` | 15 | 派工后多久未领取可改派（评审派工同样受该去重窗口约束） |
| `paused` | false | 暂停派工（也可用 `company pause`） |
| `eval_enabled` | true | 任务完成后是否自动评审打绩效分 |
| `eval_engine` | auto | `auto`=Jev 优先 LLM 兜底；`llm`=只用 eval 员工；`jev`=只用 Jev |
| `jev_min_confidence` | 0.7 | Jev 单题置信度下限，低于则升级 LLM 评审（auto） |
| `jev_flag_threshold` | 0.65 | Jev 员工风险标记阈值，达到则提醒老板 |
| `jev_notify_triage` | true | 系统提醒是否先经 Jev 分诊再决定弹窗（提醒始终进收件箱） |

## 排障

- 调度日志：`logs/stdout-dispatcher.log`、`logs/stderr-dispatcher.log`；只在有变化时写入一行 `tick {...}`。
- 订阅状态：`pnpm run company status`，或查询 `SELECT * FROM provider_health`。
- 手动让某订阅立即重试：`UPDATE provider_health:<provider> SET until = 0;`（下一轮只派一个探测任务）。
- 任务历史：经理员工 `get_task_history`，或查询 `SELECT * FROM audit WHERE task = task:<id> ORDER BY at`。
- 绩效记录：`pnpm run admin scores [任务ID]`；员工定义均分 `SELECT id, weight, avg_score, scored FROM employee_def`；想给某任务重新评审：`UPDATE task:<id> SET evaluated_at = NONE;`。
- **Jev 接入**：在 `private/service.env` 加 `JEV_API_KEY`（也可用 `TYPESAFE_API_KEY`）即启用；可选 `JEV_BASE_URL`（默认官方 `https://api.typesafe.ai/v1/systemone`，托管计费网关为 `https://jevtypesafeai.com/api/v1/decide`）、`JEV_MODEL`（默认固定 `jev-1.13.0`，避免阈值漂移）。key 从 TypeSafe 早期访问 waitlist 或托管网关获取。验证连通性：`pnpm run admin jev-test`。Jev 不产生文本输出，scorecard 的 `notes` 为空，判据与置信度在 `probabilities`/`confidence` 字段。
- devin 订阅不接受 `thinking=low`（`paseo run` 报 AGENT_CREATE_FAILED）；devin 定义请用 medium/high。定义连续 spawn 失败 3 次会自动停用，修正后 `pnpm run admin def enable <id>` 恢复。
- 不想让某类员工再接任务但保留定义：`pnpm run admin def weight <id> 0`（软停用，全部候选为 0 时仍可能兜底）；彻底停用用 `def disable <id>`。

## v2 归档

`scripts/queue.py`、`agents/registry.json` 与 GitHub 标签队列只用于收尾 v2 旧工单（#23、#28 等），新工作一律进入任务服务。启动任务 #3—#16 已由老板决定取消。

## 上线记录

- 2026-09-28：v3 上线，发布 `af63565`（`releases/<sha>`，`active` 指向当前版本）。写入 18 个默认员工定义；gm-01、product-01、eng-01、eng-02、ai-01、qa-01、cs-01 挂到各自的 `*-codex` 定义上，身份与历史保留。旧 Paseo 定时巡检 `d747edb8` 已到期，额度巡检 `cc85bb8f` 已暂停，由调度器取代。启动任务 #3—#16 已按老板决定取消（not planned）。
- 演练 A（GitHub #34）：调度器派 qa-01 执行 → checkpoint → submit → 自动派 eng-01 独立验收 → done。
- 演练 B（GitHub #35）：codex 并发临时设为 0，调度器按定义新开 `cs-grok-9d59da`；它存下 ALPHA 进度后会话被强制归档。约 25 秒内调度器退役该实例并撤销凭证、收回租约并附交接包、新开 `cs-grok-580043` 接手；接手者读到 ALPHA 与交接包，跳过已完成步骤存下 BETA 并提交；`qa-grok-5dfd5a` 独立验收通过。旧凭证调用返回 401。
- 未在真实环境演练的路径：真实订阅额度耗尽（错误文本分类、冷却与探测恢复由集成测试用模拟网关覆盖），所有订阅耗尽时的充值提醒。
