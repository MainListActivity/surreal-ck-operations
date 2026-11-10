-- 产品反馈、独立需求与老板确认快照。旧任务保持原状。
DEFINE TABLE IF NOT EXISTS product_iteration SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS product_feedback SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS product_feedback_rate SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS product_requirement SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS requirement_approval SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS feedback_product_state ON product_feedback FIELDS project, state;
DEFINE INDEX IF NOT EXISTS feedback_request ON product_feedback FIELDS project, request_key UNIQUE;
DEFINE INDEX IF NOT EXISTS requirement_product_state ON product_requirement FIELDS project, state;
DEFINE INDEX IF NOT EXISTS approval_revision ON requirement_approval FIELDS requirement, revision UNIQUE;
-- JWT 的系统角色不受 PERMISSIONS 约束。确认快照必须由 owner 身份创建，且不可更新/删除。
-- 本地 fork 的 root 测试、受控迁移没有 $access，可创建 fixture；生产不向执行端提供 root。
DEFINE EVENT OVERWRITE approval_owner_only ON requirement_approval WHEN $event IN ['CREATE', 'UPDATE', 'DELETE'] THEN {
  IF $access != NONE AND ($access != 'owner' OR $event != 'CREATE') {
    THROW 'requirement approval is immutable and requires owner identity';
  };
};

DEFINE EVENT OVERWRITE product_policy_owner_only ON product_iteration WHEN $event IN ['CREATE', 'UPDATE', 'DELETE'] THEN {
  IF $access != NONE AND $access != 'owner' { THROW 'product iteration policy requires owner identity'; };
};

DEFINE TABLE IF NOT EXISTS requirement_plan SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS requirement_release_approval SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS requirement_execution SCHEMALESS PERMISSIONS NONE;
DEFINE EVENT OVERWRITE plan_automation_only ON requirement_plan WHEN $event IN ['CREATE','UPDATE','DELETE'] THEN {
  IF $access != NONE AND ($access != 'automation' OR $event != 'CREATE') { THROW 'iteration plan is immutable and requires automation identity'; };
  IF !record::exists($after.approval) { THROW 'iteration plan requires owner approval'; };
};
DEFINE EVENT OVERWRITE release_approval_owner_only ON requirement_release_approval WHEN $event IN ['CREATE','UPDATE','DELETE'] THEN {
  IF $access != NONE AND ($access != 'owner' OR $event != 'CREATE') { THROW 'release approval is immutable and requires owner identity'; };
};
