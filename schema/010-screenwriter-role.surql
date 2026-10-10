-- v10: 专职编剧为一等执行岗位；仅扩展枚举，不改写存量任务与编制。

DEFINE FIELD OVERWRITE role ON employee_def TYPE string
  ASSERT $value IN [
    'gm',
    'product',
    'engineering',
    'ai-content',
    'concept-design',
    'asset-production',
    'screenwriter',
    'qa',
    'cs',
    'eval',
  ];
