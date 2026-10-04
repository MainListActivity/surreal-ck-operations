-- v8: 内容产线专属执行岗位拆分。employee_def.role 新增 concept-design（原型/概念设计，产线 P 段）
-- 与 asset-production（量产制作，产线 M 段），派工按岗位拉取后两类任务互不错派；
-- ai-content 及其编制/员工/凭证全部保留，存量任务不改写。

DEFINE FIELD OVERWRITE role ON employee_def TYPE string
  ASSERT $value IN ['gm', 'product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'qa', 'cs', 'eval'];
