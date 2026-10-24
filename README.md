# Surreal CK · AI 公司

老板（用户本人）是唯一真人：给出公司方向和目标、做 G3 最终验收、为订阅充值。其余事项由运营、经理逐级决定。其余岗位全部是 AI 员工，由调度器派工、在多个订阅之间互为备份，会话中断时自动接手续做。

## 老板怎么用

```
cd "$HOME/Library/Application Support/SurrealCKCompany/active"
pnpm run company goal "我要一个 B2C 商城"    # 提出目标（可加 --tier quick|standard|program --project <项目>）
pnpm run company inbox                        # 看待你决定的关口与提问
pnpm run company approve <任务ID> [意见]      # 批准关口；reject/reply 同理
pnpm run company status                       # 公司运行概况
```

也可以直接在 SurrealDB 写 `owner_command`，或在 Paseo 里对经理说。完整说明见 [运行手册](docs/agent-operations.md#老板入口)。

目标先分级（Jev 或经理）：**quick** 小开发任务走一条交付链（实现 → 上线申请 → 合入部署与生产实测）后由运营验收，完成即记录、不打扰老板；**standard** 由经理拆成多条交付链；**program** 先由运营做范围提案。standard / program 在运营验收后才到老板做 **G3 最终验收**，此时交付已经上线，G3 写明入口链接和验收步骤。是否上线由运营决定（Jev 高置信时自动批准），只有花钱、签约、对外联系、公司方向和项目红线才上报老板。详见 [员工协议](agents/PROTOCOL.md#决策权)。

## 员工与运行

- [员工协议](agents/PROTOCOL.md)：被派工后如何领取、存进度、交接。
- [岗位与员工](docs/roles.md)：员工定义（SurrealDB `employee_def`）与动态实例。
- [运行手册](docs/agent-operations.md)：服务组成、员工编制、运行参数、排障。
- [模板](docs/templates.md)：G1 范围提案、真人验收操作手册、G3、checkpoint 与通用交付/验收单。
- [员工通道](docs/sidecar-channel.md)：sidecar 架构、零凭证模型、comm 文件协议与 `ops_*` 运维工具边界。
- [任务服务运维](docs/company-service-operations.md)、[核心契约](docs/core-contract.md)、[有效策略](docs/effective-policy.md)、[MCP 接入](docs/mcp-adapter.md)。
- [业务流程](docs/playbooks.md)、[经营节奏](docs/management.md)。

任务、身份、租约与审计存于自托管 SurrealDB 的 `sck_agent_company/control_plane`（与产品同一实例、独立 namespace，地址与凭证读自产品 `.env`），GitHub Issue 为投影看板。员工按 `employee_def.weight` 加权派工；任务完成后由 `eval` 评审员打绩效分并回馈权重。v2 的 `scripts/queue.py` 与 `agents/registry.json` 仅用于收尾旧工单。

技术规格与代码在 [产品仓库](https://github.com/MainListActivity/surreal_ck)。客户原件、凭证和合同正文留在授权存储，运营仓库只保留必要证据。
