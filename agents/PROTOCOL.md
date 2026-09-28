# 员工执行协议 v3

公司任务服务是唯一事实来源。调度器（普通后台进程）负责派工：它从 SurrealDB 读队列，挑空闲且订阅健康的员工，通过 Paseo 叫醒。你被叫醒时，派工消息里会写明任务 ID 和调用命令：

```
SCK_EMPLOYEE_CREDENTIAL_FILE='<你的凭证路径>' '<sck 路径>' call <工具> '<JSON>'
```

你的身份（员工编号、岗位、能力）由凭证在服务端确定。凭证只以路径使用。

## 每次被唤醒

1. **领取**：`claim_next {"taskId": "<派工消息里的 ID>"}`。返回 `already_claimed`、`no_available_task` 或 `forbidden` 时，直接结束本轮。
   领取成功时记下 `deliveryId`、`fence`、`task.version`，后续每次写入都带上它们（`expectedVersion` 用最新版本）。
2. **读上下文**：完整读 `task.context` 和返回的 `history`：前任的 checkpoint、交接包（`revoked`）、验收退回意见（`return`）、老板决定（`owner_*`）。`task.handover=true` 表示前任会话中断，你在接手续做：先核对任务分支/工作目录里的实际改动与最后一次 checkpoint，从断点继续。需要公司方向或在办目标时调用 `get_context`；需要更早记录时调用 `get_task_history`。
3. **做事并存进度**：每完成一个有意义的步骤就 `checkpoint`（执行和验收都适用），写明已完成什么、改了哪些文件或验到哪一步、下一步做什么。你的会话随时可能因订阅额度中断，只有 checkpoint 和任务分支上的提交能交给接手的人。
   代码任务：在任务专属分支 `task/<任务ID前8位>` 的独立 worktree 里工作；checkpoint 前先把改动提交到该分支，并在 checkpoint 里写分支名和 worktree 路径。
4. **交接**（本轮只做一项，做完即结束本轮）：
   - 执行完成 → `submit`：成果位置、逐项验收条件对应的证据、实际验证命令与结果、未验证项与限制。
   - 验收 → `review`（`decision=accept` 或 `return`）：独立复核，写逐项检查结果；退回写复现方式和期望结果。
   - 缺老板的信息或决定 → `report_blocker to=owner`：写清要老板回答什么、可选项与推荐、回答后从哪里继续。
   - 需要经理协调（依赖、范围、权限、跨岗位） → `report_blocker to=gm`。
5. **结束本轮**：用一两句话汇报任务 ID 与交接结果，然后停止。下一项工作由调度器再派。

## 边界

- 证据真实：读代码、本地测试、线上验证、客户确认分开表述；没有验证的写「未验证」。
- 验收独立：服务端拒绝你验收自己提交的成果；换会话、换订阅也一样。
- 老板决定只来自老板：关口（`reviewerRole=owner` 的任务）只能由老板批准或驳回。经理只在老板直接对话里明确表态时，用 `record_owner_decision` 转录，并逐字引用老板原话。
- 权限：生产数据库、发布上线、付款、签约、对外联系都需要老板在对应关口明确批准。
- 阅读或修改 Mastra 前加载产品仓库 mastra skill；写 SurrealQL 前加载 surrealql skill；shell 命令遵循本机 RTK 规则。

## 调度器会替你做的事

- 你的会话在运行时，调度器自动续租；会话中断、订阅耗尽，或超过 90 分钟没有 checkpoint 时，调度器收回租约并附上你会话最后的日志作为交接包，改派给同岗位其他员工。
- 你被收回的租约立即失效：之后用旧 `deliveryId` 的写入都会被拒绝。
- 任务完成后，调度器会派 `eval` 岗位的员工（评审员）对本轮每位参与员工打绩效分，写入 `scorecard` 表并滚动更新员工定义的 `avg_score`——分数直接影响同类员工接到任务的概率。

## eval 评审员（派工消息以「绩效评审」开头）

eval 岗位不领取任务。收到评审派工后按 `agents/eval.md` 读任务历史并调 `record_score` 提交全部参与者的评分。eval 凭证不能领任务、不能验收，只能读任务历史与写评分。
