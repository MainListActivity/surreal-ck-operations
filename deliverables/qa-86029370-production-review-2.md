# LCA04 生产独立验收 · return（qa-devin-9fdf3f，第二轮）

任务：86029370-a6cd-4548-9a58-89c824045f88。实测 2026-09-30 02:52–03:50 UTC。
待验提交：b305fcb8c2bb408bc92103c4b90e2f01af51629b（PR #64）。独立核实：Deploy production run 36661160188 headSha=b305fcb SUCCESS（origin + Cloudflare 双 job）；`GET /health` → `{"status":"ok","surrealdb":"up"}`。前任 qa-devin-745198 退回的 content-search 503 已解除。

方法：真实 OIDC+PKCE（IdP https://o.maplayer.top/t/ck）→ `/api/auth/token` → `/api/session/switch-workspace` → `/api/session/content-search|content-reader` 换票 → surrealdb-js 2.0.8 直连 `wss://data.maplayer.top/rpc`；UI 用 ego-browser（生产账号 sck-lca03-a-admin）。截图：deliverables/shots-86029370/。

## 阻断一（AC4/AC6）：「已保存的引用」列表对所有用户确定性不可用

`web/src/screens/ContentEntryScreen.svelte:25` 的 loadSaved 查询：

```surql
SELECT id, content_public_id, content_version_id, title, locator, note
FROM legal_reference ORDER BY created_at DESC LIMIT 100
```

`created_at` 不在 SELECT 投影中，生产引擎 3.3.0-native-quota.1 必然抛 `Missing order idiom 'created_at'`（与上轮 503 同一约束，修复只覆盖了服务端 catalog 扫描，漏了这条前端查询）。

生产复现（真实会话逐字执行）：
- A admin（JWT）与 A member（participant）会话均返回 `Parse error: Missing order idiom 'created_at' in statement selection`；同一查询补选 `created_at` 后正常返回 2 行。
- 浏览器实测（admin）：https://l.maplayer.top/w/sck-lca03-a/content 两次完整加载与一次 SPA 导航，「已保存的引用」区始终显示 `工作区引用卡片暂不可用`（截图 search-results-savedlist-error.png）。

影响：引用卡片能写入但不能被界面列出——本票「把引用卡片及批注保存到工作区」的用户可见闭环不成立，验收标准第 4、6 条无法通过。

修复建议：`SELECT id, created_at, ... ORDER BY created_at`（补进投影即可）。建议顺带 grep 全仓同类「ORDER BY 未投影字段」模式，本轮发现的在 content-search 链路仅此一处（其余新查询 `ORDER BY local_key`/`id` 均已投影）。

## 阻断二（AC6）：换票失败原因码在 UI 层被吞，「缺少授权」伪装成「平台不可用」

服务端拒绝响应形状是 `{"error":{"code":"content-search-not_member",...}}`；而 `web/src/lib/content-search-browser.ts` 与 `content-reader-browser.ts` 只识别 `{ok:false, error}` 形状：

- 检索页：任何 403/400 拒绝（not_member / member_removed / entitlement_absent / entitlement_expired / action_denied）→ fetch 分支落空抛错 → `open()` catch → `searchStatus="unavailable"` → 界面显示「内容平台暂不可用，请稍后重试」。无授权工作区成员会被引导反复重试，且把权限语义误报为平台故障。
- 阅读页：403 `collection_denied` → 客户端归一为 `idp_rejected` → `messages` 无该键 → 兜底「当前授权不允许读取，请返回工作区后重试」。实测打开未授权 publicId `version_dfbb6725079947589823926b82b35b3c` 显示兜底文案而非「当前权益不包含该内容集合」（截图 denied-reader.png）。`content_withdrawn`、`member_removed`、`entitlement_expired` 等全部专用文案同理不可达。

验收标准第 6 条要求界面区分「无结果 / 缺少授权 / 平台不可用 / 部分覆盖」，当前拒绝侧全部塌陷为不可用/兜底。修复建议：exchange 客户端按 `body.error.code` 的 `content-search-`/`content-reader-` 前缀映射回 ContentReaderError，或服务端返回 `{ok:false,error}` 形状。

## 已通过项（本轮实测）

