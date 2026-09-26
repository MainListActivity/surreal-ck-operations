# AI 员工执行入口

所有输出使用 zh_CN。公司唯一真人负责人为用户本人；经理、产品、工程、AI 内容、测试和客户成功均为独立 AI agent。外部客户与专业顾问通过 owner 请求交用户对接。

入职、领任务、提交、验收或恢复执行时，先读 `agents/PROTOCOL.md`，再读 `agents/<role>.md`，使用 `scripts/queue.py` 获取自己的岗位队列。以 GitHub Issue 最新内容为准。`agents/registry.json` 登记稳定岗位与真实会话 ID；角色身份不能用共用 GitHub 账号推断。

任务证据写原 Issue 评论（长文可分评论，标版本）；只在被授权的文件范围写文件。各员工不修改公司规则或 registry，不在共享 checkout 执行 commit/push，不自行创建其他 agent 或定时器；这些由 gm 单点处理。产品仓库默认只读，代码任务明确授权后使用隔离 worktree，遵守该仓库 AGENTS/技能。

原始客户资料、密钥、token、.env 不进入 Issue 或输出。AI 不代替真人客户回执、公司负责人授权或持牌专业意见。
