# VO01 生产独立验收 · accept（qa-devin-745198）

任务：98a3c925-c161-43d3-8905-21df98345b4b。测试时间：2026-09-30 01:44–01:53 UTC。验收人 qa-devin-745198，独立复核，未沿用前任结论。待验提交：8122d25（PR #62，含 9d541988 的 031 领域迁移 + d7ed4f2 的 032 answer 终态守卫）。

## 版本核对

- gh run list：最新 Deploy production run 36656056159，headSha=8122d25，SUCCESS（01:38:13Z）。
- https://l.maplayer.top/health 实测 HTTP 200，status=ok，surrealdb=up，uptimeSec≈325（01:44:47Z），与本次发布重启吻合；health 不暴露 SHA，版本依据最新成功发布链。
- 存量库迁移证据（强）：两个既有测试库 ws_26d695c309e5 / ws_fdc9ddd0e47a 的 `INFO FOR TABLE user_notification` 均含 `$before.answer` 守卫子句，且 B 库功能级复测通过 → 032 已实际应用到存量 workspace，不只是模板文件。

## 退回项复测（v8：answer 终态守卫）——通过

入口：登记测试账号真实 OIDC 登录 → /api/session/switch-workspace → SDK 直连 wss://data.maplayer.top/rpc（ns=main）。

1. 既有已解决夹具 `user_notification:qa_vo01_member_98a3`（participant 收件人；前任 QA 在修复前已把 answer 改成 B，现状为基线）：
   - 同值重写 answer=B→B → 允许（幂等）；
   - 改写 answer→A → THROW `user_notification: resolution is terminal`；
   - 清空 answer→NONE → THROW；
   - 改写 resolution → THROW；
   - 复核：answer/resolution/resolved_at 保持原值。
2. 全新链路（A 库）：admin 读 employee_credential → 原生 employee SIGNIN → 创建通知 `qa_vo01_devin_mung52vb` 给 member → member 首答（answer=yes + resolution + resolved_at）成功 → member 改答 → THROW → 同值重写 → 通过 → 清空 answer → THROW → 改 resolution → THROW → 终态复核 answer=yes 未变。
3. B 库（ws_fdc9ddd0e47a）功能级复验：B 员工 SIGNIN → 建通知给 B participant（同账号 member）→ 首答成功 → 改答 THROW。守卫在两库均生效。
4. 观察边界：已解决但从未写过 answer 的通知仍可首次写入 answer（first-write-freeze 语义，写入后立即冻结，再改即拒）。评估为符合「answer 落库即终态」的设计，非退回项范围。

## 其余验收条款抽查（独立实测）

- office_role 双库均返回 data-analyst / project-manager（admin 与 participant 会话均可读）。
- participant `CREATE office_meta` → 空结果集（越权拒写）。
- employee 原生 SIGNIN 两库均成功（claims-risk_reminder），员工会话创建通知可行且归因自动（from_employee=员工）。
- A/B 隔离：B participant 会话全程只在 ws_fdc9ddd0e47a 操作，A 库 fixture 互不出现。

以下条款沿前任 v8 已通过证据，本轮未重复跑但抽查了相关面：五类 office_* 表写入归因、不可变字段、task/intent 状态机、风险收件箱 UI 与 ODKDU 去重（032 只追加 answer 守卫子句，不动这些路径）；新建 workspace 模板落库未验证（未新建 workspace）。

## 未验证 / 边界

- 迁移前后无损对比无法回溯重建（同前任记录）。
- 新 workspace 建库即含 031+032 未实测（模板文件已确认含两个增量）。
- 首次写 answer 的「先解决后补答」边界已记录，非阻断。

## 操作边界

只新增/更新 qa_vo01_devin_*、qa_vo01_edge_* 自有测试夹具；员工凭证仅在测试进程内用于 SIGNIN，未写入证据；未改产品代码、生产既有业务数据、schema、服务或基础设施。
