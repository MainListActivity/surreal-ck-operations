-- v21: 派工维护暂停（经理停派屏障）。dispatch_pass 账本：每个派工 pass 一行，记录派工实例、纪元与起止，
-- 暂停排空据此观测；已结束且超过一天的行在新 pass 开始时清理。仅新增表与索引，不改写存量行。

DEFINE TABLE IF NOT EXISTS dispatch_pass SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS dispatch_pass_state ON TABLE dispatch_pass FIELDS state;
