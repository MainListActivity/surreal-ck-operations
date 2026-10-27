-- Durable jobs survive the plugin replacing itself. No shell text or credentials from employees.
DEFINE TABLE IF NOT EXISTS company_upgrade SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS company_upgrade_at ON company_upgrade FIELDS at;
