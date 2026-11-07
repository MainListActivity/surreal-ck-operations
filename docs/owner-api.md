# 老板接口（编制外 agent 可用）

令牌文件：`<service home>/private/owner-token`（0600，员工沙箱禁读 `private/`）。安装或服务启动时不存在即生成。
网页控制台 `/o/<token>/` 自身也调用同一套接口；命令由任何持有老板令牌的 agent 调用，审计 actor 为 `owner`，
`via` 取请求头 `X-Owner-Agent`（没有则 `web`）。

`bin/sck owner <命令> '<JSON>'`（读令牌文件路径、调用本机 HTTP 接口；令牌不打印）。

| 命令 | 一行示例 |
|---|---|
| 建任务（路由类型） | `sck owner task.create '{"type":"software","title":"导出","requirement":"导出 CSV","acceptanceText":"列头正确","tag":"发布线","hold":false}'`（返回 `{task, planned}`：route.next 链上的 planned 后续任务各带草稿） |
| 笔记列表 | `sck owner note.list '{"lane":"surreal_ck:qa"}'`（不带 lane 列全部，含待生效） |
| 笔记全文 | `sck owner note.preview '{"lane":"surreal_ck:qa"}'`（会话将读到的 `notes.md`） |
| 加笔记 | `sck owner note.add '{"lane":"surreal_ck:qa","text":"…"}'`（`proposed:true` 进待审） |
| 改笔记 | `sck owner note.edit '{"noteId":"n1","text":"…"}'` |
| 置顶笔记 | `sck owner note.pin '{"noteId":"n1","pinned":true}'` |
| 笔记生效 | `sck owner note.activate '{"noteId":"n1"}'` |
| 删笔记 | `sck owner note.remove '{"noteId":"n1"}'` |
| 任务链与消息 | `sck owner task.plan '{"taskId":"t1"}'`（父链回溯 + 下游全链任务与每任务消息） |
| 路由列表 | `sck owner route.list '{}'` |
| 保存路由 | `sck owner route.save '{"type":"software","label":"软件需求","executorRole":"engineering","reviewerRole":"qa","code":true,"next":"gate","hold":false}'`（拒绝同岗/未知岗/未启用 next/成环） |
| 停用路由 | `sck owner route.disable '{"type":"story"}'`（被别的 next 引用时拒绝） |
| 改任务 | `sck owner task.update '{"taskId":"t1","requirement":"新需求","acceptanceText":"新验收标准"}'` |
| 删任务（作废） | `sck owner task.delete '{"taskId":"t1","note":"不需要了"}'` |
| 任务详情/审计/消息记录 | `sck owner task.detail '{"taskId":"t1"}'` |
| 列出任务 | `sck owner task.list '{}'` |
| 改派 | `sck owner task.reassign '{"taskId":"t1","executorRole":"engineering","reviewerRole":"qa","note":"换人"}'` |
| 作废 | `sck owner task.void '{"taskId":"t1","note":"重复"}'` |
| 撤销租约 | `sck owner task.revoke '{"taskId":"t1","note":"终止在途"}'` |
| 暂停派工 | `sck owner task.pause '{}'` |
| 恢复派工 | `sck owner task.resume '{}'` |
| 任务成本 | `sck owner task.cost '{"taskId":"t1"}'` |
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
