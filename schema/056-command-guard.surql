-- 056 命令守卫：老板保护命令（protected_command）、员工策略（agent_policy）与只追加的审计账本（ops_audit）。
-- 只新增三张表与事件，本机与公司库都应用；旧 release 读不到这三张表即忽略（RB01）。
-- 写入边界看 $access：老板访问方式（owner）与 root（$access 为 NONE）可以写保护清单与员工策略，其它访问方式一律拒绝。
-- 系统用户（rl）不受表 PERMISSIONS 约束，所以这里用 EVENT 判断，THROW 会回滚整条语句。

DEFINE TABLE IF NOT EXISTS protected_command SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS command ON protected_command TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS owner_only ON protected_command TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS updated_by ON protected_command TYPE string;
DEFINE FIELD IF NOT EXISTS updated_at ON protected_command TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS protected_command_command ON protected_command FIELDS command UNIQUE;
DEFINE EVENT OVERWRITE protected_command_owner_write ON TABLE protected_command WHEN $access != NONE AND $access != 'owner' THEN {
  THROW '只有老板可以修改保护命令';
};

DEFINE TABLE IF NOT EXISTS agent_policy SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS agent ON agent_policy TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS disabled ON agent_policy TYPE bool DEFAULT false;
-- allow 为 NONE 表示不限制；为数组（含空数组）时只放行清单内的命令。
DEFINE FIELD IF NOT EXISTS allow ON agent_policy TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS deny ON agent_policy TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS updated_by ON agent_policy TYPE string;
DEFINE FIELD IF NOT EXISTS updated_at ON agent_policy TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS agent_policy_agent ON agent_policy FIELDS agent UNIQUE;
DEFINE EVENT OVERWRITE agent_policy_owner_write ON TABLE agent_policy WHEN $access != NONE AND $access != 'owner' THEN {
  THROW '只有老板可以修改员工策略';
};

-- 审计只存参数与结果的摘要（args_digest / result_digest），不存原文：参数里可能有凭据或客户资料。
DEFINE TABLE IF NOT EXISTS ops_audit SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS at ON ops_audit TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS actor_kind ON ops_audit TYPE string ASSERT $value IN ['owner', 'agent', 'runner', 'automation'];
DEFINE FIELD IF NOT EXISTS actor ON ops_audit TYPE string;
DEFINE FIELD IF NOT EXISTS task ON ops_audit TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS command ON ops_audit TYPE string;
DEFINE FIELD IF NOT EXISTS args_digest ON ops_audit TYPE string;
DEFINE FIELD IF NOT EXISTS outcome ON ops_audit TYPE string ASSERT $value IN ['ok', 'denied', 'error'];
DEFINE FIELD IF NOT EXISTS reason ON ops_audit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS result_digest ON ops_audit TYPE option<string>;
DEFINE INDEX IF NOT EXISTS ops_audit_at ON ops_audit FIELDS at;
DEFINE EVENT OVERWRITE ops_audit_append_only ON TABLE ops_audit WHEN $event = 'UPDATE' OR $event = 'DELETE' THEN {
  THROW '审计账本只追加，不能修改或删除';
};
