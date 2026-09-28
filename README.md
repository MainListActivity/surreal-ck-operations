# Surreal CK · AI 公司

老板（用户本人）是唯一真人：提出目标、给出公司方向、在关口拍板、为订阅充值。其余岗位全部是 AI 员工，由调度器派工、在多个订阅之间互为备份，会话中断时自动接手续做。

## 老板怎么用

```
cd "$HOME/Library/Application Support/SurrealCKCompany/active"
pnpm run company goal "我要一个 B2C 商城"    # 提出目标
pnpm run company inbox                        # 看待你决定的关口与提问
pnpm run company approve <任务ID> [意见]      # 批准关口；reject/reply 同理
pnpm run company status                       # 公司运行概况
```

也可以直接在 SurrealDB 写 `owner_command`，或在 Paseo 里对经理说。完整说明见 [运行手册](docs/agent-operations.md#老板入口)。

一个目标的流转：**G1 范围提案**（运营 → 老板批准）→ **任务拆解**（经理）→ 各岗位执行与独立验收 →（必要时 **G2 关口**）→ **真人验收操作手册**（运营写，测试按手册实际操作）→ **G3 最终验收**（老板）。详见 [任务流转](docs/workflow.md)。

## 员工与运行

- [员工协议](agents/PROTOCOL.md)：被派工后如何领取、存进度、交接。
- [岗位与员工](docs/roles.md)：员工定义（SurrealDB `employee_def`）与动态实例。
- [运行手册](docs/agent-operations.md)：服务组成、员工编制、运行参数、排障。
- [模板](docs/templates.md)：G1 范围提案、真人验收操作手册、G3、checkpoint 与通用交付/验收单。
- [任务服务运维](docs/company-service-operations.md)、[核心契约](docs/core-contract.md)、[MCP 接入](docs/mcp-adapter.md)。
- [业务流程](docs/playbooks.md)、[经营节奏](docs/management.md)。

任务、身份、租约与审计存于本机 SurrealDB `sck_agent_company/control_plane`，GitHub Issue 为投影看板。v2 的 `scripts/queue.py` 与 `agents/registry.json` 仅用于收尾旧工单。

技术规格与代码在 [产品仓库](https://github.com/MainListActivity/surreal_ck)。客户原件、凭证和合同正文留在授权存储，运营仓库只保留必要证据。
