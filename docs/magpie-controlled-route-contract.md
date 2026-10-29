# FV06 Magpie 受控路由快照契约 v4（历史本机契约）

> 2026-10-29更正：此契约采样源为Mac本机订阅网关，不能用于证明VPS上已经配置的产品remote-magpie路由。生产surreal_ck入口现拒绝误用，并提供只读产品观测；不要求创建本机work组或绑定个人Claude。参见 [产品证据来源](./fv06-product-evidence.md)。以下v4字段保留历史语义，不能将新观测伪装成v4授权。

本链代码范围仍是公司运维程序（operations），业务 opsScope=`surreal_ck`；制度只读，实现不合入、不部署、不启用。旧的直连 SenseNova v3 证据契约（`sensenova-token-plan/3`、`reviewed-token-plan` schemaVersion 2/3）逐字保留，**不得**通过改 manifest 字段把 Magpie 路径伪装成旧供应商路径：Magpie 的 host、servedModel、账号归属与本机网关都不同，因此新增独立版本，而不是复用 v1/v3 字段。

## 1. 证据链版本

| 层 | 版本 | 说明 |
|---|---|---|
| manifest | `schemaVersion=2` | 绑定 Magpie 路由；v1 原样保留，仅供直连供应商 |
| 证据文档 | `schemaVersion=4`、`type=magpie-controlled-route` | 受控路由快照，evidenceClass=`controlled-route-snapshot` |
| 采样器 | `magpie-controlled-route/1` | 只读采集，body 不出采样器 |
| 窗口适配 | `ops_magpie_window_prepare` | 缺能力在本链代理，不改公司执行窗口接口 |

`manifestSchema` 是 v1/v2 的判别联合；`evidenceSchema` 在 v2/v3 之外增加 v4。三者都严格拒绝未知字段。

## 2. manifest v2

```json
{
  "schemaVersion": 2,
  "goalId": "2e2a6e41c1193595",
  "project": "surreal_ck",
  "env": "production",
  "activityId": "…",
  "workspaceSlug": "…",
  "documentHash": "<完整 v4 文档字节 SHA256>",
  "service": {
    "kind": "magpie-route",
    "accountRef": "mgp<24 hex>",
    "endpoint": "http://127.0.0.1:3425/v1",
    "routeId": "group/work",
    "routeDigest": "<approved routable set 的规范 JSON SHA256>",
    "priceRevision": "…"
  },
  "budget": { "currency": "USD", "totalNanoUsd": 1000000000, "perAttemptNanoUsd": 100000000, "maxAttempts": 30, "autoTopupDisabled": true },
  "identities": [ …固定两名身份… ],
  "configurationDigest": "…"
}
```

- `endpoint` 必须是完整、无 userinfo/query/fragment 的 loopback URL，且端口、`/v1` 路径显式存在；`https` 也可，但默认生产为本机 `http://127.0.0.1:<port>/v1`。远程 host 一律拒绝。
- `routeDigest` 覆盖**批准的可路由集合**（`[{model,provider}]` 的规范 JSON）。路由动态改变 → digest 改变 → 已登记候选失效，不能只信调用请求里的 model。
- `budget`、`identities`、`workspaceSlug`、`activityId` 等与 v1 相同；预算包络不放宽：总 $1.00、单次 $0.10、最多 30 次，历史失败/不确定次数照扣，旧过期周期不复活，不购买/不提升/不新增 grant，60000 供应商积分不折算成美元或次数。

## 3. v4 文档字段

`account`：`provider`、`accountHash`、`identityHash`、`binding=company-sealed-account|unverified|mismatch`、`ownership=company-sealed-account|unknown`、`source=magpie-quotas`。绑定方式是**在采样器内存中**把公司密封的 `SUPPLIER_<ALIAS>_USERNAME` 与网关 `/v1/magpie/quotas` 返回的 `user` 精确比较；回执和文档只出现哈希，**不输出用户名、密码、key、token 或任何凭证值**。找不到或匹配到多个账号即 `accountBinding` gap，不生成文档。

`endpointBinding`：记录解析来源（env/stash/default/injected）与 `loopback=true`；这是本机网关，不是供应商承诺。

