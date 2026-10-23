-- v27: QA 受限只读取证通道（SYS-DISP QA observation）。仅新增两张表，不改写任何既有行。
-- 编号说明：执行当刻 main 的迁移到 024；在办 PR #1494 预占 025（维护暂停）、PR #1547 预占 026（SYS02 验收）。
-- 本 lane 不合并那些未发布功能，故取 027，避免与在办迁移同文件冲突；部署集成时按当时 main 的并集重排并重跑 bootstrap。
-- qa_observation_scope：GM 登记的只读验收范围（部署任务、同 goal、QA/复核租约 holder+fence、任务 allowlist、期限、版本）。
-- qa_observation_session：QA 经本人 sck 会话换取的一次性登录码与浏览器受限会话（只存哈希，不存明文）。
DEFINE TABLE IF NOT EXISTS qa_observation_scope SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS qa_observation_scope_deployment ON qa_observation_scope FIELDS deployment_task;
DEFINE INDEX IF NOT EXISTS qa_observation_scope_qa ON qa_observation_scope FIELDS qa_employee, status;
DEFINE TABLE IF NOT EXISTS qa_observation_session SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS qa_observation_session_code ON qa_observation_session FIELDS code_hash;
DEFINE INDEX IF NOT EXISTS qa_observation_session_token ON qa_observation_session FIELDS token_hash;
