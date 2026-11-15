-- 072 消息链预排：需求流水线做完一步才建下一步的任务，后面步骤的派工消息在建任务之前并不存在。
-- 老板可以提前给某一步的执行或复核消息做安排（改写正文、建出后先扣住），存在这里；流水线建出那一步的任务时套用。
-- 一步一条：编号是 需求:修订:第几步:execute|review。需求改了修订，旧修订的安排自然不再被读到。
DEFINE TABLE IF NOT EXISTS planned_message SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS requirement ON planned_message TYPE string;
DEFINE FIELD IF NOT EXISTS revision ON planned_message TYPE int;
DEFINE FIELD IF NOT EXISTS index ON planned_message TYPE int;
DEFINE FIELD IF NOT EXISTS step ON planned_message TYPE string ASSERT $value IN ['execute', 'review'];
DEFINE FIELD IF NOT EXISTS body ON planned_message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS hold ON planned_message TYPE bool DEFAULT false;
-- 套用到建出的草稿之后记下时间：建单回放时不再重复套用，没记上的会在回放里补套。
DEFINE FIELD IF NOT EXISTS applied_at ON planned_message TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS actor ON planned_message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_at ON planned_message TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS planned_message_requirement ON planned_message FIELDS requirement, revision, index;