`route`：`group=group/work`、`revision`（受控本地路由配置的规范摘要；配置不可读时才是 null）、`revisionSource=magpie-config-digest|not-exposed`、`digest`、`digestAlgorithm=canonical-json/1`、`routable[]`、`servedModel`、`servedModelSource=magpie-usage-requests`、`association=served-model-in-approved-routable-set`、`observedAt`。路由组来自只读的 `~/.config/magpie/providers.json`，采样器只提取 `groups`/`providers` 的白名单字段；该文件可能含其他配置或秘密，绝不外传，只记录 SHA256。

`snapshot`：`id=magpie-controlled-snapshot/1`、`capturedAt`、`maxAgeSeconds=7200`、`invalidatesOn=[route-digest-change, account-change, price-revision-change, quota-reset]`。

`sources[]`：catalog（`/v1/models`）、quotas（`/v1/magpie/quotas`）、usage（`/v1/magpie/usage/requests?period=7d&…`）与 providers（本地配置）。每个来源记录状态、本机 UTC 抓取时刻、HTTP Date、精确偏差（±5 分钟内，且 `clockSkewMs = capturedAt − httpDate`）、Age、缓存头、body SHA256、字节数与来源 `readAt`；**正文不进入文档/回执**。

`subscription` 与 `balance`：网关只提供 0–100 的百分比窗口与 `resetsAt`，因此 `windows[].remainingPct` 是百分比，`balance.absoluteAmount=null`、`unit=null`，并在 `balance.disclosure` 明示“百分比不是绝对余额”。`readAt` 缺失或早于快照 TTL 即 `staleBalance`；本机抓取时间不能刷新来源余额。窗口已重置 → `quotaExpired`；任一非 `unlimited` 窗口剩余为 0 → `quotaInsufficient`（健康的长窗口不能抵消已耗尽的短窗口）。**每个窗口行都必须可确证**：非对象行、`remaining` 缺失/非数/负数/>100、`resetsAt` 存在但不可解析，均产出 `quota` gap 并拒绝生成文档；畸形窗口不会被 `flatMap` 静默丢弃，健康兄弟窗口也不能掩盖它。`unlimited=true` 的窗口同样要在 v4 里带数值百分比，缺失即 gap 闭锁——不允许为凑字段而编造余量。

`usage`：从网关历史请求行中选取**同账号 provider、已完成、served model 在批准可路由集合内**的最新一条，记录 `requestId`（响应 id，缺失时用行 id）、`runId`（`route_id`）、`provider`、`servedModel`、`at`、`providerKeyIdHash`（网关未给则为 null，不臆造）、input/output/cache/reasoning/total。完成态必须**显式** `done === true`：`done` 缺失、为 `false` 或非布尔（如字符串/数字）都视为未知，一律不作为已完成 usage 关联；当存在其他字段都匹配但完成态未知的行时，`usage` gap 会写明 `done=true` 缺失，而不是笼统地说没有请求。`cost` 只有在 `priced=true` 且成本为有限数时才写数值；否则 **null 且 `costUnknown=true`，绝不以 0 填充**。

`pricing`：从网关 catalog 观测（`source=magpie-catalog`），记录 `priceRevision`、`reviewed`、`free`、`freeEvidence`、input/output 单价、币种、`subscriptionCost.disclosed=false`、`marginalCost`。零价证据只认源**明确给出数值** `input=0` 且 `output=0`；catalog `free=true` 但价格缺失/非 0 视为价目不明 → `price` gap、不生成文档，`freeEvidence` 永远不会因此写成 `magpie-catalog-zero`。订阅分摊成本与边际成本分开披露，订阅成本当前不披露。观测价目默认 `reviewed=false`，不能自证受审。

`approvalReadiness`：`ready` 与 `blockedReasons`（`account-ownership` / `price-not-reviewed`）必须一致。当前生产状态通常是 `price-not-reviewed`：文档是有效证据，但**不能**用于 enable 证明或执行窗口，直到出现新的受审价目决定。

## 4. 有效期与关闭规则

- 本机证据有效期 = `min(采样 + 7200s, 已知订阅 until, 每个已知窗口 resetsAt)`；不晚于任一已知来源到期/重置。
- 执行余量必须 ≥ **5400 秒（90 分钟）**；不足即 `headroom` gap、不生成文档，窗口适配也拒绝。余量不足时**不延长**证据，而是关闭。
- 过期或重置后只能真实重采样；不续旧件、不用宿主机时钟刷新来源时间。
- 任何必需事实缺失都返回 `blocked` + 结构化 gaps（字段名稳定），不猜、不补零、不把未知写成已知。

