# 公司内部AI可信证明契约 v1（实现冻结）

本链6ebb9e12代码范围是公司运维程序；制度只读。实现不合入、不部署。公司release与Paseo vendor双面发布，不能走产品Hono发布模板。

固定issuer `urn:surreal-ck:company:internal-ai:v1`；audience `urn:surreal-ck:surreal_ck:production:internal-ai:v1`；Ed25519/EdDSA，显式kid，产品pin公开JWK；禁止caller传JWKS URL。签名私钥由代理在现有env_secret AES-GCM密封存储原子初始化，员工仅得到公开信任锚。proof最长300秒；状态最长60秒，客户端必须校验自己生成的nonce、jti及用途。

工具（均从sidecar当前租约读取任务/员工/角色/goal/project/env）：
- `ops_internal_ai_prepare {env?, manifestPath, documentPath}`：仅将当前任务交付目录的实际受审JSON manifest和脱敏文档字节SHA256登记为不可变候选。返回digest与独立评审必须明确使用的接受标记；不签enable，不创建任务。
- `ops_internal_ai_prove {env?, mode:"register-disabled"|"enable", approvalTask?, manifestPath, documentPath, activityId, nonce, idempotencyKey}`：enable必须找到同goal/project独立review的真实done/accept（或owner approve）审计，接受证据含精确 `company-internal-ai-approve:v1:<digest>`，且已prepare候选完全一致。普通taskRef/version、subscription.manage、GM拆链文字不算审批。disabled从当前任务读取，证明类型development-disabled、paidCallsAllowed=0，不冒充余额ready。仅返回task-bound proofHandle及脱敏摘要。
- `ops_internal_ai_deliver {env?, proofHandle, session}`：运营会话调用固定产品POST `/api/ops/internal-ai/company-proof`；原始JWS、subject、状态认证能力仅代理→产品内部传送，员工响应仅状态/非敏感摘要。消费端未部署时准确报告不可用。
- `ops_internal_ai_revoke {env?, proofHandle}`：持久撤回并审计；同scope可跨重试撤回，不能越租约/环境/身份。
- `ops_internal_ai_rotate_key {env?, approvalTask, expectedKid}`：必须有真实独立done/accept或owner批准，接受证据单独含 `company-internal-ai-key-rotation:v1:surreal_ck:production:<当前kid>`；代理CAS轮换密封私钥，只返回新公开信任锚。旧证明立即失效；产品CI先pin新锚后才恢复受控活动。
- `ops_internal_ai_trust {env?}`：仅公开issuer/audience/alg/kid/JWK/契约与状态路径。

manifest（严格JSON，不接受未知字段）含schemaVersion=1、goalId=2e2a6e41c1193595、project=surreal_ck、env=production、activityId、service.accountRef/endpoint/model/priceRevision、budget.currency=USD/totalNanoUsd<=1e9/perAttemptNanoUsd<=1e8/maxAttempts<=30/autoTopupDisabled=true、documentHash、角色固定LCA04_REMOVABLE admin+owner与LCA04_MEMBER participant+member、workspaceSlug（当前ui01实际slug）、configurationDigest（上述规范JSON计算）。文件只允许对应审批任务evidenceDir或已发布deliverables根，普通文件、无隐藏/secret路径、无symlink，读取同一已打开fd，前后inode/size/mtime/ctime核对，最多256KiB；documentHash由代理实际字节校验，正文不落日志或证明。

仅 `manifest.service.model` 与资料 `evidence.model` 使用版本模型标识：长度 1..128，由 ASCII 字母、数字、下划线、连字符构成的非空片段，以单个点号分隔。接受 `sensenova-6.8-flash-lite` 及原无点号模型；拒绝首尾/连续点号、空白（含尾部换行）、Unicode、URL/路径/query/fragment/百分号。其余通用 ref、nonce、task、activityId、accountRef、priceRevision、idempotencyKey 保持原规则，不因模型点号放宽。格式合法不代表模型、供应商账户、余额或价格已受审；跨文件模型必须相同，摘要、独立批准、disabled/enable 与其它门禁继续生效。当前 SenseNova 缺真实证书仍 unsupported、dataReady=false、paidCallsAllowed=0。

