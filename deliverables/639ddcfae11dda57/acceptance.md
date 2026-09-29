# SCK-LCA-03 运营验收记录

- 目标：639ddcfae11dda57（standard）
- 验收人：product-devin-016290
- 验收日期：2026-09-29
- 结论：**通过**。老板原始输入逐条满足，QA 生产实测 8AC 全过，本人已在生产用登记测试成员独立复验正/负向关键路径。

## 老板原始输入核对

> 完成 surreal_ck 的 SCK-LCA-03 实施票并发布到生产：工作区获授权成员通过独立短期内容读取凭证，在真实页面打开一篇已发布法律内容；无权限成员不能以直连数据库或伪造内容 ID 绕过。

| 要求 | 结果 |
| --- | --- |
| 发布到生产 | surreal_ck main `d9db533c9f44364c636a0e36dd3787b1d167d3f5`，Deploy production run `36538080967` success；IdP ma_hono PR #1（head `8edc9474`）部署为 Worker `2445b4aa` |
| 获授权成员用独立短期凭证在真实页面打开已发布法律内容 | 实测通过（见下「本人复核」）：页面渲染、换票返回 `content_reader.v1` 短期 token（lease≤900s） |
| 无权限成员不能直连数据库或伪造内容 ID 绕过 | 伪造内容 ID 换票 → 403 `content_not_published`；未认证 → 401；QA 实测非成员/移除成员/直连 DML·DDL 全拒 |
| 票内全部验收标准 | QA 生产实测 8AC 逐项通过（见下） |

## 交付内容

- **换票**：Workspace Scope Module `POST /api/session/content-reader`，校验身份/成员关系/工作区/权益后经 IdP `/scope`（`content_reader.v1`）签发短期 `content_reader` token；不替换工作区 token，不接受客户端指定 revision。
- **隔离内容库**：`platform_content` 独立 SurrealDB database；内容经 `origin-pre-start.sh` 冻结复制钩子从 `_system` 一次性迁移（钩子已修可重入，标记 verified 后短路）。
- **权限模型**：`content_reader` RECORD access，schema 表/字段 PERMISSIONS 强制；权益投影 digest/revision 严格匹配；许可动作交集（来源 `allowed_actions` ∩ 权益 ∩ 发布状态 ∩ 集合绑定）。
- **阅读页**：`/w/<slug>/content/<contentPublicId>` 最小正文阅读页，显示版本、来源、授权状态。
- **许可词表**：`source_license_revision.allowed_actions` 扩展至 11 词（4 运营动词 + browse/search/read/cite/export + research/generate）。
- **集合绑定**：publish 管道事务内写 `content_collection_binding`（幂等、审计失败回滚）。
- **修复**：成员重加索引双行 500、pointWorkspace 回指缺陷均已修复上线。
- **IdP**：ma_hono `/scope` content_reader 签发（闭集 claims、三层 allowlist 默认拒绝、TTL≤900s、审计事件）。

交付链：PR #30（merge `a31900e`）→ #38 迁移钩子可重入 → #39 成员重加修复 → #40 集合绑定 → #41 换票错误映射 → #43 权益指针回指 → ma_hono PR #1。关联核实文档：`content-authorization.md`（分支 task/b068f582，许可矩阵与专用样本方案）、`production-readiness.md`（就绪任务提交 ef8306a6）。

## 生产入口与验收步骤

**入口**：`https://l.maplayer.top/w/sck-lca03-a/content/version_b26c8be35f0948058a85055f81dacb1a`

步骤（老板/验收者可照做）：

1. 打开 `https://l.maplayer.top`，经 IdP `https://o.maplayer.top/t/ck` 登录测试成员账号 `sck-lca03-a-member`（密码用 `get_secret` 领 `LCA03_A_MEMBER_PASSWORD`，values 不落盘）。
2. 进入工作区 `sck-lca03-a`，打开上述入口 URL（或工作区内容入口进入）。
3. **应看到**：「法律内容 · 独立授权阅读」页，标题《中华人民共和国著作权法（2020年修正）第一条至第五条（SCK-LCA-03 正向允许样本）》，精确版本 `2020年修正 · #1`，来源 `https://flk.npc.gov.cn/detail?id=ff808081752b7d430175e4766bab1557`，授权状态「当前已授权读取」，内容指针 `version_b26c8be35f0948058a85055f81dacb1a`，正文条文渲染。
4. 负向抽查：以成员 token `POST /api/session/content-reader` 伪造 `contentPublicId` → 403 `content_not_published`；无 token → 401；非成员/被移除成员账号登录后打开同一 URL → 拒绝且无正文。

