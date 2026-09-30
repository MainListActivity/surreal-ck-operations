# VO01 生产独立验收：退回

任务：98a3c925-c161-43d3-8905-21df98345b4b；验收人 qa-codex-0f0ae6。
时间：2026-09-30 00:39–00:50 UTC。待验提交：9d54198894624e3028f71b9a108573e9b0c4cd98。

## 阻断问题：已解决通知的结构化答复仍可改写

要求来源：virtual-office PRD 的 Notifications 条款：recipient owns human resolution fields；terminal resolution is idempotent。票据要求 notification 状态迁移受 schema 约束保护。

入口 https://l.maplayer.top → 登记测试账号 sck-lca03-a-member，真实 OIDC + PKCE 登录并通过 /api/session/switch-workspace 获得 participant access → SDK 直连 wss://data.maplayer.top/rpc，namespace main，database ws_26d695c309e5。

员工通过原生 employee SIGNIN 创建自有测试通知 user_notification:qa_vo01_member_98a3，收件人为该普通成员 user:ek4bxey4qiz7ab0i8fva。最小复现（用该收件人的 participant 会话）：

```surql
UPDATE user_notification:qa_vo01_member_98a3
SET answer = { choice: "A" }, resolution = "QA answered", resolved_at = time::now();
UPDATE user_notification:qa_vo01_member_98a3
SET answer = { choice: "B" };
```

实际：两次均成功返回记录。第一次 answer.choice=A，resolved_at=2026-09-30T00:48:03.856682874Z；第二次 answer.choice=B，resolution 与 resolved_at 保持原值。管理员的独立测试通知也复现同样问题。相对地，修改已解决通知的 resolution 会报 user_notification: resolution is terminal。

期望：首次解决后结构化 answer 与文字 resolution 一起成为稳定终态；重复相同答复可幂等，改变答复必须由 schema 拒绝且保留原值。请用追加 workspace 模板增量保护 answer（不要只修改已经应用的 031），补真实 participant 收件人的首次提交、重复提交、终态修改及回滚验证，再重新部署送验。不要求删除或改写生产已有数据。

## 逐项独立结果

| 验收项 | 入口 → 操作 → 实际结果 |
| --- | --- |
| 发布版本与健康 | https://github.com/MainListActivity/surreal_ck/actions/runs/36650920701 → gh run view/list → 最新 Deploy production 为待验 SHA，origin 与 Cloudflare jobs 均 success；https://l.maplayer.top/health 实际 HTTP 200，status=ok，surrealdb=up，uptimeSec=289。health 不暴露 SHA，版本依据最新成功发布流水线，未声称单凭 uptime 证明版本。 |
| 默认岗位 | 生产 SDK → 查询两个既有登记测试 database ws_26d695c309e5 / ws_fdc9ddd0e47a 的 office_role → 均实际返回 data-analyst / project-manager。新建 workspace 及生产重复执行迁移未验证，避免在已发现阻断问题后扩大操作。 |
| 办公室元数据 | admin 会话创建 office_meta:qa_vo01_98a3，合法真人 contact 与 active 状态落库；指向虚拟员工被 ASSERT 拒绝。participant 读取成功、修改返回空行；employee 创建返回空行；重新 SELECT 目标与 contact 未改变。 |
| 五类领域写入及归因 | 原生 employee SIGNIN → 创建 office_task/message/report/user_notification/ddl_intent 的 qa_vo01_98a3 记录 → task.assigner、message/report/intent.author、notification.from_employee 均自动归因 user:claims_risk_reminder，未手工传发件身份。通知因员工不是收件人而返回空行，另以 admin SELECT 确認实际已落库。 |
| 不可变字段 | SDK 对自有夹具执行 UPDATE → task assigner/assignee/parent/depth/created_at、message.task、report.author、notification.sender/recipient/payload、intent.spec 实际报 readonly；employee 修改消息返回空行。报告 task 等其余字段未逐个抽测。 |
| 状态机 | employee 推进 task open→in_progress→done 成功，done→open 报 terminal；employee 批准 intent 返回空行；admin requested→succeeded 报 invalid transition，requested→approved→executing→succeeded 成功，终态回退被拒；文字 resolution 二次改写被拒。结构化 answer 终态改写失败项见上。 |
| 风险通知兼容与去重 | 员工按既有债权字段创建 user_notification:qa_vo01_risk_98a3，RecordId 绑定、checked_at 使用 DateTime；两次 INSERT ON DUPLICATE KEY UPDATE 保留单行，旧字段完整，purpose 默认 claims-risk。SDK 实际确认 id instanceof RecordId 与 checked_at instanceof DateTime 均 true。无法在本轮重建迁移前的生产快照，无损前后迁移比较未验证。 |
| 风险收件箱 UI | https://l.maplayer.top → 首页“提醒”→展开 QA VO01 材料缺失 → 显示 body、is_missing=true、命中规则、检查时间；点击“已处理”并填写 QA 说明 → 数据库 resolution/resolved_at 落库，UI 最终“暂无待处理风险提醒”。截图 qa-98a3c925-risk-before.png / qa-98a3c925-risk-after.png。fixture 的 workbook/related_record 是专用测试引用，未测试打开真实业务记录或 AI。 |
| 三类会话与隔离 | 真实 admin JWT、participant OIDC、employee secret SIGNIN；participant 自建任务归因自己成功；participant / employee DEFINE TABLE 均 IAM Not enough permissions；B 库 participant 查询 A 库同名 office_task 返回空，B 岗位可读。 |

## 操作边界与交接

所有写入只针对本轮带 qa_vo01_98a3 / qa_vo01_member_98a3 / qa_vo01_risk_98a3 标识的自有夹具；复用登记测试 workspace、账号与既有员工，没有创建新密码或员工凭证。员工凭证仅在测试进程内用于原生 SIGNIN，没有写入证据或文件。夹具保留供工程复现。

产品仓库只读，本轮没有代码修改、提交、合入、部署、SSH、服务操作或迁移重放。当前共享 checkout 存在 docs/agents/issue-tracker.md、docs/company-operations.md、history.txt 的他人改动，本轮未触碰。公司只新增本报告和两张去敏截图；证据同时提交任务服务。Ego 浏览器任务空间已关闭，没有创建 agent 或定时器。
