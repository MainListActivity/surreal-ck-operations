# SYS02：结构化验收与关键运行证据门禁

本文件是实现腿的设计与验收映射。门禁由代码维护，不靠请求员工记住；48 KiB 应答预算、租约 fence、权限/写权与既有审计不变。

## 1. 数据契约（AC01）

- `task.acceptance_criteria` 是版本化数组，每项 `{ id, kind, required, layer, evidence, verify, description?, risk?, legs?, environment? }`。`id` 唯一（`AC-…`），`kind` 为 `machine`/`human`；`machine` 不能用 `review-signoff`，`human` 只能用 `review-signoff`。`environment` 是受控 AC 声明的目标环境（如 `production`），只能由建单/AC 写入，执行者不能在 submit 时引入或改写。
- `create_delivery` 按 `legs` 把同一组 criteria 分到实现/上线申请/部署三腿；没有匹配项的腿使用该腿默认 criteria（实现：CI + 独立复核；上线申请：CI；部署：CI + QA 生产签署）。`create_task` 也可显式携带 criteria。`create_task`/`create_delivery` 还可携带受控的 `acceptanceEnvironment`；它与 criteria 的 `environment` 必须一致，冲突在建单时拒绝。
- **legacy 先于 criteria 判定**：`acceptance_legacy === true` 或 `createdAt < enabledAt` 的行无论 criteria 是否为空都保留旧路径，且 legacy 不写 SYS02 证据；停用期间创建的交付三腿在启用后可继续 submit→独立 accept，启用后新建交付仍必须补机器证据。
- 启用门禁后，每个新代码交付及其三腿由服务端合并**不可移除基线**（如 `AC-BASE-IMPL-1` required 机器 CI、`AC-BASE-IMPL-2` 真实独立签署；release/deploy 各有对应腿基线）；自定义 criteria 只能补充，同 ID、`required:false`、仅 human、全 optional 或 legs 过滤都不能移除/降级基线。`create_task`、`create_delivery` 与统一评估器同源合并，缺基线/降级/非法变更在创建或放行拒绝；门禁关闭期间创建的任务在创建时标 legacy，启用后保留旧路径，只读保留，不能伪造已满足。
- `acceptance_version`、`acceptance_legacy`、`acceptance_head`、`acceptance_environment`、`acceptance_attempt`、`acceptance_chain` 均新增可选字段；旧行不需要迁移。

## 2. 证据（AC02）

