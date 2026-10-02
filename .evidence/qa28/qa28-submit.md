# #28 qa-01 最终独立验收交付

执行员工 qa-01；真实会话 e65c81af-4f6f-43a4-8b2f-b35b90ffdbaf；中央队列 delivery 46cf1a16e21c4db0a32c69eb08fbd4d3。固定运行提交 **73198e3adb9f6e5644fc97e4bf264131dc9a98a5**，release 为 /Users/y/Library/Application Support/SurrealCKCompany/releases/73198e3adb9f6e5644fc97e4bf264131dc9a98a5。版本：pnpm 10.32.1，官方 MCP SDK client/server 2.1.0，surrealdb-js 2.0.8，Bun 1.3.11。以下 QA 于 2026-09-28 UTC 实跑；明确标注的 #27 证据系本人此前独立验收。合成写入限定 sck_agent_company_test/control_plane；真实交接只写公司服务目标库 sck_agent_company/control_plane；没有修改产品实现或客户库。提交给 gm；本人不自验 #28。

## 命令、脚本版本、结果

在固定 release 目录执行，均退出 0。/tmp 脱敏 QA 脚本只导入固定 release、使用真实 SurrealDB、官方 SDK 与 HTTP MCP；合成独立员工不冒充 B12 真实员工。

- rtk proxy bun /tmp/qa28-mcp-matrix.ts：最终 run f1815679，B01/B02/B03/B04/B05/B06/B07/B08 全部断言 PASS；SHA256：0ec85eb10de25a5d7270a5cf25fcbf7a26fca13b0835b070fdd778e3dcefc181。
- rtk proxy bun /tmp/qa28-mcp-fence.ts：run fa632600，旧 heartbeat/checkpoint/submit 被拒、版本未被旧写覆盖；SHA256：da9a102a3046e7e43147ad9b9066532e40147f65e49702cf1cf64f36e02f4ea8。
- rtk proxy bun /tmp/qa28-mcp-restart.ts：run 8be519df 和 92e922a1 均 PASS；真实 DB 上关闭/重建 MCP HTTP 服务及 DB 连接、重复 bootstrap；SHA256：1115d9ea64d21020c1c13afa64e7c4ef579155cf125bdc5dd2d3de726241a2b3。
- rtk proxy pnpm exec bun test tests/github-projector.test.ts tests/projector-worker.test.ts：4 pass、19 expect。固定版注入 GitHub 已接收但丢响应、重放及 worker 故障。正式 launchd restart 与真实 GitHub 投影状态丢失恢复，复用此前本人 [#27 独立验收](https://github.com/MainListActivity/surreal-ck-operations/issues/27)：4 个 Issue 映射、19 个 completedEvents 恢复一致，#33 当时一份 Issue/一条 created 评论，ready 200。
- rtk proxy bun /tmp/qa28-nontarget-fingerprint.ts：非目标 6 库 schema metadata SHA256 前后同为 3a90f2364d213382227793f4f65089508e4aef11461c0437dff8fe0f2e37a8f6。
- rtk proxy bun /tmp/qa28-nontarget-counts.ts：一次隔离库创建/领取/checkpoint/提交及服务两次重建前后，只读非目标 6 库/123 表，schema+各表行数 SHA256 均为 ad161f5c057b6abead10901fc8b8d6bf1d7e72380ba7f53e0883ebbeb83d5e3a。没有输出客户记录。
- rtk proxy bun /tmp/qa28-final-readonly.ts：目标库审计只读摘要，已知 root/员工 token 日志存在性检查和私有文件权限；退出 0。
- rtk proxy sh scripts/company-service.sh status；rtk proxy lsof -nP -iTCP:38473 -sTCP:LISTEN；rtk proxy curl -fsS http://127.0.0.1:38473/ready：最终 running PID 94206，仅 127.0.0.1:38473 监听，返回 ready。service.env 与两位员工 token 文件均 0600；日志 knownSecret=false、Bearer=false；未输出秘密值。

## B01—B12 独立结果

| 项 | 结果 | 输入与证据 |
| --- | --- | --- |
| B01 | PASS | #27 正式常驻服务官方客户端 initialize/tools/list/get_context，9 工具；本轮真实 HTTP 合成服务无 token/错 token=401、异常 Host/Origin=403，官方 SDK 列 9 工具。 |
| B02 | PASS | get_context 员工身份来自凭证；普通员工 create_task/resume_task=forbidden，cs 跨岗位 claim=forbidden。 |
| B03 | PASS | 两独立 QA SDK 客户端并发 claim 同任务，恰一位成功；另建 A/B，同岗两员工分别同时领不同 task ID，均成功。 |
| B04 | PASS | 有效 heartbeat；TTL=1 秒过期后 heartbeat/checkpoint 拒绝；替代员工领取提高 fence，旧 heartbeat/checkpoint/submit 均拒（conflict/lease_expired），版本未被旧写覆盖。 |
| B05 | PASS | create 同键同 payload 返回同 task，同键不同 payload=conflict；submit 旧版本=conflict，同键同 payload 重试返回同 version，同键不同 payload=conflict。#24 核心幂等/outbox 曾由本人独立验收，本轮补 MCP 实际调用。 |
| B06 | PASS | submitter 自己 claim review=self_review；同一稳定员工凭证换新的 MCP 会话仍=self_review；独立合成员工可 accept。真实 #33 由 cs 提交、qa 验收。 |
| B07 | PASS | 合成员工有活动租约时受控管理员撤销凭证；下一 HTTP 请求 401，已建立 SDK 客户端 submit 失败，无该员工成功写入。 |
| B08 | PASS（约定范围） | 子任务初始 blocked，report_blocker 持久，GM resume，父任务独立 accept 后子任务 ready。任务撤销/归档未实现且不在 #24/#25 冻结契约，**该子项不标 PASS**；员工凭证撤销见 B07。 |
| B09 | PASS | #27 正式服务 restart/ready/投影恢复；本轮隔离真实 DB 的 MCP 服务关闭/重建、DB 重连、重复 bootstrap：doing 任务和 checkpoint version 保留，原独立凭证可继续 submit 至 review，再重建后 review/version 保留。 |
| B10 | PASS（组合证据） | 固定版 projector/worker 故障注入 4 pass/19 expect；#27 由本人实测常驻 worker 丢本地投影状态后从 DB outbox 恢复，4 映射/19 事件无重复；#33 真实 GitHub 最终 CLOSED，6 条事件评论对应 create/claim/checkpoint/submit/review-claim/accept，无重复。未人为造成 GitHub 公网实际中断；丢响应由确定性测试替身注入。 |
| B11 | PASS（可观察边界） | 合成脚本明确只用测试 ns/db；非目标 6 库/123 表 schema+行数只读指纹在合成写入前后相同。正式服务仅 loopback；私有配置/凭证 0600；当前日志无已知 root/员工 token 或 Bearer。行数摘要不能检测等量内容改写；脚本无非目标写入口，未读取客户内容。 |
| B12 | PASS | cs-01 真实 Paseo 会话 6f12e1c5-6cec-4d94-aef1-2f6c57a9aad4 活动记录含本人正式客户端 list/get_context/claim_next/heartbeat/checkpoint/submit。任务 8b233ba6-f6aa-48be-849f-f8f20579f1a0 / [#33](https://github.com/MainListActivity/surreal-ck-operations/issues/33) 在 cs 提交后 review/version4。本人以 qa-01 独立私有凭证正式客户端 claim_next 得 review/version5/fence2/delivery 8c4bd74a-3d79-4bc9-ab10-ef4a23224e33，审阅接入回执后 review decision=accept 至 done/version6。目标 DB 审计逐版本：gm create v1；cs claim/checkpoint/submit v2–4；qa claim/accept v5–6。#33 现 CLOSED。 |

真实员工命令形式：固定 release 目录下设置 SCK_MCP_URL=http://127.0.0.1:38473/mcp，SCK_EMPLOYEE_CREDENTIAL_FILE 指向各自 0600 私有文件，执行 rtk proxy env ... pnpm run mcp:client -- list，以及 call get_context、claim_next、heartbeat、checkpoint、submit、review。本人仅使用 qa 文件路径，未使用 cs 凭证。cs 的回执含实际岗位、允许动作、命令与返回版本的脱敏摘要、遇到问题，未见 secret；DB 审计与 Issue 投影吻合。

结论：按经理明确的 B08 范围，B01—B12 均有上述独立证据，正式服务最终 running/ready。B10 公网故障通过确定性注入与真实 outbox 恢复组合验证；B11 指纹覆盖 schema/行数而非客户内容。请 gm 独立验收本 #28。
