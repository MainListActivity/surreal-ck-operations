# FV06 产品证据来源与恢复边界

产品使用现有 remote-magpie 连接中的 work 路由。该配置属于已确定前提；修复公司工具不能将产品改为本机 Claude、创建 Mac 的 work 组或更换产品供应商。

VPS 上的 `http://127.0.0.1:3425/v1` 与 Mac 上同样的 URL 是两个不同来源。模型目录中的 `remote-magpie/group/work` 是 Mac 看到的远端引用；对应远端调用引用 `group/work`，配置存储 ID 才是 `work`。不能因 Mac 没有 work 组推断产品缺组。

生产 `surreal_ck` 的 `ops_magpie_route_sample` / `ops_magpie_route_restore` 返回 `product_gateway_source_mismatch`，并指向 `ops_product_magpie_observe`。旧本机 v4 契约保留历史兼容，但不适用于本产品的远端证据，不能要求个人订阅密封为产品供应商。

`ops_product_magpie_observe {}` 复用老板已有 remote-magpie HTTPS 连接。员工不能覆盖地址、模型、账号或凭证。仅 GET models / quotas / usage，受现有任务、角色、策略和故障预算控制，不调用推理、不改配置。

回执 `product-magpie-observation/1` 明示 source、远端 endpoint、模型引用、来源 SHA256、抓取时刻与覆盖范围。usage 采用**有界分页**：每页 200 行、最多 5 页（1000 行）、累计 4MiB、12s 预算，逐页仍受 1MiB/15s 限制；`coverage` 如实给出 rowsRead、pages、matchingRows、rowsReturned、total、complete、truncated、stoppedReason 与 scannedOffset，分页不推进（仍声明有行却返回空页）按 fail-closed 报错。**不足或为空都不能推断不存在或缺组**：最近一页无匹配只代表该有界范围未找到。使用 Magpie 实际字段 req/served/in/out/t/status/ms/stop；无 done 字段不机械判为失败。完成态需成功状态、正耗时和结束标志，仍不代表端到端UI成功。`accountRef` 由行的 provider + providerAccount/providerKeyId 派生为 `mgp…` 哈希；可派生时 `accountBinding` **等于同一 accountRef**，无法派生时保持 `unknown`，绝不借用同供应商其他账号。route 除 present/configurationModified 外，若远端只读 `models` 条目提供 revision/digest/max_output_tokens/expires_at 则如实透出；servedModel 取扫描范围内首个 group/work 匹配行，sampledAt 取该行的上游 `t`；取不到的字段返回结构化 null 并在 `route.gaps` 说明，`coverage.routeFieldsComplete` 标明是否齐全——**不用本机时钟或本地配置补造**。价目读取 catalog prompt/completion 字符串；缺失保持 null（不写 0），已核零价与未受审授权区分，reviewed 恒 false。

此回执只是观测，不是新供应商授权证书。不得把它改字段伪装为 v4 文档，或用来自动 prepare/prove/deliver/enable；不授予任何预算。产品实际配置需与 `ops_request GET /api/ops/internal-ai/runtime`、产品 run/requestId 对应核验。剩余30次预算用尽是独立事实，不能通过更换任务、组、身份或周期重领；只读观测不消耗模型次数。

## 本次根因的时间线

- 2026-10-09：原目标要求生产首次体验和四指标基线。拆解后增加真实用量、现金/次数预算、账户和受审证据门禁；这部分有合理约束，但不是要求永久绑定特定供应商。
- 10-16至10-27：新证据有效期、周期和依赖接力反复错过窗口，继续产生重采样/重新批准；同时存在真实登录、容量及生命周期缺陷，不能把所有工作笼统归为空转。
- 10-28 10:44Z：老板管理任务91d486正式采用已经配置的产品Magpie路径。描述写了产品的loopback地址，但没有记录执行主机；两条实现链在输入冻结28eb31b1结束前已经创建，未知来源被提前固化。
- 10-28：0ec530ce代码把来源默认落在Mac，组ID硬写为group/work，并使用合成字段done、pricing.input/output。独立评审和部署QA验证了拒绝路径，却把无法产生真实正向证据列为后续配置前置。
- 10-28 23:09Z：cdc2dd4c对Mac采样得出缺组/缺密封账号，33eaa21e将其变为恢复前置，继续产生恢复工具链。
- 10-29 02:15Z：10abba95已经证明组引用/存储ID、done与真实价目字段错误。02:38Z上报仍以旧v4前提排除远端，提出个人Claude账号或停线，说明技术不兼容被误当成老板账号选择。
- 本次只读复核：现有remote-magpie的远端目录、配额和用量均200，远端存在group/work；Mac目录则只出现remote-magpie/group/work。产品缺组的前提被反证。

责任归因：任务描述的来源主机歧义、适配器对真实API的错误假设、验收只验证闭锁而未覆盖现役正向来源，以及经理继续沿用已知过时契约共同导致；不能归因于老板未提供账号或未决定改模型。

详细原始审计和维护验证保存在本机维护目录，不在仓库提交原始账号、凭证或客户数据。目标、G3、历史失败和未完成状态均保留；纠正来源不等于四指标已完成。


## 原生筛选和输出上限的后续更正

v0.3.37 使用远端 Magpie 原生 q=group/work 先筛选再分页，仍逐行核对 req===group/work。固定版本源码依据：yetone/magpie v0.1.1970 的 internal/usageapi/usageapi.go FilterOf 接受 q，internal/usage/ledger.go Filter.keepsRecord 会匹配 Requested 等字段。不能用 model=group/work 替代：model 是实际模型过滤。筛选来自固定工具逻辑，员工不能注入查询或连接覆盖；分页与字节/时间上限不扩大。coverage.filter 披露请求的服务端筛选及本地精确核对。

