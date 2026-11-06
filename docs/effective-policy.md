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

`policy_blocked` 的处置口径写在 `dispatch-blocked.ts`：责任人 `owner`（老板），下一步 `policy_plan`，恢复条件是新契约重新授权或任务被隔离/重派。

## 治理入口

| 工具 | 谁 | 作用 |
| --- | --- | --- |
| `policy_set` | `owner` | 写一版策略：显式 `supersedes` + 同事务 CAS（epoch 与目标仍是活跃版本） |
| `policy_revoke` | `owner` | 紧急撤销：立即停止授权，历史保留撤销原因与撤销人 |
| `policy_list` | `manage` 能力 + `owner` | 按作用域/域列出；默认只列当前生效版本，`includeInactive` 看历史 |
| `policy_effective` | `manage` + `owner`（带 `taskId` 时该任务的执行岗/评审岗与 `qa`/`eval` 也读得到自己那份） | 当前有效契约 + 作用域链 + 人读 `rendered` + `notes`（到期/被替代/被撤销的当前事实） |
| `policy_plan` | `owner` | 试算：差异前后版本、受影响任务与它为什么失去授权；**不写库**。候选集与派工/领取判定同源——扫的是**全公司的在办任务**（与提案的作用域无关），不按 `policy_hash` 预筛，所以策略层上线前既存、没有登记的任务也会被列出来。受影响清单**按页返回**（`page`：`total` / `returned` / `hasMore` / `nextCursor` / `budgetBytes`），每页都裁到 48 KiB 响应预算内；用同一提案加 `cursor` 翻下一页；`planHash` 覆盖全量、翻页不变（同一份试算的指纹）。服务端不留快照，每一页都重算当下的全量试算，所以某页看到的永远是当下事实；生效 epoch 或**受影响清单**一变，旧光标即被拒（`conflict`）——与受影响清单无关的在办变化（某条无关任务新建或完成）不会让光标失效。从第一页重跑即可。数据库扫描本身的上限另由 `scanned` / `scanLimit` / `truncated` 报告 |
| `policy_enforce` | `product`（owner 经 owner 接口） | 隔离在办任务：不在有效契约下仍获授权的任务一律置 `blocked` + `blocked_to=owner`，记 `policy_block_reason`、清租约与持有人；本来就被策略拦着的记 `alreadyBlocked`，已结束或判定为 `clear` 的记 `absent`。**单批最多 200 个 taskId**（超过直接 `invalid`）；清单大于一页时按 `policy_plan` 的页收集 id，再分批发来 |

`policy_enforce` 只对 `policy_plan` 列出的受影响任务动手：`resume_state`/`resume_role` 只在 `ready`/`doing`/`review` 三态有值（`review` 记评审岗），其余状态保留它原有的 `resume_state`；每次隔离写一条 `action='policy_blocked'` 的审计，并把 `employee.active_task` 上指向它的关联清掉。隔离的对象来自试算清单，所以清单的覆盖范围就是这条缓解路径的覆盖范围：候选集必须与判定同源，没有登记的在办任务要先被列出来，隔离才有对象。清单的可获得性分两层，都是显式事实：**页**由 `page.total` / `page.hasMore` / `page.nextCursor` 说明——在扫描上限以内，受影响清单再大也能一页页读完，不会整份被响应预算拒掉；**库扫描**由 `scanned` / `scanLimit` / `truncated` 说明。`truncated=true` 表示候选集本身被读上限（200×50 = 10000 条）截断了，这时**翻页也只能翻已扫到的那部分，本工具给不出完整清单**：候选集是全公司在办任务、与提案作用域无关，`policy_plan` 没有任何收窄入参（换作用域、换域都不会改变候选集），所以「收窄一点再试」这条路不存在，也**不得据此认定已隔离全部受影响任务**。扫描按 `created_at DESC` 走、逐页用 `(created_at, id)` 续读（keyset）：并发新建或离开的任务不会让页与页错位，扫描本身既不重复也不漏行；被上限丢掉的是**最早**的在办任务——恰好包含策略层上线前既存、没有登记的那一批。真需要完整清单时的现实做法是老板另定方案（例如低峰人工核对、或另写一段读取），本工具只如实报告它扫到了什么。

写入前必须过的校验（写入与试算共用同一段 `validatePolicyProposal`）：

- 作用域引用必须存在；`company` 不带 `scopeRef`。
- `source=owner` 时 `ownerQuote` 必须能 `contains` 上一条**已登记的老板方向**——伪造引文直接 `forbidden`。
- `supersedes` 目标必须存在、同域、在本次作用域链上、仍是活跃版本且未到期。失败分别是 `not_found` / `conflict` / `forbidden`（跨作用域/跨项目）、`conflict`（已被替代/已到期）。
- 替代链成环：目标谱系上出现同一 `policyId` 的任何版本 → `conflict`。
- 同域冲突：同（作用域, 域）已有生效版本 → `conflict`，要求显式替代。
- 空 `codeRoles`（冻结代码写权）必须 `source=owner`。
- `expiresAt` 必须晚于 `effectiveAt`。

