-- v7: 公网 MCP 端点门禁。远端实例在员工 Bearer 认证之前先校验一道共享口令；
-- 口令由 SurrealDB 生成（rand::string），只存在于数据库与各调用方的私有 env 文件。

DEFINE TABLE IF NOT EXISTS service_gate SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS token ON service_gate TYPE string ASSERT string::len($value) >= 32;
