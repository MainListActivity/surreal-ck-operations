-- 058 老板端共享核心：执行作业表（ops_job）、员工身份映射（agent_identity）、消息译文字段（outbound_message）、员工语言（agent_policy）与审计摘要（ops_audit）。
-- 只新增表与字段，不改既有行；旧 release 读不到这些表与字段即忽略（RB01）。
-- 访问方式（access）不在本文件定义（055 与 W3-RUNNER 管）；schema 只由 migrator / bootstrap 应用。
-- 本文件不写 protected_command 与 agent_policy 的数据（056 的 EVENT 只认 owner）；这里只给 agent_policy 加 lang 字段。

-- 执行作业：老板端发起的长任务（排队、运行、完成或出错）。input 与 result 存 JSON 文本，由调用方负责脱敏。
DEFINE TABLE IF NOT EXISTS ops_job SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS command ON ops_job TYPE string;
DEFINE FIELD IF NOT EXISTS input ON ops_job TYPE string;
DEFINE FIELD IF NOT EXISTS actor_kind ON ops_job TYPE string ASSERT $value IN ['owner', 'agent', 'runner', 'automation'];
DEFINE FIELD IF NOT EXISTS actor ON ops_job TYPE string;
DEFINE FIELD IF NOT EXISTS task ON ops_job TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS state ON ops_job TYPE string ASSERT $value IN ['queued', 'running', 'done', 'error'];
DEFINE FIELD IF NOT EXISTS result ON ops_job TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error ON ops_job TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON ops_job TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS started_at ON ops_job TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS finished_at ON ops_job TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS runner ON ops_job TYPE option<string>;
DEFINE INDEX IF NOT EXISTS ops_job_state ON ops_job FIELDS state;
DEFINE INDEX IF NOT EXISTS ops_job_created ON ops_job FIELDS created_at;

-- 员工身份映射：本机员工 key 与身份提供方用户的一一对应。两边都唯一，一个员工只对应一个身份，反之亦然。
DEFINE TABLE IF NOT EXISTS agent_identity SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS employee ON agent_identity TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS idp_user ON agent_identity TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS created_at ON agent_identity TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON agent_identity TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS agent_identity_employee ON agent_identity FIELDS employee UNIQUE;
DEFINE INDEX IF NOT EXISTS agent_identity_idp_user ON agent_identity FIELDS idp_user UNIQUE;

-- 译文：老板为某个员工语言准备的译文只对应它译过的那一版原文。translated_from_hash 是译文时的原文哈希（SHA-256，小写十六进制）；
-- 原文一改哈希即不一致，译文视为过期，投递时等待补译。outbound_message 为 SCHEMALESS，这里只声明新增字段的类型。
DEFINE FIELD IF NOT EXISTS lang ON outbound_message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS translated_text ON outbound_message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS translated_from_hash ON outbound_message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS translated_at ON outbound_message TYPE option<datetime>;
-- 补译失败的时间：定时补译先译没失败过的，失败过的按这个时间轮流，译不出的消息不挡住其它消息（见 owner-end/src/cron.ts）。
DEFINE FIELD IF NOT EXISTS translate_failed_at ON outbound_message TYPE option<datetime>;
-- 老板为这条消息选过语言（含选“原文”）：之后不再套用员工默认语言。
DEFINE FIELD IF NOT EXISTS lang_chosen ON outbound_message TYPE option<bool>;

-- 员工默认语言：派工时，老板没为消息选过语言的，消息带上该语言（之后按译文投递）；没有值即沿用原文（既有行为不变）。
DEFINE FIELD IF NOT EXISTS lang ON agent_policy TYPE option<string>;

-- 审计摘要：一句话的可读说明，最多 500 个字符；审计账本仍只追加（056）。
DEFINE FIELD IF NOT EXISTS summary ON ops_audit TYPE option<string> ASSERT $value = NONE OR string::len($value) <= 500;
