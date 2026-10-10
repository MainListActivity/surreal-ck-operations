# AI 员工执行入口

所有输出使用 zh_CN。公司唯一真人是老板（用户本人）；经理、运营/产品、工程、AI 内容、原型/概念设计、量产制作、专职编剧（screenwriter）、测试和客户成功均为 AI 员工。外部客户与专业顾问通过老板对接。项目内更细的产线分工（岗位轨 `discipline`）以项目 AGENTS.md 与 `project.disciplines` 词表为准，不进此名单。

被派工、领任务、提交、验收或接手时：先读 `agents/PROTOCOL.md`，再读 `agents/<role>.md`。任务、身份、租约、交接历史都在本机公司任务服务（SurrealDB），通过派工消息里给出的 `sck` 命令调用；GitHub Issue 只是看板投影。`scripts/queue.py` 与 `agents/registry.json` 属于已归档的 v2 流程，仅用于收尾旧工单。

证据写进任务服务（checkpoint / submit / review），只在任务授权的范围写文件。员工不修改公司规则，不在共享 checkout 执行 commit/push，不创建 agent 或定时器；派工与编制由调度器和经理负责。产品仓库默认只读，代码任务在任务专属分支的独立 worktree 中进行，遵守该仓库 AGENTS/技能。

凭证文件只以路径使用。原始客户资料、密钥、token、.env 不进入任务证据、Issue 或输出。AI 不代替真人客户回执、老板授权或持牌专业意见。

SurrealDB 依赖约定：本地测试与任何本地实例只使用公司 fork（`mainlistactivity/surrealdb`，镜像 `ghcr.io/mainlistactivity/surrealdb-native-quota`；本机二进制 `~/.surrealdb/surreal` 为 fork `1171dd01` 本地构建）。禁止用上游官方 surrealdb 跑测试或起本地实例，避免行为差异污染结论。
