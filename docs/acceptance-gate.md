# SYS02：结构化验收与关键运行证据门禁

本文件是实现腿的设计与验收映射。门禁由代码维护，不靠请求员工记住；48 KiB 应答预算、租约 fence、权限/写权与既有审计不变。

## 1. 数据契约（AC01）

- `task.acceptance_criteria` 是版本化数组，每项 `{ id, kind, required, layer, evidence, verify, description?, risk?, legs? }`。`id` 唯一（`AC-…`），`kind` 为 `machine`/`human`；`machine` 不能用 `review-signoff`，`human` 只能用 `review-signoff`。
- `create_delivery` 按 `legs` 把同一组 criteria 分到实现/上线申请/部署三腿；没有匹配项的腿使用该腿默认 criteria（实现：CI + 独立复核；上线申请：CI；部署：CI + QA 生产签署）。`create_task` 也可显式携带 criteria。
- **legacy 先于 criteria 判定**：`acceptance_legacy === true` 或 `createdAt < enabledAt` 的行无论 criteria 是否为空都保留旧路径，且 legacy 不写 SYS02 证据；停用期间创建的交付三腿在启用后可继续 submit→独立 accept，启用后新建交付仍必须补机器证据。
- 启用门禁后，每个新代码交付及其三腿由服务端合并**不可移除基线**（如 `AC-BASE-IMPL-1` required 机器 CI、`AC-BASE-IMPL-2` 真实独立签署；release/deploy 各有对应腿基线）；自定义 criteria 只能补充，同 ID、`required:false`、仅 human、全 optional 或 legs 过滤都不能移除/降级基线。`create_task`、`create_delivery` 与统一评估器同源合并，缺基线/降级/非法变更在创建或放行拒绝；门禁关闭期间创建的任务在创建时标 legacy，启用后保留旧路径，只读保留，不能伪造已满足。
- `acceptance_version`、`acceptance_legacy`、`acceptance_head`、`acceptance_environment`、`acceptance_attempt`、`acceptance_chain` 均新增可选字段；旧行不需要迁移。

## 2. 证据（AC02）

- `acceptance_evidence` 表保存 `task/ac_id/kind/sha/environment/evidence_type/source/verified/verifier/actor/at/criteria_version/task_version/digest`，`digest` 唯一，重复来源幂等。
- 机器证据只由服务端适配器写入：`record_acceptance_evidence` 让适配器只读调用 `gh run view`、`gh api .../artifacts/<id>` 与 target run/job/status API，要求 run 的 `headSha` 等于提交 SHA、`conclusion=success`。probe 必须是受信版本 `acceptance-probe/2` 的 CI artifact 记录：运行中通道由 target 作业开始即创建的 commit status 承载，适配器核验 producer run、target run/job 的 in-progress 窗口（`started_at <= readAt <= completed_at`）与 status 创建时刻/哈希；Node 打包模板由 Node 实际执行构建 bundle 的 default 请求路径并记录 Node 版本/bundle hash；`criterion.verify`（如 `probe:running-channel`/`probe:node-packed`）与 `risk` 绑定 probe kind/target。任意 2xx URL、Fake adapter、自传 `RUN_ID`、作业完成后读取或记录不符一律拒绝；artifact 类证据要求未过期且属于同一 head。模型文本或自写 `passed` 不会进入 `verified=true`。
- 人工证据由获授权的独立签署写入：实现腿由另一位工程师在 `accept` 时签署，上线申请由运营，部署由 QA，老板关口由 `owner.decide`。Jev 是机器 actor，永远不能签署人工 AC。

## 3. 统一评估器（AC03）

`src/acceptance.ts` 的 `evaluateAcceptance` 是唯一判定；以下入口都调用它：

| 入口 | 位置 | 阶段 |
| --- | --- | --- |
| submit | `core.transitionRecord` | `submit`：以 PR 门禁核验的实际 head 为权威，声明 head 不一致即 `conflict`；机器 AC 必须已有 verified 证据并绑定该 head；人工 AC 待复核 |
| review accept | `core.transitionRecord` | `accept`：机器证据匹配已提交 head；复核人签署人工 AC，同事务写证据 |
| Jev 自动批准 | `workforce.jevAccept` | `release`：机器证据通过且无人工 AC；否则拒绝并写 `jev_acceptance_blocked` |
| 运营上线 accept | `core.transitionRecord`（release 腿） | `accept`：运营签署人工 AC |
| 部署/生产实测 | `core.transitionRecord`（deploy 腿） | `accept`：QA 签署；机器证据绑定部署 head |
| 老板关口 | `owner.decide`（approve） | `owner`：机器证据 + 老板签署；老板关口不自动批准 |
| 目标完成 | 验收锚点任务的 accept/owner approve | 上述门禁通过后目标才关闭；部署与目标完成都经 accept/owner approve 传递，不设独立旁路 |

拒绝返回 `invalid`/`conflict`，消息与 `details.unmet` 列出每个未满足 AC 及原因（`machine-evidence-missing-or-untrusted`、`submission-head-missing`、`self-review`、`reviewer-role-mismatch`、`human-signoff-required`、`structured-acceptance-criteria-required` 等）。旧 head 的证据、旧 attempt、失效 artifact、越权作者和自验都会被拒；新 head 必须重新验证。

