# WT02 工作树生命周期：回收、孤儿 sweep 与四仓对账

## 语义摘要

| 事件 | 引用 | 物理树 |
|---|---|---|
| 提交待验收（review）/ 退回待续（ready）/ blocked / 租约过期 / 撤回交接 | 释放旧员工/fence；非终态任务在其 assigned_tree（非 shared）上的引用一律计 recovery | 不删现场，接手续用 |
| shared 树上的任务引用 | 非终态也计 released（shared 硬保护，不依赖引用保留） | 不删；shared 只给只读/资产任务，代码任务从不进入，分支也不会被切换（漂移的会被调度自动挪回） |
| 线（lane）的树 | 同一目标下 `workIntent.lane` 相同的任务共用一棵 exclusive 树；线内任一未终态（非 done/void）任务都让该树保持 `lane-open` | 线内最后一个任务终态且无引用、干净 → 回收树，已合入的 lane 分支一并删除 |
| 任务 done（验收通过） | 任务保留引用结束，sweep/accept 观测到全量释放时写持久 `release` 审计 | exclusive 干净且无有效引用则立即回收；shared 保留 |
| 脏树 / 未跟踪改动 | 不变 | 保留，审计 reason=`dirty-or-untracked` 并写 `cleanup_todo` 待办 |
| 未合并任务分支 | 树可删 | 本地分支仅 `git branch -d`；失败则 `branch_retain` 审计 |
| 孤儿宽限 N（默认 7 天） | 无 active/recovery 引用 | 仅公司管理任务树；时钟=last_released_at → last_used_at → created_at |

删除唯一依据：持久 `worktree` / `worktree_ref` / `worktree_session_ref` 与实时对账。不用文件 mtime，不用 `git worktree remove --force` / `branch -D`，不借 `git prune` 扩大删除面。

## 本地受控演练（QA 无需公司凭证）

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm --dir plugin install --frozen-lockfile --ignore-scripts
rtk proxy sh plugin/scripts/vendor.sh
rtk proxy pnpm run typecheck
rtk proxy pnpm --dir plugin exec tsc --noEmit
rtk proxy pnpm run test:worktrees
```

`scripts/test-worktrees.ts` 启动公司 fork SurrealDB 临时实例，覆盖 WT01 分配回归 + WT02 回收/宽限/禁用开关/审计。可设 `SCK_WORKTREE_EVIDENCE=<evidenceDir/json>` 导出本地 before/after。`production=false`。

## 开关与配置

| 键 | 作用 |
|---|---|
| `SCK_WORKTREE_RECLAIM=0` | 紧急关闭回收（两面同时设）；登记与审计保留 |
| `SCK_WORKTREE_ORPHAN_GRACE_DAYS` | 孤儿宽限天数，默认 7 |
| `company_meta:config.worktree_reclaim_enabled` | 运营可配；环境变量优先 |
| `company_meta:config.worktree_orphan_grace_days` | 同上 |

关闭回收或回滚代码后，schema 012 审计表与既有登记不删除。

## 生产查询与 dry-run

```sh
# 全局库存（GM）：不带分页参数时返回完整数组；超出 48 KiB 预算会报 response_too_large，
# 此时改用 '{"pageSize":100}'，按返回的 page.nextCursor 逐页读完（带分页参数时返回 {worktrees, page}）
sck call list_worktrees '{}'

# dry-run：只写 audit，不删
sck call reclaim_worktrees '{"dryRun":true}'

# 执行回收（仍跳过 protected/shared/dirty/宽限内）
sck call reclaim_worktrees '{}'

# 持久审计
sck call list_worktree_audits '{"limit":100}'
```

调度器沿用既有 10 分钟 sweep；accept 成功后对终态任务事件触发一次回收，失败由 sweep 重试。

## 四仓存量对账

覆盖 `surreal-ck-operations`、`surreal_ck`、`ma_hono`、`maplayer-content` 的 `git worktree list`：

- 主 checkout、shared、插件长期树、`SurrealCKCompany/releases/*`、外部工具（如 `~/.codex/worktrees`）、归属不明 detached：`protected` / `unknown`，无引用也不自动删
- 公司任务形态：`*-task-<id8>`、`*-wt-<id8>`、`*-review-<id8>`、`task/<id8>` 与带后缀分支；存量无可靠时间时以首次登记为宽限起点
- 先 dry-run 清单（逐项理由），再同一判定清理已确认孤儿

## 生产演练（上线后 QA 腿）

1. 经理取 `list_worktrees {}`（超出预算报 `response_too_large` 时改用 `pageSize`/`cursor` 逐页读完再统计）与四仓 git list 作 before；记录 MCP/插件提交与 schema 012 哈希
2. 串行/并行工程任务：done 后 exclusive 不在 `git worktree list`，shared 仍在；两写手未提交改动互不覆盖
3. fixture：dirty exclusive 保留；租约过期交接、submit→review、return→ready 窗口 recovery 保留；把 fixture `last_released_at` 拨到 N 前，经真实 sweep 删除；N 内与保护树仍在；`list_worktree_audits` 可见 release/delete/skip/fail
4. 至少 10 个同仓串行任务后 shared 数不增加（代码任务不进 shared）；同一线的多个任务始终落在同一路径同一分支，线结束后树消失；并行峰值与写手数相关；结束后收敛到共享/受保护基线加明确保留例外
5. `SCK_WORKTREE_RECLAIM=0` 验证可关闭；回滚后登记/审计仍在

证据写 `evidenceDir`，老板可打开的手册与摘要用 `deliverable_publish`。
