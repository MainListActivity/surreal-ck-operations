# 可信宿主固定发布接缝（FV06/SYS04）

实现腿交付：固定 `prepare / status / apply / receipt` 契约。  
**本链不合入、不声称生产可用。** Apply 只能由沙箱外的可信宿主执行。

## 能力边界（AC06）

| 面 | 能力 ID / 入口 | 谁能跑 | 现状 |
|---|---|---|---|
| 员工通道 | `host_release_prepare` / `host_release_status` / `host_release_receipt` | 任务持有人 / engineering / gm | 本 PR 代码接缝；**合入并切到含本提交的 release 后**才可调用 |
| 可信宿主 | `scripts/host-release/apply.sh` | 沙箱外配置管理 / 老板本机（需 releases 写、private 读、paseo、launchctl） | **现役无可投递的公司任务能力 ID**；须由经理安排已存在的宿主执行层接入此脚本，不能用本链尚未上线的工具自举签成功 |

员工沙箱（`scripts/sandbox/employee.sb`）明确 deny：`releases/`、`active`、`private/`、`paseo` CLI、`launchctl`。因此员工通道**永远不会**暴露 `host_release_apply`。

## 契约

### prepare（员工安全）

输入（全部必填，拒绝任意命令/路径）：

- `taskId`、`targetSha`(40 hex)、`expectedActive`(绝对路径 CAS)、`snapshotHash`(sha256)、`rollbackSha`(40 hex)、`snapshotPath`(绝对路径，目录名=targetSha)、`idempotencyKey`

校验顺序（与 `company-service.sh install` 一致，无副作用）：

1. main 祖先（`merge-base --is-ancestor` → `origin/main`）
2. `release_matches_commit` 内容绑定
3. RW06 / SYS02 / IR06 / SYS06 四守卫
4. 双 gate（comm-slow-pipe + sidecar-review）+ 服务 Bun 版本匹配
5. `expectedActive` CAS（只读）
6. release 形态（mcp + dispatcher + plugin）

产物：`maintenance/host-release/<opId>/operation.json` + `prepare.json`  
返回：`apply.available=false` + 原因。

### status / receipt（员工安全）

- `host_release_status`：读 envelope 状态。
- `host_release_receipt`：只接受宿主写的 `receipt.json`（`schema=host-release-receipt/1` 且含 `executor`）；员工上传的无 executor JSON 一律拒绝。

### apply（仅可信宿主）

```sh
sh scripts/host-release/apply.sh \
  --service-home "$SCK_ROOT" \
  --ops-repo /absolute/ops/checkout \
  --op-id <from prepare> \
  --snapshot /absolute/prepared/snapshot
```

步骤：锁 → CAS → 拷贝到 `releases/<sha>/` → `company-service.sh install` → 后置核对 active/health/ready/plugin SOURCE+DIRECTORY → 写 receipt。  
**插件重指 warning 视为失败**（AC02）。失败时用**当前健康 installer** 回滚到 `rollbackSha`（候选须先过同一套守卫；无合格回退则保留健康现役）。

## 固定包（给宿主）

对已合入目标（例：`ba2a41b0…`）：

1. 快照已在 `scratch/<employee>/<sha>/`（archive + vendor + frozen install + 双 tsc + 双 gate）。
2. 清单 hash 算法：`src/host-release/verify.ts` → `snapshotInventoryHash`（与 handoff 包同形）。
3. prepare（员工或宿主均可）：`sh scripts/host-release/prepare.sh --service-home … --ops-repo … --snapshot … --task-id … --expected-active … --rollback-sha … --idempotency-key …`
4. apply（仅宿主）：见上。
5. 回执：`sck call host_release_receipt '{"opId":"…"}'`（合入部署后）或直接读 envelope 内 `receipt.json`。

## AC03 活动屏障

文件信号（无 DB 依赖）：

- `maintenance/host-release.lock` — 进行中的 apply（O_EXCL 创建；自持锁在 apply 核验时豁免）
- `maintenance/dispatch-paused.json` `{paused:true|false}` — 全局暂停权威镜像
- `maintenance/qa-observation-active.json` `{active:true|false, expiresAt?}` — 采样/观察窗权威镜像
- 其它 envelope `state=applying`（忽略自身 opId）

**prepare**（`mode=prepare`）：缺失镜像记 `no file signal` 并放行（只做预检）。  
**apply**（`mode=apply`，副作用前）：缺失镜像 **拒绝**（fail closed）。宿主须显式写入 `{paused:false}` / `{active:false}` 才算放行。

## AC04 回执来源

- receipt 必须带 `hostTag`：HMAC-SHA256，密钥 `$SCK_SERVICE_HOME/private/host-release.hmac`（0600）。
- 员工沙箱 deny 读 `private/`、deny 写 `maintenance/host-release/`（`employee.sb`）。
- reader 校验：operation 五字段绑定 **且** `hostTag` 通过；照抄 operation + 自填 executor **不能**通过。
- 回执证据字段（全部纳入三处 canonical payload：mint / 释锁后重签 / `receiptTagPayload`）：
  - `binding.schemaHash` / `binding.vendorSchemaHash` / `binding.vendorSchemaDiff`：install 后分别对 `releases/<sha>/schema` 与 `plugin/server/vendor/schema` 算目录清单摘要；两者都在时才判 `none`/`differ`，否则 `unavailable` + `null`。
  - `mcp.{pid,cwd,sha}`：用 `lsof` 取**实际监听服务端口**的进程与其 cwd；cwd 落在 `releases/` 时再算该目录清单摘要。没有监听者时如实为 `null`（不臆造）。
  - `plugin.modules`：对 paseo 报告的 SOURCE 目录内实际加载的清单与源码文件算 sha256（排除 `node_modules`）；SOURCE 未知时为 `null`。
  - `checks`：install / active / mcp-health / mcp-ready / plugin-source /（发生回滚时）rollback 的结构化结果。
- `channelRecovery` 仍是**推断值**（`succeeded && plugin_ok → adopt-expected`），不是观测到的活通道恢复。

## 明确未解决

- 现役公司任务通道**没有**可投递的 apply 能力 ID；本 PR 不假装有。
- 回滚候选 `05ac7593…` 的兼容守卫**本链未重验**；apply 前宿主须用当前受审 installer 验证。
- 本链不跑真实登录、不改 fault budget、不切 active。
- DB 侧 `company_meta:config.paused` / QA observation 与文件镜像的自动同步：由宿主/经理工具维护镜像；本缝不直接开 DB。
- `host-release.hmac` 由 apply 首跑自行生成（自举）；密钥的生成/保管/轮换/吊销主体仍未指定（属宿主接入协调）。
- `channelRecovery` 为推断，非活通道探针；`employee.sb` 的实际加载、真实 install/Paseo/launchctl 仍未在本链验证。