## 5. 校验与动态路由

`magpieEvidenceEligible` 在 prepare/prove/deliver/diagnose 共用检查中重新推导：类型/evidenceClass/serviceApproved、readiness 为空、账号绑定与归属、价格已受审、采样/过期/使用时刻、TTL 与 90 分钟余量、route digest 重算、routable 的 provider 必须等于绑定账号、servedModel 在同一集合且 usage 一致、usage provider 与账号一致、`route.observedAt` 必须是同一 usage 事件且不晚于本机采集（允许 ≤5 分钟来源偏差）、`sampledAt` 不晚于当前时刻、订阅 readAt 新鲜且所有非 `unlimited` 窗口剩余 >0（至少一个可用窗口）、窗口/订阅未到期、`priceRevision` 顶层与 pricing 一致。窗口代理额外返回 `sample-in-future`/`usage-in-future`，未来时刻的文档不能取得窗口。手写或篡改文档不能靠自报字段通过。

`serviceFieldsMatch` 按 manifest 版本判别：v2 必须配 v4 文档，且 accountRef/endpoint/route.group/routeDigest/priceRevision 全部一致；v1 只能配非 Magpie 文档。跨契约（v1 manifest + v4 文档、v2 manifest + v3 文档）在读取阶段即拒绝。

`documentHash` 是完整 v4 JSON 字节的 SHA256；`configurationDigest` 覆盖 v2 manifest 全部新字段（含 routeDigest）。任何路由/账号/价目/窗口变化都会使候选或证明失配，必须重新采样并重新独立审批。

## 6. 窗口代理

`ops_magpie_window_prepare {env?, manifestPath, documentPath, approvalTask}`：

- 只读，不写候选、不启用、不续跑、不重试；
- 证据根跟随 `approvalTask`（与 `ops_internal_ai_prove`/`ops_internal_ai_deliver` 一致），因此经理可以在自己的任务租约上为另一个审批任务准备窗口；若未来允许省略 `approvalTask`，才回落到调用者自己的任务根。指向其他任务根或证据根之外的路径一律拒绝；
- 校验文件路径安全、manifest 为 v2、documentHash/configurationDigest/service 绑定一致；
- 返回 `{eligible, blockedReasons, headroomSeconds, evidenceExpiresAt, window?, manifestHash, documentHash}`；
- `window = {approvalTask, configurationDigest, evidenceExpiresAt, minRemainingSeconds:5400, notAfter: evidenceExpiresAt − 5400s}`；
- 不满足条件时返回具体字段（如 `price-not-reviewed`、`insufficient-headroom`），不做 resume/block 循环。

经理仍按公司原执行窗口接口绑定；本工具只是补上缺失的窗口/容量适配能力。产品消费链是并行产品链，本实现不跨仓修改产品。

## 7. 只读边界与非目标

- 采样器只 GET 本机网关的 `/v1/models`、`/v1/magpie/quotas`、`/v1/magpie/usage/requests`，并读取 `providers.json`；**零模型调用**、不 POST 聊天、不写 Magpie。
- 不购买、不提升、不新增 grant、不启用、不创建周期或执行窗口；不把 60000 积分换美元/次数；不改宿主机时钟；不放宽 ±5 分钟；不对差 1 容差。
- 不读取或输出凭证值；不读客户原始资料；证据目录只写脱敏文档与回执（0600）。
- 不改公司规则、不创建 agent/定时器、不在共享 main commit/push。

## 8. 验收检查（零模型调用）

正向：完整快照生成、账号绑定、路由 digest、servedModel、requestId/run、百分比窗口与余额披露、未知成本 null、免费真实证据、窗口代理输出精确 `notAfter`、重复调用确定性。

负向：错误账号、路由漂移、缺失 usage、价目不明、窗口过期、余额不足、来源陈旧、余量不足、旧契约拒绝、已登记候选与文档/路由不一致拒绝、重复 prepare 不产生第二份候选。

## 9. 受控恢复工具 `ops_magpie_route_restore`（只读 plan）

