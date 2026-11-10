-- 061 节点记录与升级回退记录：每台执行端一行 node_release（插件心跳、节点更新器检查与结果），
-- node_rollback 只追加，记录每次回退的来源与去向。只新增表与索引，不改任何既有行；旧 release 读不到即忽略（RB01）。
-- 任务租约所在节点（认领时写入）：节点更新器据此判断本节点有没有进行中的租约；未归属的旧租约按阻止处理。
DEFINE FIELD IF NOT EXISTS lease_node ON task TYPE option<string>;

DEFINE TABLE IF NOT EXISTS node_release SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS host ON node_release TYPE string;
DEFINE FIELD IF NOT EXISTS platform ON node_release TYPE string;
DEFINE FIELD IF NOT EXISTS version ON node_release TYPE option<string>;
DEFINE FIELD IF NOT EXISTS sha ON node_release TYPE option<string>;
-- 插件最近一次心跳（unix 秒）。
DEFINE FIELD IF NOT EXISTS seen_at ON node_release TYPE option<int>;
-- 节点更新器最近一次检查（unix 秒）。
DEFINE FIELD IF NOT EXISTS checked_at ON node_release TYPE option<int>;
DEFINE FIELD IF NOT EXISTS last_status ON node_release TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_target ON node_release TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_at ON node_release TYPE option<int>;
DEFINE FIELD IF NOT EXISTS last_error ON node_release TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_at ON node_release TYPE int;

DEFINE TABLE IF NOT EXISTS node_rollback SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS node ON node_rollback TYPE string;
DEFINE FIELD IF NOT EXISTS at ON node_rollback TYPE int;
DEFINE FIELD IF NOT EXISTS from_version ON node_rollback TYPE string;
DEFINE FIELD IF NOT EXISTS from_sha ON node_rollback TYPE string;
DEFINE FIELD IF NOT EXISTS to_version ON node_rollback TYPE string;
DEFINE FIELD IF NOT EXISTS to_sha ON node_rollback TYPE string;
DEFINE FIELD IF NOT EXISTS reason ON node_rollback TYPE string;
DEFINE FIELD IF NOT EXISTS outcome ON node_rollback TYPE string;
DEFINE INDEX IF NOT EXISTS node_rollback_node ON node_rollback FIELDS node;