| 验收点 | 入口 → 操作 → 结果 |
| --- | --- |
| 换票链路（前任 503 阻断解除） | member/admin/removable POST /api/session/content-search → 200 `ready`，content_reader.v1，lease≈876s，db=platform_content；reader token claim ac=content_reader、workspace_id、entitlement_revision 正确 |
| 关键词/类型/日期/法域/效力过滤 | member reader 会话跑 CONTENT_SEARCH_QUERY：keyword 著作权→1/探针→1/正文词「艺术」「作品」「本法」→命中正文（标题无该词）/不存在词→0；kind legislation/judicial_document 各归位；published_on 区间、jurisdiction=中国大陆/美国、effective_on 均正确；count 与行数一致 |
| 分页游标 | cursor=第一行 RecordId → 返回第二行；cursor=末行 → 空集；结果行含 version_id/public_id/revision/version_label/source_url/published_on/jurisdiction/effective_on |
| 详情与法条定位 | POST /api/session/content-reader（著作权法 publicId）→ 200；页面查询返回正文（226 字，source_form=excerpt）；legal_article_version 3 条（第一/二/五条）按 local_key 排序，UI 阅读页渲染全文+条文锚点+精确版本/来源/指针 |
| 授权强制与无泄露 | 存在但未授权 publicId（version_dfbb67… 未绑定集合、version_383e86… 不在 lca03_acceptance）→ 403 collection_denied 无任何元数据；伪造 publicId → 403 content_not_published；body 带额外字段 → 400 client_authority_rejected；reader 会话直接 SELECT 未授权 version → 0 行、`fn::content_reader_action` → false；content_item/content_source/ingestion_batch/content_publication_projection 全 0 行可见；gate/projection 仅本工作区 2+1 行；DDL（DEFINE TABLE）与写入均被引擎硬拒 |
| 引用卡片写入（AC4 数据面） | member participant 会话 CREATE legal_reference：created_by 自动归因本人 user 记录；显式冒名 created_by=admin → 拒绝（空结果）；body_text 走私 → SCHEMAFULL 拒（"no such field"）；note 4001 字 → ASSERT 拒；改自己引用成功；member 改/删 admin 的引用 → 空结果（拒绝），admin 原值不变；UI 阅读页选法条定位+写批注保存 → 落库 locator=article:art-1（legal_reference:khbvyulmwzwdpct0r1pa） |
| 越权与成员边界 | nonmember switch-workspace 到 A → 403 workspace-forbidden；member token 调 /api/content/* 运营端点 → 401 ops audience invalid（服务端/运营检索权限不混入调用者会话） |
| UI 状态（正向） | 检索页展示结果计数、类型/版本/日期/法域/效力/来源；「部分来源未提供…相关过滤结果可能不完整」部分覆盖提示正确出现（探针条目缺 effective_on） |
| 票据收口 | main 上 03、04 两票 Status 均为 done |
| AI 额度 | 检索/阅读/引用保存链路（exchange→projection→facet/version/legal_reference 查询）无 Mastra/LLM 参与，代码层面无额度扣减点；生产未观察到计量写入 |

## 观察项（不判阻断）

- content-search 换票端到端约 24–25s（catalog 扫描 + IdP 换票 + 投影 UPSERT），功能正确但明显偏慢，繁忙期须防超时错觉。
- `content_read_gate` 对 content_reader 会话全表可读（按 workspace_id 过滤仅限函数层），可见其他工作区 gate 行的 version 记录 ID——不含内容字段，注意后续是否收敛。
- `SELECT count() FROM content_search_facet GROUP ALL`（无 WHERE）在 3.3 引擎返回 0 而非可见行数——低计数方向，不泄露；应用内带 WHERE 的 count 正确。

## 未验证项

- 撤回内容的 reader 换票（content_withdrawn）与「新发布滚动出现/引用指向原版本」的生产实测：本轮凭证内无平台运营身份（/api/content/* 需 ops audience token），无法在生产执行撤回/发布。新发布自动进入检索已由 09-29 发布的 QA 探针条目出现在检索结果中间接证明。
- member_removed 换票路径：sck-lca03-a-removable 当前仍是 A 库有效成员（exchange 200 ready），未做禁用后复测。
- 保存失败的配额超限分支（workspace 配额打满）未构造；AI 额度变化无从观测（无计量表可读）。

## 边界说明

仅使用登记测试账号与 ws_26d695c309e5；新增测试夹具：legal_reference 三条（QA 前缀 note）与运行期投影行（功能正常写入）。未修改生产既有数据、schema、服务或凭证；产品仓库只读；凭证不入证据。
