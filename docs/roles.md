# 岗位与员工

老板是唯一真人，负责目标、方向、关口决定、真实客户与外部顾问、付款授权。其余岗位全部是 AI 员工，由调度器按需派工。

## 员工定义与实例

1. **岗位 role**：gm、product、engineering、ai-content、concept-design、asset-production、qa、cs 八个任务岗位；另设 **eval** 评审岗位（不领任务，只在任务完成后给员工打绩效分，默认由 Jev 决策模型在调度器内直评，eval 员工是低置信度或故障时的升级通道）。其中 concept-design（原型/概念设计）与 asset-production（量产制作）是内容产线的专属执行岗位：P 段原型类任务派给 concept-design、由老板 demo 验收（reviewerRole=owner，交付证据须附老板可直接打开的产物）；M 段量产类任务派给 asset-production、由经理或 qa 验收，其 dependencies 须含对应原型任务——老板 approve 前不得解锁开工；两岗与 ai-content 互不错派。
2. **员工定义 employee_def**：岗位 + 订阅（provider）+ 模型 + 思考强度 + `weight` 派工权重，存 SurrealDB。每个岗位在 codex、grok、devin 三个订阅上各有定义，互为备份；同岗位多个候选按 `weight × 绩效系数` 加权随机分配任务。
3. **岗位轨 discipline/track**：项目内更细的分工（如编剧、角色设计、分镜）用项目轨表达，不进全局岗位枚举。项目在 `project.disciplines` 维护词表与各轨说明（`project set` 的 JSON 里写 `disciplines: [{name, description?}]`）；任务可选 `discipline` 标轨，编制的 `tracks` 声明能接的轨。匹配规则：任务无轨按岗位正常匹配；编制 `tracks` 为空全接；两者都有值时任务轨必须在编制名单内，否则派工跳过、直接 claim 被显式拒绝（`forbidden`：编制不覆盖任务轨）。项目词表非空时 `create_task`/`create_delivery` 的 `discipline` 必须在词表内，无项目或词表为空则自由取值。交付链只有实现腿带轨，上线/部署腿保持无轨。各轨与 P/M 段、承接 `executorRole` 的映射以项目 AGENTS.md「岗位轨」表为准。
4. **员工实例**：调度器按定义生成，拥有独立员工编号、凭证和 Paseo 会话（`paseo_agent_id`）。一个实例同一时间只持有一个任务租约；同岗位多个实例可并行处理不同任务。

实例会话中断时，调度器收回其租约并附交接包改派给同岗位其他实例；中断的实例退役、凭证撤销，历史归因保留。验收独立按员工编号判断：提交者不能验收自己的成果。

## 岗位职责

见 `agents/<role>.md`：[gm](../agents/gm.md)、[product](../agents/product.md)、[engineering](../agents/engineering.md)、[ai-content](../agents/ai-content.md)、[concept-design](../agents/concept-design.md)、[asset-production](../agents/asset-production.md)、[qa](../agents/qa.md)、[cs](../agents/cs.md)、[eval](../agents/eval.md)。

## 同一需求多人协作

经理拆出接口、实现、集成与验收子任务，写清接口契约、依赖、可写范围和集成负责人。实现者各用任务专属分支的 worktree，集成人整合固定版本，qa 验结果。