正常身份来源：代理读取自己密封alias密码，正常customer PKCE登录（不ensure、不修复、不建账号成员，consent不绕过），从当前产品正常workspace/member通道核对subject/database。产品消费链提供只读 `GET /api/internal-ai/identity?workspaceSlug=...`，响应仅本调用者subject、spaceId、database、workspaceRole、billingRole、billingAccountRef；产品以正常workspace/成员/计费索引实时计算，不能回显body自报值。代理再比对正常workspace列表、scope切换和workspace user查询subject/is_admin，未知/不匹配拒签。该只读契约补齐计费身份；现有quota/邮箱不能推断owner/member。此消费端就绪前身份资料unavailable，不伪造ready。

Proof claims绑定project/env/goal、requestTask/员工+delivery+fence、approvalTask/version/action/auditId、documentHash、完整manifest/digest、映射与映射digest、scope、jti、nonce、iat/exp、type、paidCallsAllowed、status能力。用途 `sck-internal-ai-proof+jwt`。nonce与idempotencyKey同scope同digest可复用同结果；改变任何activity/env/身份/用途冲突，不跨任务复用。

状态复用现有preview发布面 `GET /internal-ai/status`，仅Bearer专用随机status能力（proof内交产品）与`x-sck-nonce`，不使用preview HMAC。答复为EdDSA签名 `sck-internal-ai-status+jwt`，只含指定jti/valid/版本/checkedAt/expiry/nonce。私有task/history/文件不开放。每次状态请求重新查审批事件/任务版本、实际文件hash、当前租约、employee撤权及真实身份映射；失败、未知或变更均拒绝/invalid。新登记/enable必取当前状态；新的模型调用/续跑状态年龄<=60秒、exp有效，否则fail-closed。无后台timer。

当前生产preview signed未配置，公网可达状态地址需按已有runbook复用公司发布面，由上线/部署阶段核定，不新购或SSH。本实现公开固定相对路径与pin契约，不能宣称origin已能访问。proofHandle最长300秒且租约结束失效；生产无真实审批/资料仍paidCallsAllowed=0。

文件资料严格限制为最多256KiB的脱敏JSON白名单（不是通用PDF/账单读取器）；字段详见src/ops/proof-contract.ts evidenceSchema。不可变候选一任务一份，修改后须重新独立审批。所有响应和审核日志不含document正文、登录token、签名证明或真实subject。

evidenceSchema 是按 `type` 判别的冻结联合。公司保留产品 PR175 固定 SHA `1adf73aeaf8b14a7e9b30c1ef0d7a340f63dc16a` 的 `shared/src/internal-ai-proof.ts` 原始区域（27–28、38–45、142–186），注释、helper、FREE 常量和 schema 均逐字复制；仅区域外导出 `evidenceSchema` / `ServiceEvidence` alias。`tests/fixtures/product-1adf73ae-internal-ai-proof.ts` 是该固定源码的全文件快照，双端真实 schema 接收同一批 fixtures。详见 [v2 发布配套](./internal-ai-proof-v2-release.md)。

`development-disabled` / `reviewed-service` 保持 schemaVersion=1、USD-only 余额契约和 autoTopupDisabled=true；token-plan **只接受 schemaVersion=2 和 accountPlanType="TOKEN_PLAN_PLAN_TYPE_FREE"**。必填 planName、planSourceUrl、quotaUnit（points/requests）、quotaAmount（正整数）、quotaWindowSeconds（正整数）、quotaRemaining（必须提供，可 null，数值非负）。token-plan 不含供应商账户 noPaymentInstrument / autoTopupDisabled，传入旧字段由 strict 拒绝；USD、配额字段不得互混，不接受未知字段。

