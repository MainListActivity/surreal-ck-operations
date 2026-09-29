# VER01 生产独立验收（qa-codex-feef6e）

任务：d6f76d02-f020-4f69-877c-8bb7b5e395c5。测试时间：2026-09-29 22:18–22:24 UTC。

结论：建议 return。存在可复现的生产 Router 失败路径；尚未证明此缺陷由 PR #52 引入。

## 发布证据与限制

PR #52 merge=79e0d23b3082284b8e8fb5d38f4e5babb4883b0b。独立 gh run list/view 显示最新 Deploy production 为 https://github.com/MainListActivity/surreal_ck/actions/runs/36600170972，origin 和 Cloudflare 均 success；独立 Deploy origin 列表未见其后的成功手动发布。生产 health 无 SHA，仅此不能证明实际进程精确提交；不能用 uptime 推断版本。当前发布链对应目标版本，实际进程 SHA 未独立核实。

## 实测

- https://l.maplayer.top → 新 OIDC 登录登记 A admin 测试账号 → ws_26d695c309e5/admin，令牌 iat=1790720321；页面数据库已连接、1 个工作簿、3 位成员、动态可读。22:19:24Z /health HTTP 200，status=ok，surrealdb=up。仅证明 A admin 路径恢复。
- 首页 AI 助手 → 发送“帮我打开名为未命名工作簿的工作簿” → 返回找到工作簿 workbook:eb65071e2a90ac0c；截图 qa-d6f76d02-router-production.png。没有验证实际发生页面导航，不能把模型声称“已打开”当导航证据。
- https://l.maplayer.top/api/chat → 登记 A admin 调用，JSON={"message":"帮我打开名为未命名工作簿的工作簿"}，省略路由类型声明为可选的 contextSnapshot → HTTP 200，随后通过返回的 runId/短期 streamToken 连接 /api/chat/stream；连续两次仅收到 progress/routing 与 error(code=chat-failed,message=[object Object])，无 done，WS 关闭 1000。runId：a498af9f-0f8e-44c9-996b-c852afc646a7；e814c7ba-31db-4fbf-82db-ba7ec4eb2fc6（22:22:30Z）。证据不含任何 token。
- 同一调用补全 contextSnapshot={route:{screen:"home"},workbook:null,sheet:null,selectedRow:null,contextHint:"当前在应用首页"} → runId=1ff6c403-c71c-4823-954f-4d3e442a5f61，22:23:15Z：HTTP 200，progress/routing、progress/agent-step navigationAgent、多条 chunk、done 正常，WS 1000。故障范围收窄到省略上下文路径；此对照不证明根因或引入提交。

期望：可选字段缺省时使用默认上下文并正常完成，或若协议要求必传，则在启动前明确 400 校验并更新合同；不能先 200 启动再返回不透明 chat-failed。工程需复核目标版本与前版的差异，修复或提供已有缺陷的独立处置安排后再提交。

## 原验收标准覆盖

1. 全部 tool 共享上下文 seam：PR 文件清单与描述已核对，未对目标版本全量源码审计/本地重跑；生产只读 navigation 路径成功，不外推到所有 tool。
2. 缺少会话 fail-closed/无身份兜底：未生产注入缺会话；PR 报告单测通过不是本轮独立实测。
3. 两个不同会话并发查询/写入隔离：未验证。
4. 最小 employee run 只读 tool：未生产验证。
5. Router/tool session/暂停恢复/调用者归因：导航带上下文流通过；可选上下文缺省路径两次失败；暂停恢复和写入归因未验证。

A participant、B admin/participant、platform_content content_reader 新令牌认证未验证。测试遇到失败后按岗位规则交回，不宣布 JWT 全面恢复或整个票通过。

无产品代码变更，无 schema 或生产既有数据改写，无主机/SurrealDB 服务操作。只新增此去敏报告与截图。
