# AI 任务状态与交接

执行细节以 [员工协议](../agents/PROTOCOL.md) 为准。任务 company-task 元数据定义 executor_role、reviewer_role、depends_on、next，以及实际 submitted_by / accepted_by；role 标签指当前动作岗位。员工 ID 记录在评论和领取租约中。

| 状态 | 含义 | 谁处理 |
|---|---|---|
| inbox | 等待分诊 | gm |
| ready | 输入、依赖和授权齐全 | 岗位队列中的空闲员工 |
| doing | 已由实际员工领取 | 持有任务租约的员工 |
| review | 有成果和证据，等待独立复验 | 指定验收岗位中非原执行员工 |
| blocked | 缺输入、依赖、权限或真人答复 | 元数据与评论指定的解除者 |
| done | 独立验收通过并关闭 | gm 检查后续依赖是否可解锁 |
| cancelled | 明确取消，关闭为 not planned | 不作为下游依赖完成 |

员工通过 queue.py 执行 claim、submit、accept、return、block；经理核对真实会话结束后才能 release 接管。提交不会自动关闭，代码合并不等于客户验收。accept 完成后，经理检查后续任务全部 depends_on 为 done，输入/授权齐备才转 ready。

首次岗位任务每轮交付一次就结束。交付失败保留本机 pending 记录，重试原动作按 delivery ID 去重；遇到远端其他变更交经理恢复，不覆盖。GitHub 评论与状态更新不是跨操作事务。

退回保留原成果和失败证据，回 executor_role 队列重新领取。缺真人输入转 owner；经理把专业问题、客户样本和决策集中成用户可回答的请求，不让用户负责 AI 排期。

产出写原任务交付评论，必要时附固定版本代码、测试命令和结果；读取代码、执行本地测试、验证线上环境和客户确认分开表述。跨岗位文档/代码需写清唯一写入人和验收人。

P0 事故由 qa 协调，engineering/ai-content 处置，gm 决定暂停相关交付；对外通知、生产修改和恢复依既有明确授权。新范围由 product 定义、gm 排期；历史条件不静默改变。
