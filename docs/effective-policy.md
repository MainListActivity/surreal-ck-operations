# 有效规则版本与执行层策略强制（SYS06 P1）

这一层管的是**机器可执行**的授权：谁能写码、能调哪些运维工具与账号、交付要不要走老板关口。判定只读 `policy` 表里受限字段，服务端算出一份"当前有效契约"，执行层（任务服务、调度器、sidecar、ops broker）在动作前用同一份代码校验。

三条边界是刻意的，也是这一层存在的理由：

- **只认受限 schema**：三个域各自只接受固定字段，多余字段一律 `invalid`。没有自由文本 eval，也没有"把提示词当编译结果"的路径——改任务标题、描述、证据里的话，不改变允许/拒绝。
- **版本只增不改**：一版写定后 payload 与 hash 不再变动。收紧/放开写在新一版上，用 `supersedes` 显式指认被替代的那一版；历史永远可查，当前有效视图由生效链算出。
- **同域冲突必须显式替代**：同（作用域, 域）已有生效版本时，不带 `supersedes` 的新版本被拒绝，不会静默覆盖成"最新一条文本"。

文学、风格、语义、敏感词这类判断**不在本层范围内**：程序不判定它们，这一层只强制可执行的授权与关口。

## 三个域与受限 payload

| 域 | 字段 | 语义 |
| --- | --- | --- |
| `write_authority` | `codeRoles: Role[]`、`intents: ('read'\|'code'\|'assets')[]`、`lanes?: string[]` | 允许承接 code 意图任务的岗位、本作用域允许出现的工作意图、可选线名白名单。空 `codeRoles` = 冻结代码写权，只能由 owner 来源授权。白名单生效时，code 任务必须**同时声明线名并挂在某个目标下**（没有目标就没有轨分支，只能落到 `task/<id8>` 的临时分支），否则一律 `forbidden`——缺声明是拒绝，不是放行。 |
| `tool_scope` | `allowedTools: string[]`、`allowedAliases: string[]`、`newSpend: false` | 受控工具与账号别名白名单；`newSpend` 只能是 `false`，本层从不放开支出能力。 |
| `gate` | `requireOwnerApproval: boolean`、`requireIndependentReviewer: boolean`、`requiredCriteriaLegs: AcceptanceLeg[]` | 老板关口与独立验收岗只能被加强。 |

岗位清单直接引用 `contracts.ts` 的 `ROLES`，别名按 `canonicalAliasValue` 归一后校验，schema 不随岗位表/账号表漂移。

`write_authority` 只能**再收紧**已经存在的基线（工程岗写码的基线规则不变）；`gate` 的开关只会把要求加高，不会把关口放低。

## 作用域链与当前有效视图

作用域四档：`company` → `project` → `goal` → `task`（`company` 不带 `scopeRef`，其余必须在库里存在）。读取时按"任务 → 目标 → 项目 → 公司"组成链，**越靠前越具体、命中即覆盖更宽的域**；同一（作用域, 域）里同时出现两个生效版本属于坏数据，`resolveEffective` 按失败关闭抛 `conflict`——宁可无契约也不猜。

有效契约 = 链上每个域的胜出版本 + 生效 epoch：

```json
{ "version": 7, "hash": "<sha256>", "domains": [ { "domain": "write_authority", "policyId": "…", "policyVersion": 2, "scope": "company", "hash": "…", "payload": { … } } ] }
```

摘要 `hash` 覆盖 epoch 与每个域的条目，**刻意不含策略行的记录号**（记录号是存储细节，试算时还没写库）——所以"先 `policy_plan` 试算、再落地"两边给出的 hash 逐位一致。

## 版本、epoch、登记与复核

