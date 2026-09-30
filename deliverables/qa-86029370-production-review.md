# LCA04 生产独立验收 · return（qa-devin-745198）

任务：86029370-a6cd-4548-9a58-89c824045f88。测试时间：2026-09-30 02:08–02:15 UTC。待验提交：6f74d38（PR #56）。

## 阻断问题：检索换票对全部有权成员确定性 503，功能主链路不可用

入口 `POST https://l.maplayer.top/api/session/content-search`（body `{}`）。

最小复现（真实 OIDC 登录 → `/api/session/switch-workspace` → 工作区 scope token）：

```
# sck-lca03-a-member（ws_26d695c309e5 participant，权益 lca03_acceptance 含 search）
POST /api/session/content-search {}
→ 503 {"error":{"code":"content-search-unavailable","message":"授权内容检索暂不可用"}}
```

实测矩阵（02:10–02:15Z，每个身份新签 token）：

| 调用者 | 结果 |
| --- | --- |
| A member（participant） | 503 content-search-unavailable，02:14:20–36Z 连续 3 次重试相同 |
| A admin | 503 同上 |
| B admin（ws_fdc9ddd0e47a） | 503 同上 |
| sck-lca03-nonmember | 403 `content-search-not_member`（正确的 fail-closed 拒绝，证明成员/工作区前置校验正常） |

对照证据（同账号同时段）：`POST /api/session/content-reader {contentPublicId:"qa-probe-nonexistent"}` → 403 `content-reader-content_not_published` —— 说明 _system 成员索引、workspace 会话、content projection 会话、权益快照、事实查询全部可达。失败点收窄在 search handler 独有的内部步骤：catalog 扫描（content_publication_projection，超界/缺 public_id 断言）、IdP content_reader 换票、或投影 UPSERT，请工程查 origin 日志定位。

期望：有权成员应得 `status:"ready"`+短期会话或 `status:"empty"`；真正的目录为空也应返回 empty 而非 503。当前主检索/阅读/定位链路在生产完全不可用，验收标准第 1、2、3、6 条无法通过。

## 已通过项（本轮实测）

- 发布链：Deploy production run 36657985291 headSha=6f74d38 SUCCESS（02:02:50Z）；/health status=ok surrealdb=up，uptime 与重启吻合。
- `legal_reference` 工作区表（A 库，participant 会话）：创建成功且 `created_by` 自动归因 member 本人 user 记录；显式冒名 `created_by=<admin user>` → 空结果（拒绝）；member 改/删 admin 的引用 → 空结果（拒绝）；note 4001 字符 → ASSERT 拒绝；改自己引用成功。
- 负路径：nonmember exchange 正确 403 not_member；不存在 publicId 的 reader exchange 403 content_not_published（fail-closed）。

## 未验证

内容检索/阅读/定位/分页/过滤/越权内容读取/收藏 UI 等全部依赖检索或阅读会话的功能项——被 503 阻断未验证；不冒充通过。配额扣减语义未验证。
