# 老板接口（编制外 agent 可用）

令牌文件：`<service home>/private/owner-token`（0600，员工沙箱禁读 `private/`）。安装或服务启动时不存在即生成。
网页控制台 `/o/<token>/` 自身也调用同一套接口；命令由任何持有老板令牌的 agent 调用，审计 actor 为 `owner`，
`via` 取请求头 `X-Owner-Agent`（没有则 `web`）。

`bin/sck owner <命令> '<JSON>'`（读令牌文件路径、调用本机 HTTP 接口；令牌不打印）。

| 命令 | 一行示例 |
|---|---|
| 发目标 | `sck owner goal.create '{"text":"做报表导出","tier":"quick","pipeline":"software"}'` |
| 目标分级 | `sck owner goal.triage '{"goalId":"g1","tier":"quick"}'` |
| 取消目标 | `sck owner goal.cancel '{"goalId":"g1","note":"方向变了"}'` |
| 列出目标 | `sck owner goal.list '{}'` |
| 目标分阶段 | `sck owner goal.split '{"goalId":"g1","taskIds":["t1","t2"],"title":"下一阶段","reason":"第一阶段收口"}'` |
| 待处置作废任务 | `sck owner goal.retired.list '{"goalId":"g1"}'` |
| 处置作废任务 | `sck owner goal.retired.resolve '{"goalId":"g1","taskId":"t1","goalVersion":1,"taskVersion":1,"disposition":"fixture","replacementTaskIds":[],"reason":"保留为历史基线"}'` |
| 建任务 | `sck owner task.create '{"title":"导出","requirement":"导出 CSV","acceptanceText":"列头正确","executorRole":"engineering","reviewerRole":"qa","dependencies":[]}'` |
| 改任务 | `sck owner task.update '{"taskId":"t1","requirement":"新需求","acceptanceText":"新验收标准"}'` |
| 删任务（作废） | `sck owner task.delete '{"taskId":"t1","note":"不需要了"}'` |
| 任务详情/审计/消息记录 | `sck owner task.detail '{"taskId":"t1"}'` |
| 列出任务 | `sck owner task.list '{}'` |
| 改派 | `sck owner task.reassign '{"taskId":"t1","executorRole":"engineering","reviewerRole":"qa","note":"换人"}'` |
| 作废 | `sck owner task.void '{"taskId":"t1","note":"重复"}'` |
| 撤销租约 | `sck owner task.revoke '{"taskId":"t1","note":"终止在途"}'` |
| 解锁 | `sck owner task.unlock '{"taskId":"t1"}'` |
| 暂停派工 | `sck owner task.pause '{}'` |
| 恢复派工 | `sck owner task.resume '{}'` |
| 任务成本 | `sck owner task.cost '{"taskId":"t1"}'` |
| 实现人判定预演 | `sck owner contributor.dryRun '{"taskIds":["t1"]}'` |
| 指定实现人 | `sck owner implementer.takeover '{"taskId":"t1","toEmployee":"eng-1","expectedVersion":3,"reason":"任务有多名经手人，需指定实现负责人"}'` |
| 关口决定 | `sck owner decide '{"taskId":"t1","decision":"approve"}'` |
| 批准 | `sck owner approve '{"taskId":"t1"}'` |
| 退回 | `sck owner reject '{"taskId":"t1","note":"补齐证据"}'` |
| 回复员工提问 | `sck owner reply '{"taskId":"t1","note":"按方案 A"}'` |
| 收件箱 | `sck owner inbox '{}'` |
| 升级清单 | `sck owner upgrade.list '{}'` |
| 自动升级策略 | `sck owner upgrade.automatic '{"enabled":true}'` |
| 启动升级 | `sck owner upgrade.start '{"taskId":"t1","taskVersion":1,"digest":"d1"}'` |
| 简报 | `sck owner brief '{}'` |
| 添加方向 | `sck owner direction.add '{"text":"优先解决交付延迟"}'` |
| 老板指示 | `sck owner instruct '{"text":"清查近期阻塞任务"}'` |
| 解决提醒 | `sck owner notice.resolve '{"key":"n1"}'` |
| 列出提醒 | `sck owner notice.list '{}'` |
| 列出待发消息 | `sck owner message.list '{"taskId":"t1"}'` |
| 编辑待发消息 | `sck owner message.edit '{"messageId":"m1","body":"实现 task.md 中的需求…"}'` |
| 需要我放行 | `sck owner message.hold '{"messageId":"m1"}'` |
| 取消放行标记 | `sck owner message.release '{"messageId":"m1"}'` |
| 放行 | `sck owner message.send '{"messageId":"m1"}'` |
| 消息记录 | `sck owner message.records '{}'` |
| 列出编制 | `sck owner def.list '{}'` |
| 新建/修改编制 | `sck owner def.ensure '{"id":"eng-1","role":"engineering","provider":"codex","model":"auto:sol"}'` |
| 停用编制 | `sck owner def.disable '{"id":"eng-1","reason":"缩编"}'` |
| 启用编制 | `sck owner def.enable '{"id":"eng-1"}'` |
| 模型排序视图 | `sck owner model.ranking '{}'` |
| 模型排序预览 | `sck owner model.ranking.preview '{"policy":{},"refresh":false}'` |
| 保存模型排序 | `sck owner model.ranking.save '{"rules":"优先级规则","refreshMinutes":5}'` |
| 置顶模型 | `sck owner model.ranking.pin '{"group":"sck-opus","model":"m1","pinned":true}'` |
| 模型目录 | `sck owner model.catalog '{"query":"opus","offset":0,"limit":40}'` |
| 模型启用范围 | `sck owner model.membership '{"input":{"group":"sck-opus","model":"m1","present":true,"expectedMembers":["m1"]}}'` |
| 模型别名 | `sck owner model.alias '{"model":"m1","slug":"opus-main"}'` |
| 待批权限 | `sck owner permission.list '{}'` |
| 回答权限 | `sck owner permission.answer '{"agentId":"a1","requestId":"r1","behavior":"allow"}'` |
| 任务附件 | `sck owner task.attachments '{"taskId":"t1"}'` |
| 附件链接 | `sck owner attachment.url '{"taskId":"t1","file":"report.md"}'` |
| 审计 | `sck owner audit.list '{}'` |
| 概况 | `sck owner status '{}'` |
