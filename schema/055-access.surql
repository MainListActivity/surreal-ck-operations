-- 055 公司库访问方式：老板（owner）、员工运行器（runner）、自动化（automation）三种 JWT 访问方式，以及 runner / automation 的字段守卫。
-- 只由 bootstrap 在 COMPANY_JWKS_URL 与 COMPANY_ISSUER 都配置时应用：占位符替换后执行；本机模式跳过，且不推进 schema_version（不新增表）。
-- 每次 bootstrap 都重放（OVERWRITE）：JWKS 地址或签发方变更后，下一次 bootstrap 即生效。只新增访问方式与事件，不改任何既有行。
-- 令牌约定：必须带 ac=<访问方式名>、ns、db；rl 为数组（如 ["Editor"]）；身份用 sub，不能带 id / ID（fork 会把它当成记录用户并拒绝）。
-- 系统用户（rl）不受表 PERMISSIONS 约束，所以字段守卫用 EVENT：事件里 $access 可用，THROW 会回滚整条语句。

DEFINE ACCESS OVERWRITE owner ON DATABASE TYPE JWT URL '{{COMPANY_JWKS_URL}}'
  AUTHENTICATE { IF $token.iss != '{{COMPANY_ISSUER}}' { THROW '令牌签发方不属于公司库' } }
  DURATION FOR SESSION 15m;

DEFINE ACCESS OVERWRITE runner ON DATABASE TYPE JWT URL '{{COMPANY_JWKS_URL}}'
  AUTHENTICATE { IF $token.iss != '{{COMPANY_ISSUER}}' { THROW '令牌签发方不属于公司库' } }
  DURATION FOR SESSION 15m;

DEFINE ACCESS OVERWRITE automation ON DATABASE TYPE JWT URL '{{COMPANY_JWKS_URL}}'
  AUTHENTICATE { IF $token.iss != '{{COMPANY_ISSUER}}' { THROW '令牌签发方不属于公司库' } }
  DURATION FOR SESSION 15m;

-- 需求与验收标准只能由老板修改：runner / automation 改动已有任务的这些字段一律拒绝。
-- 只比较值是否变化，原样回写同一个值仍然放行。context 是老板原话（建单时写入），按需求处理。
-- acceptance_environment 由 submit 写入（执行人报告环境），不在守卫内，否则会打断提交路径。
DEFINE EVENT OVERWRITE task_owner_fields_update ON TABLE task WHEN $event = 'UPDATE' AND $access IN ['runner', 'automation'] AND (
  $before.requirement != $after.requirement OR $before.acceptance_text != $after.acceptance_text
  OR $before.acceptance_criteria != $after.acceptance_criteria OR $before.context != $after.context
) THEN {
  THROW '需求与验收标准只能由老板修改';
};

-- 员工建单只走提议（submit 的 next，带 proposed_in）。runner / automation 直接建带需求、验收或正文的非提议任务一律拒绝。
DEFINE EVENT OVERWRITE task_owner_fields_create ON TABLE task WHEN $event = 'CREATE' AND $access IN ['runner', 'automation']
  AND $after.proposed_in = NONE AND (
    $after.requirement != NONE OR $after.acceptance_text != NONE OR $after.acceptance_criteria != NONE OR $after.context != NONE
  ) THEN {
  THROW '非提议任务不能由员工直接写入需求或验收标准';
};

-- 消息正文与放行保留（hold）只能由老板改。员工侧 markSent 只写 state / sent_*，并把 hold 写回 false：
-- 草稿未被保留时值不变、放行；已被老板保留时守卫拒绝，老板的保留优先于发送。
-- CREATE 不在守卫内：员工提议与路线草稿靠它建草稿。
DEFINE EVENT OVERWRITE outbound_message_owner_fields ON TABLE outbound_message WHEN $event = 'UPDATE' AND $access IN ['runner', 'automation'] AND (
  $before.body != $after.body OR ($before.hold ?? false) != ($after.hold ?? false)
) THEN {
  THROW '消息正文与放行保留只能由老板修改';
};
