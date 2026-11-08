-- 057 老板看板的执行端心跳：本机插件每 30 秒 upsert 一行 runner_heartbeat:current。只新增表，不改既有行；旧 release 读不到即忽略（RB01）。
DEFINE TABLE IF NOT EXISTS runner_heartbeat SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS runner ON runner_heartbeat TYPE string;
DEFINE FIELD IF NOT EXISTS host ON runner_heartbeat TYPE string;
DEFINE FIELD IF NOT EXISTS version ON runner_heartbeat TYPE string;
DEFINE FIELD IF NOT EXISTS at ON runner_heartbeat TYPE datetime;