`ops_internal_ai_prove(mode=enable)` 的 USD 分支不变：serviceApproved 且 balanceNanoUsd 覆盖 manifest.budget.totalNanoUsd。token-plan 查真实受审 v2 FREE 文档、serviceApproved、quotaAmount>0、quotaRemaining 为 null 或 >0、sampledAt 不晚于签发且年龄≤24h、expiresAt 未过。独立审批、身份、文件原始 hash、租约、status 和签名检查不变。prepare / register-disabled 可以接受契约合法的 v2，但仅登记 disabled、paidCallsAllowed=0，不授予调用权限；enable 才检查服务可用窗口。

采样器 `sensenova-token-plan/3` 使用账户 console 的 `/tokenplan/pool-usage` 计划读回；以同一 console `/metered/api-keys` 对密封 API key 精确交叉绑定。`/v1/models` 只验证 key 活性与模型列表，不证明账户 FREE。官方计划页面须同时包含免费公测、付费档位即将上线、限时放量、Free 公测正面标记；配额数字只作为 `officialQuotaNumberObserved` 记录，不再要求官方页给出数字。两个池的 5h/7d limit/used/remaining/reset 全部读回并校验一致；准用上界取核定 60000/18000s 与所有池可信剩余的较小者，观察到的 120000 不抬高上界。支付 URI 枚举纯为回执观测（paymentSurface 不作证明、不阻塞文档）：存活面漂移记 note 提请人工复核，付费档上线跳闸由官方页 marker 承担；枚举绝不证明支付绑定为空或账户自动充值已禁用。`ACCOUNT_PAYMENT_SOURCES` 注册表机制保留、维持空表。回执同时记录 `planSource`（HTTP Date/ETag/raw hash）、`normalization`（flat 算法/hash）、池分析、governingPool/依据与 observed limits；`accountPlanSource` 标来源与绑定。缺计划/非 FREE/未绑定列 `accountPlanType` gap（对应产品 enable 缺口名 `account-plan-free`）；缺任一池窗口、剩余或 reset 均 blocked，不臆造数值。过期重置窗口闭锁，文档 expiresAt 取所有池 reset、活动截止与24小时上限的最早者。

manifest.budget.autoTopupDisabled=true 和我方计量配置自动充值禁用保持；measurementCycle≤30、worstCost=0、原30台账和消费者预算门不在本次变更中放宽。JWT contractVersion=1、issuer/audience/alg/kid 和信任锚不变。

### FV06 v3：限时账号绑定 FREE 观测（promotional/account-bound）

GM 技术裁定：官方页仍写公测免费、限时放量，但**不再给配额数字**；授权账号 default/dedicated 池的 120000/5h、1200000/7d 只是 account-bound 观测，不是官方稳定免费配额，更不是 QUOTA 常量。v3 是独立的新证据版本，v2 schema 与判定逐字保留（见 `tests/proof-mirror.test.ts` 与 v2 回归）；v3 仅在 `proof-contract.ts` 冻结镜像区之外新增。

v3 文档（`schemaVersion=3`，`type=reviewed-token-plan`，`evidenceClass=promotional-account-bound`）在 v2 基础上强制并记录：

