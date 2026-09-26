# Surreal CK 公司工作台

这里是公司经营任务、验收决定和交接状态的唯一事实来源。代码和技术规格继续在 [产品仓库](https://github.com/MainListActivity/surreal_ck)维护。公司仓库为私有；客户原始材料、凭证和合同正文放在获授权的专用存储中，任务只记录受控链接和必要摘要。

## 每个人每天只需这样工作

1. 打开[自己的全部任务](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aissue%20is%3Aopen%20assignee%3A%40me)。先处理待验收，再处理进行中，最后领取就绪任务。
2. 阅读任务的输入、验收条件和交接目标。缺材料就标记阻塞，写明需要谁提供什么；材料齐全才开始。
3. 将就绪任务改为进行中。每人最多同时执行两项任务；按 P0、P1、P2，再按期限排序。
4. 成果放到任务指定位置，在原任务评论中粘贴[交付单](docs/templates.md)。将任务转给指定验收人，状态改为待验收，岗位标签改成验收人岗位。
5. 验收人通过后关闭原任务，并按[交接规则](docs/workflow.md)解锁下一项任务；不通过就在原任务退回。每个人通过自己的队列接到下一项工作。

员工无需看全公司看板，也无需从聊天记录寻找任务。通知只是提醒，任务队列是工作入口。

## 入口

- [我的待验收](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aissue%20is%3Aopen%20assignee%3A%40me%20label%3Astate%3Areview)
- [我的进行中](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aissue%20is%3Aopen%20assignee%3A%40me%20label%3Astate%3Adoing)
- [我的就绪任务](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aissue%20is%3Aopen%20assignee%3A%40me%20label%3Astate%3Aready)
- [我的阻塞任务](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aissue%20is%3Aopen%20assignee%3A%40me%20label%3Astate%3Ablocked)
- [经理控制台](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aissue%20is%3Aopen%20label%3Arole%3Agm)
- [待分诊入口](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aissue%20is%3Aopen%20label%3Astate%3Ainbox)
- [全部待配员任务](https://github.com/MainListActivity/surreal-ck-operations/issues?q=is%3Aissue%20is%3Aopen%20label%3Astaffing%3Aneeded)
- [新建任务](https://github.com/MainListActivity/surreal-ck-operations/issues/new/choose)

## 按需阅读

- [岗位职责与人员登记](docs/roles.md)：入职、代班、岗位领任务、权限与验收责任。
- [状态与交接规则](docs/workflow.md)：领取、提交、验收、退回、阻塞、取消、紧急事故。
- [公司业务流程](docs/playbooks.md)：从获客到续费，以及研发、内容供应、发布、招聘和财务。
- [任务与交付模板](docs/templates.md)：复制即可使用。
- [经理运行节奏](docs/management.md)：优先级、产能、例会、指标和上线边界。
- [首批启动任务](docs/launch.md)：首轮工作依赖和负责人。

## 当前启用状态

工作台、标签、模板和首批任务已建立。员工姓名、账号、预算、营业时间和试点客户尚未确认，见启动任务。MainListActivity 仅作为启动协调和待配员任务的临时收件人，不代表已聘任五个岗位，也不代表 AI 在后台持续运行。

本版使用人工交接，GitHub 不会根据评论内容自动变更状态、解锁依赖或计时升级。验收人按清单操作，经理每天检查遗漏。后续只有出现实际交接量瓶颈时才建设自动化。

GitHub 机制依据：[Issue 表单](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)、[任务筛选](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)。岗位、时限与验收制度是本公司的管理决策。
