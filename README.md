# Surreal CK · AI 公司

老板（用户本人）是唯一真人：给出公司方向和目标、做最终验收、为订阅充值；阻塞与升级一律上报老板。其余岗位全部是 AI 员工，由调度器派工、在多个订阅之间互为备份，会话中断时自动接手续做。

## 老板怎么用

```
cd "$HOME/Library/Application Support/SurrealCKCompany/active"
sck owner task.create '{"type":"software","title":"我要一个 B2C 商城"}'   # 新建任务（type 查路由表；task.plan 预览链）
pnpm run company inbox                        # 看待你决定的关口与提问
pnpm run company approve <任务ID> [意见]      # 批准关口；reject/reply 同理
pnpm run company status                       # 公司运行概况
```

也可以直接在 SurrealDB 写 `owner_command`，或在 Paseo 里说。完整说明见 [运行手册](docs/agent-operations.md#老板入口)。

唯一单位是任务，路由表 `route` 把类型映射到执行岗、复核岗与消息模板（执行岗≠复核岗，一任务一会话）。`task.create` 按路由 `next` 展开 planned 链；员工 `submit` 可带 `next` 提议后继；`task.md` 给需求与验收标准；发给员工的每条消息都是 `outbound_message` 行（老板可在控制台预览/扣留）。详见 [任务运行规程](docs/workflow.md)。

## 员工与运行

- [员工协议](agents/PROTOCOL.md)：被派工后如何领取、存进度、交接。
- [岗位与员工](docs/roles.md)：员工定义（SurrealDB `employee_def`）与动态实例。
- [运行手册](docs/agent-operations.md)：服务组成、员工编制、运行参数、排障。
- [模板](docs/templates.md)：G1 范围提案、真人验收操作手册、G3、checkpoint 与通用交付/验收单。
- [员工通道](docs/sidecar-channel.md)：sidecar 架构、零凭证模型、comm 文件协议与 `ops_*` 运维工具边界。
- [任务服务运维](docs/company-service-operations.md)、[核心契约](docs/core-contract.md)、[老板接口](docs/owner-api.md)、[MCP 接入](docs/mcp-adapter.md)。
- [业务流程](docs/playbooks.md)、[经营节奏](docs/management.md)。

任务、身份、租约与审计存于自托管 SurrealDB 的 `sck_agent_company/control_plane`（与产品同一实例、独立 namespace，地址与凭证读自产品 `.env`），GitHub Issue 为投影看板。员工按 `employee_def.weight` 加权派工。0.5.0 起不再有员工绩效评分，任务完成后按 `task_cost` 结算成本。v2 的 `scripts/queue.py` 与 `agents/registry.json` 仅用于收尾旧工单。

技术规格与代码在 [产品仓库](https://github.com/MainListActivity/surreal_ck)。客户原件、凭证和合同正文留在授权存储，运营仓库只保留必要证据。
