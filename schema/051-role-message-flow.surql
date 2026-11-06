-- v51: 派工体系重构。outbound_message 保存建单时生成的待发消息草稿、编辑、放行与已发原文；
-- task 增补 requirement / acceptance_text；迁移撤销 gm 岗位、把在途任务改派给老板。
DEFINE TABLE IF NOT EXISTS outbound_message SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS task ON outbound_message TYPE record<task>;
DEFINE FIELD IF NOT EXISTS step ON outbound_message TYPE string ASSERT $value IN ['execute','review','rework','nudge','eval'];
DEFINE FIELD IF NOT EXISTS role ON outbound_message TYPE string;
DEFINE FIELD IF NOT EXISTS body ON outbound_message TYPE string;
DEFINE FIELD IF NOT EXISTS state ON outbound_message TYPE string DEFAULT 'draft' ASSERT $value IN ['draft','held','sent'];
DEFINE FIELD IF NOT EXISTS hold ON outbound_message TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS edited_by ON outbound_message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS edited_at ON outbound_message TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS sent_to ON outbound_message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS sent_at ON outbound_message TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON outbound_message TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS outbound_message_task ON outbound_message FIELDS task, step, created_at;

DEFINE FIELD IF NOT EXISTS requirement ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS acceptance_text ON task TYPE option<string>;

-- 迁移：停用 gm 编制，把在途 gm 任务改到老板；gm 复核岗按执行岗转 product 或 qa；gm 执行岗转 product 并由老板接续，写审计。
UPDATE employee_def SET enabled = false, disabled_reason = 'gm 岗位撤销', disabled_at = time::now() WHERE role = 'gm';
UPDATE task SET blocked_to = 'owner' WHERE state = 'blocked' AND blocked_to = 'gm';
UPDATE task SET reviewer_role = 'product' WHERE reviewer_role = 'gm' AND executor_role = 'qa' AND state NOT IN ['done', 'void'];
UPDATE task SET reviewer_role = 'qa' WHERE reviewer_role = 'gm' AND state NOT IN ['done', 'void'];
LET $gm_tasks = SELECT id, version, reviewer_role, state, blocked_to FROM task WHERE executor_role = 'gm' AND state NOT IN ['done', 'void'];
FOR $t IN $gm_tasks {
  IF $t.reviewer_role != 'owner' {
    IF NOT ($t.state = 'blocked' AND $t.blocked_to = NONE) {
      UPDATE ONLY $t.id SET
        executor_role = 'product',
        dependency_continuation = 'manager',
        state = 'blocked',
        blocked_to = 'owner',
        resume_state = 'ready',
        current_employee = NONE,
        delivery_id = NONE,
        lease_expires_at = NONE,
        version = $t.version + 1;
    } ELSE {
      UPDATE ONLY $t.id SET
        executor_role = 'product',
        dependency_continuation = 'manager',
        version = $t.version + 1;
    };
  } ELSE {
    UPDATE ONLY $t.id SET
      executor_role = 'product',
      version = $t.version + 1;
  };
  CREATE audit CONTENT {
    task: $t.id,
    actor: 'owner:migration',
    action: 'gm_role_retired',
    evidence: 'gm 岗位撤销',
    version: $t.version + 1,
    at: time::now()
  };
};
