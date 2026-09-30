# VER01 返工生产独立复测

任务 d6f76d02-f020-4f69-877c-8bb7b5e395c5，员工 qa-codex-feef6e，2026-09-29 23:26–23:40 UTC。结论：return；前次缺省上下文故障已修复，另发现已完成 run 在终态缓存过期后的重复续跑无终态。未证明新发现问题由 PR #52/#58 引入。

## 版本

待验合入：aeedef3d3e77bc496de46c31c7d6104a9c6d39f2（含79e0d23 seam和2863c06修复）。最新成功发布 https://github.com/MainListActivity/surreal_ck/actions/runs/36643291371；独立读 origin job109660339753 日志：23:06:21Z从79e0d23-ci36600170972切到aeedef3-ci36643291371，23:06:51Z release healthy。23:27:01Z health HTTP200 status=ok/surrealdb=up。以CI激活日志和修复行为确认发布链；health不含SHA，未独立读取当前主机进程SHA，未按uptime推断版本。历史首次发布失败和TiKV/rocksdb切换属前任证据，本人未操作基础设施。

## 修复与正常路径（生产）

- https://l.maplayer.top → 新OIDC登录登记A管理员 → iat1790724401、ws_26d695c309e5/admin；数据库已连接，1个工作簿、3位成员、动态可读。
- POST /api/chat，只有message=帮我打开名为未命名工作簿的工作簿 → HTTP200，run69ff051f-7514-43f0-9e2b-4921444e83d1；WS progress/routing、agent-step navigationAgent、chunk、done、关闭1000。done的默认快照route.screen=unknown/contextHint=未提供页面上下文。旧缺省崩溃已通过复测。
- 同接口contextSnapshot={} → HTTP400/chat-context-invalid，在启动前拒绝。
- 使用新PKCE登录并调用应用switch-workspace后，A admin、A participant、B admin分别23:33:35–40Z authenticate成功；B participant于23:37Z使用新scope authenticate成功。库为A=ws_26d695c309e5、B=ws_fdc9ddd0e47a。初始IdP token的_system/madocs不是工作区scope，未切scope的认证失败不当产品故障。
- SDK正确使用new Table("workbook")查询：A admin/participant各看到workbook:eb65071e2a90ac0c（未命名工作簿），B admin/participant为空。早期SDK string参数探针返回undefined映射已纠正，不把它当业务数据。
- 三身份并发只读导航：A admin run040ca654-e1ab-42f9-a941-a16658979309，A member rune99afc7a-6a11-4f28-ac07-e8f7ee92ae7c，B admin run1a2dd60d-2bde-4949-aa07-8a408143a67f；全部progress/chunk/done，A找到A工作簿，B未找到，没有混入A工作簿。不把模型文字声称打开当真实页面跳转证据。
- 错误streamToken → WS1008/stream-forbidden，无数据；A member对A admin run提交合法candidate-cancelled → HTTP403/chat-run-forbidden。
- A/B member并发resource-search → 各自manual-research suspend：A run6d290fe8-260a-405f-943c-86102a087c88/session research_session:ezwwp5xdbgxwa9r00w0g；B run6a039f36-9533-4277-a625-6b36a8ad6456/session research_session:klr88ipcmw3bwxuwl1op。SDK用各自真实participant会话与StringRecordId回查：A创建者user:ek4bxey4qiz7ab0i8fva，B创建者user:romd88k7o9w7xwd8q50n；各库看不到对方session。证明并发真实写入分别入各自db，调用者归因正确。
- 两个并发测试run随后各提交candidate-cancelled → HTTP200，均done/WS1000，首次暂停恢复通过。

## 新失败：缓存过期后的重复恢复

入口 https://l.maplayer.top/api/chat/runs/63b907b8-b8b6-4948-add4-fc06c321518e/resume。

步骤：
1. A participant启动resource-search，不存在的自有测试关键词VER01_QA_20260929；收到manual-research suspend，创建research_session:1nhuy3dxvqtt60fge5y5。
2. 同一用户提交decision={kind:"candidate-cancelled"}。23:36:25Z HTTP200、WS重放progress/suspend后done，关闭1000。
3. 原run已经完成；超过60秒终态缓存窗口后，仍用同用户有效participant scope提交相同decision。23:39:31.391Z再次HTTP200并取得新stream票据。
4. WS连接成功；23:39:57.124Z仅收到ping。截至23:40:11.321Z（40秒）无done/error、连接未关闭。此前一次重复调用也在15秒观察窗口无终态，浏览器评估超时；该超时不是产品错误码。
5. 同时用真实A participant SDK SELECT workflow_run，确认原run status=success、state.status=success、workflow_name=routerWorkflow。

期望：已完成run重复恢复应明确返回已完成结果（HTTP或流终态），避免再次执行副作用，同时客户端能结束等待；不能HTTP200发新票后永远只心跳。复测时至少覆盖终态TTL前后、重连和同一决定重复提交。

源码提示（读取，不当生产根因证明）：shared CHAT_STREAM_TERMINAL_RETENTION_MS=60000；run-bus在subscribe时清除过期终态；assemble-mastra defaultResumeWorkflow对持久success直接返回而不重新发布终态，chat-service.resumeChat也不把resumer返回值转换为done。组合与观察一致，工程需独立定位并判断引入提交。

## 原验收条款分开记录

1. 所有tool共享seam：源码读到四个DB tool模块从execution-context导入getSurrealSession；生产导航和resource分支通过。未对其余业务tool做生产全量操作。
2. 缺会话fail-closed：共享helper源码会抛错、无root/service兜底；独立本地相关测试通过。未在生产内部注入缺会话。
3. 并发会话隔离：上述生产A/B查询、研究session创建及归因/互查通过。
4. 最小employee run：独立本地execution-context测试使用makeSession假对象通过，不代表真实employee access生产运行。生产A库有1个virtual user，但未领取其secret或执行employee SIGNIN；未验证真实employee run。
5. Router/tool-session/暂停恢复/归因测试：本地全server470pass/25skip/0fail（独立pnpm --filter @surreal-ck/server run test，worktree HEAD2863c06）；生产首次暂停恢复、流事件、成员归因通过；超过TTL重复恢复失败。25个skip不能视为通过。

platform_content content_reader认证本轮未完成：未定位登记内容公开指针，不能声称已全面恢复。此前经理提出的A/B admin/participant矩阵已完成。

## 测试数据和权限

复用登记sck-lca03-a-member测试账号，以B测试管理员经/api/workspaces/sck-lca03-b/members新增该账号的B participant成员，displayName=QA VER01 B participant，不修改其A角色。复用原有A_MEMBER凭证，没有新建密码；新增成员及三个research session仅为自有测试夹具，保留供复现。workflow快照由真实调用者会话自动写入。没有修改/删除生产既有业务记录、schema、root凭证、SurrealDB服务或数据目录；产品worktree保持干净。公司只新增本去敏报告；不包含任何密码、OIDC token或stream票据。
