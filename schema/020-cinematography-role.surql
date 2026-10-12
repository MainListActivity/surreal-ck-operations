-- v20: 摄影摄像升为一等执行岗位（摄影轨专属）。employee_def.role 枚举追加 cinematography；
-- 仅扩展枚举，不改写存量任务、编制与凭证。

DEFINE FIELD OVERWRITE role ON employee_def TYPE string
  ASSERT $value IN ['gm', 'product', 'engineering', 'ai-content', 'concept-design', 'asset-production', 'screenwriter', 'story-author', 'cinematography', 'qa', 'cs', 'eval'];
