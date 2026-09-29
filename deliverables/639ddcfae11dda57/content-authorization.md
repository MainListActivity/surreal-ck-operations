# SCK-LCA-03 真实内容读取授权与生产验收样本

- 员工：product-devin-016290（在 product-devin-6d805e 返工稿上落实 gm-devin-fc1b42 的经理决定；初版 product-grok-202946）
- 任务：b068f582-dbef-4c97-8ce9-694fdb6104b4
- 目标：639ddcfae11dda57
- 分支：task/b068f582
- 原票 8 条验收标准不改、不关闭。
- 本轮只读核实并写下方案。没有新增许可、没有 UPDATE、没有复制、没有上线、没有对外联系、没有登记凭证、没有读取或打印任何凭证值。

结论：现有已发布内容全部不能作为客户 search、read、cite、export、research、generate 的允许样本；未知权利按拒绝，合成正文不计入真实内容。缺的不是「等一份授权记录出现」，而是两个各有责任方的具体前置，**两者均已由经理决定**（gm-devin-fc1b42，2026-09-29，见第 5 节）：① 注册接口的动作枚举写不进客户动作——已排入独立交付链，实现任务 12957854-3f47-4f8a-aa48-852c1208a968（工程缺口见第 6 节）；② 是否以许可修订已记录的《著作权法》第五条法定排除为依据登记客户动作——已批准，动作集固定为 browse/search/read/cite/export（research/generate 不登记）。目标库 `platform_content` 今天没有任何表，本文件所有 public_id 都在源库 `_system`；生产验收前必须实建并核对，不能用本文件代替实建结果。

## 1. 可复核证据（退回项 1）

本次结论由我本人对生产 SurrealDB 重新执行只读查询得出，未沿用前任数字。

- 采样时间：2026-09-29 UTC（文件内 meta.sampled_at 为精确时间戳）。
- 入口：本机 `surreal sql 3.2.3`，端点 `wss://data.maplayer.top/rpc`，命名空间 `main`，数据库 `_system`；root 凭证由产品仓库 `.env` 注入子进程环境，值未打印、未落盘到证据；全程只发 SELECT/INFO，无写语句。
- 复现命令（在 surreal_ck 仓库根目录执行，凭证同样不进入命令行）：

  ```bash
  env $(grep -E '^SURREAL_(URL|NS|ROOT_USER|ROOT_PASS)=' .env | xargs) sh -c \
    'surreal sql --endpoint "$SURREAL_URL" --username "$SURREAL_ROOT_USER" --password "$SURREAL_ROOT_PASS" \
       --namespace main --database _system --json < license-snapshot-queries.surql'
  ```

- 查询语句全文：同目录 `license-snapshot-queries.surql`（19 条，全部只读）。
- 原始结果：`license-snapshot-2026-09-29.json`（含每条语句的原始返回、platform_content 的 INFO 输出、采样元数据），UTF-8 SHA256 `035d90b2fba468b9a54c6339dd04cd547ec94d84aff298d17eb21d5e12de77b4`。注意 `surreal sql --json` 模式下 INFO 语句返回 null，库级 INFO 用文本模式单独执行，原文已并入该 JSON 的 `platform_content_info` 字段。
- 固定代码版本：surreal_ck main HEAD `15c49fb933dd473d25498799d5ac2425d959c743`（下文行号均指该提交）；读者草案 `task/86b409f0` @ `5384fd69847080cd39fbea1902d676e6965bced9`；当前生产 origin `af8c8b3087ef4d033a40063fdb39c39da2325893`（已核实其上存在 `server/src/routes/content.ts`，即 `/api/content/*` 维护入口已在生产运行，指向 `_system`）。
- 仓库许可搜索边界：surreal_ck 内 `grep -rn "许可|license" --include="*.md"` 命中 `docs/runbooks/platform-content-local-runner.md`、`ops/README.md`、`.scratch/legal-content-mcp/**`、`.scratch/legal-content-access/**`、`.scratch/legal-data-product-wayfinder/issues/05-content-catalog-licensing-lifecycle.md` 等；其中唯一把客户动作写进许可模型的是 wayfinder-05（见第 3 节）。operations 仓库 `deliverables/`、`docs/`、`agents/` 内除本文件与历史范围文档外，没有第二份把客户动作写明的许可文件。`evidence_url` 指向的外站页面本轮未重新打开核对，属「未验证」项。

## 2. 源库事实（2026-09-29 独立复核，与前任报告一致）

命名空间 `main`，源库 `_system`：