## QA 实测结论（任务 7c9fb60c，2026-09-29 生产逐条实测，独立 accept）

- AC1 四类身份换票 200（contractId=`content_reader.v1`、expiresInSeconds=900；夹带 revision → 400 `client_authority_rejected`）。
- AC2 投影交集（digest `sha256:0040f3…` 与换票一致；未绑定→`collection_denied`、许可过期→`license_expired`、撤回→`content_withdrawn`）。
- AC3 RECORD 边界（读成功；UPDATE/DELETE/INSERT 零行；DDL 拒；RL=Owner 不越权）。
- AC4 浏览器真实页渲染正文。
- AC5 动作/字段边界（browse/search/read/cite/export 允许；research/generate/ai_use 拒；隐藏字段空；metadata-only 权益下正文剥离）。
- AC6 租约收敛（TTL≤900s、token exp=leaseEnd、过期 token authenticate 拒、rev4 token 在 rev5 撤权后被拒）。
- AC7 控制面隔离（内容库仅三个 access、客户写投影零行、审计只记 claim 名）。
- AC8 矩阵（两工作区/成员角色/移除重加/错误 revision/过期 token/投影更迭/许可过期/撤回/DDL·DML 拒）。

## 本人复核（2026-09-29，生产，独立于 QA）

- `GET /health` → `status=ok`、`surrealdb=up`。
- 以登记测试成员 `sck-lca03-a-member`（sub `0a06e1a6-a01c-411e-a5a6-fc368da83770`，client `b10df483`）登录态打开入口 URL → 页面渲染标题/版本/来源/授权状态/正文，与 QA 记录一致。
- 持 workspace-scoped token（`db=ws_26d695c309e5`、`ac=participant`）调 `POST /api/session/content-reader`：
  - allow 样本 → 200，`contractId=content_reader.v1`、`database=platform_content`、`digest=sha256:0040f36899785ea7cafea014af12f18ca82bf2247cc6bf385e1696a53c580b02`（与 QA 投影记录一致）、lease 字段齐全。
  - 伪造 `contentPublicId` → 403 `content_not_published`；无 bearer → 401。
- IdP discovery `https://o.maplayer.top/t/ck/.well-known/openid-configuration` → 200；IdP Worker 部署版本 `2445b4aa`（wrangler deployments 实测），回滚版本 `5f914aa8` 存在。
- 注：用 `oidc.user` 里的原始登录 token（无 workspace 上下文）换票会得 `workspace_inactive` 403——这是正确拒绝，不是缺陷；应用走 `oidc.access_token` 中切换工作区后的 token。

## 已知限制

- >15 分钟墙钟「连接保持逐查询收敛」未做长等待实测（上限链已核对）。
- ops sources 读视图 `effective_until` 显示异常（enforce 不受影响，另案记录）。
- 换票失败经 Cloudflare 时 502 会丢 JSON——已改 503 + 应用层 JSON（PR #41）。
- 内容库现有 1807 条迁移内容全部无集合绑定=继续拒绝（正确语义）；客户读取允许样本仅 `lca03_acceptance` 集合下的专用条目。
- `research`/`generate` 动作按经理决定一律不登记（保留 AI 拒绝侧）。

## 回滚方式

- 应用侧：Actions 手动运行 Deploy origin，sha 填上一通过 Quality gate 的提交，重跑该提交的 Deploy production 对齐前端。
- IdP 侧：`wrangler rollback` 至 `5f914aa8`（或对 `af796251` 重发）。
- 数据库迁移为只新增结构（platform_content 表、access、复制数据），**不随代码回滚**；回退后旧代码仍可用既有结构。`_system` 源数据在复制迁移中未删除。
