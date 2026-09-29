# SCK-LCA-03 G3 最终验收

- 目标：639ddcfae11dda57（standard）
- 整理：gm-devin-5220d6
- 日期：2026-09-29

## 1. 结论

SCK-LCA-03 已上线生产：工作区获授权成员用独立短期 `content_reader` 凭证，在真实页面打开了正式法律内容（著作权法 2020 官方文本）；无权限成员、伪造内容 ID、直连数据库均被拒绝。QA 在生产对票内 8 条验收标准逐条实测通过，运营验收已通过。

## 2. 已上线提交与生产入口

| 项 | 值 |
| --- | --- |
| surreal_ck 当前生产 | `0024dbe453ce8e1fb2ed147ddbd6f3a1598054e3`（Deploy production run `36562025056`，2026-09-29T11:29Z） |
| QA 实测基线 | `d9db533`（Deploy run `36538080967`；0024dbe 仅多含 PR #43 权益指针修复） |
| IdP（ma_hono） | main `f93441ec81bffc21b35e45616fc17ad1fa2a66b6`（PR #2，树=80e7f83）；CI 部署版本 `939d1c0f`（run `36538952172`）；当前线上版本为随后手动部署 `7428d597`（行为实测等价，树一致性未逐项核对） |
| 内容库 | `platform_content` 已从 `_system` 冻结复制并校验（`content_migration_state:legacy` verified，18 表行数一致；`_system` 未删改） |
| 生产入口 | https://l.maplayer.top/w/sck-lca03-a/content/version_b26c8be35f0948058a85055f81dacb1a |
| 应用健康 | https://l.maplayer.top/health → `status=ok`、`surrealdb=up`（经理复核） |

## 3. 老板验收步骤

1. 打开 https://l.maplayer.top ，经 IdP `https://o.maplayer.top/t/ck` 登录测试成员账号 `sck-lca03-a-member`（密码为公司登记的 `LCA03_A_MEMBER_PASSWORD`，员工侧用 `get_secret` 领取，值不落盘）。
2. 进入工作区 `sck-lca03-a`，打开入口链接。
3. **应看到**：「法律内容 · 独立授权阅读」页——标题《中华人民共和国著作权法（2020年修正）第一条至第五条（SCK-LCA-03 正向允许样本）》、版本 `2020年修正 · #1`、来源 `https://flk.npc.gov.cn/detail?id=ff808081752b7d430175e4766bab1557`、授权状态「当前已授权读取」、内容指针 `version_b26c8be35f0948058a85055f81dacb1a`、正文条文全文。页面背后发生的是：浏览器用工作区 token 向 `POST /api/session/content-reader` 换得 900 秒短期 `content_reader` 凭证，再以该凭证直连 `platform_content` 读正文。
4. 负向抽查（可选）：以成员 token 调 `POST /api/session/content-reader` 换伪造 `contentPublicId` → 403 `content_not_published`；不带 token → 401；用非成员或已移除成员账号打开同一 URL → 拒绝且无正文。

## 4. QA 与运营结论

- **QA 生产实测**（任务 `7c9fb60c`，qa-devin-de39f8，独立 accept）：8 条 AC 全部线上逐条实测——四类身份换票 200 且 token 为 `ac=content_reader`/`db=platform_content`/TTL≤900s/无 RL 放大；投影 digest 与换票一致，未绑定/许可过期/撤回分别 `collection_denied`/`license_expired`/`content_withdrawn`；RECORD 权限下 UPDATE/DELETE/INSERT 零行、DDL 拒、workspace admin 的 Owner 角色不进内容库；ego-browser 真实页面渲染正文；browse/search/read/cite/export 允许、research/generate/ai_use 拒、隐藏字段与 metadata-only 权益下正文剥离；过期 token 物理拒读、撤权在上限内收敛；两工作区/成员角色/移除重加/错误 revision/过期 token/投影更迭矩阵全过。
- **运营验收**（任务 `d012d14d`，product-devin-016290 提交，gm-devin-5220d6 复核 accept）：验收记录 `deliverables/639ddcfae11dda57/acceptance.md`（分支 task/d012d14d @ `0288609b`）；运营本人以测试成员登录生产页面复验正/负向关键路径，与 QA 一致。
- **许可核实前置**（任务 `b068f582`）：1807 条既有内容均不能作客户读取允许样本；专用 `lca03-allow`/`lca03-expiry` 来源按经理决定登记 `browse/search/read/cite/export`（research/generate 不登记），允许样本正文为官方正式文本。

## 5. 已知限制与回滚方式

已知限制（均不阻断验收）：
- 「连接保持后逐查询收敛」超过 15 分钟墙钟未做长等待实测；租约上限链已核对并实测过期/撤权拒读。
- ops sources 读视图 `effective_until` 显示异常（enforce 不受影响，已另案记录）。
- 换票失败经 Cloudflare 时曾丢 JSON 错误体，已改 503+应用层 JSON（PR #41）。
- 1807 条迁移内容均无集合绑定 = 继续拒绝（正确语义）；允许样本仅 `lca03_acceptance` 集合下专用条目。
- IdP 当前版本 `7428d597` 系 CI 后一次手动部署，与已验收树的严格一致性未核对（行为实测等价），如有疑义可回滚至 CI 版本 `939d1c0f`。
- `platform_content` 内 `qa.lca03.vocab.probe` 来源（11 词、inactive）为 QA 词表探针残留，不产生授权。

回滚方式：
- 应用侧：Actions 手动运行 Deploy origin，sha 填上一通过 Quality gate 的提交，并重跑该提交的 Deploy production 对齐前端。
- IdP 侧：`wrangler rollback` 回上一版本 `939d1c0f`（即 PR #2 树）；更早可回 `5f914aa8`（构建 `af796251`，无 content_reader）。
- 数据库迁移为只新增结构，`platform_content` 不随代码回滚删除；`_system` 源数据在复制中未删改。
