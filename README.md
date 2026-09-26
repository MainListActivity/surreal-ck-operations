# Surreal CK · AI 公司工作台

公司负责人是用户本人；其余岗位全部由真实创建的 AI agent 会话担任。外部律师用户和专业顾问由负责人对接。

## 员工领任务

AI 员工先读 [执行协议](agents/PROTOCOL.md)，再读自己的岗位文件，使用 `scripts/queue.py` 从岗位队列领取。共用 GitHub 账号的 `assignee:@me` **不能区分员工**。

| 岗位队列 | 稳定员工编号 | 执行入口 |
|---|---|---|
| [职业经理](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aopen+label%3Arole%3Agm) | gm-01 | [岗位说明](agents/gm.md) |
| [产品交付](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aopen+label%3Arole%3Aproduct) | product-01 | [岗位说明](agents/product.md) |
| [工程](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aopen+label%3Arole%3Aengineering) | eng-01、eng-02 | [岗位说明](agents/engineering.md) |
| [AI 与内容](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aopen+label%3Arole%3Aai-content) | ai-01 | [岗位说明](agents/ai-content.md) |
| [测试](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aopen+label%3Arole%3Aqa) | qa-01 | [岗位说明](agents/qa.md) |
| [客户成功](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aopen+label%3Arole%3Acs) | cs-01 | [岗位说明](agents/cs.md) |
| [负责人待办](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aopen+label%3Arole%3Aowner) | 用户本人 | 律师用户、顾问答复、资料与关键决策 |

经理查询待验收和就绪任务后唤醒对应员工；员工实际读取队列并领取。执行 → 提交 → 独立验收 → 经理解锁后续。无任务或需真人输入时结束本轮，不空转。

## 岗位绑定与同岗协作

[员工登记表](agents/registry.json) 分开保存稳定员工 ID、岗位、实际会话 ID、状态和能力。一岗多人；一张子任务只有一个执行者。同一需求需要两位工程师时拆子任务并指定集成责任人；代码工作用不同 worktree。验收排除原员工 ID，换会话不能绕过。

[运行器](scripts/queue.py) 对单机领取加锁并记录任务租约。身份是可审计的调度约束；共用凭证不是安全权限隔离，也不是跨机器分布式锁。

## 手册与进度

- [AI 员工协议](agents/PROTOCOL.md)：领取、提交、验收、退回、接管。
- [角色与多人协作](docs/roles.md)：职责、身份与工作边界。
- [业务流程](docs/playbooks.md)：获客、交付、研发、发布、财务与续费。
- [任务状态](docs/workflow.md)、[交付模板](docs/templates.md)、[经营节奏](docs/management.md)。
- [启动任务](docs/launch.md)：原 16 张任务保留，v2 元数据取代待真人招聘假设；新增 AI 岗位首批任务。

本机工作目录：`/Users/y/IdeaProjects/surreal-ck-operations`。真实 ID 与运行状态看 registry / Paseo，不能从岗位名称推测员工在后台运行。巡检调度的实际启用情况以运行记录为准。

技术规格与代码仍在 [产品仓库](https://github.com/MainListActivity/surreal_ck)。客户原件、凭证和合同正文留在授权存储，运营仓库只保留必要证据。
