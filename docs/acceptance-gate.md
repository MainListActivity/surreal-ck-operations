# SYS02：结构化验收与关键运行证据门禁

本文件是实现腿的设计与验收映射。门禁由代码维护，不靠请求员工记住；48 KiB 应答预算、租约 fence、权限/写权与既有审计不变。

## 1. 数据契约（AC01）

- `task.acceptance_criteria` 是版本化数组，每项 `{ id, kind, required, layer, evidence, verify, description?, risk?, legs? }`。`id` 唯一（`AC-…`），`kind` 为 `machine`/`human`；`machine` 不能用 `review-signoff`，`human` 只能用 `review-signoff`。
- `create_delivery` 按 `legs` 把同一组 criteria 分到实现/上线申请/部署三腿；没有匹配项的腿使用该腿默认 criteria（实现：CI + 独立复核；上线申请：CI；部署：CI + QA 生产签署）。`create_task` 也可显式携带 criteria。
- 启用门禁后，新代码交付缺 criteria、重复 id 或机器/人工证据类型混用在创建或提交时被拒；门禁关闭期间创建的任务在创建时标 legacy，启用后保留旧路径，只读保留，不能伪造已满足。
- `acceptance_version`、`acceptance_legacy`、`acceptance_head`、`acceptance_environment`、`acceptance_attempt`、`acceptance_chain` 均新增可选字段；旧行不需要迁移。

## 2. 证据（AC02）

- `acceptance_evidence` 表保存 `task/ac_id/kind/sha/environment/evidence_type/source/verified/verifier/actor/at/criteria_version/task_version/digest`，`digest` 唯一，重复来源幂等。
- 机器证据只由服务端适配器写入：`record_acceptance_evidence` 让适配器只读调用 `gh run view` 与 `gh api .../artifacts/<id>`，要求 run 的 `headSha` 等于提交 SHA、`conclusion=success`。probe 必须提供承载记录的 CI artifact：artifact 必须属于同一 run 与 head，适配器下载其 JSON 记录并核验 `probe/runId/readAt/inProgress/observationHash` 与调用方记录一致；只有窗口内自报记录、没有 artifact 的一律拒绝。artifact 类证据要求未过期且属于同一 head。模型文本、任意 URL 或自写 `passed` 不会进入 `verified=true`。
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

`scripts/acceptance-probe.ts` 在 CI 作业内读取目标（URL 或打包后的模块），记录 `GITHUB_RUN_ID`、`GITHUB_JOB`、读取时刻、`inProgress=true` 与观测 sha256；`.github/workflows/acceptance-probe.yml` 上传该记录。调用方必须把该 artifact 的 id 传给 `record_acceptance_evidence`；服务端下载 artifact 并核验其 JSON 记录属于同一 run/head、读取时刻在 run 窗口内且与调用方记录一致。作业完成后下载或手写记录没有 artifact 记录依据，不能满足 AC。

## 5. 存量与治理（AC06）

`company_meta:acceptance_gate` 是版本化记录 `{version, enabled, enabled_at, scope, criteria_version}`，安装时 `enabled=false`。只有 gm 能通过 `set_acceptance_gate` 修改，必须带 `expectedVersion` 与理由，前后值与理由写入审计；执行者不能自批豁免。启用时记录 `enabledAt`，之前创建的任务为 legacy；新强制范围在上线申请列明。老板关口不自动批准，旧历史只读。

## 6. 回滚隔离（RB01）

新增状态只有可选字段、新表 `acceptance_evidence` 与 `company_meta:acceptance_gate`，没有新增 task 状态。回滚到 SYS02 之前的 release 时：

- 旧版按 schemaless 行读取，忽略 `acceptance_*` 字段与新表；它不会崩溃，也不会把任务认领到不存在的新状态（任务仍只在 ready/doing/review/blocked 中）。
- 旧版没有评估器，会绕过新门禁直接 accept。因此**在存在已启用 criteria 的在办任务时不得回滚**；上线申请必须列出该边界，部署腿的回滚演练要覆盖「新版写入 → 回滚旧版 → 调度若干轮」并证明没有误认领/误拉起，且回滚计划包含排空或保留新 release。
- `tests/acceptance-gate.fork.test.ts` 的 RB01 用例用隔离 fork 记录旧阅读器忽略新字段、任务状态不变、旧门禁关闭时可通过（即回滚边界）。

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
- `tests/acceptance-gate.fork.test.ts`：RB01 旧版读取与回滚边界，以及 probe artifact 伪造与 PR head 绑定的负例。
- 根与 plugin typecheck；相关既有套件。
