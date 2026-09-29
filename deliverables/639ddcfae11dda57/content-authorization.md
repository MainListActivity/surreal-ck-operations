# SCK-LCA-03 真实内容读取授权与生产验收样本

- 员工：product-grok-202946
- 任务：b068f582-dbef-4c97-8ce9-694fdb6104b4
- 目标：639ddcfae11dda57
- 分支：task/b068f582
- 原票 8 条验收标准不改、不关闭。
- 本轮只读核实并写下方案。没有新增许可、没有 UPDATE、没有复制、没有上线、没有对外联系、没有登记凭证。

结论：现有已发布内容全部不能作为客户 search、read、cite、export、research、generate 的允许样本。未知权利按拒绝。合成正文不计入真实内容。目标库 `platform_content` 今天没有内容表，下面的 public_id 都在源库；复制后必须再核对同一 id，不能把本文件当成目标库已经存在的证明。

## 查过的来源

1. 原票 `.scratch/legal-content-access/issues/03-authorized-content-reader.md` 的 8 条验收标准。
2. 就绪包 `deliverables/639ddcfae11dda57/production-readiness.md`（operations 提交 ef8306a6，任务 d5ba0dea）。
3. 产品仓库现行契约：`shared/sql/platform-content/001-content-schema.surql` 的许可修订不可 UPDATE/DELETE；`shared/src/platform-content/contracts.ts` 把来源动作限制为 submit、publish、withdraw、restore。读者草案 `task/86b409f0` 的 `006-content-reader.surql` 要求客户动作与 `license_actions` 相交，相交为空则拒绝。该读者代码未在本轮部署，也未在生产执行。
4. 仓库与 operations 交付物中没有另一份把客户读取动作写明的许可文件。
5. 2026-09-29 对生产 SurrealDB 做只读查询。命名空间 `main`，源库 `_system`。没有打印凭证，没有写库。

就绪包写「`platform_content` 不存在」。本次 `INFO FOR NS` 已能看到库名 `platform_content`，`INFO FOR DB` 的 tables 为空。库名在，内容表和行不在。源库仍是 `main` / `_system`。

## 源库事实

`_system`：content_item 1807，全部 publication_status=published（judicial_document 1783，legislation 24）。content_source_record 1806。content_source 9。source_license_revision 12。没有一条许可的 effective_until 有值。allowed_actions 里 search、read、cite、export、browse、research、generate 的条数为 0。

publication_event：published 1807，corrected 1，withdrawn 1，restored 1。后三件都是合成条目 `item_1ed1d85fab7843b0a91a95f82d02a32c`，发生在 2026-09-11T22:58Z，当前状态仍是 published。没有一篇真实内容处于撤回或许可到期。

没有 content_source_record 的唯一条目是 `debug_publish_probe`，来源版本指向合成来源，published。它不是真实内容。

最高修订与来源行上的 allowed_actions 一致。登记实现会对已有 `content_source` 做 UPDATE，同时 CREATE 新的 `source_license_revision`。所以不能对下面 9 个来源再登记一版来改客户权利，否则会改动现有来源行，并让该来源下全部条目改挂新的最高修订。

