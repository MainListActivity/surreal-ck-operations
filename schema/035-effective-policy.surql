-- v34: 有效策略层（SYS06 P1）。只新增表与字段：本次迁移前写入的任务行没有策略登记，语义是"无有效契约"，
-- 与旧版行为一致；没有改写或删除任何已有数据。
-- policy 是版本化的机器策略，只有 status 会随后续版本/撤销变化，payload 与 hash 一版写定后不再改动（历史不可变）。
-- 任务的 policy_* 是创建时的契约登记，lease_policy_* 是本租约的契约登记：策略变了以后，旧 claim 与旧提示都不能继续授权写。
DEFINE TABLE IF NOT EXISTS policy SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS policy_version_key ON policy FIELDS policy_id, version UNIQUE;
DEFINE INDEX IF NOT EXISTS policy_domain_scope ON policy FIELDS domain, scope, scope_ref;
DEFINE FIELD IF NOT EXISTS policy_id ON policy TYPE string;
DEFINE FIELD IF NOT EXISTS version ON policy TYPE int;
DEFINE FIELD IF NOT EXISTS scope ON policy TYPE string;
DEFINE FIELD IF NOT EXISTS scope_ref ON policy TYPE option<string>;
DEFINE FIELD IF NOT EXISTS domain ON policy TYPE string;
DEFINE FIELD IF NOT EXISTS status ON policy TYPE string;
DEFINE FIELD IF NOT EXISTS effective_at ON policy TYPE int;
DEFINE FIELD IF NOT EXISTS expires_at ON policy TYPE option<int>;
DEFINE FIELD IF NOT EXISTS supersedes ON policy TYPE option<record<policy>>;
DEFINE FIELD IF NOT EXISTS superseded_by ON policy TYPE option<record<policy>>;
DEFINE FIELD IF NOT EXISTS revoked_by ON policy TYPE option<record<employee>>;
DEFINE FIELD IF NOT EXISTS revoke_reason ON policy TYPE option<string>;
DEFINE FIELD IF NOT EXISTS authorization ON policy TYPE object;
DEFINE FIELD IF NOT EXISTS payload ON policy TYPE object;
DEFINE FIELD IF NOT EXISTS hash ON policy TYPE string;
DEFINE FIELD IF NOT EXISTS created_by ON policy TYPE record<employee>;
DEFINE FIELD IF NOT EXISTS created_at ON policy TYPE datetime;
DEFINE FIELD IF NOT EXISTS policy_version ON task TYPE option<int>;
DEFINE FIELD IF NOT EXISTS policy_hash ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS policy_contract ON task TYPE option<object>;
DEFINE FIELD IF NOT EXISTS lease_policy_version ON task TYPE option<int>;
DEFINE FIELD IF NOT EXISTS lease_policy_hash ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS policy_block_reason ON task TYPE option<string>;