# 岗位与员工

老板是唯一真人，负责目标、方向、关口决定、真实客户与外部顾问、付款授权。其余岗位全部是 AI 员工，由调度器按需派工。

## 员工定义与实例

1. **岗位 role**：gm、product、engineering、ai-content、qa、cs 六个任务岗位；另设 **eval** 评审岗位（不领任务，只在任务完成后给员工打绩效分）。
2. **员工定义 employee_def**：岗位 + 订阅（provider）+ 模型 + 思考强度 + `weight` 派工权重，存 SurrealDB。每个岗位在 codex、grok、devin 三个订阅上各有定义，互为备份；同岗位多个候选按 `weight × 绩效系数` 加权随机分配任务。
3. **员工实例**：调度器按定义生成，拥有独立员工编号、凭证和 Paseo 会话（`paseo_agent_id`）。一个实例同一时间只持有一个任务租约；同岗位多个实例可并行处理不同任务。

实例会话中断时，调度器收回其租约并附交接包改派给同岗位其他实例；中断的实例退役、凭证撤销，历史归因保留。验收独立按员工编号判断：提交者不能验收自己的成果。

## 岗位职责

见 `agents/<role>.md`：[gm](../agents/gm.md)、[product](../agents/product.md)、[engineering](../agents/engineering.md)、[ai-content](../agents/ai-content.md)、[qa](../agents/qa.md)、[cs](../agents/cs.md)、[eval](../agents/eval.md)。

## 同一需求多人协作

经理拆出接口、实现、集成与验收子任务，写清接口契约、依赖、可写范围和集成负责人。实现者各用任务专属分支的 worktree，集成人整合固定版本，qa 验结果。