- `company_meta:policy_epoch` 是单例计数器：每次写入或撤销 +1。
- **创建**任务时登记 `policy_version` / `policy_hash` / `policy_contract`，并写一条证据行（含生效链）。
- **领取**时先做派工判定（执行相位与复核相位同一份判定，都用任务自身的执行岗与意图）；通过后把 `policy_version` / `policy_hash` / `expected_policy_epoch`（CAS）写到租约上，返回 `policy` 视图（含人读 `rendered`）。
- **写入动作**（非心跳）先比 `lease_policy_hash` 与当前契约 hash：不一致直接拒 `conflict`（「策略已变更：本次动作按的契约已过期」）。下一次动作前复核版本，因此旧 claim、旧提示都不能继续授权写入。
- 任务/租约上登记过的域是 AC01 的历史事实：**当前契约里整个域消失**（临时授权到期、被撤销）时判 `blocked`，而不是"没有策略所以放行"。

## 执行层强制点

判定函数只有一处（`src/policy.ts`），读取层只有一处（`src/policy-store.ts`），下面每个入口都调它：

| 位置 | 代码 | 表现 |
| --- | --- | --- |
| 创建任务/关口 | `core.ts` `createTaskRecord`（`checkWriteAuthority` / `checkGateCreation`） | `forbidden`「策略拒绝创建：…」；gate 域要求的验收腿写进任务证据 |
| 领取任务（执行相位与复核相位都算） | `core.ts` `claim` / `claimLease`（`dispatchVerdict` + epoch CAS） | `forbidden`「策略拒绝领取：…」；契约变化时 `conflict`。判定问的是"这条任务还在授权范围内吗"，所以用**任务自身**的执行岗与意图（与调度器同源）；被 `blocked` 的任务连复核也领不走，不会在执行缝被拒、却从复核缝拿到独占写树 |
| 任务写入 | `core.ts` `transitionRecord`（`lease_policy_hash`） | `conflict`「策略已变更：…」 |
| 调度器派工 | `workforce.ts` `policyDispatchVerdict` → `dispatcher.ts`（`policyBlocks`） | 该任务在整个候选池里带 `policy_blocked`，不值得再试别的实例 |
| sidecar | `plugin/server/sidecar.ts` | 暴露 `policy_*` 五个工具，写操作由 core 按角色拒绝 |
| ops broker | `ops/broker.ts` `call` / `info`（`policyToolScope`） | `forbidden`「有效策略拒绝：…」；`info` 只列出被授权的工具与别名 |
| MCP / sck | `src/mcp/server.ts` | 与 owner 通道同源：同一个 core、同一份判定 |

`policy_blocked` 的处置口径写在 `dispatch-blocked.ts`：责任人 `gm`，下一步 `policy_plan`，恢复条件是新契约重新授权或任务被隔离/重派。

## 治理入口

| 工具 | 谁 | 作用 |
| --- | --- | --- |
| `policy_set` | `gm` / `product`（`source=owner` 时仅 `gm`） | 写一版策略：显式 `supersedes` + 同事务 CAS（epoch 与目标仍是活跃版本） |
| `policy_revoke` | `gm` / `product` | 紧急撤销：立即停止授权，历史保留撤销原因与撤销人 |
| `policy_list` | `manage` 能力 + `gm`/`product` | 按作用域/域列出；默认只列当前生效版本，`includeInactive` 看历史 |
| `policy_effective` | `manage` + `gm`/`product`（带 `taskId` 时该任务的执行岗/评审岗与 `qa`/`eval` 也读得到自己那份） | 当前有效契约 + 作用域链 + 人读 `rendered` + `notes`（到期/被替代/被撤销的当前事实） |
| `policy_plan` | `gm` / `product` | 试算：差异前后版本、受影响任务与它为什么失去授权；**不写库** |
| `policy_enforce` | `gm` / `product` | 隔离在办任务：不在有效契约下仍获授权的任务一律置 `blocked` + `blocked_to=gm`，记 `policy_block_reason`、清租约与持有人；本来就被策略拦着的记 `alreadyBlocked`，已结束或判定为 `clear` 的记 `absent` |