**迁移既有冲突配置**：先用 `policy_list` + `policy_effective` 把现网事实与候选列清楚，再由人决定谁替代谁；这一层不自动决定优先级。老板的方向由既有 owner 通道（`owner/*`）转录，批策略也用同一套 `policy_*` 工具（owner 角色）——不为老板另开一条批策略的路。

## 回滚与隔离（RB01）

隔离**不引入新的状态字面量**：用的是旧版就认得的 `blocked` + `blocked_to`，另加一个旧版读不到的说明字段 `policy_block_reason`，并把 `resume_state` / `resume_role` 一起记下来（旧版读到也不认识，只会继续按 `blocked` 处理）。

这样做的理由：新旧版本共用一个命名空间时，回滚后的旧 release 必须能安全读到新代码写下的行。旧版的派工读法是"state ∈ {ready, doing} 的执行 / review 的评审，且没有持有人"——它的候选集里本来就没有 `blocked`，`current_employee` / `lease_expires_at` 又被隔离清空，所以隔离过的任务**在任何一轮里都不会被旧版误派**；等待（`blocked_to=owner`）、关口、需修的任务同理，不会被领走。

`tests/rollback-isolation-policy.fork.test.ts` 在隔离 fork 库上彩排了这条链路：旧 release 先建库，新代码升到 035 并收权 + 隔离，随后连派三轮（旧版直接读 / 旧版 bootstrap 之后 / 旧版逐个试领之后）——受保护的 6 个任务零命中，而冻结之后新建的对照任务一直可派（证明这三轮不是空转）；6 次旧版领取全部被拒且行内容不变。

`tests/effective-policy-plan-coverage.fork.test.ts` 补的是同一条链路上"上线前既存任务"这一段：**旧 release 自己建**的两条在办任务（ready / doing，没有 `policy_hash` 登记）在新代码上收权后，必须被 `policy_plan` 列出、被 `policy_enforce` 隔离为 `blocked + blocked_to=owner`（并保留 `resume_state`），随后旧 release 的候选集里没有它们、试领全部被拒。

切换路径上的那条门禁（"已写策略的数据不能切到不执行策略的代码"）由 `scripts/policy-guard.sh` 在 install / 远端 deploy 的副作用之前把关，见 [company-service-operations.md](./company-service-operations.md) 第 5 节。

## 一处刻意的不对称

- `tool_scope` **到期**时，broker 的边界退回"没有该域 = 不设机器限制"（`policyToolScope` 读不到 payload 就返回 `ok`）。工具白名单是运维便利与支出边界，不是写权，到期松回基线不会让谁获得额外的写权限。
- `write_authority` 的域**消失**（到期或被撤销）时，已经在办的任务按 `dispatchVerdict` 判 `blocked`：原来被授权、现在没有契约，绝不能读成放行。冻结但还没被隔离的任务，用 `policy_plan` 看差异 + `policy_enforce` 隔离来关闭这个窗口——**包括策略层上线前就已在办、没有任何策略登记（`policy_hash = NONE`）的任务**：`policy_plan` 的候选集与派工/领取判定同源，扫全部在办任务而不按 `policy_hash` 预筛，这类任务既进得来清单（`fromHash` 为空），也会被判 `blocked` 后隔离为 `blocked + blocked_to=owner`。这不是边缘情形：策略层上线那一刻，线上的在办任务全都是这一类，回滚到不执行策略的 release 时它们会被旧候选集当普通任务派工。清单的可获得性也是显式事实：扫描上限以内，受影响清单按 `page` 分页（每页都在 48 KiB 预算内，顺 `nextCursor` 读完）；数据库扫描本身的上限由 `scanned` / `scanLimit` / `truncated` 报告。`truncated=true` 时必须把清单当成**不完整**的：候选集与作用域无关、`policy_plan` 没有收窄入参，翻页只能翻已扫到的部分，因此不得据此认定「失去授权的任务都已隔离」，也不得据此回滚；补救只能由老板另定方案。

## 验证

```sh
bun scripts/test-worktrees.ts tests/effective-policy.test.ts tests/effective-policy.fork.test.ts   # 单元 + fork 库
bun scripts/test-worktrees.ts tests/effective-policy-plan-coverage.fork.test.ts                     # R1 候选集与判定同源（要旧 release 的 commit）
bun scripts/test-worktrees.ts tests/rollback-isolation-policy.fork.test.ts                          # RB01 彩排（要旧 release 的 commit）
bun test tests/policy-guard.test.ts                                                                 # 切换守卫（SYS06）：正/负例与内容绑定
```

真实通道：`tests/effective-policy.fork.test.ts` 里同时走 MCP HTTP（`createMcpHttpService` + `connectCompanyClient`）与 ops broker 入口，并断言"只改提示词/标题/证据文本"不改变判定结果。同一文件里的 R1(b) 用例在真实 fork 库上造 60 条在办任务：默认页与 `pageSize` 页都必须在 48 KiB 预算内，顺 `page.nextCursor` 能读完 `page.total` 条（不重不漏、`planHash` 不变），且按页收集的 id 能直接分批交给 `policy_enforce`。艺术类 AC 仍需真人验收，机器策略不代替它。