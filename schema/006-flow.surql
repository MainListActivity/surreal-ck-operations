-- v6: 项目环境、加密环境凭证、目标分级。
-- goal / task 上的新字段一律 option<>，避免旧行在 UPDATE 整行校验时因缺字段被拒。

DEFINE TABLE IF NOT EXISTS project SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS name ON project TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS repo_path ON project TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS red_lines ON project TYPE array<string> DEFAULT [];

DEFINE TABLE IF NOT EXISTS project_env SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS project ON project_env TYPE record<project>;
DEFINE FIELD IF NOT EXISTS name ON project_env TYPE string ASSERT string::len($value) > 0;
DEFINE INDEX IF NOT EXISTS project_env_name ON project_env FIELDS project, name UNIQUE;

-- 值以 AES-256-GCM 加密；密钥只在本机 macOS 钥匙串（或 SCK_SECRET_KEY），数据库里没有明文。
DEFINE TABLE IF NOT EXISTS env_secret SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS env ON env_secret TYPE record<project_env>;
DEFINE FIELD IF NOT EXISTS name ON env_secret TYPE string ASSERT $value = /^[A-Za-z][A-Za-z0-9_.-]*$/;
DEFINE FIELD IF NOT EXISTS roles ON env_secret TYPE array<string> DEFAULT ['qa'];
DEFINE FIELD IF NOT EXISTS ciphertext ON env_secret TYPE string;
DEFINE FIELD IF NOT EXISTS iv ON env_secret TYPE string;
DEFINE FIELD IF NOT EXISTS tag ON env_secret TYPE string;
DEFINE INDEX IF NOT EXISTS env_secret_name ON env_secret FIELDS env, name UNIQUE;

DEFINE FIELD IF NOT EXISTS tier ON goal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS project ON goal TYPE option<record<project>>;
DEFINE FIELD IF NOT EXISTS triage_via ON goal TYPE option<string>;
DEFINE INDEX IF NOT EXISTS goal_state ON goal FIELDS state;

DEFINE FIELD IF NOT EXISTS jev_release_version ON task TYPE option<int>;
DEFINE FIELD IF NOT EXISTS jev_route_version ON task TYPE option<int>;
DEFINE FIELD IF NOT EXISTS owner_rerouted ON task TYPE option<bool>;

DEFINE FIELD IF NOT EXISTS tier ON owner_command TYPE option<string>;
DEFINE FIELD IF NOT EXISTS project ON owner_command TYPE option<string>;