`policy_enforce` 只对 `policy_plan` 列出的受影响任务动手：`resume_state`/`resume_role` 只在 `ready`/`doing`/`review` 三态有值（`review` 记评审岗），其余状态保留它原有的 `resume_state`；每次隔离写一条 `action='policy_blocked'` 的审计，并把 `employee.active_task` 上指向它的关联清掉。

写入前必须过的校验（写入与试算共用同一段 `validatePolicyProposal`）：

- 作用域引用必须存在；`company` 不带 `scopeRef`。
- `source=owner` 时 `ownerQuote` 必须能 `contains` 上一条**已登记的老板方向**——伪造引文直接 `forbidden`。
- `supersedes` 目标必须存在、同域、在本次作用域链上、仍是活跃版本且未到期。失败分别是 `not_found` / `conflict` / `forbidden`（跨作用域/跨项目）、`conflict`（已被替代/已到期）。
- 替代链成环：目标谱系上出现同一 `policyId` 的任何版本 → `conflict`。
- 同域冲突：同（作用域, 域）已有生效版本 → `conflict`，要求显式替代。
- 空 `codeRoles`（冻结代码写权）必须 `source=owner`。
- `expiresAt` 必须晚于 `effectiveAt`。

**迁移既有冲突配置**：先用 `policy_list` + `policy_effective` 把现网事实与候选列清楚，再由人决定谁替代谁；这一层不自动决定优先级。老板的方向由既有 owner 通道（`owner/*`）转录，经理用同一套 `policy_*` 工具，角色权限沿用现有岗位模型——不为老板另开一条批策略的路。

## 回滚与隔离（RB01）

隔离**不引入新的状态字面量**：用的是旧版就认得的 `blocked` + `blocked_to`，另加一个旧版读不到的说明字段 `policy_block_reason`，并把 `resume_state` / `resume_role` 一起记下来（旧版读到也不认识，只会继续按 `blocked` 处理）。

这样做的理由：新旧版本共用一个命名空间时，回滚后的旧 release 必须能安全读到新代码写下的行。旧版的派工读法是"state ∈ {ready, doing} 的执行 / review 的评审，且没有持有人"——它的候选集里本来就没有 `blocked`，`current_employee` / `lease_expires_at` 又被隔离清空，所以隔离过的任务**在任何一轮里都不会被旧版误派**；等待（`blocked_to=gm/owner`）、关口、需修的任务同理，不会被领走。

`tests/rollback-isolation-policy.fork.test.ts` 在隔离 fork 库上彩排了这条链路：旧 release 先建库，新代码升到 035 并收权 + 隔离，随后连派三轮（旧版直接读 / 旧版 bootstrap 之后 / 旧版逐个试领之后）——受保护的 6 个任务零命中，而冻结之后新建的对照任务一直可派（证明这三轮不是空转）；6 次旧版领取全部被拒且行内容不变。

## 一处刻意的不对称

- `tool_scope` **到期**时，broker 的边界退回"没有该域 = 不设机器限制"（`policyToolScope` 读不到 payload 就返回 `ok`）。工具白名单是运维便利与支出边界，不是写权，到期松回基线不会让谁获得额外的写权限。
- `write_authority` 的域**消失**（到期或被撤销）时，已经在办的任务按 `dispatchVerdict` 判 `blocked`：原来被授权、现在没有契约，绝不能读成放行。冻结但还没被隔离的任务，用 `policy_plan` 看差异 + `policy_enforce` 隔离来关闭这个窗口。

## 验证

```sh
bun scripts/test-worktrees.ts tests/effective-policy.test.ts tests/effective-policy.fork.test.ts   # 单元 + fork 库
bun scripts/test-worktrees.ts tests/rollback-isolation-policy.fork.test.ts                          # RB01 彩排（要旧 release 的 commit）
```

真实通道：`tests/effective-policy.fork.test.ts` 里同时走 MCP HTTP（`createMcpHttpService` + `connectCompanyClient`）与 ops broker 入口，并断言"只改提示词/标题/证据文本"不改变判定结果。艺术类 AC 仍需真人验收，机器策略不代替它。