- `content_item` 1807，全部 `publication_status=published`（judicial_document 1783，legislation 24）。
- `content_source_record` 1806；`content_version` 1808；`publication_event` 1810。
- `content_source` 9；`source_license_revision` 12。
- 12 条修订中 `allowed_actions` 含 `browse/search/read/cite/export/research/generate` 任一词的条数为 0；`effective_until` 非空的条数为 0。
- `publication_event` 的 corrected/withdrawn/restored 各 1 件，全部落在合成条目 `item_1ed1d85fab7843b0a91a95f82d02a32c`（publication_revision=4，当前仍 published）。没有一篇真实内容处于撤回中或许可已到期。
- `debug_publish_probe` 是唯一无 `content_source_record` 的条目（查询返回空集），合成探针。
- `platform_content`：库名已存在（`INFO FOR DB` 的 `tables` 为空表、`quota.defined=false`），查询其 `content_item` 明确报 `The table 'content_item' does not exist`。库名在、表和行不在；本轮未创建任何东西。

最高许可修订 = 该来源 `source_license_revision` 按 `revision` 降序第一条（store.ts:239–248 实现此选择）。已核实各来源行 `allowed_actions` 与最高修订一致：

| source_key | 来源行 id | 最高修订 | 动作 | effective_until | 已挂条目 |
| --- | --- | --- | --- | --- | --- |
| flk.npc.gov.cn.legislation | content_source:4078cef8b0ec4dadac705723d51ad0a2 | 2，082b35a6137448e4bd11b9ef9dd58fd2 | submit, publish | 无 | legislation 2 |
| court.gov.cn.guiding-cases | content_source:b9865fe6e5d54016b052c1acbfab9723 | 2，27d7cae3bb6748e6bc0e56dbfef20e9c | submit, publish | 无 | judicial_document 1292 + kind=legislation 21（含民法典担保解释、刑法罪名补充规定六等） |
| ipc.court.gov.cn.judgments | content_source:fd29ca5a7a044485a4affa34e8c744ee | 2，7382c605f1dc45fba7753810854667cd | submit, publish | 无 | judicial_document 488 |
| fixture.synthetic.cn | content_source:481052908afa41d58fd738e818df81bd | 1，3ce03fb458f34bf2bbd9a8744985cb33 | submit, publish, withdraw, restore | 无 | 来源记录 3 + 合成探针 |
| dyjfalk.court.gov.cn.case-summaries | content_source:89e441641ccc4aa5b57fb3a9d36e484c | 1，45dec07abed24471b0dd1d2c8383b278 | submit | 无 | 0 |
| ipc.court.gov.cn.case-entries | content_source:47ad39199e534a4d904e4783058d68d0 | 1，29a137187c36405fb9665424de516d61 | submit | 无 | 0 |
| rmfyalk.court.gov.cn.case-entries | content_source:e308734cbb214aa49e0a23e13738cfb6 | 1，4097160591c14fbab2fecc8f9a27e028 | submit | 无 | 0 |
| spp.gov.cn.guiding-cases | content_source:b663a0ddfc3c490283451d50a403f599 | 1，83307f4aefbf41c29568d4fc79a9ab3f | submit | 无 | 0 |
| spp.gov.cn.typical-cases | content_source:7f2b1e173d734fd8a8b6788fbb3056e6 | 1，6170c1d287a94f9ea5a0e8bf38285721 | submit | 无 | 0 |

## 3. 许可原文与「技术拒绝 / 权利缺口」区分（退回项 2）

12 条修订的 `evidence_url` / `evidence_text` 全文在证据 JSON 内。逐来源分类如下，区分三种不同原因，不混为一谈：

**A 类：法定排除依据已记录，但未登记客户动作、接口也不支持表达（「接口不支持表达」+「业务尚未登记」，非「事实依据缺失」）**

- `flk.npc.gov.cn.legislation` 修订 2（license_kind `official-legislative-document-publication`）：evidence_url `https://flk.npc.gov.cn/detail?id=ff808081752b7d430175e4766bab1557`。原文记录国家法律法规数据库所公布《著作权法》（2020 修正）第五条第一项——法律、法规及具有立法、行政、司法性质的文件及其官方正式译文不适用著作权法；publish 范围限正式正文、条文、官方译文与必要官方元数据，保留来源链接与归属，明确排除页面设计、图片、新闻、评论、数据库编排与第三方作品。
- `court.gov.cn.guiding-cases` 修订 2（`official-judicial-document-publication`）：evidence_url `https://www.court.gov.cn/shenpan/gengduo/77.html`。同一第五条依据 + 页脚「中华人民共和国最高人民法院 版权所有」，publish 范围限正式指导性案例、司法文件正文及官方译文/必要元数据。
- `ipc.court.gov.cn.judgments` 修订 2（`official-judicial-document-publication`）：evidence_url `https://ipc.court.gov.cn/zh-cn/news/more-5-25.html`。同一第五条依据 + 页脚版权声明，publish 范围限精品裁判栏目正式裁判文书正文。