2026-10-28 的 FV06 路由采样无法出证：本机网关 `providers.json` 缺 `group/work`，且公司未密封 `SUPPLIER_MAGPIE_USERNAME`。本发布**只提供只读 plan**：真实写入通道（直接替换 `providers.json` 与 Magpie 自身 `SaveGroup` API 的取舍）、真实组 schema 与网关加载/刷新语义均未证实，因此 `apply` 关闭，实际账号/路由恢复**未完成**。

### 9.1 plan（只读，已发布）

`ops_magpie_route_restore {mode:"plan", alias:"MAGPIE", purpose}`

- 只读 `providers.json`（`~/.config/magpie/providers.json`，lstat 拒绝符号链接/非普通文件，1..256 KiB）与网关 `/v1/models`、`/v1/magpie/quotas`；**零模型调用、零写入**。
- 返回：`group`、`config{sha256,bytes,groupPresent,existingMembers}`、`groups[{id,memberCount}]`、`unsafeGroupIds`、`providers[{id,routing}]`、`accounts[{accountHash,accountRef,provider}]`、`binding{status:missing|matched|mismatch}`、可选 `proposedAccount`（仅网关恰好一个账号时）、可选 `candidates{provider,models,modelCount,omitted}`、`snapshots{catalogSha256,quotasSha256}`、`sources[]`、`planDigest`、`issuedAt/expiresAt`（15 分钟）、`gatewayReload:"unknown"`、**`writeAvailable:false`**、`recovery.interrupted[]`、`notes[]`。
- **不输出**用户名、token、secret、`api_key` 或 `providers.json` 正文；组/供应商 id 只出安全字符集，账号只出 `sha256("magpie|provider|user")` 与 `mgp…` 引用。
- `candidates` 只含绑定账号同 provider 的 catalog 模型，纯建议；**不自动授权整个 catalog**；无绑定且多账号时不给候选、不给 `proposedAccount`，也不猜默认账号/模型。
- `recovery.interrupted` 只从既有 journal 读出未完成写入的备份文件名、计划摘要前缀与配置是否已变，供经理核实；本工具不据此恢复、不清理旧 journal/备份原件。
- plan 沿用环境既有的 `cfg.roles` 授权；本发布不改生产 roles，也不新增 GM 权限。
- **plan 通过不等于恢复成功**：它只陈述当前缺口与候选，不证明网关会加载任何写入。

### 9.2 apply（已关闭）

`ops_magpie_route_restore {mode:"apply", …}` 在 broker 入口与底层导出入口都以结构化 `not_configured`（`details.capability="magpie_route_restore_apply"`、`writeAvailable:false`、`gatewayReload:"unknown"`）拒绝，**发生在任何配置读取、密封或 journal 访问之前**；qa、engineering、product、gm 一样拒绝，直接 import 底层入口也无法写。apply 参数仍走严格 allowlist，未知参数先按 `invalid` 拒绝。

未发布的写入实现（`applyMagpieRouteRestoreRetained`）仅作为后续发布的可恢复证据保留：

- 生产不可达：broker 只引用拒绝入口，`src/` 内无其他引用，测试守卫该约束；已知非目标残留是 journal 在取锁前读取、锁内整体写回（只假设单写者）。
- 崩溃恢复元数据已修正：完成记录不再以 `null` 覆盖 `started.backupFile`；由本键中断写入的组标为 `created`（附 `recovered:true` 与 `recovery-completed` 阶段），不再冒充「未写」的 `unchanged`；重放保留备份指针。
- 旧 journal 与 `providers.json.bak-*` 原件保留、不清理；在写入通道被另链证实并经经理/运营批准前，**恢复功能不可用**，也不提供人工 DML 或手工替换 `providers.json` 的替代做法。

### 9.3 测试覆盖

`tests/ops-magpie-restore.test.ts` 使用隔离临时配置 + 受控本机 mock：plan 脱敏/候选边界/`writeAvailable:false`；apply 在 broker 与底层入口对全部角色结构化拒绝且零写入（配置、密封、journal、备份均不变）；保留实现的 A–D 契约（绑定冲突、完成态重放、拒绝不改写身份、组只写 `id`+`members`）、崩溃恢复保留备份指针与中断写入如实标注、跨 key 身份拒绝；以及未知参数与别名限制、秘密零泄漏、生产不可达守卫。
