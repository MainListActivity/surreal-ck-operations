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

采样器 `sensenova-token-plan/2` 使用账户 console 的 `/tokenplan/pool-usage` 计划读回；以同一 console `/metered/api-keys` 对密封 API key 精确交叉绑定。`/v1/models` 只验证 key 活性与模型列表，不证明账户 FREE。官方计划页面须同时包含免费公测、付费档位即将上线、60,000积分/5小时、Free 公测正面标记；console governing pool 的硬顶须与核定配额一致，否则 blocked。猜测支付 URI 枚举纯为回执观测（paymentSurface 不作证明、不阻塞文档）：存活面漂移记 note 提请人工复核，付费档上线跳闸仍由官方页 marker 承担；枚举绝不证明支付绑定为空或账户自动充值已禁用。`ACCOUNT_PAYMENT_SOURCES` 注册表机制保留、维持空表，供应商出现官方账户级支付来源时再注册。回执 `accountPlanSource` 标来源与绑定，`removedAccountAssertions` 标明 noPaymentInstrument/autoTopupDisabled 系契约修订移除而非探测不足；缺计划/非 FREE/未绑定列 `account-plan-free` gap。剩余额度未读回可 null 并记录 gap，不臆造数值。过期重置窗口闭锁，文档 expiresAt 取重置时刻与24小时上限的较早者。

manifest.budget.autoTopupDisabled=true 和我方计量配置自动充值禁用保持；measurementCycle≤30、worstCost=0、原30台账和消费者预算门不在本次变更中放宽。JWT contractVersion=1、issuer/audience/alg/kid 和信任锚不变。