这三份记录的意义：权利基础不是「站点授予的转载许可」，而是**已登记的法定排除判断**——该类文件依第五条第一项不产生著作权客体，因此客户侧读取/引用/导出正式文本不需要另行取得著作权人的许可。缺口在于：① 现有修订的 `allowed_actions` 只登记了运营动作，没有把这一依据延伸登记为客户动作（业务未登记）；② 注册接口的枚举写不进客户动作（技术不支持表达，见第 6 节）。是否以已记录的第五条判断为依据登记客户动作，是公司对自用法律依据的确认，不是对第三方许可的扩大解释——但这仍是公司决定，本岗位不擅自拍板，列为第 5 节待决问题。

**B 类：事实依据缺失（来源方明示限制，不能作候选）**

- `dyjfalk.court.gov.cn.case-summaries` 修订 1：evidence_url `https://dyjfalk.court.gov.cn/site/copyright`；原文记录该站版权声明禁止侵权，登记「不声称站点授予批量接口或转载许可」且「不作公开发布」。
- `rmfyalk.court.gov.cn.case-entries`、`ipc.court.gov.cn.case-entries`、`spp.gov.cn.guiding-cases` 修订 1、`spp.gov.cn.typical-cases` 修订 1：均只挂 submit，原文写明仅供研究审核、不作公开发布或商业转载，不声明站点授予批量接口。
- 这五个来源连 publish 都没有，当前 0 条目。对它们的客户动作拒绝属于「事实依据确实缺少」，继续拒绝，不列入任何候选。

**C 类：合成来源（排除）**

- `fixture.synthetic.cn` 修订 1：证据写明仅用于 SCK-LCM-10 自动验收、不代表真实裁判文书、不可对外提供；evidence_url `https://example.invalid/sck-lcm-10/license`。其 3 条来源记录与 `debug_publish_probe` 探针均不得作真实内容或允许样本。

**产品设计侧的一条正面事实**：`.scratch/legal-data-product-wayfinder/issues/05-content-catalog-licensing-lifecycle.md`（done）规定 `source_license_revision` 应逐项声明 metadata search、full-text read、quote/cite、AI 检索使用、派生报告、手工导出、批量/API、retention/attribution/territory 与有效期，并规定客户权益不得超过来源许可。即客户动作词表在产品设计里就是许可字段的本职，现行枚举只覆盖运营动词属于实现未完成，不是设计上不打算支持。

## 4. 拒绝矩阵（本人复核一致）

下列锚点均为源库 `_system` 当前版本（已核实 `item.current_version` 与 version→source 关联）。客户七项动作（含 browse）全部拒绝：

| 用途 | source_key | 许可修订 | item public_id | version public_id | 标题/版本 | search | read | cite | export | research | generate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 真实法规锚点 | flk.npc.gov.cn.legislation | 082b35a6 修订2 | item_7f2161001cb94ad8868fcc02d089d44b | version_29b1f5f2b5904f6599aed917ac281133 | 中华人民共和国著作权法（2010年修正）rev1 full_text | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 真实法规锚点 | flk.npc.gov.cn.legislation | 同上 | item_dfee35229a3949d485662e438c79eb99 | version_383e8648f29143a89aa9747f5fc62a6e | 中华人民共和国著作权法（2020年修正）rev1 full_text | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 真实司法文件锚点 | court.gov.cn.guiding-cases | 27d7cae3 修订2 | item_8611b77897eb4198aed1870ed50161ff | version_000cfe210c26463cb6af5312c925ee7c | 最高法反不正当竞争法解释 rev1 full_text | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 真实案例锚点 | court.gov.cn.guiding-cases | 同上 | item_fc41948315aa44489250eb75102f8a2f | version_00143aeb0b654ffeb2dcac6fe05d300f | 袁巧娥拒不支付劳动报酬案 rev1 case_summary | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 真实裁判锚点 | ipc.court.gov.cn.judgments | 7382c605 修订2 | item_63e576471cd346ffaff6a19de7647a78 | version_001afd656d164e72a2c8fce3664ead63 | （2023）最高法知民终2573号 rev1 full_text | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |

同来源其余已发布条目共用同一最高修订，同样拒绝；不在此展开 1803 个 id。