- `planSource { url, fetchedAt, httpDate, clockSkewMs, status, etag, rawSha256 }`：官方 URL、本机 UTC 抓取时刻、来源 HTTP Date 与偏差（±5 分钟）、HTTP 状态、ETag、原始页面字节 SHA256；`clockSkewMs` 必须精确等于 `fetchedAt - httpDate` 且实际差值在 ±5 分钟内，签名后的自报字段不能伪造新鲜度；
- `normalization { algorithm:"html-text-flat/1", flatSha256, flatChars }`：固定归一化算法（去 script/style、标签换空格、空白折叠）及归一化文本 hash；
- `accountPlanType=FREE`、`accountBound=true`、`accountBoundSource`：仅认证 console 的 pool-usage + 同一密封 API key 精确交叉绑定可证明；
- `pools[]` 每个池必须同时有 `window5h`/`window7d` 的 `limit/used/remaining/resetAt`，`used` **必须由 provider 报告**（`usedSource=reported`；缺失即 blocked，禁止用 `limit−remaining` 派生后冒充一致，`tokenPlanV3Eligible` 也拒绝 `derived`），`used+remaining=limit` 严格成立；重复池类型、缺任一窗口、已重置或事实不一致（含差 1/差 2）一律 blocked；**缺 7d 不得当作无限**；
- `governingPool { poolType, basis }`：绑定模型优先 dedicated，其次 default，单池则 single-pool；重复 dedicated 视为歧义；`basis` 必须与所选池一致（dedicated/default 对应同名池类型，single-pool 仅限单池文档）；
- `quotaAmount`：本次**准用上界** = min(核定 60000 points / 18000s, 所有适用池 5h/7d 的可信 remaining)，`quotaRemaining` 必须精确等于所有池窗口 remaining 的最小值（自报更大值或保守小值都不能通过），`quotaAmount` 同时不得大于该最小值；观察到的 120000/1200000 只进 `pools`/回执，永不抬高准用上界；余额 0 时 blocked，不生成文档；
- `promotional=true`、`revalidateBeforeUse=true`、`terminationRisk`、`promotionalEndsAt`：官方页若给出可解析的活动截止日，按站点时区 Asia/Shanghai（UTC+8）的当日 23:59:59.999 理解，`expiresAt` 不得晚于该时刻；`terminationRisk=promotional-end-recorded` 必须同时给出 `promotionalEndsAt`，`unknown-promotional-end` 必须为 null；提到截止但无法解析时 blocked；未提及时明示 `unknown-promotional-end`，不得声称永久有效；
- `autoTopupDisabled=true` 仍是我方计量配置断言；支付面 404 仍只是回执观测，不证明没有支付能力，也绝不参与判定；
- `expiresAt` ≤ `sampledAt+24h`，且由**同域相对时间**推导：`sampledAt + min(reset_at − consoleNow) − 完整请求耗时 − 60s margin`，不晚于活动截止；`consoleNow` = console HTTP Date + Age。来源时钟快不会延长证据（偏差在相对差中抵消），console 时间域不可用时 blocked；到期不续旧件，必须真实重采样。

`tokenPlanV3Eligible` 在 prepare/prove/deliver/diagnose 共用的 `evidenceChecks` 中重新推导上述边界（额度上限与各池最小 remaining 交叉核对、HTTP Date 偏差与 `clockSkewMs` 一致、terminationRisk/promotionalEndsAt 一致、governingPool basis 与池类型一致、每个池保持一致、expires 不越过 reset/24h/活动截止、FREE/accountBound/promotional/revalidate/autoTopup 全为真），因此手写或篡改的文档不能靠自报字段通过。`documentHash` 覆盖完整 v3 JSON，任何新语义字段变化都会使候选/证明失配。官方页 marker 由 v2 的 `quota5h` 换成 v3 的 `freeBetaOpen + paidTiersUpcoming + limitedTimePromotion + freeTierNamed`；配额数字改为 `officialQuotaNumberObserved` 观测项，不是放行条件——这不是删除失败项，而是官方文案已无数字，新增的限时 marker 与账号绑定池约束更严。

### 来源时间诊断、条件 GET 与池原始精度（15d775ea 修复）

**每个 source 的原始时间/缓存元数据**（receipt/derivation-only，不进入 v3 文档）：所有 probe（models/planPage/planPageConditional/apiKeys/poolUsage/paymentSurface）记录 `requestStartedAt`、`headersAt`、`bodyCompletedAt`（本地 UTC ISO；亚毫秒精度由单调时钟承担）、`monotonicMs`/`monotonicBodyMs`（`performance.now`，不受墙钟回拨影响）、原始 `httpDate` 及解析 epoch、`ageSeconds`（缺失为 null）、`cacheControl`、`etag`、`cfCacheStatus`、`xNextjsCache`、`server`、`via`、`location`、`redirectRejected`、`redirectChain`、`responseHost`、`rawSha256`、`bodyBytes`；console 另记 `x-request-id`。字段来源由命名标明：`httpDate*` 来自响应头，`*At` 是本机墙钟，`monotonic*` 是实测。

