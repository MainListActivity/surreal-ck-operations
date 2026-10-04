-- v9: 项目级岗位轨（discipline/track）。task.discipline 标记任务的项目内岗位轨；
-- employee_def.tracks 限定编制可接的轨（空 = 全接）；project.disciplines 是项目轨词表与说明。
-- 全部可选新增，存量任务/编制/凭证不改写、语义不变。

DEFINE FIELD IF NOT EXISTS discipline ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tracks ON employee_def TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS disciplines ON project TYPE option<array<object>>;
