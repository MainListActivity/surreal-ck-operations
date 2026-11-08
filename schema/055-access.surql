-- 055 公司库访问方式：老板（owner）、员工运行器（runner）、自动化（automation）、网关（gateway）、迁移（migrator）、只读（viewer）六种 JWT 访问方式，以及 runner / automation 的字段守卫。
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

-- 网关（gateway，rl=Editor）：代老板执行命令。不在上面的字段守卫名单内，所以其写入不受 task / outbound_message 守卫限制。
DEFINE ACCESS OVERWRITE gateway ON DATABASE TYPE JWT URL '{{COMPANY_JWKS_URL}}'
  AUTHENTICATE { IF $token.iss != '{{COMPANY_ISSUER}}' { THROW '令牌签发方不属于公司库' } }
  DURATION FOR SESSION 15m;

-- 迁移（migrator，rl=Owner）：只供 company-migrate 与首次开通使用，应用 schema 与初始数据。
DEFINE ACCESS OVERWRITE migrator ON DATABASE TYPE JWT URL '{{COMPANY_JWKS_URL}}'
  AUTHENTICATE { IF $token.iss != '{{COMPANY_ISSUER}}' { THROW '令牌签发方不属于公司库' } }
  DURATION FOR SESSION 15m;

-- 只读（viewer，rl=Viewer）：看板与只读查询。Viewer 角色不能写入，写入由 fork 的角色检查拒绝。
DEFINE ACCESS OVERWRITE viewer ON DATABASE TYPE JWT URL '{{COMPANY_JWKS_URL}}'
  AUTHENTICATE { IF $token.iss != '{{COMPANY_ISSUER}}' { THROW '令牌签发方不属于公司库' } }
  DURATION FOR SESSION 15m;

-- 原有的 runner / automation 字段守卫（需求、验收、正文、保留）已在 059 移除：老板定，持有任务的员工可以执行老板端全部操作，
-- 云端执行端以 runner 身份代员工与老板（RUNNER_ONLY 命令）写库，字段守卫会挡住建单与改单。限制靠网关的命令守卫与按目标锁。