**时钟分类**（`derivations.clockDomains.{planPage,console,api}`）：同一轮分别观察 `www.sensenova.cn`、`platform.sensenova.cn`、`token.sensenova.cn` 的 Date 与本机时点，输出 `missing-date` / `invalid-date` / `redirect-date` / `code-error`（墙钟与单调耗时不自洽） / `stale-cache-date`（Age > 5 分钟） / `cacheAgeUnknown`（可共享缓存但无 Age） / `source-clock-skew` / `host-clock-skew` / `ok`，并单独给出不受缓存门影响的 `skewClass`。**provider API 域 Date 只用于标注偏差在哪一侧，不能替代 web/console 时钟，也不得据多数域推翻目标域**；本机在 ±5 分钟内也不能单独证明来源时间可信。`sourceDate` gap 的文案必须写清来源侧/本机侧与分类，不再写成笼统的“local clock differs”。

**门（只收紧）**：官方页 `planSource` 只在 Date 有效、Age 缺失但不可共享缓存（或 Age ≤ 5 分钟）、且 `|skew| ≤ 5 分钟` 时生成；缺失/非法/3xx/陈旧缓存/缓存年龄未知/超界一律 blocked，±5 分钟与差 1 均无容差，也不改宿主机时钟。console 的 `reset_at` 用同域相对差 `reset_at − (Date + Age)` 判定；console Date 缺失/非法、缓存陈旧或年龄未知时，reset 相对时间不可建立，直接 blocked。

**条件 GET**：主页面 200 且带 ETag 时追加一次 `If-None-Match` + `Cache-Control: no-cache` + `Pragma: no-cache` 请求，receipt 记录请求头、304/200、Date、Age、ETag、body hash、`x-nextjs-cache`。**304（本身也可能来自缓存）或 200+同 ETag/同 body hash 最多证明 body 身份，永不证明 origin 重新校验或内容新鲜，也永不绕过时钟门**。

**池原始精度**：`PoolFacts` 每项保留脱敏 `{type:'number'|'string'|'null', value}` 的 raw 值（`limit/used/remaining/reset_at` 的 5h/7d 全部），`derivations.poolUsageSnapshot` 记录同一快照的 Date/Age/cache-control/ETag/requestId/raw SHA256/bodyBytes。算术前不 `Math.floor`、不静默字符串强转：值必须是有限、非负、精确整数，否则 `poolPrecision` gap；小数或小数字符串默认 blocked，除非 provider 给出书面取整规则（当前没有）。`used` 缺失记 missing，禁止派生。`quotaAmount` 仍 `min(60000, 所有窗口最小 remaining)`，不因 120k/1.2M 或差 1 扩大。`pools[].resetAt` 写入文档时是 console 时钟域的绝对 epoch；`expiresAt` 由同域相对差推导并在 receipt 的 `expiryDerivation` 中可复算，绝对来源时间不得延长证据。

产品消费端不变：投递的 JWT 仍 `contractVersion=1`，manifest 仍 schemaVersion=1，v3 文档不进入 JWT（产品只校验签名、manifest 与 documentHash）。若未来产品需要解析 evidence 文档，v3 必须另拆独立产品交付链与部署依赖，不能把不兼容版本直接发布为可用。

`revalidateBeforeUse=true` 是文档的持续义务声明，不是“已核实”的证明：每次模型调用前由源业务（33dc）重新采样官方 FREE/限时状态与池剩余，文档到期即作废、不续旧件；公司证明链只在签发时校验该文档。

评审人生命周期（FV06）：批准以审计行的 accept 评审人为准，其撤权状态按结构化字段判定，诊断、授权与密钥轮换共用同一规则。调度器正常轮换或归档（员工退役类型 `rotation` / `archive`）只使凭证失效，不撤销已形成的独立批准；显式安全撤权（管理员 revoke，写入不可回退的 `security_revoked`）、失败或人工退役、改动前写入的无类型退役（旧记录）一律拒绝。旧记录不自动追认，需要新的独立批准。
