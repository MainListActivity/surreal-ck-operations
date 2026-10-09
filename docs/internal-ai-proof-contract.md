# 公司内部AI可信证明契约 v1（实现冻结）

本链6ebb9e12代码范围是公司运维程序；制度只读。实现不合入、不部署。公司release与Paseo vendor双面发布，不能走产品Hono发布模板。

固定issuer `urn:surreal-ck:company:internal-ai:v1`；audience `urn:surreal-ck:surreal_ck:production:internal-ai:v1`；Ed25519/EdDSA，显式kid，产品pin公开JWK；禁止caller传JWKS URL。签名私钥由代理在现有env_secret AES-GCM密封存储原子初始化，员工仅得到公开信任锚。proof最长300秒；状态最长60秒，客户端必须校验自己生成的nonce、jti及用途。

工具（均从sidecar当前租约读取任务/员工/角色/goal/project/env）：
- `ops_internal_ai_prepare {env?, manifestPath, documentPath}`：仅将当前任务交付目录的实际受审JSON manifest和脱敏文档字节SHA256登记为不可变候选。返回digest与独立评审必须明确使用的接受标记；不签enable，不创建任务。
- `ops_internal_ai_prove {env?, mode:"register-disabled"|"enable", approvalTask?, manifestPath, documentPath, activityId, nonce, idempotencyKey}`：enable必须找到同goal/project独立review的真实done/accept（或owner approve）审计，接受证据含精确 `company-internal-ai-approve:v1:<digest>`，且已prepare候选完全一致。普通taskRef/version、subscription.manage、GM拆链文字不算审批。disabled从当前任务读取，证明类型development-disabled、paidCallsAllowed=0，不冒充余额ready。仅返回task-bound proofHandle及脱敏摘要。
- `ops_internal_ai_deliver {env?, proofHandle, session}`：运营会话调用固定产品POST `/api/ops/internal-ai/company-proof`；原始JWS、subject、状态认证能力仅代理→产品内部传送，员工响应仅状态/非敏感摘要。消费端未部署时准确报告不可用。
- `ops_internal_ai_revoke {env?, proofHandle}`：持久撤回并审计；同scope可跨重试撤回，不能越租约/环境/身份。
- `ops_internal_ai_trust {env?}`：仅公开issuer/audience/alg/kid/JWK/契约与状态路径。

manifest（严格JSON，不接受未知字段）含schemaVersion=1、goalId=2e2a6e41c1193595、project=surreal_ck、env=production、activityId、service.accountRef/endpoint/model/priceRevision、budget.currency=USD/totalNanoUsd<=1e9/perAttemptNanoUsd<=1e8/maxAttempts<=30/autoTopupDisabled=true、documentHash、角色固定LCA04_REMOVABLE admin+owner与LCA04_MEMBER participant+member、workspaceSlug（当前ui01实际slug）、configurationDigest（上述规范JSON计算）。文件只允许对应审批任务evidenceDir或已发布deliverables根，普通文件、无隐藏/secret路径、无symlink，读取同一已打开fd，前后inode/size/mtime/ctime核对，最多256KiB；documentHash由代理实际字节校验，正文不落日志或证明。

正常身份来源：代理读取自己密封alias密码，正常customer PKCE登录（不ensure、不修复、不建账号成员，consent不绕过），从当前产品正常workspace/member通道核对subject/database。产品消费链提供只读 `GET /api/internal-ai/identity?workspaceSlug=...`，响应仅本调用者subject、spaceId、database、workspaceRole、billingRole、billingAccountRef；产品以正常workspace/成员/计费索引实时计算，不能回显body自报值。代理再比对正常workspace列表、scope切换和workspace user查询subject/is_admin，未知/不匹配拒签。该只读契约补齐计费身份；现有quota/邮箱不能推断owner/member。此消费端就绪前身份资料unavailable，不伪造ready。

Proof claims绑定project/env/goal、requestTask/员工+delivery+fence、approvalTask/version/action/auditId、documentHash、完整manifest/digest、映射与映射digest、scope、jti、nonce、iat/exp、type、paidCallsAllowed、status能力。用途 `sck-internal-ai-proof+jwt`。nonce与idempotencyKey同scope同digest可复用同结果；改变任何activity/env/身份/用途冲突，不跨任务复用。

状态复用现有preview发布面 `GET /internal-ai/status`，仅Bearer专用随机status能力（proof内交产品）与`x-sck-nonce`，不使用preview HMAC。答复为EdDSA签名 `sck-internal-ai-status+jwt`，只含指定jti/valid/版本/checkedAt/expiry/nonce。私有task/history/文件不开放。每次状态请求重新查审批事件/任务版本、实际文件hash、当前租约、employee撤权及真实身份映射；失败、未知或变更均拒绝/invalid。新登记/enable必取当前状态；新的模型调用/续跑状态年龄<=60秒、exp有效，否则fail-closed。无后台timer。

当前生产preview signed未配置，公网可达状态地址需按已有runbook复用公司发布面，由上线/部署阶段核定，不新购或SSH。本实现公开固定相对路径与pin契约，不能宣称origin已能访问。proofHandle最长300秒且租约结束失效；生产无真实审批/资料仍paidCallsAllowed=0。