| source_key | 来源行 id | 最高修订 | 当前动作 | 已挂条目 |
| --- | --- | --- | --- | --- |
| flk.npc.gov.cn.legislation | content_source:4078cef8b0ec4dadac705723d51ad0a2 | 2，source_license_revision:082b35a6137448e4bd11b9ef9dd58fd2，2026-09-15T14:42:00Z | submit, publish | 法规 2 |
| court.gov.cn.guiding-cases | content_source:b9865fe6e5d54016b052c1acbfab9723 | 2，source_license_revision:27d7cae3bb6748e6bc0e56dbfef20e9c，2026-09-15T14:47:00Z | submit, publish | 司法文书 1292，kind=legislation 21 |
| ipc.court.gov.cn.judgments | content_source:fd29ca5a7a044485a4affa34e8c744ee | 2，source_license_revision:7382c605f1dc45fba7753810854667cd，2026-09-15T14:48:00Z | submit, publish | 司法文书 488 |
| fixture.synthetic.cn | content_source:481052908afa41d58fd738e818df81bd | 1，source_license_revision:3ce03fb458f34bf2bbd9a8744985cb33 | submit, publish, withdraw, restore | 来源记录 3；另有合成探针 |
| dyjfalk.court.gov.cn.case-summaries | content_source:89e441641ccc4aa5b57fb3a9d36e484c | 1，source_license_revision:45dec07abed24471b0dd1d2c8383b278 | submit | 0 |
| ipc.court.gov.cn.case-entries | content_source:47ad39199e534a4d904e4783058d68d0 | 1，source_license_revision:29a137187c36405fb9665424de516d61 | submit | 0 |
| rmfyalk.court.gov.cn.case-entries | content_source:e308734cbb214aa49e0a23e13738cfb6 | 1，source_license_revision:4097160591c14fbab2fecc8f9a27e028 | submit | 0 |
| spp.gov.cn.guiding-cases | content_source:b663a0ddfc3c490283451d50a403f599 | 1，source_license_revision:83307f4aefbf41c29568d4fc79a9ab3f | submit | 0 |
| spp.gov.cn.typical-cases | content_source:7f2b1e173d734fd8a8b6788fbb3056e6 | 1，source_license_revision:6170c1d287a94f9ea5a0e8bf38285721 | submit | 0 |

## 许可证据实际说了什么

证据在 `source_license_revision.evidence_text` / `evidence_url`，不是单独的许可文件。本轮没有重新打开这些外站页面。

三个已发布真实来源的修订 2 都写明：平台 publish 只覆盖正式法律、司法文件或裁判文书正文、官方译文和必要官方元数据，保留来源链接；不包含页面设计、图片、新闻、评论、数据库编排或第三方作品。依据是记录中的《著作权法》（2020 年修正）第五条第一项，以及来源页脚或数据库页面。修订 1 还写「用户已明确授权本平台登记来源并采集入库」，并写明不声明站点授予了批量接口或商业转载许可。

研究存档来源（多元解纷、知产法庭入库案例、人民法院案例库、最高检指导性案例和典型案例）只允许 submit。多元解纷的证据写明站点版权声明禁止侵权，登记不声称转载许可，且不作公开发布。这些来源当前没有条目。

合成来源的证据写明只用于 SCK-LCM-10 自动验收，不代表真实裁判文书，不可对外销售或作为法律内容提供。证据 URL 是 `https://example.invalid/sck-lcm-10/license`。

这些文字没有出现客户动作 browse、search、read、cite、export、research、generate。采集和平台发布许可不能推出客户读取、引用、导出或 AI 使用。本岗位不把第五条解释成客户权利，也不按本任务扩大第三方许可。

## 拒绝矩阵

下列锚点都是源库 `_system` 的当前版本（`item.current_version` 等于该 version）。客户六项动作全部拒绝。browse 同样拒绝，因此连元数据也不构成允许样本。

| 用途 | source_key | 许可修订 | item public_id | version public_id | 版本 | 标题 | search | read | cite | export | research | generate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 真实法规锚点 | flk.npc.gov.cn.legislation | 082b35a6137448e4bd11b9ef9dd58fd2 修订 2 | item_7f2161001cb94ad8868fcc02d089d44b | version_29b1f5f2b5904f6599aed917ac281133 | revision 1，2010年修正，full_text | 中华人民共和国著作权法 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 真实法规锚点 | flk.npc.gov.cn.legislation | 同上 | item_dfee35229a3949d485662e438c79eb99 | version_383e8648f29143a89aa9747f5fc62a6e | revision 1，2020年修正，full_text | 中华人民共和国著作权法 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 真实司法文件锚点 | court.gov.cn.guiding-cases | 27d7cae3bb6748e6bc0e56dbfef20e9c 修订 2 | item_8611b77897eb4198aed1870ed50161ff | version_000cfe210c26463cb6af5312c925ee7c | revision 1，full_text，kind=legislation | 最高人民法院关于适用《中华人民共和国反不正当竞争法》若干问题的解释 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 真实案例锚点 | court.gov.cn.guiding-cases | 同上 | item_fc41948315aa44489250eb75102f8a2f | version_00143aeb0b654ffeb2dcac6fe05d300f | revision 1，case_summary | 袁巧娥拒不支付劳动报酬案 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 真实裁判锚点 | ipc.court.gov.cn.judgments | 7382c605f1dc45fba7753810854667cd 修订 2 | item_63e576471cd346ffaff6a19de7647a78 | version_001afd656d164e72a2c8fce3664ead63 | revision 1，full_text | （2023）最高法知民终2573号 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |

同一来源的其余已发布条目使用同一条最高许可，客户六项动作同样拒绝。这里不把 1803 个其余 id 逐条展开。

排除，不能当真实内容，也不能当允许样本：

| public_id | 说明 |
| --- | --- |
| debug_publish_probe | 合成探针，published，无 content_source_record |
| item_0183b2e80b774190a858c8225511a3bd / version_545c21818b0e4bc19abac2c428cf2c6e | fixture.synthetic.cn |
| item_f24ac023c8514e2b96f5feca7a868dc6 / version_7b7492a29565490e8479c09d44eadf55 | fixture.synthetic.cn，version_label=fixture-v1 |
| item_1ed1d85fab7843b0a91a95f82d02a32c | 合成条目。修订 1 为 version_88bb608a246b4c4fa8ec6b3b8896c39e，当前修订 2 为 version_b67c0e19e3c54e0fb8ca7a5e6a9555d3。撤回后又恢复，现为 published |

允许样本：无。可撤回的真实样本：无。许可已到期的样本：无。

## 复制后的核验

源库标识：命名空间 `main`，数据库 `_system`。目标库名 `platform_content` 已出现，但没有表。复制若按就绪包只 CREATE 缺失行，客户动作不会变多。

复制完成后，在 `platform_content` 核对，并且 `_system` 行数不得变少：

- 上表 4 个有条目的 source_key、最高修订 id、allowed_actions、evidence_url 与源库一致。
- 五个真实锚点的 item public_id、version public_id、revision、publication_status 与本文件一致。
- 合成 public_id 仍标为合成，不能改记成真实允许样本。
- `content_migration_state` 若被写入，source_database 应为 `_system`。就绪包已说明源库没有删除语句；本轮未执行复制，也未在目标库看到内容表。

生产验收前若这些 id 在目标库不存在或修订不一致，不能用本文件代替实建结果。

## 以后才能新增的许可与专用样本

现在缺的事实：一份写明授予哪些客户动作、覆盖哪个来源、生效与截止时间的授权记录。现有 evidence_text 不是这份记录。要对外向全国人大、法院或检察院取得许可，或要公司作出法律承诺，才需要老板；本任务不需要，也不做。

在那份记录出现之前，工程不得把客户动作写进许可，也不得把现有 1807 篇改成允许样本。

记录出现之后，只做新增，并且只动专用来源：

1. 使用新的 source_key。不要对现有 9 个 source_key 调用会 UPDATE `content_source` 的登记。`source_license_revision` 保持只 CREATE；UPDATE/DELETE 会被 `immutable-platform-content-record` 拒绝。
2. 许可挂在来源上，最高修订对应该来源的全部条目。因此到期样本用单独的新来源，修订 1 就写上 effective_until，不要往最高人民法院或国家法律法规数据库来源上追加到期修订。
3. 允许样本用另一个新来源。修订 1 的动作只填写那份授权记录点名的客户动作。现行发布接口的动作枚举仍是 submit、publish、withdraw、restore，写不进客户动作；数据库字段虽是普通字符串数组，也不能靠绕过接口把未授权动作塞进去。
4. 撤回样本是允许来源上的另一篇专用条目，只追加 publication_event，并把该条目标成 withdrawn。不撤回源库里已有的 1807 篇。
5. 专用条目的正文必须来自授权记录覆盖的真实文件。`fixture.synthetic.cn` 和任何合成正文都不能填进这个来源。
6. 先在 `_system` 写完并读回 public_id、version、许可修订，再复制到 `platform_content`，用上一节的核对确认目标行。读者投影把该修订的动作抄进 `license_actions`；与客户动作不相交则继续拒绝。

8 条验收标准里，允许路径、许可到期和内容撤回仍然没有可执行的真实样本。本文件只确定现有数据的拒绝范围和以后的写法。