- `acceptance_evidence` 表保存 `task/ac_id/kind/sha/environment/attempt/evidence_type/source/verified/verifier/actor/at/criteria_version/task_version/digest`，`digest` 唯一。digest 包含目标 attempt、环境与 criteria 版本，因此同一来源为新 attempt 重新记录会产生新的行，不会被幂等回放成旧 attempt 的证据。
- **环境绑定（N1）**：所需环境只来自建单/AC 的受控声明，并且只挂在**部署腿**（`kind=deploy`）；实现腿与上线申请腿在合入前不存在 deployment，带环境要求会被建单拒绝（`acceptance environment requirements apply to the deploy leg only`）。submit 使用本次提交的目标环境（不是旧任务行）与受控声明严格比较，accept 使用持久化的同一值；缺失、未知、错误环境一律拒绝。机器证据的 `environment` 必须与目标环境精确相等，`undefined` 只表示「通用 CI」，不能通配 `production`。适配器必须返回核验过的环境。**N1-R 来源关联**：`src/deployment-source.ts` 判定，规则是两道独立的门，缺一不可。①**授权**：只有受信的部署 workflow（`TRUSTED_DEPLOYMENT_WORKFLOWS`：`Deploy production` / `Deploy origin` / `Deploy origin (manual)`，可用 `SCK_TRUSTED_DEPLOYMENT_WORKFLOWS` 追加，**只增不减**）能证明环境；通用 CI（quality gate、channel build）只能证明「这次提交能构建」，永远不能升级为 production 事实，它没有环境事实。②**因果**：deployment 记录或其状态必须**指名本次证据 run** —— 真实 GitHub 形状里 deployment 记录本身不带 run 引用（`payload` 为空），链接在状态的 `log_url`/`target_url`（`…/actions/runs/<runId>/job/<jobId>`）里；同 SHA、同环境名、时间接近**都不是**证明，因为一次成功的通用 CI 与另一 run 的同提交失败 deployment 这三样全都一样。同时 deployment 必须与 run 同 head（**缺 sha 是未知不是通配**）、同环境、创建在 run 时间窗内，并且其状态里必须读到**成功终态**（`success`/`active`）且该状态也指向本次 run；状态缺失/未知/失败/未完成/指向别的 run 一律失败关闭。`source` 不再只写 environment 字符串，而是保留 `deployment{id,status,runId,jobId}`、workflowName 与 sha，可追溯。
- **attempt 绑定（N2）**：机器证据在记录时绑定目标 attempt（`doing` 时为当前 attempt+1，`review` 时为当前 attempt）和当时的 gate criteria 版本。submit/accept 只接受 attempt 与 criteria 版本都匹配的证据；退回后的新 attempt 必须重新记录，旧 attempt 记录被拒绝并返回对应 AC。heartbeat/checkpoint 只推进任务版本、不推进 attempt，因此不会让已有证据失效；`task_version` 仅作审计。
- 机器证据只由服务端适配器写入：`record_acceptance_evidence` 让适配器只读调用 `gh run view`、`gh api .../artifacts/<id>`、`gh api .../deployments` 与 target run/job/status API，要求 run 的 `headSha` 等于提交 SHA、`conclusion=success`。probe 必须是受信版本 `acceptance-probe/2` 的 CI artifact 记录：运行中通道由 target 作业开始即创建的 commit status 承载，适配器核验 producer run、target run/job 的 in-progress 窗口（`started_at <= readAt <= completed_at`）与 status 创建时刻/哈希；Node 打包模板由 Node 实际执行构建 bundle 的 default 请求路径并记录 Node 版本/bundle hash；`criterion.verify`（如 `probe:running-channel`/`probe:node-packed`）与 `risk` 绑定 probe kind/target。任意 2xx URL、Fake adapter、自传 `RUN_ID`、作业完成后读取或记录不符一律拒绝；artifact 类证据要求未过期且属于同一 head。模型文本或自写 `passed` 不会进入 `verified=true`。
- **受管本地单测例外（SYS02，老板授权）**：当 GitHub Actions 账单不可用且存在真实 `owner_reply`（原文含「无法取得就在本地运行单元测试，通过就可以」）时，`provider=managed-local-test` 可代替 `github-actions` 满足 **ci-run** 机器 AC，并可在 **submit 前置 PR 门** 上替代 soft CI FAILURE（`pr-gate` 把 CI 红标为 `ciFailed` + head；关闭/冲突仍硬拒）。受信宿主跑 `scripts/managed-local-test.sh <suite> /absolute/path`（固定允许名单：`sys04-runtime-diagnostics` / `sys02-local-evidence`），写出 `gates/managed-local-test/<sha>.json`。记录必须带 `hostMode=managed` 与 `hostAttestation`（HMAC-SHA256，密钥=可读的 `private/service.env`）；工程沙箱读不到 `private/` 时只能写出 `hostMode=dry-run`，**不能**替代 CI、不能入账。`record_acceptance_evidence` / PR 门替代共同核验：宿主签名、logHash、dirty=false、exitCode=0、真实 `owner_reply`（固定审计 `wuj9vmp3vg9pqyu33p2v`）、授权任务名单（`25ec8d1a` + 本链 `612f1946`/`690ea881`/`231e786b`）、PR 实际 head。未授权任务、dry-run、脏树、失败、改日志、错误 head、伪造 owner 一律拒绝。**不关 gate、不删 required AC、不伪造 GitHub success/pending。** 本修复首次上线仍须引导包 + 独立复核 + 合法宿主发布；不得用未上线工具自证。
- 人工证据由获授权的独立签署写入：实现腿由另一位工程师在 `accept` 时签署，上线申请由运营，部署由 QA，老板关口由 `owner.decide`。Jev 是机器 actor，永远不能签署人工 AC。

## 3. 统一评估器（AC03）

`src/acceptance.ts` 的 `evaluateAcceptance` 是唯一判定；以下入口都调用它：

| 入口 | 位置 | 阶段 |
| --- | --- | --- |
| submit | `core.transitionRecord` | `submit`：以 PR 门禁核验的实际 head 为权威。**声明**的 head 与 PR head 不一致一律 `conflict`；**未声明** head 只有在门禁开启且该行不是 legacy 时才拒绝。门禁关闭或 legacy 行保留旧路径：只附 PR 链接的提交不被 head 检查挡住。机器 AC 必须已有 verified 证据并绑定该 head；人工 AC 待复核 |
| review accept | `core.transitionRecord` | `accept`：机器证据匹配已提交 head；复核人签署人工 AC，同事务写证据 |
| Jev 自动批准 | `workforce.jevAccept` | `release`：机器证据通过且无人工 AC；否则拒绝并写 `jev_acceptance_blocked` |
| 运营上线 accept | `core.transitionRecord`（release 腿） | `accept`：运营签署人工 AC |
| 部署/生产实测 | `core.transitionRecord`（deploy 腿） | `accept`：QA 签署；机器证据绑定部署 head |
| 老板关口 | `owner.decide`（approve） | `owner`：机器证据 + 老板签署；老板关口不自动批准 |
| 目标完成 | 验收锚点任务的 accept/owner approve | 上述门禁通过后目标才关闭；部署与目标完成都经 accept/owner approve 传递，不设独立旁路 |