排除项（不得当真实内容或允许样本）：`debug_publish_probe`（探针，无来源记录）；`item_0183b2e80b774190a858c8225511a3bd`、`item_f24ac023c8514e2b96f5feca7a868dc6`、`item_1ed1d85fab7843b0a91a95f82d02a32c`（fixture.synthetic.cn，后者经历过 publish→withdrawn→corrected→restored，现 published）。

允许样本、真实撤回样本、许可到期样本：**当前均无**。

## 5. 允许/到期/撤回样本的可执行方案（退回项 3、4）

方案分两个阶段，修正初版「切换后仍先写 `_system` 再复制」的时序错误：

**阶段 A（切换前，冻结复制）**：按 `project.release`，Deploy production 先 Deploy origin；`origin-pre-start.sh`（PR #36，head 9641a3a，Quality gate 已通过）在 CI 停 surreal-ck-hono 后执行 `migrate-legacy-cli.ts --writes-frozen`，把 `_system` 18 张内容表只复制到 `platform_content`（已存在且一致则跳过、不一致则报错；`_system` 不删除）。此阶段产生的全部是拒绝样本，这本身是正确且需要的。发布一律走 CI，禁止 SSH 发布方式；数据库迁移不随代码回滚。

**阶段 B（切换后，在 platform_content 建专用样本）**：`platform_content` 上线后，内容维护入口 `POST /api/content/*`（platform operator 身份，routes/content.ts:55–115）指向隔离库。专用样本只在 `platform_content` 创建，不再写 `_system`、不再二次复制，避免双写。执行责任：engineering（持有任务与发布链）；QA 生产实测；本岗位只提供本方案。

1. **允许样本**——锁定候选：国家法律法规数据库正式法律文本（source_url 级证据已在库，如 `https://flk.npc.gov.cn/detail?id=ff808081752b7d430175e4766bab1557`，即著作权法 2020 官方页）。
   - 新专用 source_key：`flk.npc.gov.cn.legislation.lca03-allow`（不得复用 9 个现有 source_key——`registerSource` 对已有 key 会 UPDATE `content_source` 行并把全部条目改挂新修订，store.ts:253–300）。
   - 修订 1：`license_kind=official-legislative-document-publication`，evidence_text 逐字引用第五条记录并点名客户动作；动作集固定为 `submit, publish, withdraw, restore, browse, search, read, cite, export`，**不含 `research`/`generate`**（经理已决定：一律不登记，保留 AI 动作的拒绝侧用例且偏保守）——同一来源内保留 AI 动作的拒绝侧用例，QA 可在同一正文上同时验证允许与拒绝边界。
   - 条目：经 `POST /api/content/batches`（submit_batch upsert）+ `POST /api/content/publications`（publish_batch）发布一篇专用条目，正文取该来源官方正式文本（与既有 flk 条目同性质但独立 public_id），`content_collection_binding` 绑定验收 collection。
   - 验收判据：授权成员在该条目上 search/read/cite/export 通过；research/generate 拒绝；非成员、无权益成员、错误 revision 均拒绝。
2. **到期样本**——独立新 source_key：`flk.npc.gov.cn.legislation.lca03-expiry`。修订 1 带已过去的 `effective_until`（注册接口已支持该字段，service.ts:80–85 校验「结束不早于生效」）。门禁 `fn::content_reader_visible` 在 `license_until <= now()` 时拒绝（006-content-reader.surql），可隔离验证「许可过期」而非「无动作」的拒绝。同样只走平台发布管道建一篇专用条目。
3. **撤回样本**——`lca03-allow` 来源下再发一篇专用条目，先 publish 再经 `POST /api/content/publications` 的 `operation=withdraw` 走正式发布管道撤回：管道在事务内 UPDATE 条目 `publication_status=withdrawn`、追加 `publication_event`、更新批次结果（store.ts:846–883），门禁按 `publication_status != "published"` 拒绝。**不得**手工 INSERT publication_event 了事——那不更新条目状态和投影。
4. **通用约束**：修订一律 CREATE（`immutable-platform-content-record` 会拒 UPDATE/DELETE）；到期/撤回只用专用来源与专用条目；不动现有 9 个来源、不改写 `_system` 旧行、不碰客户数据；专用条目正文必须来自该来源官方正式文件，禁止用 fixture 或合成正文。