实测原生筛选得到2条请求（total=2/complete=true），均为2026-10-28、实际模型sn-sensenova-6-8-flash、provider=raccoon。它们是历史维护请求，不能当成管理员/成员UI成功样本；完成态与端到端结果仍分别核对，旧证据不因此变新。

route.maxOutputTokens 是远端目录的模型能力，保留兼容读取，不是窗口必须放行的请求值。executionBounds 分别披露该能力、magpie-window/v1的65536上限及候选请求上限（两者取小）。产品现有 InternalBudgetModel 在真正发请求前将 maxOutputTokens 限制为窗口批准值；声明窗口65536不等于伪造模型能力为65536。该候选值不是预算或授权。

observationSnapshot 单独记录本次读取的哈希、采集时刻和本地2小时新鲜度策略，expiryBasis 明示 local-observation-freshness-policy。它不填入远端route.revision/digest/expiresAt，routingConfigurationVerified=false；不能把本地快照期限冒充供应商到期或实际路由配置验证。过期历史请求、未知完成态、价格未受审、剩余模型预算及产品窗口绑定仍独立处理。

产品受保护runtime接口另行修复HTTP loopback观测：运行时配置披露与直接供应商HTTPS价目认证分离。endpointHost=null的旧返回来自价目函数限制，不能证明产品未配置。此更正不放宽tariffFor、不改模型/连接配置。

## remote-magpie-evidence/1：远端证据契约（产品用）

`ops_product_magpie_candidate {budget?}` 复用同一只读观测，把结果写成 `remote-magpie-evidence/1` 候选文件（写入任务证据目录）。它只取远端回执能给出的字段：endpoint、group/work、servedModel 与上游 `t`、价目原文与 priceRevision、usage 匹配行与 coverage、accountRef/accountBinding、observationSnapshot 哈希与采集时刻。

- 远端未提供的 revision、digest、maxOutputTokens、expiresAt 保持 null 并写入 `gaps`，不阻断生成，不用本机时钟、本地配置或常量填充。`observation.routingConfigurationVerified` 恒为 false。
- 有效期取本地观测新鲜度策略（7200s，`expiry.basis=local-observation-freshness-policy`）与远端已给出的源到期、额度 reset 中的较小值。这不是供应商承诺。
- 价目审核是显式批准步：候选列出 catalog 价目原文与 priceRevision。只有不同员工的批准记录读回同一 `configurationDigest` 与 priceRevision 时，窗口才不再报 `price-not-reviewed`。缺价目保持 null，不写 0；已核零价记为 `remote-catalog-zero`，与未审区分。当前生产没有批准读取器，因此远端窗口在批准读取器建成前一律闭锁。`price-not-reviewed` 是有意的安全闭锁，不是缺陷：窗口只检查注入的 `remotePriceApprovals`，生产中该注入点未接线，任何远端候选都会报此原因。批准 marker 的写入与读回拆出为后续任务 `b943c060`（依赖本任务合入），在该任务完成前不得放行远端窗口。
- 预算包络（`totalNanoUsd`、`perAttemptNanoUsd`、`maxAttempts`）由调用方给出并原样记录；未给出则 `budget-missing`，窗口闭锁。不读取或复用旧 30 次周期、旧批准或旧容量。
- `ops_magpie_window_prepare {candidatePath, approvalTask}` 读取候选文件，校验 digest 未被改动，按上面的规则输出 `eligible`、`blockedReasons` 与 `window{approvalTask, configurationDigest, evidenceExpiresAt, minRemainingSeconds=5400, notAfter=expiresAt−5400s}`。它不绑定、不 resume、不调用模型、不改配置或预算。
- 证据余量不足 5400s 或已过期的候选闭锁；过期候选只能通过新观测生成新候选，不能续期。
- 旧 v4 本机契约（`magpie-controlled-route/1`）与 `manifestPath/documentPath` 调用方式保留，用于历史兼容。

此契约只说明远端观测与有效期，不是新供应商授权证书，也不授予任何预算。

## 价目人工批准 marker（remote-price-approval/1）

- `ops_product_magpie_price_approve {candidatePath}` 由另一位员工调用：候选作者不能批准自己的候选（`self_review`）；候选 digest 被改动、候选无 catalog 价目（`price-missing`，保持 null，不写 0）时拒绝写入。
- marker 写入批准员工自己的任务证据目录 `evidence/<任务>/price-approval-<员工哈希>-<digest前16位>.json`，并带 `markerDigest`。`approvalTask` 必须等于调用者自己的任务，不能写进别的任务证据根。
- marker 绑定 `configurationDigest`、`priceRevision`、批准时刻与候选有效期（`expiresAt`），不写账号名、token 或任何凭证。
- `ops_magpie_window_prepare {candidatePath, approvalTask}` 在没有注入 `remotePriceApprovals` 时，从 `approvalTask` 证据根读取 marker。以下情形会跳过该 marker，窗口保持 `price-not-reviewed` 或报 `evidence-expired`：文件不符合 schema、`markerDigest` 不符（被篡改）、`configurationDigest` 或 `priceRevision` 不符、批准时刻在未来、已过期。
- 生产中只要存在一条独立、未篡改、未过期且 digest 相符的 marker，窗口才不再报 `price-not-reviewed`。这份 marker 只代表价目审核，不授予预算，不启用、不执行。
- 注入的 `remotePriceApprovals` 仍保留为测试接缝，并优先于磁盘 marker。