拒绝返回 `invalid`/`conflict`，消息与 `details.unmet` 列出每个未满足 AC 及原因（`machine-evidence-missing-or-untrusted`、`machine-evidence-wrong-attempt`、`machine-evidence-wrong-environment`、`machine-evidence-stale-criteria-version`、`environment-mismatch`、`submission-head-missing`、`self-review`、`reviewer-role-mismatch`、`human-signoff-required`、`structured-acceptance-criteria-required` 等）。旧 head 的证据、旧 attempt、失效 criteria 版本、错误环境、失效 artifact、越权作者和自验都会被拒；新 head 必须重新验证。

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
| `record_acceptance_evidence` | `taskId`、`acId`、`sha`、`environment?`（只用于与受控声明比对，不能新增要求）、`source{provider,runUrl?,suite?,ownerReplyAuditId?,ownerReplyTaskId?,artifactId?,probe?}`、`idempotencyKey` | `provider=github-actions` 时 probe 必须带 artifactId，声明环境由 Deployments API 核验；`provider=managed-local-test` 时需 suite + ownerReply*，核验宿主 `gates/managed-local-test/<sha>.json` 与授权 `owner_reply`；服务端写入本次 attempt 与 criteria 版本 |
| `acceptance_status` | `taskId` | 读 gate、criteria、证据与当前未满足清单 |
| `acceptance_gate` | — | gm 读 gate 记录 |
| `set_acceptance_gate` | `enabled`、`reason`、`expectedVersion`、`idempotencyKey` | gm 版本化启停，审计理由 |

`create_task`/`create_delivery` 的 MCP schema 携带 `acceptanceCriteria`、`acceptanceEnvironment`；`submit`/`review` 携带 `acceptance{sha,environment}`。`submit` 的声明 head 必须等于 PR 门禁实际 head，声明的环境必须等于受控声明；`accept` 使用提交时持久化的环境与 attempt。

通道（中继）边界：**sidecar 只做转发，不做判定**。它把调用方声明的 `acceptance{sha,environment}` 原样转给 core；格式非法时中继直接拒绝，不会静默丢弃（被丢弃的 head 到门禁会变成“未声明”）；字段缺失时不转发，由门禁按门禁状态判断。判定一律在 core 的统一评估器里完成，所以 sidecar 与 core 是同源判定、不是两套规则。由 report.md 文件触发的提交没有结构化 acceptance：门禁关闭时走旧路径（只附 PR 链接不会被 head 检查挡住），门禁开启且该行不是 legacy 时被拒（有 PR 链接时是缺 head 的 head 检查，没有链接时是缺 head 的机器 AC），这是 AC05 的预期行为。

## 8. 回归

- `tests/acceptance.test.ts`：criteria 校验、三腿默认、机器/人工判定、Jev 不能签人工、拒绝清单、签署摘要唯一性；GitHub adapter 的 artifact 记录核验；`managed-local-test` 适配器正负例（pass/fail/dirty/logHash/缺记录/未授权任务/伪造 owner_reply/未知 suite/错误 sha/composite 路由）。
- `scripts/managed-local-test.sh`：固定 suite 允许名单；宿主写出 `gates/managed-local-test/<sha>.{json,log}`；脏树/未知 suite/非 40-char 路径拒绝。
- `tests/acceptance-gate.fork.test.ts`：隔离 fork 上的建单/提交/复核/owner/Jev/证据适配器/真实 sck 拒绝→补证据→独立 accept。
- `tests/acceptance.test.ts` 的 adapter 负例：不受信 probeVersion、target workflow 不符、缺 `commit-status` 通道均拒绝；`Node` 执行失败时 `acceptance-node-probe` 不写记录。服务端核验 artifact 与 producer/target run/job/status 的绑定；`nodeVersion`/`bundleHash` 是受信探针自报，Node 执行保证来自 CI 作业退出码，信任锚是受信 `acceptance-probe/2` 与 run/artifact provenance。
- `tests/acceptance-gate.fork.test.ts`：RB01 旧版读取与回滚边界，以及 probe artifact 伪造与 PR head 绑定的负例。
- `tests/acceptance-gate.fork.test.ts` 的 N1/N2 用例：声明 production 的任务只有在适配器核验环境后才能 submit/accept；通用任务不能由提交方引入 production；退回后的新 attempt 不补证据会被拒，补录本 attempt 证据后非作者 accept；checkpoint 只改版本不使证据失效。
- `tests/acceptance-gate.fork.test.ts` 的通道回归：门禁关闭时只附 PR 链接的提交必须通过（不再被 head 检查挡住）；门禁开启时未声明 head 仍被拒；声明了与 PR head 不一致的 head 仍被拒；`acceptanceEnvironment` 只落在部署腿，实现腿与上线申请腿带它时建单被拒；任务进入 done 后 `acceptance_status` 与证据行的 attempt 口径一致。
- `tests/sidecar.test.ts`：中继把声明的 `acceptance{sha,environment}` 转发给 core，非法字段被中继拒绝。
- 根与 plugin typecheck；相关既有套件。