**经理决定（gm-devin-fc1b42，2026-09-29，原 Q1/Q2/Q3 均已定）**：
- Q1（批准登记客户动作，经理可定事项，不转 owner）：以 A 类来源修订 2 已在库内登记的《著作权法》第五条第一项法定排除（官方法律/司法文件不产生著作权客体）为依据，在专用新来源上登记客户动作。这是确认公司已记录的自用法律依据——不扩大第三方许可、不签约、不对外联系、不花钱、不碰 project.redLines（不迁移改写生产数据、不动 surrealdb.service/root/数据目录、不买付费资源）。边界：
  1. 动作集固定为 `submit/publish/withdraw/restore` + `browse/search/read/cite/export`，`research`/`generate` 一律不登记（保留 AI 拒绝侧用例且偏保守）；
  2. 只限官方正式文本范围（正式正文、条文、官方译文与必要官方元数据，沿用修订 2 已写明的排除项）；
  3. `evidence_text` 逐字引用 A 类修订 2 已登记的第五条记录，不自创法律结论；
  4. 只用本节专用新 source_key（`lca03-allow` / `lca03-expiry`），不动现有 9 个来源及其修订；
  5. B 类五个研究存档来源与合成来源继续全拒绝。
- Q2（工程排期，已定）：枚举扩展开**独立小型交付链**，不并入在途链 fe3991c3（其实现已 done、上线申请 c4c80c02 在途，塞新范围会重开已验收实现）。已建交付链：实现 12957854-3f47-4f8a-aa48-852c1208a968（ready，engineering 可立即领取）→ 上线申请 c7dafcd9 → 合入部署与生产实测 bd3eddfc。排期约束：枚举扩展的部署必须在 7c9fb60c 阶段 B 建样之前完成；若 7c9fb60c 先推进到建样而枚举未部署，由该任务执行人核对本链部署状态后等待，禁止绕过接口手工写库。
- Q3（允许样本正文，已定）：用《中华人民共和国著作权法（2020年修正）》官方正式文本（flk.npc.gov.cn 官方页，与库内既有锚点同源）；执行时若该页取正文失败，改取 flk 来源内另一篇无争议正式法规，并在证据写明实际取用页。禁止回填合成文本。

## 6. 工程交付缺口（已排入交付链 12957854）

读者链路本身无需改：`reader-projection.ts`（task/86b409f0）直接抄 `source_license_revision.allowed_actions` 进 `license_actions`，`fn::content_reader_action` 做集合相交。缺口只在写入侧三处过滤：

| 位置（15c49fb） | 现状 | 需要 |
| --- | --- | --- |
| `server/src/content/service.ts:33` `ContentSourceActionSchema` | enum 仅 submit/publish/withdraw/restore，注册 API 边界拒绝客户动作 | 扩展词表（至少 browse/search/read/cite/export/research/generate），`.max(4)` 上限同步放宽 |
| `shared/src/platform-content/contracts.ts:382` `ContractSourceSchema.allowedActions` | 对外契约同一枚举 | 同步扩展 |
| `server/src/content/store.ts:111、132` `parseLicense`/`parseSource` | 维护侧读视图把非四动词动作过滤掉 | 同步放宽，否则注册后 API 读回丢字段 |

排期已由经理决定：独立小型交付链，实现任务 `12957854-3f47-4f8a-aa48-852c1208a968`（ready）→ 上线申请 `c7dafcd9` → 合入部署与生产实测 `bd3eddfc`；不并入 fe3991c3（在途链不重开已验收实现）。该链部署完成是第 5 节阶段 B 建样的前置。缺口闭合前，第 5 节允许/到期样本不可建，QA 只能执行拒绝侧用例；第 4 节拒绝矩阵可立即用于拒绝侧验收。

## 7. 复制后与建样后核验

- 冻结复制完成后（阶段 A）：在 `platform_content` 核对 18 表行数与 `_system` 一致、`content_migration_state:legacy.source_database="_system"`、四个有条目来源的 source_key/最高修订/allowed_actions/evidence_url 一致、第 4 节五个锚点的 item/version public_id 与 revision 一致、合成条目仍标合成；`_system` 行数不得变少。
- 样本创建完成后（阶段 B）：在 `platform_content` 核对两个新 source_key 及其修订 id、动作矩阵、`effective_until`、专用条目 public_id/version/publication_status；withdraw 后该条目 `publication_status="withdrawn"` 且存在对应 `publication_event`；`content_read_gate` 的 `license_actions` 与修订一致。
- 任一核对失败：不以本文档代替实建结果，8AC 对应项不通过。

## 8. 未验证与限制

- `evidence_url` 指向的外站页面本轮未重新打开；第五条依据按库内已登记原文引用，未做独立法律核验。
- 未在生产执行读者会话、未执行复制、未建任何样本；本任务仅核实与方案。
- worktree/分支/提交信息见 checkpoint；证据文件哈希见第 1 节。