## 4. 运行探针（AC04）

`.github/workflows/acceptance-target.yml` 在真实 CI target 作业开始时创建 commit status `acceptance-barrier=target-ready` 并保持作业 in progress；`scripts/acceptance-target-probe.ts` 由 producer 作业在 target 仍 in_progress 时读取该 status，记录 producer/target run 与 job、读取时刻、当时状态、status 创建时刻与哈希；`.github/workflows/acceptance-probe.yml` 的 Node 作业用 Bun 构建 `scripts/acceptance-pack-fixture.ts`，再用 Node 实际执行 bundle 的 default 请求路径并断言响应，记录 Node 版本与 bundle hash。调用方必须把承载记录的 artifact id 传给 `record_acceptance_evidence`；服务端下载 artifact 并核验其 JSON 记录属于同一 run/head、读取时刻在 target run/job 窗口内且与调用方记录一致。作业完成后下载、手写记录、只有 Bun 通过而 Node 失败、或 target/kind 不符均不能满足 AC。

## 5. 存量与治理（AC06）

`company_meta:acceptance_gate` 是版本化记录 `{version, enabled, enabled_at, scope, criteria_version}`，安装时 `enabled=false`。只有 gm 能通过 `set_acceptance_gate` 修改，必须带 `expectedVersion` 与理由，前后值与理由写入审计；执行者不能自批豁免。启用时记录 `enabledAt`，之前创建的任务为 legacy；新强制范围在上线申请列明。老板关口不自动批准，旧历史只读。

## 6. 回滚隔离（RB01）

新增状态只有可选字段、新表 `acceptance_evidence` 与 `company_meta:acceptance_gate`，没有新增 task 状态。回滚到 SYS02 之前的 release 时：

- 旧版按 schemaless 行读取，忽略 `acceptance_*` 字段与新表；它不会崩溃，也不会把任务认领到不存在的新状态（任务仍只在 ready/doing/review/blocked 中）。
- 旧版没有评估器，会绕过新门禁直接 accept。因此**在存在已启用 criteria 的在办任务时不得回滚**；上线申请必须列出该边界，部署腿的回滚演练要覆盖「新版写入 → 回滚旧版 → 调度若干轮」并证明没有误认领/误拉起，且回滚计划包含排空或保留新 release。
- `tests/acceptance-gate.fork.test.ts` 的 RB01 用例用隔离 fork 记录旧阅读器忽略新字段、任务状态不变、旧门禁关闭时可通过（即回滚边界）。SYS02 还把目标能力守卫并入 `scripts/review-wait-guard.sh`：本地 install/回滚与远程 deploy 在任何 active/插件/MCP/ssh 副作用前读取目标自身（内容绑定提交）的基线声明、评估器合并、schema/bootstrap 与 plugin vendor；旧 a925222、缺失、注释冒充或不可读目标一律拒绝，没有“当前 gated 任务为 0/先关 gate”的宽松例外。公司 fork 演练固定 a925222 的旧 dispatcher/core：旧 tick 认领 gated review（`tickClaims=1`）且旧 core 无证据 accept 到 done，新守卫拒绝该目标（`code=1`）。

## 7. 工具与字段

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `record_acceptance_evidence` | `taskId`、`acId`、`sha`、`environment?`、`source{provider,runUrl,artifactId,probe?}`、`idempotencyKey` | probe 必须带 artifactId，服务端下载并核验记录后写机器证据 |
| `acceptance_status` | `taskId` | 读 gate、criteria、证据与当前未满足清单 |
| `acceptance_gate` | — | gm 读 gate 记录 |
| `set_acceptance_gate` | `enabled`、`reason`、`expectedVersion`、`idempotencyKey` | gm 版本化启停，审计理由 |

`create_task`/`create_delivery`/`submit`/`review` 的 MCP schema 同时携带 `acceptanceCriteria` 与 `acceptance{sha,environment}`；`submit` 的声明 head 必须等于 PR 门禁实际 head；sidecar 与 core 同源校验。

## 8. 回归

- `tests/acceptance.test.ts`：criteria 校验、三腿默认、机器/人工判定、Jev 不能签人工、拒绝清单、签署摘要唯一性；GitHub adapter 的 artifact 记录核验。
- `tests/acceptance-gate.fork.test.ts`：隔离 fork 上的建单/提交/复核/owner/Jev/证据适配器/真实 sck 拒绝→补证据→独立 accept。
- `tests/acceptance.test.ts` 的 adapter 负例：不受信 probeVersion、target workflow 不符、缺 `commit-status` 通道均拒绝；`Node` 执行失败时 `acceptance-node-probe` 不写记录。服务端核验 artifact 与 producer/target run/job/status 的绑定；`nodeVersion`/`bundleHash` 是受信探针自报，Node 执行保证来自 CI 作业退出码，信任锚是受信 `acceptance-probe/2` 与 run/artifact provenance。
- `tests/acceptance-gate.fork.test.ts`：RB01 旧版读取与回滚边界，以及 probe artifact 伪造与 PR head 绑定的负例。
- 根与 plugin typecheck；相关既有套件。
