-- 067 员工回报的译文：员工用自己职能的语言写的提交、退回、受阻说明（audit 的 submit / return / block），
-- 译成老板常用语言（company_meta:config.owner_lang，缺省 zh）后存在这里，原审计行不改。
-- 由老板端定时任务补译；页面读译文，原文随时可看。source_hash 是被译原文的哈希，原文变了即视为过期。
DEFINE TABLE IF NOT EXISTS reply_translation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS source ON reply_translation TYPE record<audit>;
DEFINE FIELD IF NOT EXISTS lang ON reply_translation TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS source_hash ON reply_translation TYPE string;
DEFINE FIELD IF NOT EXISTS text ON reply_translation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS failed_at ON reply_translation TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS at ON reply_translation TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS reply_translation_source_lang ON reply_translation FIELDS source, lang UNIQUE;
