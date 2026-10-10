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

evidenceSchema 是按 `type` 判别的冻结联合，与产品侧 `reviewedEvidenceSchema`（surreal_ck `shared/src/internal-ai-proof.ts`）逐字一致：`development-disabled`/`reviewed-service` 沿用 USD-only 余额契约（currency=USD、balanceNanoUsd 非负）；`reviewed-token-plan` 为配额型供应商证据，无 USD 现金价目/余额语义，必填 planName（无控制字符短文本）、planSourceUrl（与 endpoint 同规则的 https 出处）、quotaUnit（points/requests）、quotaAmount（正整数）、quotaWindowSeconds（正整数）、noPaymentInstrument=true，quotaRemaining 可空、存在时非负。两族字段互不混入：配额文档写 currency/balanceNanoUsd、USD 文档写配额字段、未知字段均拒绝。`ops_internal_ai_prove(mode=enable)` 对 reviewed-service 分支不变（serviceApproved 且 balanceNanoUsd 覆盖 manifest.budget.totalNanoUsd）；对 reviewed-token-plan 改查配额语义：serviceApproved、quotaAmount>0、quotaRemaining 存在时>0、noPaymentInstrument 与 autoTopupDisabled 为 true、sampledAt 不晚于签发时刻、expiresAt 未过，不再要求 USD 余额覆盖预算。证明绑定/租约/独立审批检查不因证据类型放宽。

## 独立复核和发布交接

本机（公司fork已安装）执行 `rtk proxy env RUN_COMPANY_PROOF_FORK_TESTS=1 pnpm test:bridge`，该测试自行启动隔离RocksDB，使用实际CompanyCore claim/submit/独立accept事件、正常IdP/客户接口合成fixture；不加载产品.env、不访问生产、不操作真实账号或模型。CI Quality gate执行公司/插件类型检查和无凭证相关单测，fork项显式skip，不能替代本机fork证据。

发布仍需另一工程复核、独立上线申请。固定release安装按docs/company-service-operations.md，先从批准提交打包、根 `pnpm install --frozen-lockfile` 并由现有脚本安装固定release，schema010随MCP bootstrap新增；插件必须来自同一批准基线的独立打包worktree（保留并整合operations-v3的在途提交），`rtk proxy pnpm --dir plugin install --frozen-lockfile --ignore-scripts`、`rtk proxy sh plugin/scripts/vendor.sh`、公司和插件typecheck后reload现有sck-company，不新建dispatcher。vendor同时拷贝src和schema；不要把本开发worktree直接作为active或覆盖共享插件源码。

部署核对 `/health`、`/ready`、ops_info六工具+JSON schema、公开keyId、公司固定release SHA和插件vendor基线SHA。使用真实已登记alias的只读通道验证映射；产品identity接口未就绪不得推断角色。公网状态地址由既有发布面配置，固定origin信任锚由产品CI消费，不把caller URL带进proof。先用development-disabled证明验证验签/撤回/expiry，再验证无审批enable拒绝、未知资料拒绝、nonce和跨scope拒绝；不调用模型，不充值。

回滚：恢复此前固定公司release和对应独立插件包（包括其在途提交），reload同一插件。产品内部活动保持disabled/paidCallsAllowed=0；状态不可达、证明过期或key不匹配均拒绝。保留候选/proof/撤回记录及密封key，不删除历史、不重置预算；新表可留在库内。
